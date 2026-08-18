//! Steamworks-backed implementation.
//!
//! Needs no SDK download and no environment variable: `steamworks-sys` vendors
//! the Steamworks SDK, including the redistributable `steam_api64.dll` that
//! cargo drops beside the executable. The only requirement on an end user's
//! machine is a running Steam client.
//!
//! Written against `steamworks` 0.13.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use anyhow::{Context, Result, anyhow};
use crossbeam_channel::{Receiver, Sender, unbounded};
use parking_lot::Mutex;
use steamworks::networking_types::{NetworkingIdentity, SendFlags};
use steamworks::{
    AppId, CallbackHandle, Client, FriendFlags, FriendState, GameLobbyJoinRequested, LobbyChatUpdate,
    LobbyDataUpdate, LobbyId, LobbyType,
};

use crate::avatar::rgba_to_data_url;
use crate::backend::{BackendKind, SteamBackend, SteamCommand, SteamEvent};
use crate::types::{ChatWire, Channel, Peer, PersonaState, Presence, Room, SteamId};

/// Valve's public test app. Real friends, lobbies and P2P all work against it,
/// which makes it the right default until Hollow ships under its own App ID.
pub const SPACEWAR_APP_ID: u32 = 480;

/// Lobby data key holding the room's display name.
const ROOM_NAME_KEY: &str = "hollow_room_name";
/// Lobby data key stamping the lobby as ours, so joining a stray Spacewar
/// lobby does not land the user in a stranger's game.
const ROOM_TAG_KEY: &str = "hollow";
const ROOM_TAG: &str = "1";

/// Mesh topology means the sharer uploads one copy of their screen per viewer,
/// so the ceiling is upload bandwidth, not Steam. Six is the point where a
/// typical home connection stops keeping up at 1080p.
pub const DEFAULT_MAX_MEMBERS: u32 = 6;

/// How many messages to pull off a channel per tick. Signaling bursts during a
/// join (an offer, an answer and a dozen ICE candidates per peer), so this is
/// sized to drain a full mesh join in one pass.
const RECV_BATCH: usize = 128;

/// Who may talk to us, in the only form the session-request callback can read.
///
/// That callback runs inside Steam's own dispatch, as a `'static` closure with
/// no path back to `&mut self`, so the lobby it has to check membership against
/// lives here instead.
#[derive(Default)]
struct Gate {
    /// The lobby we are in, if any.
    lobby: Option<u64>,
    /// Its members, as of the last reconciliation.
    members: HashSet<u64>,
}

/// Results that Steam callbacks produce but cannot act on directly: the
/// callbacks are `'static` closures with no access to `&mut self`, so they post
/// here and [`SteamRealBackend::tick`] applies them.
enum Internal {
    LobbyCreated { id: u64, name: String },
    LobbyJoined { id: u64 },
    LobbyChurn,
    Event(SteamEvent),
}

pub struct SteamRealBackend {
    client: Client,
    app_id: AppId,
    me: Peer,
    room: Option<Room>,
    /// The lobby and the members a P2P session request is checked against.
    /// Shared because Steam runs that callback itself, outside `&mut self`.
    gate: Arc<Mutex<Gate>>,
    tx: Sender<Internal>,
    rx: Receiver<Internal>,
    /// Registrations stay live only while their handle does. Dropping these
    /// silently unsubscribes: invites stop arriving and lobby membership stops
    /// updating, with no error anywhere to explain why.
    _callbacks: Vec<CallbackHandle>,
    friends_cache: Vec<Peer>,
    avatar_cache: HashMap<u64, String>,
    ticks: u64,
}

impl SteamRealBackend {
    /// Connect to the running Steam client.
    pub fn new(app_id: u32) -> Result<Self> {
        ensure_appid_file(app_id as u64);

        let client = Client::init_app(AppId(app_id))
            .map_err(|e| anyhow!("could not reach Steam: {e}. Is the Steam client running?"))?;

        // Valve's relay network is what carries P2P when the two peers cannot
        // reach each other directly, and it takes seconds to come up. Asking
        // for it at startup rather than on the first send means the first call
        // is not the one that waits for it — and waiting for it late is
        // indistinguishable, from the user's side, from a call that never
        // connects at all.
        client.networking_utils().init_relay_network_access();

        let (tx, rx) = unbounded();
        let gate: Arc<Mutex<Gate>> = Arc::new(Mutex::new(Gate::default()));

        let my_id = client.user().steam_id();
        let me = Peer {
            id: SteamId(my_id.raw()),
            persona: client.friends().name(),
            state: PersonaState::Online,
            avatar: None,
            in_hollow: true,
        };

        let mut backend = Self {
            client,
            app_id: AppId(app_id),
            me,
            room: None,
            gate,
            tx,
            rx,
            _callbacks: Vec::new(),
            friends_cache: Vec::new(),
            avatar_cache: HashMap::new(),
            ticks: 0,
        };

        backend.install_callbacks();
        backend.me.avatar = backend.avatar_for(my_id.raw());
        Ok(backend)
    }

    fn install_callbacks(&mut self) {
        // Only peers in our lobby may open a session with us. Without this any
        // Steam user could push signaling traffic at us.
        let gate = Arc::clone(&self.gate);
        let client = self.client.clone();
        let tx = self.tx.clone();
        self.client
            .networking_messages()
            .session_request_callback(move |req| {
                let Some(raw) = req.remote().steam_id().map(|s| s.raw()) else {
                    return;
                };

                // The cached set can be a beat behind: a peer that just joined
                // knocks before our own membership update lands. Refusing there
                // does not cost a retry, it costs the call — Steam marks the
                // session failed, and every later message to that peer needs it
                // rebuilt. So ask the lobby itself before saying no. This runs
                // on the Steam thread inside `run_callbacks`, which makes the
                // query a local lookup rather than a round trip.
                let (lobby, cached) = {
                    let g = gate.lock();
                    (g.lobby, g.members.contains(&raw))
                };
                let member = cached
                    || lobby.is_some_and(|id| {
                        client
                            .matchmaking()
                            .lobby_members(LobbyId::from_raw(id))
                            .iter()
                            .any(|s| s.raw() == raw)
                    });

                if member {
                    gate.lock().members.insert(raw);
                    req.accept();
                    let _ = tx.send(Internal::Event(SteamEvent::Diagnostic(format!(
                        "p2p: accepted session from {raw}"
                    ))));
                } else {
                    // Returning without accepting rejects the request.
                    let _ = tx.send(Internal::Event(SteamEvent::Diagnostic(format!(
                        "p2p: refused session from {raw}, not a member of this room"
                    ))));
                }
            });

        let tx = self.tx.clone();
        self.client
            .networking_messages()
            .session_failed_callback(move |info| {
                let who = info
                    .identity_remote()
                    .and_then(|i| i.steam_id())
                    .map(|s| s.raw().to_string())
                    .unwrap_or_else(|| "a peer".into());
                // Recoverable: every send carries AUTO_RESTART_BROKEN_SESSION,
                // so the next message rebuilds the session instead of failing
                // forever. Worth recording, not worth alarming anyone about.
                let _ = tx.send(Internal::Event(SteamEvent::Diagnostic(format!(
                    "p2p: session with {who} failed; the next message restarts it"
                ))));
            });

        // A friend's invite was accepted, ours or theirs.
        let tx = self.tx.clone();
        let invites = self
            .client
            .register_callback(move |req: GameLobbyJoinRequested| {
                let _ = tx.send(Internal::Event(SteamEvent::InviteReceived {
                    from: Peer::unknown(SteamId(req.friend_steam_id.raw())),
                    room: SteamId(req.lobby_steam_id.raw()),
                }));
            });

        // Membership churn. The callback cannot see which lobby is ours, so it
        // only wakes `tick` up; reconciliation does the real work.
        let tx = self.tx.clone();
        let churn = self
            .client
            .register_callback(move |_: LobbyChatUpdate| {
                let _ = tx.send(Internal::LobbyChurn);
            });

        // Lobby data changes do not raise LobbyChatUpdate, so without this the
        // room name would never reach anyone who joined before it was set.
        let tx = self.tx.clone();
        let data = self.client.register_callback(move |ev: LobbyDataUpdate| {
            if ev.success {
                let _ = tx.send(Internal::LobbyChurn);
            }
        });

        self._callbacks = vec![invites, churn, data];
    }

    fn avatar_for(&mut self, raw: u64) -> Option<String> {
        if let Some(cached) = self.avatar_cache.get(&raw) {
            return Some(cached.clone());
        }
        // Steam serves the image only once it has been downloaded; before then
        // this yields None and a later tick retries.
        let encoded = self
            .client
            .friends()
            .get_friend(steamworks::SteamId::from_raw(raw))
            .medium_avatar()
            .and_then(|rgba| rgba_to_data_url(&rgba, 64, 64).ok())?;
        self.avatar_cache.insert(raw, encoded.clone());
        Some(encoded)
    }

    fn peer_from_raw(&mut self, raw: u64) -> Peer {
        let friend = self
            .client
            .friends()
            .get_friend(steamworks::SteamId::from_raw(raw));
        let persona = friend.name();
        let state = map_state(friend.state());
        let in_hollow = friend
            .game_played()
            .is_some_and(|g| g.game.app_id() == self.app_id);
        drop(friend);

        Peer {
            id: SteamId(raw),
            persona: if persona.is_empty() {
                format!("User {raw}")
            } else {
                persona
            },
            state,
            avatar: self.avatar_for(raw),
            in_hollow,
        }
    }

    fn collect_friends(&mut self) -> Vec<Peer> {
        let raws: Vec<u64> = self
            .client
            .friends()
            .get_friends(FriendFlags::IMMEDIATE)
            .iter()
            .map(|f| f.id().raw())
            .collect();

        let mut peers: Vec<Peer> = raws.into_iter().map(|raw| self.peer_from_raw(raw)).collect();

        // Friends already in Hollow first, then online, then alphabetically.
        peers.sort_by(|a, b| {
            b.in_hollow
                .cmp(&a.in_hollow)
                .then(b.state.is_online().cmp(&a.state.is_online()))
                .then_with(|| a.persona.to_lowercase().cmp(&b.persona.to_lowercase()))
        });
        peers
    }

    fn reconcile_room(&mut self, out: &mut Vec<SteamEvent>) {
        let Some(current) = self.room.clone() else {
            return;
        };
        let lobby = LobbyId::from_raw(current.id.raw());

        let member_raws: Vec<u64> = self
            .client
            .matchmaking()
            .lobby_members(lobby)
            .iter()
            .map(|s| s.raw())
            .collect();

        if member_raws.is_empty() {
            // The lobby evaporated.
            self.room = None;
            *self.gate.lock() = Gate::default();
            out.push(SteamEvent::RoomLeft);
            return;
        }

        let known: HashSet<u64> = current.members.iter().map(|m| m.id.raw()).collect();
        let now: HashSet<u64> = member_raws.iter().copied().collect();

        let name = self
            .client
            .matchmaking()
            .lobby_data(lobby, ROOM_NAME_KEY)
            .unwrap_or_else(|| "Hollow".to_string());

        if known == now && name == current.name {
            return;
        }

        for raw in now.difference(&known) {
            let peer = self.peer_from_raw(*raw);
            out.push(SteamEvent::PeerJoined(peer));
        }
        for raw in known.difference(&now) {
            out.push(SteamEvent::PeerLeft(SteamId(*raw)));
        }

        *self.gate.lock() = Gate {
            lobby: Some(current.id.raw()),
            members: now,
        };

        let members: Vec<Peer> = member_raws.iter().map(|r| self.peer_from_raw(*r)).collect();
        let owner = self.client.matchmaking().lobby_owner(lobby).raw();

        let room = Room {
            id: current.id,
            owner: SteamId(owner),
            name,
            members,
            max_members: current.max_members,
        };
        self.room = Some(room.clone());
        out.push(SteamEvent::RoomUpdated(room));
    }

    /// Whether a peer is entitled to talk to us, which means: is it in our lobby.
    ///
    /// The cached set is what the session-request callback sees, and it only
    /// refreshes when membership churn is noticed. A joiner's very first offer
    /// can beat that notice — it learned the full member list the moment it
    /// entered, while our own update is still in flight. Dropping that offer
    /// costs a call that never connects and never says why, so ask Steam
    /// directly before rejecting anyone.
    fn is_room_member(&self, raw: u64) -> bool {
        let (lobby, cached) = {
            let g = self.gate.lock();
            (g.lobby, g.members.contains(&raw))
        };
        if cached {
            return true;
        }
        // The gate's lobby, not `self.room`: joining sets the former as soon as
        // we ask Steam and the latter only once Steam confirms. The offer we
        // are about to drop arrives inside exactly that gap.
        let Some(lobby) = lobby else {
            return false;
        };
        let member = self
            .client
            .matchmaking()
            .lobby_members(LobbyId::from_raw(lobby))
            .iter()
            .any(|s| s.raw() == raw);
        if member {
            self.gate.lock().members.insert(raw);
        }
        member
    }

    fn drain_channel(&mut self, channel: Channel, out: &mut Vec<SteamEvent>) {
        let messages = self
            .client
            .networking_messages()
            .receive_messages_on_channel(channel as u32, RECV_BATCH);

        for msg in messages {
            let Some(from) = msg.identity_peer().steam_id() else {
                continue;
            };
            let raw = from.raw();
            if !self.is_room_member(raw) {
                continue;
            }
            let payload = msg.data().to_vec();

            if channel == Channel::Chat {
                match serde_json::from_slice::<ChatWire>(&payload) {
                    Ok(wire) => out.push(SteamEvent::ChatReceived {
                        from: SteamId(raw),
                        text: wire.text,
                    }),
                    Err(err) => out.push(SteamEvent::Diagnostic(format!(
                        "chat: unreadable message from {raw} — {err}"
                    ))),
                }
                continue;
            }

            if channel == Channel::Control {
                if let Ok(presence) = serde_json::from_slice::<Presence>(&payload) {
                    out.push(SteamEvent::PresenceChanged {
                        peer: SteamId(raw),
                        presence,
                    });
                    continue;
                }
            }

            out.push(SteamEvent::Message {
                from: SteamId(raw),
                channel,
                payload,
            });
        }
    }

    /// Deliver one payload to one peer.
    ///
    /// `AUTO_RESTART_BROKEN_SESSION` is what keeps a call recoverable. Once a
    /// session has failed — and one fails routinely at join time, when a peer
    /// knocks a moment before we have seen them enter the lobby — every later
    /// send returns `NoConnection` until the session is explicitly closed and
    /// reopened. `steamworks` 0.13 exposes no `CloseSessionWithUser`, so
    /// without this flag the first stumble is permanent: the lobby still looks
    /// healthy, membership still updates, and not one byte of WebRTC signaling
    /// crosses again. That is a call where nobody can hear anybody and no video
    /// ever arrives, with nothing on screen to say why.
    fn send_to(&self, to: SteamId, channel: Channel, payload: &[u8]) -> Result<()> {
        self.client
            .networking_messages()
            .send_message_to_user(
                NetworkingIdentity::new_steam_id(steamworks::SteamId::from_raw(to.raw())),
                SendFlags::RELIABLE
                    | SendFlags::NO_NAGLE
                    | SendFlags::AUTO_RESTART_BROKEN_SESSION,
                payload,
                channel as u32,
            )
            .map_err(|e| anyhow!("send to {to} on {channel:?} failed: {e:?}"))
    }

    /// Send a lobby invite straight to a friend's Steam client.
    ///
    /// The safe wrapper only offers `activate_invite_dialog`, which renders in
    /// the Steam overlay — and the overlay is only injected into processes
    /// Steam itself launched. Hollow is a normal desktop app, so for most users
    /// that dialog would simply never appear. This flat-API call has no such
    /// dependency: the invite arrives as a Steam chat message either way.
    fn invite(&self, lobby: LobbyId, friend: SteamId) -> Result<()> {
        // SAFETY: the interface pointer comes from Steam's own accessor and is
        // valid while the client is initialised, which it is for as long as
        // `self.client` lives. Both ids are plain 64-bit values.
        let accepted = unsafe {
            let matchmaking = steamworks_sys::SteamAPI_SteamMatchmaking_v009();
            if matchmaking.is_null() {
                return Err(anyhow!("Steam matchmaking interface unavailable"));
            }
            steamworks_sys::SteamAPI_ISteamMatchmaking_InviteUserToLobby(
                matchmaking,
                lobby.raw(),
                friend.raw(),
            )
        };

        if accepted {
            Ok(())
        } else {
            Err(anyhow!("Steam refused the invite to {friend}"))
        }
    }
}

impl SteamBackend for SteamRealBackend {
    fn kind(&self) -> BackendKind {
        BackendKind::Steam
    }

    fn me(&self) -> Peer {
        self.me.clone()
    }

    fn room(&self) -> Option<Room> {
        self.room.clone()
    }

    fn handle(&mut self, cmd: SteamCommand) -> Result<()> {
        match cmd {
            SteamCommand::RefreshFriends => {
                let friends = self.collect_friends();
                self.friends_cache = friends.clone();
                let _ = self
                    .tx
                    .send(Internal::Event(SteamEvent::FriendsUpdated(friends)));
            }

            SteamCommand::CreateRoom { name, max_members } => {
                let tx = self.tx.clone();
                self.client.matchmaking().create_lobby(
                    LobbyType::FriendsOnly,
                    max_members,
                    move |result| match result {
                        Ok(lobby) => {
                            let _ = tx.send(Internal::LobbyCreated {
                                id: lobby.raw(),
                                name,
                            });
                        }
                        Err(e) => {
                            let _ = tx.send(Internal::Event(SteamEvent::Error(format!(
                                "could not create the room: {e}"
                            ))));
                        }
                    },
                );
            }

            SteamCommand::JoinRoom { id } => {
                // Open the gate on the lobby we are joining before Steam
                // confirms we are in it. The members already inside see us
                // arrive on their side first and knock immediately, and that
                // knock routinely beats our own join callback. Refusing it does
                // not cost a retry — it marks the session failed, which is what
                // turns a call into five people staring at silent tiles.
                self.gate.lock().lobby = Some(id.raw());

                let tx = self.tx.clone();
                let gate = Arc::clone(&self.gate);
                self.client
                    .matchmaking()
                    .join_lobby(LobbyId::from_raw(id.raw()), move |result| match result {
                        Ok(lobby) => {
                            let _ = tx.send(Internal::LobbyJoined { id: lobby.raw() });
                        }
                        Err(_) => {
                            *gate.lock() = Gate::default();
                            let _ = tx.send(Internal::Event(SteamEvent::Error(
                                "that room refused the connection".into(),
                            )));
                        }
                    });
            }

            SteamCommand::LeaveRoom => {
                if let Some(room) = self.room.take() {
                    self.client
                        .matchmaking()
                        .leave_lobby(LobbyId::from_raw(room.id.raw()));
                    *self.gate.lock() = Gate::default();
                    let _ = self.tx.send(Internal::Event(SteamEvent::RoomLeft));
                }
            }

            SteamCommand::OpenInviteOverlay => {
                let room = self.room.as_ref().context("not in a room")?;
                self.client
                    .friends()
                    .activate_invite_dialog(LobbyId::from_raw(room.id.raw()));
            }

            SteamCommand::InviteFriend { id } => {
                let room = self.room.as_ref().context("not in a room")?;
                self.invite(LobbyId::from_raw(room.id.raw()), id)?;
            }

            SteamCommand::SetPresence(presence) => {
                let payload = serde_json::to_vec(&presence)?;
                self.handle(SteamCommand::Broadcast {
                    channel: Channel::Control,
                    payload,
                })?;
            }

            SteamCommand::Send {
                to,
                channel,
                payload,
            } => self.send_to(to, channel, &payload)?,

            SteamCommand::Broadcast { channel, payload } => {
                let targets: Vec<SteamId> = self
                    .room
                    .as_ref()
                    .map(|r| {
                        r.members
                            .iter()
                            .map(|m| m.id)
                            .filter(|id| *id != self.me.id)
                            .collect()
                    })
                    .unwrap_or_default();
                for to in targets {
                    if let Err(e) = self.send_to(to, channel, &payload) {
                        tracing::warn!("broadcast to {to} failed: {e}");
                    }
                }
            }

            SteamCommand::Chat { id, text } => {
                let payload = serde_json::to_vec(&ChatWire { text })?;
                let targets: Vec<SteamId> = self
                    .room
                    .as_ref()
                    .map(|r| {
                        r.members
                            .iter()
                            .map(|m| m.id)
                            .filter(|id| *id != self.me.id)
                            .collect()
                    })
                    .unwrap_or_default();

                let mut failed = Vec::new();
                for to in &targets {
                    if let Err(err) = self.send_to(*to, Channel::Chat, &payload) {
                        let _ = self.tx.send(Internal::Event(SteamEvent::Diagnostic(format!(
                            "chat: send to {to} failed — {err}"
                        ))));
                        failed.push(*to);
                    }
                }

                let _ = self.tx.send(Internal::Event(SteamEvent::ChatDelivered {
                    id,
                    recipients: targets.len(),
                    failed,
                }));
            }

            SteamCommand::Shutdown => {
                if let Some(room) = self.room.take() {
                    self.client
                        .matchmaking()
                        .leave_lobby(LobbyId::from_raw(room.id.raw()));
                }
            }
        }
        Ok(())
    }

    fn tick(&mut self, out: &mut Vec<SteamEvent>) {
        self.client.run_callbacks();
        self.ticks += 1;

        while let Ok(msg) = self.rx.try_recv() {
            match msg {
                Internal::LobbyCreated { id, name } => {
                    let lobby = LobbyId::from_raw(id);
                    let matchmaking = self.client.matchmaking();
                    matchmaking.set_lobby_data(lobby, ROOM_NAME_KEY, &name);
                    matchmaking.set_lobby_data(lobby, ROOM_TAG_KEY, ROOM_TAG);

                    self.room = Some(Room {
                        id: SteamId(id),
                        owner: self.me.id,
                        name,
                        members: vec![self.me.clone()],
                        max_members: DEFAULT_MAX_MEMBERS,
                    });
                    *self.gate.lock() = Gate {
                        lobby: Some(id),
                        members: HashSet::from([self.me.id.raw()]),
                    };
                    if let Some(room) = self.room.clone() {
                        out.push(SteamEvent::RoomUpdated(room));
                    }
                }

                Internal::LobbyJoined { id } => {
                    let lobby = LobbyId::from_raw(id);
                    // Spacewar is a shared playground; without this stamp a
                    // stray invite could drop the user into an unrelated lobby.
                    if self
                        .client
                        .matchmaking()
                        .lobby_data(lobby, ROOM_TAG_KEY)
                        .as_deref()
                        != Some(ROOM_TAG)
                    {
                        self.client.matchmaking().leave_lobby(lobby);
                        *self.gate.lock() = Gate::default();
                        out.push(SteamEvent::Error(
                            "that lobby belongs to another app, not Hollow".into(),
                        ));
                        continue;
                    }

                    // Seeded empty so `reconcile_room` reports every existing
                    // member as a join, which is what the mesh needs to hear.
                    self.room = Some(Room {
                        id: SteamId(id),
                        owner: SteamId(0),
                        name: String::new(),
                        members: Vec::new(),
                        max_members: DEFAULT_MAX_MEMBERS,
                    });
                    // Open the gate before reconciling: the peers already in
                    // there knock the moment they see us arrive, and that knock
                    // can land before the first reconciliation does.
                    *self.gate.lock() = Gate {
                        lobby: Some(id),
                        members: HashSet::from([self.me.id.raw()]),
                    };
                    self.reconcile_room(out);
                }

                Internal::LobbyChurn => self.reconcile_room(out),
                Internal::Event(evt) => out.push(evt),
            }
        }

        for channel in [
            Channel::Signaling,
            Channel::Control,
            Channel::Files,
            Channel::Chat,
        ] {
            self.drain_channel(channel, out);
        }

        // Membership churn arrives as a callback, but the session-request
        // callback only ever sees the cached `allowed` set — so a peer that
        // knocks before that callback lands gets refused. Reconciling on a
        // short interval keeps the window down to tens of milliseconds; the
        // call is a local lookup in the Steam client and returns early when
        // nothing moved.
        if self.ticks % 8 == 0 {
            self.reconcile_room(out);
        }

        // Friend state and avatars settle asynchronously after startup, so poll
        // about twice a second rather than on every 8ms tick.
        if self.ticks % 64 == 0 {
            let friends = self.collect_friends();
            let changed = friends.len() != self.friends_cache.len()
                || friends.iter().zip(&self.friends_cache).any(|(a, b)| {
                    a.id != b.id
                        // Personas resolve after the ids do: a friend appears
                        // as "User 7656…" and gets their name a moment later.
                        // Without this the placeholder is what the sidebar
                        // keeps showing.
                        || a.persona != b.persona
                        || a.state != b.state
                        || a.in_hollow != b.in_hollow
                        || a.avatar != b.avatar
                });
            if changed {
                self.friends_cache = friends.clone();
                out.push(SteamEvent::FriendsUpdated(friends));
            }
            if self.me.avatar.is_none() {
                self.me.avatar = self.avatar_for(self.me.id.raw());
            }
        }
    }
}

fn map_state(state: FriendState) -> PersonaState {
    match state {
        FriendState::Offline | FriendState::Invisible => PersonaState::Offline,
        FriendState::Online => PersonaState::Online,
        FriendState::Busy => PersonaState::Busy,
        FriendState::Away => PersonaState::Away,
        FriendState::Snooze => PersonaState::Snooze,
        FriendState::LookingToTrade => PersonaState::LookingToTrade,
        FriendState::LookingToPlay => PersonaState::LookingToPlay,
    }
}

/// The SDK reads `steam_appid.txt` from the working directory when the process
/// was not launched by Steam — which is always, for Hollow. Written next to the
/// executable so a packaged install and a `cargo run` both work.
fn ensure_appid_file(app_id: u64) {
    let Some(exe_dir) = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
    else {
        return;
    };

    // Steam resolves the file relative to the working directory, not the
    // executable, so move there before writing it.
    let _ = std::env::set_current_dir(&exe_dir);

    let path = exe_dir.join("steam_appid.txt");
    let want = app_id.to_string();
    if std::fs::read_to_string(&path).unwrap_or_default().trim() != want {
        let _ = std::fs::write(&path, &want);
    }
}
