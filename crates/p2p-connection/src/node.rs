use std::{
    collections::HashMap,
    net::SocketAddr,
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

use ring::rand::{SecureRandom, SystemRandom};
use tokio::sync::{Mutex, mpsc};

use crate::{
    AutotuneConfig, AutotuneState, MobilityConfig, ReconnectState,
    identity::{Identity, default_app_dir, fingerprint_peer_id, verify_signature},
    messages::{WireMessage, read_message, write_message},
    quic::{connect_peer, make_endpoint},
};

// ── Public types ─────────────────────────────────────────────────────────────

/// Configuration for a P2P node.
#[derive(Clone, Debug)]
pub struct P2pConfig {
    /// Local address to bind. Default: `0.0.0.0:0` (OS-assigned port).
    pub bind_addr: SocketAddr,
    /// Peer to connect to on startup.
    pub connect_to: Option<SocketAddr>,
    /// If set, only accept peers whose Ed25519 public key (base64) matches this value.
    pub expected_peer_key: Option<String>,
    /// Directory used to persist the node's Ed25519 identity. Default: OS config dir.
    pub app_dir: Option<PathBuf>,
    pub autotune: AutotuneConfig,
    pub mobility: MobilityConfig,
    /// Interval between heartbeat pings. Default: 2 s.
    pub heartbeat_interval: Duration,
    /// Number of missed pings before declaring a peer timed out. Default: 3.
    pub heartbeat_max_misses: u32,
    /// Timeout for the application-level handshake. Default: 3 s.
    pub handshake_timeout: Duration,
    /// Timeout for the QUIC connect. Default: 6 s.
    pub connect_timeout: Duration,
}

impl Default for P2pConfig {
    fn default() -> Self {
        Self {
            bind_addr: "0.0.0.0:0".parse().unwrap(),
            connect_to: None,
            expected_peer_key: None,
            app_dir: None,
            autotune: AutotuneConfig::default(),
            mobility: MobilityConfig::default(),
            heartbeat_interval: Duration::from_secs(2),
            heartbeat_max_misses: 3,
            handshake_timeout: Duration::from_secs(3),
            connect_timeout: Duration::from_secs(6),
        }
    }
}

/// Events emitted by the P2P node.
#[derive(Debug)]
pub enum P2pEvent {
    /// Successfully bound to a local address.
    Bound(SocketAddr),
    /// STUN returned our public endpoint.
    PublicEndpoint(SocketAddr),
    /// A peer told us our observed public endpoint.
    ObservedEndpoint(SocketAddr),
    /// Attempting to connect to a peer.
    PeerConnecting(SocketAddr),
    /// QUIC connection established (handshake not yet done).
    PeerConnected(SocketAddr),
    /// Ed25519 handshake completed successfully.
    PeerVerified { peer: SocketAddr, peer_id: String },
    /// Handshake failed or peer key rejected.
    PeerAuthFailed { peer: SocketAddr, reason: String },
    /// Peer disconnected cleanly.
    PeerDisconnected(SocketAddr),
    /// Peer missed too many heartbeats.
    PeerTimeout(SocketAddr),
    /// Received user data from a peer.
    DataReceived { from: SocketAddr, payload: Vec<u8> },
    /// Result of a probe operation.
    ProbeResult { peer: SocketAddr, ok: bool, message: String },
    /// Generic log message.
    Log(String),
}

/// Commands sent to the P2P node.
#[derive(Debug)]
pub enum P2pCommand {
    /// Connect to a new peer.
    ConnectPeer(SocketAddr),
    /// Probe a peer (QUIC round-trip check) without establishing a persistent connection.
    ProbePeer(SocketAddr),
    /// Rebind the endpoint to a new local address.
    Rebind(SocketAddr),
    /// Send data to a specific peer.
    SendData { to: SocketAddr, payload: Vec<u8> },
    /// Broadcast data to all currently verified peers.
    BroadcastData(Vec<u8>),
    /// Disconnect a specific peer.
    Disconnect(SocketAddr),
    /// Disconnect all peers and stop the node.
    Shutdown,
}

/// Handle to a running P2P node.
#[derive(Clone)]
pub struct P2pNode {
    cmd_tx: mpsc::UnboundedSender<P2pCommand>,
}

impl P2pNode {
    /// Start the node and return a handle + event receiver.
    pub async fn start(
        config: P2pConfig,
    ) -> Result<(Self, mpsc::Receiver<P2pEvent>), Box<dyn std::error::Error + Send + Sync>> {
        let (evt_tx, evt_rx) = mpsc::channel(512);
        let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();

        let node = Self { cmd_tx };
        tokio::spawn(run_node(config, evt_tx, cmd_rx));
        Ok((node, evt_rx))
    }

    /// Send a command to the node.
    pub fn send_command(&self, cmd: P2pCommand) -> bool {
        self.cmd_tx.send(cmd).is_ok()
    }

    pub fn connect_peer(&self, addr: SocketAddr) -> bool {
        self.send_command(P2pCommand::ConnectPeer(addr))
    }

    pub fn send_data(&self, to: SocketAddr, payload: Vec<u8>) -> bool {
        self.send_command(P2pCommand::SendData { to, payload })
    }

    pub fn broadcast_data(&self, payload: Vec<u8>) -> bool {
        self.send_command(P2pCommand::BroadcastData(payload))
    }

    pub fn probe_peer(&self, addr: SocketAddr) -> bool {
        self.send_command(P2pCommand::ProbePeer(addr))
    }

    pub fn disconnect_peer(&self, addr: SocketAddr) -> bool {
        self.send_command(P2pCommand::Disconnect(addr))
    }

    pub fn shutdown(&self) -> bool {
        self.send_command(P2pCommand::Shutdown)
    }
}

// ── Internal ─────────────────────────────────────────────────────────────────

const PROTOCOL_VERSION: u8 = 1;

/// Per-peer command sent from the node task to the peer task.
enum PeerCmd {
    SendData(Vec<u8>),
    Disconnect,
}

struct PeerHandle {
    peer_id: Option<String>,
    verified: bool,
    cmd_tx: mpsc::UnboundedSender<PeerCmd>,
}

/// Node-level reconnect tracking.
struct ReconnectEntry {
    state: ReconnectState,
    retry_at: Instant,
}

/// Main node runtime.
async fn run_node(
    config: P2pConfig,
    evt_tx: mpsc::Sender<P2pEvent>,
    mut cmd_rx: mpsc::UnboundedReceiver<P2pCommand>,
) {
    let app_dir = config
        .app_dir
        .clone()
        .unwrap_or_else(default_app_dir);

    let identity = match Identity::load_or_generate(&app_dir) {
        Ok(id) => Arc::new(id),
        Err(e) => {
            let _ = evt_tx.send(P2pEvent::Log(format!("identity error: {e}"))).await;
            return;
        }
    };

    let autotune = AutotuneState::new(config.autotune.clone());
    let target_window = autotune.current_target();

    let mut log_fn = {
        let tx = evt_tx.clone();
        move |msg: String| {
            let _ = tx.try_send(P2pEvent::Log(msg));
        }
    };

    // Convert the non-Send Box<dyn Error> to String before any .await
    let endpoint_result = make_endpoint(
        config.bind_addr,
        target_window,
        &config.autotune,
        Some(&mut log_fn),
    )
    .map_err(|e| e.to_string());
    let (endpoint, _cert, stun_result) = match endpoint_result {
        Ok(r) => r,
        Err(msg) => {
            let _ = evt_tx.send(P2pEvent::Log(format!("bind error: {msg}"))).await;
            return;
        }
    };

    let local_addr = endpoint.local_addr().unwrap_or(config.bind_addr);
    let _ = evt_tx.send(P2pEvent::Bound(local_addr)).await;

    if let Ok(Some(pub_addr)) = stun_result {
        let _ = evt_tx.send(P2pEvent::PublicEndpoint(pub_addr)).await;
    }

    // Shared state: peer handles
    let peers: Arc<Mutex<HashMap<SocketAddr, PeerHandle>>> =
        Arc::new(Mutex::new(HashMap::new()));

    // Reconnect queue
    let mut reconnects: HashMap<SocketAddr, ReconnectEntry> = HashMap::new();

    // Channel for peer tasks to report back to node
    let (peer_evt_tx, mut peer_evt_rx) = mpsc::channel::<NodeEvent>(256);

    // Connect to initial peer if configured
    if let Some(peer_addr) = config.connect_to {
        let _ = evt_tx.send(P2pEvent::PeerConnecting(peer_addr)).await;
        spawn_outbound_connect(
            peer_addr,
            endpoint.clone(),
            config.clone(),
            identity.clone(),
            peers.clone(),
            peer_evt_tx.clone(),
            evt_tx.clone(),
        );
    }

    let reconnect_timer = tokio::time::sleep(Duration::from_secs(3600));
    tokio::pin!(reconnect_timer);

    loop {
        tokio::select! {
            // Accept incoming connections
            incoming = endpoint.accept() => {
                let Some(connecting) = incoming else { break };
                let config = config.clone();
                let identity = identity.clone();
                let peers = peers.clone();
                let peer_evt_tx = peer_evt_tx.clone();
                let evt_tx = evt_tx.clone();
                tokio::spawn(async move {
                    handle_incoming(
                        connecting,
                        config,
                        identity,
                        peers,
                        peer_evt_tx,
                        evt_tx,
                    ).await;
                });
            }

            // Events from peer tasks
            Some(ev) = peer_evt_rx.recv() => {
                match ev {
                    NodeEvent::PeerReady { peer, peer_id } => {
                        {
                            let mut map = peers.lock().await;
                            if let Some(h) = map.get_mut(&peer) {
                                h.peer_id = Some(peer_id.clone());
                                h.verified = true;
                            }
                        }
                        let _ = evt_tx.send(P2pEvent::PeerVerified { peer, peer_id }).await;
                        // Cancel reconnect backoff
                        reconnects.remove(&peer);
                    }
                    NodeEvent::PeerFailed { peer, reason } => {
                        peers.lock().await.remove(&peer);
                        let _ = evt_tx.send(P2pEvent::PeerAuthFailed { peer, reason }).await;
                    }
                    NodeEvent::PeerGone { peer, timed_out } => {
                        peers.lock().await.remove(&peer);
                        if timed_out {
                            let _ = evt_tx.send(P2pEvent::PeerTimeout(peer)).await;
                        } else {
                            let _ = evt_tx.send(P2pEvent::PeerDisconnected(peer)).await;
                        }
                        // Schedule reconnect if mobility enabled
                        if config.mobility.reconnect_enabled {
                            let entry = reconnects.entry(peer).or_insert_with(|| ReconnectEntry {
                                state: ReconnectState {
                                    peer,
                                    backoff: config.mobility.reconnect_initial,
                                    failures: 0,
                                },
                                retry_at: Instant::now(),
                            });
                            entry.state.bump_backoff(&config.mobility);
                            entry.retry_at = Instant::now() + entry.state.backoff;
                            let next = reconnects.values().map(|e| e.retry_at).min();
                            if let Some(t) = next {
                                let dur = t.saturating_duration_since(Instant::now());
                                reconnect_timer.as_mut().reset(tokio::time::Instant::now() + dur);
                            }
                        }
                    }
                    NodeEvent::Data { from, payload } => {
                        let _ = evt_tx.send(P2pEvent::DataReceived { from, payload }).await;
                    }
                    NodeEvent::ObservedEndpoint { addr } => {
                        let _ = evt_tx.send(P2pEvent::ObservedEndpoint(addr)).await;
                    }
                    NodeEvent::Log(msg) => {
                        let _ = evt_tx.send(P2pEvent::Log(msg)).await;
                    }
                    NodeEvent::ProbeResult { peer, ok, message } => {
                        let _ = evt_tx.send(P2pEvent::ProbeResult { peer, ok, message }).await;
                    }
                }
            }

            // Commands from user
            Some(cmd) = cmd_rx.recv() => {
                match cmd {
                    P2pCommand::ConnectPeer(addr) => {
                        let already = peers.lock().await.contains_key(&addr);
                        if !already {
                            let _ = evt_tx.send(P2pEvent::PeerConnecting(addr)).await;
                            spawn_outbound_connect(
                                addr,
                                endpoint.clone(),
                                config.clone(),
                                identity.clone(),
                                peers.clone(),
                                peer_evt_tx.clone(),
                                evt_tx.clone(),
                            );
                        }
                    }
                    P2pCommand::ProbePeer(addr) => {
                        let ep = endpoint.clone();
                        let timeout = config.connect_timeout;
                        let tx = peer_evt_tx.clone();
                        tokio::spawn(async move {
                            let result = crate::quic::quick_probe_peer(&ep, addr, timeout).await;
                            match result {
                                Ok(rtt) => {
                                    let _ = tx.send(NodeEvent::ProbeResult {
                                        peer: addr,
                                        ok: true,
                                        message: format!("rtt {}ms", rtt.as_millis()),
                                    }).await;
                                }
                                Err(msg) => {
                                    let _ = tx.send(NodeEvent::ProbeResult {
                                        peer: addr,
                                        ok: false,
                                        message: msg,
                                    }).await;
                                }
                            }
                        });
                    }
                    P2pCommand::Rebind(addr) => {
                        let _ = evt_tx.send(P2pEvent::Log(format!("rebind to {addr} not yet supported"))).await;
                    }
                    P2pCommand::SendData { to, payload } => {
                        let map = peers.lock().await;
                        if let Some(h) = map.get(&to) {
                            let _ = h.cmd_tx.send(PeerCmd::SendData(payload));
                        } else {
                            let _ = evt_tx.send(P2pEvent::Log(
                                format!("send_data: no peer {to}")
                            )).await;
                        }
                    }
                    P2pCommand::BroadcastData(payload) => {
                        let map = peers.lock().await;
                        for h in map.values() {
                            let _ = h.cmd_tx.send(PeerCmd::SendData(payload.clone()));
                        }
                    }
                    P2pCommand::Disconnect(addr) => {
                        let map = peers.lock().await;
                        if let Some(h) = map.get(&addr) {
                            let _ = h.cmd_tx.send(PeerCmd::Disconnect);
                        }
                    }
                    P2pCommand::Shutdown => {
                        endpoint.close(0u32.into(), b"shutdown");
                        break;
                    }
                }
            }

            // Reconnect timer
            _ = &mut reconnect_timer => {
                let now = Instant::now();
                let due: Vec<SocketAddr> = reconnects
                    .iter()
                    .filter(|(_, e)| e.retry_at <= now)
                    .map(|(a, _)| *a)
                    .collect();

                for addr in due {
                    let already = peers.lock().await.contains_key(&addr);
                    if !already {
                        let _ = evt_tx.send(P2pEvent::PeerConnecting(addr)).await;
                        spawn_outbound_connect(
                            addr,
                            endpoint.clone(),
                            config.clone(),
                            identity.clone(),
                            peers.clone(),
                            peer_evt_tx.clone(),
                            evt_tx.clone(),
                        );
                    }
                }

                // Reset timer to next due reconnect
                let next = reconnects.values().map(|e| e.retry_at).min();
                let dur = next
                    .map(|t| t.saturating_duration_since(now))
                    .unwrap_or(Duration::from_secs(3600));
                reconnect_timer.as_mut().reset(tokio::time::Instant::now() + dur);
            }
        }
    }
}

// ── Internal event channel (peer task → node task) ───────────────────────────

enum NodeEvent {
    PeerReady { peer: SocketAddr, peer_id: String },
    PeerFailed { peer: SocketAddr, reason: String },
    PeerGone { peer: SocketAddr, timed_out: bool },
    Data { from: SocketAddr, payload: Vec<u8> },
    ObservedEndpoint { addr: SocketAddr },
    Log(String),
    ProbeResult { peer: SocketAddr, ok: bool, message: String },
}

// ── Connection handling ───────────────────────────────────────────────────────

fn spawn_outbound_connect(
    addr: SocketAddr,
    endpoint: quinn::Endpoint,
    config: P2pConfig,
    identity: Arc<Identity>,
    peers: Arc<Mutex<HashMap<SocketAddr, PeerHandle>>>,
    node_tx: mpsc::Sender<NodeEvent>,
    evt_tx: mpsc::Sender<P2pEvent>,
) {
    tokio::spawn(async move {
        match connect_peer(&endpoint, addr, config.connect_timeout).await {
            Ok(conn) => {
                let _ = evt_tx.send(P2pEvent::PeerConnected(addr)).await;
                register_and_run_peer(
                    conn, addr, true, config, identity, peers, node_tx, evt_tx,
                ).await;
            }
            Err(e) => {
                let msg = format!("{e}");
                let _ = node_tx.send(NodeEvent::PeerGone { peer: addr, timed_out: false }).await;
                let _ = evt_tx.send(P2pEvent::Log(msg)).await;
            }
        }
    });
}

async fn handle_incoming(
    connecting: quinn::Incoming,
    config: P2pConfig,
    identity: Arc<Identity>,
    peers: Arc<Mutex<HashMap<SocketAddr, PeerHandle>>>,
    node_tx: mpsc::Sender<NodeEvent>,
    evt_tx: mpsc::Sender<P2pEvent>,
) {
    let peer_addr = connecting.remote_address();
    match connecting.await {
        Ok(conn) => {
            let _ = evt_tx.send(P2pEvent::PeerConnected(peer_addr)).await;
            register_and_run_peer(
                conn, peer_addr, false, config, identity, peers, node_tx, evt_tx,
            ).await;
        }
        Err(e) => {
            let _ = evt_tx.send(P2pEvent::Log(format!("incoming connection error: {e}"))).await;
        }
    }
}

async fn register_and_run_peer(
    conn: quinn::Connection,
    peer: SocketAddr,
    is_initiator: bool,
    config: P2pConfig,
    identity: Arc<Identity>,
    peers: Arc<Mutex<HashMap<SocketAddr, PeerHandle>>>,
    node_tx: mpsc::Sender<NodeEvent>,
    evt_tx: mpsc::Sender<P2pEvent>,
) {
    let (peer_cmd_tx, peer_cmd_rx) = mpsc::unbounded_channel::<PeerCmd>();
    {
        let mut map = peers.lock().await;
        map.insert(peer, PeerHandle {
            peer_id: None,
            verified: false,
            cmd_tx: peer_cmd_tx,
        });
    }
    tokio::spawn(run_peer(
        conn, peer, is_initiator, config, identity, node_tx, peer_cmd_rx,
    ));
    let _ = evt_tx; // kept for potential future use
}

// ── Per-peer task ─────────────────────────────────────────────────────────────

async fn run_peer(
    conn: quinn::Connection,
    peer: SocketAddr,
    is_initiator: bool,
    config: P2pConfig,
    identity: Arc<Identity>,
    node_tx: mpsc::Sender<NodeEvent>,
    mut cmd_rx: mpsc::UnboundedReceiver<PeerCmd>,
) {
    // ── Handshake ─────────────────────────────────────────────────────────────
    let handshake_result = tokio::time::timeout(
        config.handshake_timeout,
        do_handshake(&conn, is_initiator, &identity, &config),
    ).await;

    let peer_id = match handshake_result {
        Ok(Ok(pid)) => pid,
        Ok(Err(reason)) => {
            let _ = node_tx.send(NodeEvent::PeerFailed { peer, reason }).await;
            conn.close(0u32.into(), b"auth failed");
            return;
        }
        Err(_) => {
            let _ = node_tx.send(NodeEvent::PeerFailed {
                peer,
                reason: "handshake timeout".into(),
            }).await;
            conn.close(0u32.into(), b"handshake timeout");
            return;
        }
    };

    // Check whitelist
    if let Some(ref expected) = config.expected_peer_key {
        // peer_id is a fingerprint; for key comparison we'd need the raw pubkey.
        // Here we do a loose check: if the string is a full key, compare b64; otherwise compare fingerprint.
        if peer_id != *expected && !expected.is_empty() {
            let reason = format!("peer_id {peer_id} not in whitelist");
            let _ = node_tx.send(NodeEvent::PeerFailed { peer, reason }).await;
            conn.close(0u32.into(), b"not authorized");
            return;
        }
    }

    let _ = node_tx.send(NodeEvent::PeerReady { peer, peer_id }).await;

    // ── Main peer loop ────────────────────────────────────────────────────────
    let heartbeat_interval = config.heartbeat_interval;
    let max_misses = config.heartbeat_max_misses;
    let mut nonce: u64 = 0;
    let mut pending_pings: u32 = 0;
    let mut heartbeat = tokio::time::interval(heartbeat_interval);
    heartbeat.tick().await; // skip first immediate tick

    // Mobility: observe remote endpoint periodically
    let observe_interval = config.mobility.observe_interval;
    let mut observe_timer = tokio::time::interval(observe_interval);
    observe_timer.tick().await;

    // Channel to receive pong signals back from spawned stream tasks
    let (pong_tx, mut pong_rx) = mpsc::unbounded_channel::<u64>();

    loop {
        tokio::select! {
            // Accept incoming uni stream (control + data)
            stream = conn.accept_uni() => {
                match stream {
                    Ok(mut recv) => {
                        let node_tx2 = node_tx.clone();
                        let pong_tx2 = pong_tx.clone();
                        let peer_addr = peer;
                        let conn2 = conn.clone();
                        tokio::spawn(async move {
                            match read_message(&mut recv).await {
                                Ok(WireMessage::Pong { nonce }) => {
                                    let _ = pong_tx2.send(nonce);
                                }
                                Ok(WireMessage::Ping { nonce }) => {
                                    // Reply inline
                                    if let Ok(mut send) = conn2.open_uni().await {
                                        let _ = write_message(&mut send, &WireMessage::Pong { nonce }).await;
                                        let _ = send.finish();
                                    }
                                }
                                Ok(msg) => {
                                    handle_peer_message(msg, peer_addr, &conn2, &node_tx2).await;
                                }
                                Err(e) => {
                                    let _ = node_tx2.send(NodeEvent::Log(
                                        format!("read error from {peer_addr}: {e}")
                                    )).await;
                                }
                            }
                        });
                    }
                    Err(_) => {
                        // Connection closed
                        let _ = node_tx.send(NodeEvent::PeerGone { peer, timed_out: false }).await;
                        return;
                    }
                }
            }

            // Pong received — reset pending count
            Some(_) = pong_rx.recv() => {
                pending_pings = 0;
            }

            // Commands from node task (send data, disconnect)
            Some(cmd) = cmd_rx.recv() => {
                match cmd {
                    PeerCmd::SendData(payload) => {
                        let conn2 = conn.clone();
                        tokio::spawn(async move {
                            if let Ok(mut send) = conn2.open_uni().await {
                                let msg = WireMessage::UserData { payload };
                                let _ = write_message(&mut send, &msg).await;
                                let _ = send.finish();
                            }
                        });
                    }
                    PeerCmd::Disconnect => {
                        conn.close(0u32.into(), b"disconnect");
                        let _ = node_tx.send(NodeEvent::PeerGone { peer, timed_out: false }).await;
                        return;
                    }
                }
            }

            // Heartbeat tick
            _ = heartbeat.tick() => {
                if pending_pings >= max_misses {
                    conn.close(0u32.into(), b"timeout");
                    let _ = node_tx.send(NodeEvent::PeerGone { peer, timed_out: true }).await;
                    return;
                }
                nonce = nonce.wrapping_add(1);
                pending_pings += 1;
                let conn2 = conn.clone();
                let n = nonce;
                tokio::spawn(async move {
                    if let Ok(mut send) = conn2.open_uni().await {
                        let _ = write_message(&mut send, &WireMessage::Ping { nonce: n }).await;
                        let _ = send.finish();
                    }
                });
            }

            // Observe endpoint
            _ = observe_timer.tick() => {
                if config.mobility.enabled {
                    let observed = conn.remote_address();
                    let conn2 = conn.clone();
                    tokio::spawn(async move {
                        if let Ok(mut send) = conn2.open_uni().await {
                            let msg = WireMessage::ObservedEndpoint { addr: observed };
                            let _ = write_message(&mut send, &msg).await;
                            let _ = send.finish();
                        }
                    });
                }
            }
        }
    }
}

async fn handle_peer_message(
    msg: WireMessage,
    peer: SocketAddr,
    _conn: &quinn::Connection,
    node_tx: &mpsc::Sender<NodeEvent>,
) {
    match msg {
        WireMessage::UserData { payload } => {
            let _ = node_tx.send(NodeEvent::Data { from: peer, payload }).await;
        }
        WireMessage::ObservedEndpoint { addr } => {
            let _ = node_tx.send(NodeEvent::ObservedEndpoint { addr }).await;
        }
        other => {
            let _ = node_tx.send(NodeEvent::Log(
                format!("unexpected msg from {peer}: {other:?}")
            )).await;
        }
    }
}

// ── Handshake ─────────────────────────────────────────────────────────────────

/// Bidirectional handshake over a QUIC bidi stream.
///
/// Both sides:
/// 1. Open a bidi stream (or accept one, for the responder).
/// 2. Write Hello + IdentityInit.
/// 3. Read the peer's Hello + IdentityInit + IdentityAck.
/// 4. Write IdentityAck.
///
/// The initiator opens the stream; the responder accepts it.
async fn do_handshake(
    conn: &quinn::Connection,
    is_initiator: bool,
    identity: &Identity,
    _config: &P2pConfig,
) -> Result<String, String> {
    let rng = SystemRandom::new();
    let mut my_challenge = [0u8; 32];
    rng.fill(&mut my_challenge)
        .map_err(|_| "rng error".to_string())?;

    let my_pubkey = identity.public_key.to_vec();
    let my_label = Some(identity.peer_id.clone());

    if is_initiator {
        // Open bidi stream and drive the handshake
        let (mut send, mut recv) = conn
            .open_bi()
            .await
            .map_err(|e| format!("open_bi: {e}"))?;

        // Send Hello + IdentityInit
        write_message(&mut send, &WireMessage::Hello { version: PROTOCOL_VERSION })
            .await
            .map_err(|e| format!("write hello: {e}"))?;
        write_message(&mut send, &WireMessage::IdentityInit {
            version: PROTOCOL_VERSION,
            pubkey: my_pubkey.clone(),
            challenge: my_challenge,
            label: my_label,
        })
        .await
        .map_err(|e| format!("write identity_init: {e}"))?;

        // Read peer Hello + IdentityInit + IdentityAck
        let peer_init = read_peer_init(&mut recv).await?;
        let peer_pubkey = peer_init.pubkey;
        let peer_challenge = peer_init.challenge;

        let ack_msg = read_message(&mut recv)
            .await
            .map_err(|e| format!("read ack: {e}"))?;
        let peer_sig = match ack_msg {
            WireMessage::IdentityAck { signature, .. } => signature,
            other => return Err(format!("expected IdentityAck, got {other:?}")),
        };

        // Verify peer signed our challenge
        if !verify_signature(&peer_pubkey, &my_challenge, &peer_sig) {
            return Err("invalid signature from peer".into());
        }

        // Send our IdentityAck (sign peer's challenge)
        let my_sig = identity.sign_challenge(&peer_challenge);
        write_message(&mut send, &WireMessage::IdentityAck {
            pubkey: my_pubkey,
            signature: my_sig,
        })
        .await
        .map_err(|e| format!("write ack: {e}"))?;
        let _ = send.finish();

        let peer_id = fingerprint_peer_id(
            peer_pubkey[..32].try_into().map_err(|_| "bad pubkey length".to_string())?
        );
        Ok(peer_id)
    } else {
        // Accept bidi stream
        let (mut send, mut recv) = conn
            .accept_bi()
            .await
            .map_err(|e| format!("accept_bi: {e}"))?;

        // Read initiator's Hello + IdentityInit
        let peer_init = read_peer_init(&mut recv).await?;
        let peer_pubkey = peer_init.pubkey;
        let peer_challenge = peer_init.challenge;

        // Send Hello + IdentityInit + IdentityAck (sign peer's challenge)
        write_message(&mut send, &WireMessage::Hello { version: PROTOCOL_VERSION })
            .await
            .map_err(|e| format!("write hello: {e}"))?;
        write_message(&mut send, &WireMessage::IdentityInit {
            version: PROTOCOL_VERSION,
            pubkey: my_pubkey.clone(),
            challenge: my_challenge,
            label: my_label,
        })
        .await
        .map_err(|e| format!("write identity_init: {e}"))?;

        let my_sig = identity.sign_challenge(
            peer_challenge[..32].try_into().map_err(|_| "bad challenge length".to_string())?
        );
        write_message(&mut send, &WireMessage::IdentityAck {
            pubkey: my_pubkey,
            signature: my_sig,
        })
        .await
        .map_err(|e| format!("write ack: {e}"))?;

        // Read initiator's IdentityAck
        let ack_msg = read_message(&mut recv)
            .await
            .map_err(|e| format!("read ack: {e}"))?;
        let peer_sig = match ack_msg {
            WireMessage::IdentityAck { signature, .. } => signature,
            other => return Err(format!("expected IdentityAck, got {other:?}")),
        };

        let challenge_arr: &[u8; 32] = my_challenge[..32]
            .try_into()
            .map_err(|_| "bad challenge".to_string())?;
        if !verify_signature(&peer_pubkey, challenge_arr, &peer_sig) {
            return Err("invalid signature from initiator".into());
        }

        let _ = send.finish();

        let peer_id = fingerprint_peer_id(
            peer_pubkey[..32].try_into().map_err(|_| "bad pubkey length".to_string())?
        );
        Ok(peer_id)
    }
}

struct PeerInitMsg {
    pubkey: Vec<u8>,
    challenge: [u8; 32],
}

async fn read_peer_init(recv: &mut quinn::RecvStream) -> Result<PeerInitMsg, String> {
    let hello = read_message(recv).await.map_err(|e| format!("read hello: {e}"))?;
    match hello {
        WireMessage::Hello { .. } => {}
        other => return Err(format!("expected Hello, got {other:?}")),
    }
    let init = read_message(recv).await.map_err(|e| format!("read identity_init: {e}"))?;
    match init {
        WireMessage::IdentityInit { pubkey, challenge, .. } => {
            Ok(PeerInitMsg { pubkey, challenge })
        }
        other => Err(format!("expected IdentityInit, got {other:?}")),
    }
}
