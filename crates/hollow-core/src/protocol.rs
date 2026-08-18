//! The wire contract between `hollow-core` and the Electron shell.
//!
//! Newline-delimited JSON over stdio. Chosen over a localhost socket because it
//! needs no port, cannot be reached by anything else on the machine, and dies
//! with the parent process — there is no way to leave an orphaned daemon
//! listening for commands.
//!
//! Requests carry an `id` and get exactly one response. Events are unsolicited
//! and carry no id.

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Deserialize)]
pub struct Request {
    pub id: u64,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Serialize)]
pub struct Response {
    pub id: u64,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl Response {
    pub fn ok(id: u64, result: Value) -> Self {
        Self {
            id,
            ok: true,
            result: Some(result),
            error: None,
        }
    }

    pub fn err(id: u64, error: impl std::fmt::Display) -> Self {
        Self {
            id,
            ok: false,
            result: None,
            error: Some(error.to_string()),
        }
    }
}

/// Anything the daemon pushes without being asked.
#[derive(Debug, Serialize)]
pub struct Event {
    pub event: &'static str,
    pub data: Value,
}

impl Event {
    pub fn new(event: &'static str, data: Value) -> Self {
        Self { event, data }
    }
}

// Signaling payloads are relayed verbatim and never modelled here: WebRTC lives
// entirely in the renderer, and the daemon's only job is to get the bytes to the
// right SteamID. Keeping them opaque means SDP changes never require a daemon
// rebuild.

// ---------------------------------------------------------------------------
// File transfer framing (Steam `Files` channel)
// ---------------------------------------------------------------------------

/// Chunk size for file transfer.
///
/// Steam's reliable messages cap out around 512KB; 64KB keeps each send well
/// clear of that while amortising the per-message overhead, and bounds how much
/// is re-sent when a transfer is interrupted.
pub const FILE_CHUNK: usize = 64 * 1024;

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "camelCase")]
pub enum FileFrame {
    /// Sender announces a file and waits for `Accept` or `Reject`.
    Offer {
        id: u64,
        name: String,
        size: u64,
    },
    Accept {
        id: u64,
        /// Byte offset to resume from; 0 for a fresh transfer.
        offset: u64,
    },
    Reject {
        id: u64,
        reason: String,
    },
    /// One chunk. `offset` is the position of the first byte.
    Chunk {
        id: u64,
        offset: u64,
        #[serde(with = "base64_bytes")]
        data: Vec<u8>,
    },
    /// Receiver confirms bytes written. Drives the sender's flow control.
    Ack {
        id: u64,
        offset: u64,
    },
    Done {
        id: u64,
    },
    Cancel {
        id: u64,
    },
}

/// How far ahead of the last acknowledgement the sender may run.
///
/// Steam buffers unacknowledged reliable messages in memory, so without a
/// window a large file would be queued in its entirety before the first byte
/// landed. 4MB keeps the pipe full without that.
pub const FILE_WINDOW: u64 = 64 * FILE_CHUNK as u64;

/// Chunks are base64 inside JSON. That costs a third more bytes than a binary
/// framing would, which is a fair trade for one message format across the whole
/// daemon; file transfer is not the throughput-critical path here, media is.
mod base64_bytes {
    use base64::Engine;
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(bytes: &[u8], ser: S) -> Result<S::Ok, S::Error> {
        ser.serialize_str(&base64::engine::general_purpose::STANDARD.encode(bytes))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(de: D) -> Result<Vec<u8>, D::Error> {
        let s = String::deserialize(de)?;
        base64::engine::general_purpose::STANDARD
            .decode(s)
            .map_err(serde::de::Error::custom)
    }
}
