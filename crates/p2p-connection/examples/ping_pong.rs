/// Example: two nodes on loopback exchange messages.
///
/// Run with:
///   cargo run --example ping_pong -p p2p-connection
///
/// Expected output (order may vary):
///   [server] bound to 127.0.0.1:19000
///   [client] bound to 127.0.0.1:<port>
///   [client] PeerVerified: <peer_id>
///   [server] PeerVerified: <peer_id>
///   [server] received: hello from client
///   [client] received: hello from server
///   done.

use std::time::Duration;

use p2p_connection::{MobilityConfig, P2pConfig, P2pEvent, P2pNode};
use tokio::time::sleep;

#[tokio::main]
async fn main() {
    // Disable reconnect so the example terminates cleanly
    let no_reconnect = MobilityConfig {
        reconnect_enabled: false,
        ..MobilityConfig::default()
    };

    // ── Server node ───────────────────────────────────────────────────────────
    let server_cfg = P2pConfig {
        bind_addr: "127.0.0.1:19000".parse().unwrap(),
        mobility: no_reconnect.clone(),
        ..P2pConfig::default()
    };
    let (server, mut server_events) = P2pNode::start(server_cfg).await.unwrap();

    // Wait for the server to bind
    sleep(Duration::from_millis(100)).await;

    // ── Client node ───────────────────────────────────────────────────────────
    let client_cfg = P2pConfig {
        bind_addr: "127.0.0.1:0".parse().unwrap(),
        connect_to: Some("127.0.0.1:19000".parse().unwrap()),
        mobility: no_reconnect,
        ..P2pConfig::default()
    };
    let (client, mut client_events) = P2pNode::start(client_cfg).await.unwrap();

    let server_addr: std::net::SocketAddr = "127.0.0.1:19000".parse().unwrap();

    // ── Server event loop ─────────────────────────────────────────────────────
    let server_handle = tokio::spawn(async move {
        loop {
            match tokio::time::timeout(Duration::from_secs(10), server_events.recv()).await {
                Ok(Some(P2pEvent::Bound(addr))) => {
                    println!("[server] bound to {addr}");
                }
                Ok(Some(P2pEvent::PeerVerified { peer, peer_id })) => {
                    println!("[server] PeerVerified: {peer_id} ({peer})");
                    server.send_data(peer, b"hello from server".to_vec());
                }
                Ok(Some(P2pEvent::DataReceived { from, payload })) => {
                    println!(
                        "[server] received from {from}: {}",
                        String::from_utf8_lossy(&payload)
                    );
                    // Small delay so our outgoing message can be delivered
                    sleep(Duration::from_millis(200)).await;
                    server.shutdown();
                    return;
                }
                Ok(Some(P2pEvent::Log(_))) | Ok(Some(_)) => {}
                Ok(None) => break,
                Err(_) => {
                    eprintln!("[server] timeout");
                    break;
                }
            }
        }
    });

    // ── Client event loop ─────────────────────────────────────────────────────
    let client_handle = tokio::spawn(async move {
        loop {
            match tokio::time::timeout(Duration::from_secs(10), client_events.recv()).await {
                Ok(Some(P2pEvent::Bound(addr))) => {
                    println!("[client] bound to {addr}");
                }
                Ok(Some(P2pEvent::PeerVerified { peer, peer_id })) => {
                    println!("[client] PeerVerified: {peer_id} ({peer})");
                    client.send_data(server_addr, b"hello from client".to_vec());
                }
                Ok(Some(P2pEvent::DataReceived { from, payload })) => {
                    println!(
                        "[client] received from {from}: {}",
                        String::from_utf8_lossy(&payload)
                    );
                    sleep(Duration::from_millis(200)).await;
                    client.shutdown();
                    return;
                }
                Ok(Some(P2pEvent::Log(_))) | Ok(Some(_)) => {}
                Ok(None) => break,
                Err(_) => {
                    eprintln!("[client] timeout");
                    break;
                }
            }
        }
    });

    let _ = tokio::join!(server_handle, client_handle);
    println!("done.");
}
