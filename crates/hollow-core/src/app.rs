//! Wires the RPC channel to Steam, the audio engine and file transfer.

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
use crate::protocol::{FileFrame, Request, Response};
use crate::rpc::Sink;

pub struct App {
    sink: Sink,
    steam: SteamService,
    audio: AudioEngine,
    files: FileTransfers,
    me: Peer,
    backend: BackendKind,
    backend_note: String,
    caps: Capabilities,
    app_id: u32,
    room: Option<Room>,
    presence: Presence,
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

        Ok(Self {
            sink,
            steam,
            audio,
            files: FileTransfers::new(downloads),
            me,
            backend: kind,
            backend_note: note,
            caps,
            app_id,
            room: None,
            presence: Presence::default(),
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

            other => Err(anyhow!("unknown method: {other}")),
        }
    }

    async fn on_steam(&mut self, evt: SteamEvent) -> Result<()> {
        match evt {
            SteamEvent::Ready { me, backend } => {
                self.me = me.clone();
                self.backend = backend;
                self.sink
                    .emit("identity", json!({ "me": me, "backend": backend }))
                    .await;
            }

            SteamEvent::FriendsUpdated(friends) => {
                self.sink.emit("friends", json!(friends)).await;
            }

            SteamEvent::RoomUpdated(room) => {
                self.room = Some(room.clone());
                self.sink.emit("room", json!(room)).await;
            }

            SteamEvent::RoomLeft => {
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

fn steam_id(params: &Value, key: &str) -> Result<SteamId> {
    let raw = params
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("expected `{key}` as a string SteamID64"))?;
    raw.parse::<SteamId>()
        .map_err(|_| anyhow!("`{key}` is not a valid SteamID64: {raw}"))
}

/// Where received files land: the user's Downloads folder, under `Hollow`.
fn download_dir() -> PathBuf {
    directories::UserDirs::new()
        .and_then(|d| d.download_dir().map(Path::to_path_buf))
        .unwrap_or_else(std::env::temp_dir)
        .join("Hollow")
}

use std::path::Path;
