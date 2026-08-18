//! Types shared between the Steam backends and the rest of Hollow.
//!
//! Everything here crosses the JSON boundary to the Electron UI, so 64-bit ids
//! are serialized as strings: a SteamID64 is around 1.76e16 and JavaScript
//! numbers lose integer precision past 2^53 (~9.0e15).

use std::fmt;

use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// A 64-bit Steam identifier (account, lobby or clan).
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Default)]
pub struct SteamId(pub u64);

impl SteamId {
    pub const fn raw(self) -> u64 {
        self.0
    }

    pub fn is_valid(self) -> bool {
        self.0 != 0
    }
}

impl fmt::Display for SteamId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl fmt::Debug for SteamId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "SteamId({})", self.0)
    }
}

impl From<u64> for SteamId {
    fn from(v: u64) -> Self {
        Self(v)
    }
}

impl std::str::FromStr for SteamId {
    type Err = std::num::ParseIntError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        s.parse::<u64>().map(SteamId)
    }
}

impl Serialize for SteamId {
    fn serialize<S: Serializer>(&self, ser: S) -> Result<S::Ok, S::Error> {
        ser.serialize_str(&self.0.to_string())
    }
}

impl<'de> Deserialize<'de> for SteamId {
    fn deserialize<D: Deserializer<'de>>(de: D) -> Result<Self, D::Error> {
        // Accept both the string form we emit and a bare number, so hand-written
        // config or test fixtures do not have to quote ids.
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Repr {
            Str(String),
            Num(u64),
        }

        match Repr::deserialize(de)? {
            Repr::Str(s) => s.parse::<u64>().map(SteamId).map_err(serde::de::Error::custom),
            Repr::Num(n) => Ok(SteamId(n)),
        }
    }
}

/// Steam's persona (online) state.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum PersonaState {
    #[default]
    Offline,
    Online,
    Busy,
    Away,
    Snooze,
    LookingToTrade,
    LookingToPlay,
}

impl PersonaState {
    pub fn is_online(self) -> bool {
        !matches!(self, PersonaState::Offline)
    }
}

/// A Steam user as Hollow presents them.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Peer {
    pub id: SteamId,
    /// Steam persona name. This is the user's identity in Hollow.
    pub persona: String,
    pub state: PersonaState,
    /// `data:image/png;base64,...` built from Steam's RGBA avatar buffer.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
    /// True when the friend is currently running Hollow.
    #[serde(default)]
    pub in_hollow: bool,
}

impl Peer {
    pub fn unknown(id: SteamId) -> Self {
        Self {
            id,
            persona: format!("User {id}"),
            state: PersonaState::Offline,
            avatar: None,
            in_hollow: false,
        }
    }
}

/// Live state a peer publishes to the room over the control channel.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Presence {
    pub mic_muted: bool,
    pub deafened: bool,
    pub camera_on: bool,
    pub sharing_screen: bool,
    /// Whether the shared screen carries an audio track.
    pub sharing_audio: bool,
}

/// A Hollow call, backed by a Steam lobby.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Room {
    pub id: SteamId,
    pub owner: SteamId,
    pub name: String,
    pub members: Vec<Peer>,
    pub max_members: u32,
}

/// One chat message on the wire.
///
/// A struct rather than a bare string so a later field — a reply target, an
/// attachment id — does not need a new channel and a version check.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ChatWire {
    pub text: String,
}

/// Logical channels multiplexed over Steam's peer-to-peer messaging.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(i32)]
pub enum Channel {
    /// WebRTC SDP and ICE. Reliable, ordered.
    Signaling = 0,
    /// Presence, mute state, reactions. Reliable.
    Control = 1,
    /// File transfer framing. Reliable.
    Files = 2,
    /// Room chat. Reliable and ordered, which is all a chat needs.
    ///
    /// Separate from `Control` rather than another shape on it: control
    /// payloads are identified by parsing them as presence and falling back,
    /// and adding a second shape to that guess is how a chat message ends up
    /// interpreted as a mute.
    Chat = 3,
}

impl Channel {
    pub fn from_raw(raw: i32) -> Option<Self> {
        match raw {
            0 => Some(Channel::Signaling),
            1 => Some(Channel::Control),
            2 => Some(Channel::Files),
            3 => Some(Channel::Chat),
            _ => None,
        }
    }
}
