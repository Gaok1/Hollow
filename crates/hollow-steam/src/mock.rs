//! A backend that pretends Steam is there.
//!
//! Exists so the Electron UI can be built and run without the Steamworks SDK,
//! without the Steam client, and without a second machine. It fabricates a
//! friends list and lets you "create" a room that you are alone in.
//!
//! It does no networking: `Send`/`Broadcast` are dropped on the floor. Two
//! instances of Hollow running against the mock will not see each other. Use
//! `--features steam` for anything involving an actual second person.

use anyhow::Result;
use crossbeam_channel::{Receiver, Sender, unbounded};

use crate::backend::{BackendKind, SteamBackend, SteamCommand, SteamEvent};
use crate::types::{Peer, PersonaState, Room, SteamId};

/// Base for fake ids, chosen to look like a real SteamID64 so any place that
/// mishandles 64-bit precision breaks here too rather than only in production.
const FAKE_BASE: u64 = 76561197960287930;

pub struct MockBackend {
    me: Peer,
    friends: Vec<Peer>,
    room: Option<Room>,
    tx: Sender<SteamEvent>,
    rx: Receiver<SteamEvent>,
    emitted_ready: bool,
}

impl Default for MockBackend {
    fn default() -> Self {
        Self::new()
    }
}

impl MockBackend {
    pub fn new() -> Self {
        let (tx, rx) = unbounded();
        let me = Peer {
            id: SteamId(FAKE_BASE),
            persona: whoami_persona(),
            state: PersonaState::Online,
            avatar: None,
            in_hollow: true,
        };

        let friends = [
            ("Ravenholm", PersonaState::Online, true),
            ("nyx", PersonaState::Online, true),
            ("Duvet", PersonaState::Away, false),
            ("cassian_", PersonaState::Busy, false),
            ("m0th", PersonaState::Online, false),
            ("Pale Horse", PersonaState::Offline, false),
        ]
        .into_iter()
        .enumerate()
        .map(|(i, (name, state, in_hollow))| Peer {
            id: SteamId(FAKE_BASE + 1 + i as u64),
            persona: name.to_string(),
            state,
            avatar: None,
            in_hollow,
        })
        .collect();

        Self {
            me,
            friends,
            room: None,
            tx,
            rx,
            emitted_ready: false,
        }
    }
}

impl SteamBackend for MockBackend {
    fn kind(&self) -> BackendKind {
        BackendKind::Mock
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
                let _ = self
                    .tx
                    .send(SteamEvent::FriendsUpdated(self.friends.clone()));
            }
            SteamCommand::CreateRoom { name, max_members } => {
                let room = Room {
                    id: SteamId(FAKE_BASE + 9000),
                    owner: self.me.id,
                    name,
                    members: vec![self.me.clone()],
                    max_members,
                };
                self.room = Some(room.clone());
                let _ = self.tx.send(SteamEvent::RoomUpdated(room));
            }
            SteamCommand::JoinRoom { id } => {
                let room = Room {
                    id,
                    owner: id,
                    name: "Hollow".into(),
                    members: vec![self.me.clone()],
                    max_members: 6,
                };
                self.room = Some(room.clone());
                let _ = self.tx.send(SteamEvent::RoomUpdated(room));
            }
            SteamCommand::LeaveRoom | SteamCommand::Shutdown => {
                if self.room.take().is_some() {
                    let _ = self.tx.send(SteamEvent::RoomLeft);
                }
            }
            SteamCommand::InviteFriend { .. } | SteamCommand::OpenInviteOverlay => {
                let _ = self.tx.send(SteamEvent::Error(
                    "invites need the real Steam backend (build with --features steam)".into(),
                ));
            }
            // No transport, but the sender still has to learn what happened,
            // and "delivered to nobody" is the honest answer here.
            SteamCommand::Chat { id, .. } => {
                let _ = self.tx.send(SteamEvent::ChatDelivered {
                    id,
                    recipients: 0,
                    failed: Vec::new(),
                });
            }
            // No transport: nothing to send to, nothing to hear back.
            SteamCommand::SetPresence(_)
            | SteamCommand::Send { .. }
            | SteamCommand::Broadcast { .. } => {}
        }
        Ok(())
    }

    fn tick(&mut self, out: &mut Vec<SteamEvent>) {
        if !self.emitted_ready {
            self.emitted_ready = true;
            out.push(SteamEvent::Ready {
                me: self.me.clone(),
                backend: BackendKind::Mock,
            });
            out.push(SteamEvent::FriendsUpdated(self.friends.clone()));
        }
        while let Ok(evt) = self.rx.try_recv() {
            out.push(evt);
        }
    }
}

fn whoami_persona() -> String {
    std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .unwrap_or_else(|_| "Hollow Dev".into())
}
