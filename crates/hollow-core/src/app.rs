//! Wires the RPC channel to Steam, the audio engine, file transfer and servers.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use anyhow::{Context, Result, anyhow};
use hollow_audio::{AudioEngine, Capabilities, CaptureMode, MixerCommand, TrackGain};
use hollow_steam::{
    BackendKind, Channel, Peer, Presence, Room, SteamCommand, SteamEvent, SteamId, SteamService,
};
use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::files::FileTransfers;
use crate::protocol::{FileFrame, Request, Response, ServerFrame};
use crate::rpc::Sink;
use crate::servers::{Servers, newly_online, online_ids};
use crate::store::{Cursor, Store};

pub struct App {
    sink: Sink,
    steam: SteamService,
    audio: AudioEngine,
    files: FileTransfers,
    servers: Servers,
    me: Peer,
    backend: BackendKind,
    backend_note: String,
    caps: Capabilities,
    app_id: u32,
    room: Option<Room>,
    presence: Presence,
    /// The friends list as last seen, for enriching stored members with live
    /// avatars and online state.
    friends: Vec<Peer>,
    /// Who was online at the last friends update, so that the next one can tell
    /// who has just become reachable and therefore worth syncing with.
    online: HashSet<SteamId>,
    /// A server whose call we asked for but whose lobby Steam has not handed
    /// back yet. Announcing has to wait for the lobby id.
    pending_call: Option<String>,
    /// The server whose call we are currently in, if the room belongs to one.
    current_call: Option<String>,
    shutdown: Arc<AtomicBool>,
}

impl App {
    pub fn new(sink: Sink, app_id: u32) -> Result<Self> {
        let (backend, kind, note) = hollow_steam::build_backend(app_id);
        let me = backend.me();
        let steam = SteamService::spawn(backend);
        let audio = AudioEngine::spawn();
        let caps = Capabilities::detect();

        let downloads = download_dir();

        // A failure to open the database is fatal on purpose. Running on with
        // history silently disabled would look identical to a working app right
        // up to the moment someone closed it and lost the afternoon.
        let store = Store::open(&data_dir().join("hollow.db"))?;

        Ok(Self {
            sink,
            steam,
            audio,
            files: FileTransfers::new(downloads),
            servers: Servers::new(store, me.clone()),
            me,
            backend: kind,
            backend_note: note,
            caps,
            app_id,
            room: None,
            presence: Presence::default(),
            friends: Vec::new(),
            online: HashSet::new(),
            pending_call: None,
            current_call: None,
            shutdown: Arc::new(AtomicBool::new(false)),
        })
    }

    /// Drive everything until stdin closes.
    pub async fn run(mut self, mut requests: mpsc::UnboundedReceiver<Request>) -> Result<()> {
        // The Steam and audio threads use crossbeam channels; bridge them onto
        // the runtime so the main loop can select over everything at once.
        let mut steam_events = bridge(self.steam.events.clone());
        let mut mixer_events = bridge(self.audio.snapshots.clone());

        crate::pipe::serve(self.audio.pcm.clone(), Arc::clone(&self.shutdown))?;

        self.sink
            .emit(
                "ready",
                json!({
                    "me": self.me,
                    "backend": self.backend,
                    "backendNote": self.backend_note,
                    "appId": self.app_id,
                    "capabilities": self.caps,
                    "audioPipe": crate::pipe::pipe_name(),
                    "downloadDir": self.files.download_dir().to_string_lossy(),
                    "version": env!("CARGO_PKG_VERSION"),
                }),
            )
            .await;

        self.steam.send(SteamCommand::RefreshFriends);

        loop {
            tokio::select! {
                Some(req) = requests.recv() => {
                    let id = req.id;
                    match self.dispatch(&req.method, req.params).await {
                        Ok(result) => self.sink.respond(Response::ok(id, result)).await,
                        Err(err) => self.sink.respond(Response::err(id, err)).await,
                    }
                }

                Some(evt) = steam_events.recv() => {
                    if let Err(err) = self.on_steam(evt).await {
                        self.sink.emit_error(err).await;
                    }
                }

                Some(snapshot) = mixer_events.recv() => {
                    self.sink.emit("mixer", json!(snapshot)).await;
                }

                else => break,
            }
        }

        self.shutdown.store(true, Ordering::Relaxed);
        Ok(())
    }

    async fn dispatch(&mut self, method: &str, params: Value) -> Result<Value> {
        match method {
            "app.info" => Ok(json!({
                "me": self.me,
                "backend": self.backend,
                "backendNote": self.backend_note,
                "appId": self.app_id,
                "capabilities": self.caps,
                "audioPipe": crate::pipe::pipe_name(),
                "version": env!("CARGO_PKG_VERSION"),
                "room": self.room,
                // Which server the live call belongs to, if any. A renderer
                // reload mid-call has no other way to find out.
                "conversation": self.current_call,
            })),

            "friends.refresh" => {
                self.steam.send(SteamCommand::RefreshFriends);
                Ok(Value::Null)
            }

            "room.create" => {
                let name = params
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("Hollow")
                    .to_string();
                let max_members = params
                    .get("maxMembers")
                    .and_then(Value::as_u64)
                    .unwrap_or(6)
                    .clamp(2, 8) as u32;
                self.steam
                    .send(SteamCommand::CreateRoom { name, max_members });
                Ok(Value::Null)
            }

            "room.join" => {
                let id = steam_id(&params, "id")?;
                self.steam.send(SteamCommand::JoinRoom { id });
                Ok(Value::Null)
            }

            "room.leave" => {
                self.steam.send(SteamCommand::LeaveRoom);
                Ok(Value::Null)
            }

            "room.invite" => {
                let id = steam_id(&params, "id")?;
                self.steam.send(SteamCommand::InviteFriend { id });
                Ok(Value::Null)
            }

            "room.inviteOverlay" => {
                self.steam.send(SteamCommand::OpenInviteOverlay);
                Ok(Value::Null)
            }

            // WebRTC lives in the renderer; the daemon only routes bytes.
            "signal.send" => {
                let to = steam_id(&params, "to")?;
                let payload = params
                    .get("payload")
                    .cloned()
                    .ok_or_else(|| anyhow!("signal.send needs a payload"))?;
                self.steam.send(SteamCommand::Send {
                    to,
                    channel: Channel::Signaling,
                    payload: serde_json::to_vec(&payload)?,
                });
                Ok(Value::Null)
            }

            // Chat lives entirely in memory, here and in the UI: nothing is
            // written to disk on either side, and leaving the room drops it.
            "chat.send" => {
                let id = params
                    .get("id")
                    .and_then(Value::as_u64)
                    .ok_or_else(|| anyhow!("chat.send needs an id"))?;
                let text = params
                    .get("text")
                    .and_then(Value::as_str)
                    .ok_or_else(|| anyhow!("chat.send needs text"))?
                    .to_string();
                if text.is_empty() {
                    return Err(anyhow!("chat.send needs a non-empty message"));
                }
                self.steam.send(SteamCommand::Chat { id, text });
                Ok(Value::Null)
            }

            "presence.set" => {
                self.presence = serde_json::from_value(params)?;
                self.steam
                    .send(SteamCommand::SetPresence(self.presence.clone()));
                Ok(Value::Null)
            }

            // --- audio ------------------------------------------------------
            "audio.start" => {
                // Honour what the hardware can actually do rather than what the
                // UI asked for; the UI already knows from `capabilities`.
                let mode = if self.caps.per_process_capture {
                    CaptureMode::PerProcess
                } else {
                    CaptureMode::SystemLoopback
                };
                self.audio.send(MixerCommand::Start { mode });
                Ok(json!({ "mode": mode }))
            }

            "audio.stop" => {
                self.audio.send(MixerCommand::Stop);
                Ok(Value::Null)
            }

            "audio.tracks" => {
                let tracks: Vec<TrackGain> =
                    serde_json::from_value(params.get("tracks").cloned().unwrap_or(json!([])))?;
                self.audio.send(MixerCommand::SetTracks { tracks });
                Ok(Value::Null)
            }

            "audio.master" => {
                let gain = params
                    .get("gain")
                    .and_then(Value::as_f64)
                    .unwrap_or(1.0) as f32;
                self.audio.send(MixerCommand::SetMasterGain { gain });
                Ok(Value::Null)
            }

            // --- files ------------------------------------------------------
            "files.send" => {
                let to = steam_id(&params, "to")?;
                let paths: Vec<PathBuf> =
                    serde_json::from_value(params.get("paths").cloned().unwrap_or(json!([])))?;
                let ids = self
                    .files
                    .offer(&self.steam.commands, &self.sink, to, paths)
                    .await?;
                Ok(json!({ "ids": ids }))
            }

            "files.accept" => {
                let id = params
                    .get("id")
                    .and_then(Value::as_u64)
                    .ok_or_else(|| anyhow!("files.accept needs an id"))?;
                self.files.accept_pending(&self.steam.commands, id).await?;
                Ok(Value::Null)
            }

            "files.reject" => {
                let id = params
                    .get("id")
                    .and_then(Value::as_u64)
                    .ok_or_else(|| anyhow!("files.reject needs an id"))?;
                self.files.reject_pending(&self.steam.commands, id)?;
                Ok(Value::Null)
            }

            "files.cancel" => {
                let id = params
                    .get("id")
                    .and_then(Value::as_u64)
                    .ok_or_else(|| anyhow!("files.cancel needs an id"))?;
                self.files.cancel(&self.steam.commands, id);
                Ok(Value::Null)
            }

            // --- servers and direct messages --------------------------------
            "conv.list" => self.servers.list(&self.friends),

            "servers.create" => {
                let name = params
                    .get("name")
                    .and_then(Value::as_str)
                    .filter(|n| !n.trim().is_empty())
                    .unwrap_or("Hollow")
                    .trim()
                    .to_string();
                let id = self.servers.create(&name)?;
                self.refresh_allowed();
                Ok(json!({ "id": id }))
            }

            "servers.invite" => {
                let id = conversation_id(&params)?;
                let to = steam_id(&params, "to")?;
                self.servers.invite(&self.steam.commands, &id, to)?;
                Ok(Value::Null)
            }

            "servers.accept" => {
                let id = conversation_id(&params)?;
                self.servers
                    .accept_invite(&self.steam.commands, &self.sink, &id)
                    .await?;
                self.refresh_allowed();
                Ok(Value::Null)
            }

            "servers.decline" => {
                let id = conversation_id(&params)?;
                self.servers.decline_invite(&id)?;
                Ok(Value::Null)
            }

            "servers.leave" => {
                let id = conversation_id(&params)?;
                self.servers.leave(&self.steam.commands, &id)?;
                if self.current_call.as_deref() == Some(id.as_str()) {
                    self.current_call = None;
                }
                self.refresh_allowed();
                Ok(Value::Null)
            }

            "dm.open" => {
                let with = steam_id(&params, "with")?;
                // Prefer the live friend record: it carries the current persona,
                // which is what the conversation will be named after.
                let peer = self
                    .friends
                    .iter()
                    .find(|f| f.id == with)
                    .cloned()
                    .unwrap_or_else(|| Peer::unknown(with));
                let id = self.servers.open_dm(&peer)?;
                self.refresh_allowed();
                // Ask them for anything we missed while this was closed.
                let _ = self.servers.sync_with(&self.steam.commands, with);
                Ok(json!({ "id": id }))
            }

            "conv.history" => {
                let id = conversation_id(&params)?;
                let before = params
                    .get("before")
                    .filter(|c| !c.is_null())
                    .map(|c| serde_json::from_value::<Cursor>(c.clone()))
                    .transpose()
                    .context("`before` is not a history cursor")?;
                self.servers.history(&id, before)
            }

            "conv.send" => {
                let id = conversation_id(&params)?;
                let text = params
                    .get("text")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|t| !t.is_empty())
                    .ok_or_else(|| anyhow!("conv.send needs a non-empty message"))?
                    .to_string();
                let message = self
                    .servers
                    .post(&self.steam.commands, &self.sink, &id, &text)
                    .await?;
                Ok(json!(message))
            }

            "conv.markRead" => {
                let id = conversation_id(&params)?;
                let at = params
                    .get("at")
                    .and_then(Value::as_i64)
                    .unwrap_or_else(crate::store::now_ms);
                self.servers.mark_read(&id, at)?;
                Ok(Value::Null)
            }

            // Starting a server call is creating a lobby and telling the server
            // about it. The lobby id only exists once Steam answers, so the
            // announcement waits for `RoomUpdated`.
            "server.call.start" => {
                let id = conversation_id(&params)?;
                let name = params
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("Hollow")
                    .to_string();
                self.pending_call = Some(id);
                self.steam.send(SteamCommand::CreateRoom {
                    name,
                    max_members: 6,
                });
                Ok(Value::Null)
            }

            "server.call.join" => {
                let id = conversation_id(&params)?;
                let lobby = self
                    .servers
                    .call(&id)
                    .ok_or_else(|| anyhow!("there is no call running in that server"))?;
                self.current_call = Some(id);
                self.steam.send(SteamCommand::JoinRoom { id: lobby });
                Ok(Value::Null)
            }

            other => Err(anyhow!("unknown method: {other}")),
        }
    }

    async fn on_steam(&mut self, evt: SteamEvent) -> Result<()> {
        match evt {
            SteamEvent::Ready { me, backend } => {
                self.me = me.clone();
                self.servers.set_me(me.clone());
                self.backend = backend;
                // Open the gate to everyone we already share a server with, so
                // that history starts reconciling before anyone touches the UI.
                self.refresh_allowed();
                self.sink
                    .emit("identity", json!({ "me": me, "backend": backend }))
                    .await;
            }

            SteamEvent::FriendsUpdated(friends) => {
                // Someone becoming reachable is the only moment asking them for
                // the backlog can work, so the diff drives the sync.
                let arrived = newly_online(&self.online, &friends);
                self.online = online_ids(&friends);
                self.friends = friends.clone();
                self.refresh_allowed();

                for peer in arrived {
                    if let Err(err) = self.servers.sync_with(&self.steam.commands, peer) {
                        tracing::warn!("sync with {peer} failed: {err}");
                    }
                }

                self.sink.emit("friends", json!(friends)).await;
                self.emit_conversations().await;
            }

            SteamEvent::RoomUpdated(room) => {
                // The lobby we were waiting on to be able to tell a server where
                // its call is.
                if let Some(conversation) = self.pending_call.take() {
                    let _ =
                        self.servers
                            .announce_call(&self.steam.commands, &conversation, Some(room.id));
                    self.current_call = Some(conversation);
                    self.emit_conversations().await;
                } else if self.current_call.is_none() {
                    // Joined through a Steam invite rather than through the
                    // server list: the lobby may still belong to a server, and
                    // the chat panel needs to know which one.
                    self.current_call = self.servers.conversation_for_lobby(room.id);
                }

                self.room = Some(room.clone());
                self.sink
                    .emit(
                        "room",
                        json!({ "room": room, "conversation": self.current_call }),
                    )
                    .await;
            }

            SteamEvent::RoomLeft => {
                // Only the last one out turns the light off. Anyone else leaving
                // says nothing, because the call is still running for the people
                // still in it.
                let was_alone = self.room.as_ref().is_none_or(|r| r.members.len() <= 1);
                if let Some(conversation) = self.current_call.take() {
                    if was_alone {
                        let _ =
                            self.servers
                                .announce_call(&self.steam.commands, &conversation, None);
                    }
                    self.emit_conversations().await;
                }

                self.room = None;
                self.audio.send(MixerCommand::Stop);
                self.sink.emit("room", Value::Null).await;
            }

            SteamEvent::PeerJoined(peer) => {
                // Re-announce our state so the newcomer's tiles are correct
                // without waiting for the next toggle.
                self.steam
                    .send(SteamCommand::SetPresence(self.presence.clone()));
                self.sink.emit("peer.joined", json!(peer)).await;
            }

            SteamEvent::PeerLeft(id) => {
                self.sink
                    .emit("peer.left", json!({ "id": id.to_string() }))
                    .await;
            }

            SteamEvent::InviteReceived { from, room } => {
                self.sink
                    .emit(
                        "invite",
                        json!({ "from": from, "room": room.to_string() }),
                    )
                    .await;
            }

            SteamEvent::PresenceChanged { peer, presence } => {
                self.sink
                    .emit(
                        "presence",
                        json!({ "peer": peer.to_string(), "presence": presence }),
                    )
                    .await;
            }

            SteamEvent::Message {
                from,
                channel,
                payload,
            } => match channel {
                Channel::Signaling => {
                    let value: Value = serde_json::from_slice(&payload)
                        .context("signaling payload was not JSON")?;
                    self.sink
                        .emit(
                            "signal",
                            json!({ "from": from.to_string(), "payload": value }),
                        )
                        .await;
                }
                Channel::Files => {
                    let frame: FileFrame = serde_json::from_slice(&payload)
                        .context("file frame was not JSON")?;
                    self.files
                        .handle(&self.steam.commands, &self.sink, from, frame)
                        .await?;
                }
                Channel::Servers => {
                    let frame: ServerFrame = serde_json::from_slice(&payload)
                        .context("server frame was not JSON")?;
                    self.servers
                        .handle(&self.steam.commands, &self.sink, from, frame)
                        .await?;
                    // Membership may have moved, and the gate is what lets the
                    // people behind it reach us at all.
                    self.refresh_allowed();
                }
                // Presence arrives pre-parsed as PresenceChanged; anything else
                // on the control channel is not ours.
                Channel::Control => {}
                // Chat arrives pre-parsed as ChatReceived, for the same reason.
                Channel::Chat => {}
            },

            SteamEvent::ChatReceived { from, text } => {
                self.sink
                    .emit(
                        "chat",
                        json!({ "from": from.to_string(), "text": text }),
                    )
                    .await;
            }

            SteamEvent::ChatDelivered {
                id,
                recipients,
                failed,
            } => {
                self.sink
                    .emit(
                        "chat.delivery",
                        json!({
                            "id": id,
                            "recipients": recipients,
                            "failed": failed.iter().map(SteamId::to_string).collect::<Vec<_>>(),
                        }),
                    )
                    .await;
            }

            SteamEvent::Error(message) => {
                self.sink.emit_error(message).await;
            }

            SteamEvent::Diagnostic(message) => {
                self.sink
                    .emit("log", json!({ "source": "steam", "message": message }))
                    .await;
            }
        }
        Ok(())
    }
}

impl App {
    /// Tell Steam who may reach us while no call is running.
    ///
    /// Friends plus everyone we share a conversation with. Recomputed rather
    /// than accumulated, so unfriending someone or leaving the last server you
    /// shared actually closes the door again — see `SetAllowedPeers`.
    fn refresh_allowed(&self) {
        let mut allowed: HashSet<SteamId> = self.friends.iter().map(|f| f.id).collect();
        match self.servers.known_peers() {
            Ok(peers) => allowed.extend(peers),
            Err(err) => tracing::warn!("could not read known peers: {err}"),
        }
        allowed.remove(&self.me.id);
        self.steam
            .send(SteamCommand::SetAllowedPeers(allowed.into_iter().collect()));
    }

    /// Push the whole conversation list.
    ///
    /// Whole rather than incremental, in the same spirit as the friends list:
    /// unread counts, live call state and online members all move for reasons
    /// that have nothing to do with each other, and a handful of rows is far
    /// cheaper to re-send than to reconcile.
    async fn emit_conversations(&self) {
        match self.servers.list(&self.friends) {
            Ok(list) => self.sink.emit("conversations", list).await,
            Err(err) => tracing::warn!("could not list conversations: {err}"),
        }
    }
}

/// Forward a crossbeam receiver onto a tokio channel.
///
/// The producer threads are synchronous by necessity (COM apartments, Steam
/// callbacks), so a blocking task does the handoff.
fn bridge<T: Send + 'static>(rx: crossbeam_channel::Receiver<T>) -> mpsc::UnboundedReceiver<T> {
    let (tx, out) = mpsc::unbounded_channel();
    std::thread::spawn(move || {
        while let Ok(item) = rx.recv() {
            if tx.send(item).is_err() {
                break;
            }
        }
    });
    out
}

fn conversation_id(params: &Value) -> Result<String> {
    params
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .ok_or_else(|| anyhow!("expected `id` as a conversation id"))
}

fn steam_id(params: &Value, key: &str) -> Result<SteamId> {
    let raw = params
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("expected `{key}` as a string SteamID64"))?;
    raw.parse::<SteamId>()
        .map_err(|_| anyhow!("`{key}` is not a valid SteamID64: {raw}"))
}

/// Where Hollow keeps what has to outlive a session: the database, and nothing
/// else so far.
///
/// Roaming app data rather than beside the executable, so that an install for
/// all users, a portable copy and an upgrade all find the same history.
fn data_dir() -> PathBuf {
    directories::ProjectDirs::from("", "", "Hollow")
        .map(|d| d.data_dir().to_path_buf())
        .unwrap_or_else(|| std::env::temp_dir().join("Hollow"))
}

/// Where received files land: the user's Downloads folder, under `Hollow`.
fn download_dir() -> PathBuf {
    directories::UserDirs::new()
        .and_then(|d| d.download_dir().map(Path::to_path_buf))
        .unwrap_or_else(std::env::temp_dir)
        .join("Hollow")
}

use std::path::Path;
