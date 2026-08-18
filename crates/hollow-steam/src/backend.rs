//! The backend contract every Steam implementation satisfies.
//!
//! Two implementations exist: [`crate::real`], which talks to the Steamworks
//! SDK, and [`crate::mock`], which fakes a small friends list so the UI can be
//! developed without Steam running.

use crate::types::{Channel, Peer, Presence, Room, SteamId};

/// A request from Hollow into Steam.
#[derive(Clone, Debug)]
pub enum SteamCommand {
    /// Re-read the friends list and push a `FriendsUpdated`.
    RefreshFriends,
    /// Create a lobby and become its owner.
    CreateRoom { name: String, max_members: u32 },
    /// Join an existing lobby by id.
    JoinRoom { id: SteamId },
    LeaveRoom,
    /// Open Steam's overlay invite dialog for the current lobby.
    OpenInviteOverlay,
    /// Send a direct lobby invite to a friend.
    InviteFriend { id: SteamId },
    /// Publish our own presence to the room.
    SetPresence(Presence),
    /// Deliver an application payload to one peer.
    Send {
        to: SteamId,
        channel: Channel,
        payload: Vec<u8>,
    },
    /// Deliver an application payload to every other member of the room.
    Broadcast { channel: Channel, payload: Vec<u8> },
    Shutdown,
}

/// Something that happened on the Steam side.
#[derive(Clone, Debug)]
pub enum SteamEvent {
    /// Emitted once the local user is known. Always the first event.
    Ready { me: Peer, backend: BackendKind },
    FriendsUpdated(Vec<Peer>),
    /// Room membership or metadata changed.
    RoomUpdated(Room),
    RoomLeft,
    /// A peer joined the current room.
    PeerJoined(Peer),
    PeerLeft(SteamId),
    /// A friend asked us to join their lobby (accepted via the Steam overlay).
    InviteReceived { from: Peer, room: SteamId },
    /// A peer published new presence.
    PresenceChanged { peer: SteamId, presence: Presence },
    /// Application payload received on a logical channel.
    Message {
        from: SteamId,
        channel: Channel,
        payload: Vec<u8>,
    },
    /// Non-fatal problem worth surfacing in the UI.
    Error(String),
    /// Transport detail worth writing down but not worth interrupting anyone
    /// over: session accepted, session restarted, relay came up. A call that
    /// fails quietly is only debuggable if this trail exists.
    Diagnostic(String),
}

/// Which implementation is live, so the UI can say so honestly.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BackendKind {
    /// Real Steamworks SDK.
    Steam,
    /// Fake peers, no networking. Development only.
    Mock,
}

/// Implemented by both backends. Driven from a single dedicated thread: the
/// Steamworks client is not thread-safe and its callbacks must be pumped
/// regularly, so `tick` is called on a fixed cadence.
pub trait SteamBackend: Send {
    fn kind(&self) -> BackendKind;

    fn me(&self) -> Peer;

    /// Apply one command. Errors are reported as `SteamEvent::Error` by the
    /// caller rather than aborting the loop.
    fn handle(&mut self, cmd: SteamCommand) -> anyhow::Result<()>;

    /// Pump callbacks and drain inbound messages. Called roughly every 8ms.
    fn tick(&mut self, out: &mut Vec<SteamEvent>);

    fn room(&self) -> Option<Room>;
}
