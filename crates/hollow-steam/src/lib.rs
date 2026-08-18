//! Steam as Hollow's connection layer.
//!
//! Steam supplies four things Hollow would otherwise have to build and host:
//! identity (a SteamID64 and persona name), presence (who is online and who is
//! in Hollow right now), rooms (lobbies), and an authenticated peer-to-peer
//! message channel that already handles NAT traversal, falling back to Valve's
//! relay network when a direct path is not available.
//!
//! That P2P channel carries WebRTC signaling, not media. Media goes over
//! WebRTC's own transport, negotiated through here.

pub mod avatar;
pub mod backend;
pub mod mock;
pub mod real;
pub mod service;
pub mod types;

pub use backend::{BackendKind, SteamBackend, SteamCommand, SteamEvent};
pub use service::{SteamService, build_backend};
pub use types::{Channel, Peer, PersonaState, Presence, Room, SteamId};

/// Valve's public test app id. Real friends, lobbies and P2P work against it,
/// so it is the default until Hollow ships under its own App ID.
pub const DEFAULT_APP_ID: u32 = 480;

/// Resolve the app id from `HOLLOW_STEAM_APP_ID`, falling back to Spacewar.
pub fn configured_app_id() -> u32 {
    std::env::var("HOLLOW_STEAM_APP_ID")
        .ok()
        .and_then(|v| v.trim().parse::<u32>().ok())
        .unwrap_or(DEFAULT_APP_ID)
}
