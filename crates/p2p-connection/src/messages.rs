use std::io;
use std::net::SocketAddr;

use bincode::Options;

fn bincode_opts() -> impl Options {
    bincode::DefaultOptions::new().with_fixint_encoding()
}

/// Wire protocol messages exchanged over QUIC streams.
///
/// Each message is framed with a 4-byte big-endian length prefix.
#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub enum WireMessage {
    /// Initial greeting — version negotiation.
    Hello { version: u8 },

    /// Application-level identity handshake (initiator → responder).
    ///
    /// - `pubkey`: Ed25519 public key (32 bytes)
    /// - `challenge`: random nonce to be signed by the remote peer
    /// - `label`: optional human-readable label (no security effect)
    IdentityInit {
        version: u8,
        pubkey: Vec<u8>,
        challenge: [u8; 32],
        label: Option<String>,
    },

    /// Identity handshake reply: signature over the received challenge.
    IdentityAck {
        pubkey: Vec<u8>,
        signature: Vec<u8>,
    },

    /// Heartbeat ping.
    Ping { nonce: u64 },

    /// Heartbeat pong — echoes the ping nonce.
    Pong { nonce: u64 },

    /// Informs the remote peer of their observed public endpoint.
    ObservedEndpoint { addr: SocketAddr },

    /// Generic user data payload.
    UserData { payload: Vec<u8> },
}

pub fn serialize_message(msg: &WireMessage) -> bincode::Result<Vec<u8>> {
    bincode_opts().serialize(msg)
}

pub fn deserialize_message(bytes: &[u8]) -> bincode::Result<WireMessage> {
    bincode_opts().deserialize(bytes)
}

/// Write a length-prefixed message to a QUIC send stream.
pub async fn write_message(
    send: &mut quinn::SendStream,
    msg: &WireMessage,
) -> io::Result<()> {
    let bytes = serialize_message(msg)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))?;
    let len = (bytes.len() as u32).to_be_bytes();
    send.write_all(&len).await?;
    send.write_all(&bytes).await?;
    Ok(())
}

/// Read a length-prefixed message from a QUIC receive stream.
pub async fn read_message(recv: &mut quinn::RecvStream) -> io::Result<WireMessage> {
    let mut len_buf = [0u8; 4];
    recv.read_exact(&mut len_buf).await
        .map_err(|e| io::Error::new(io::ErrorKind::UnexpectedEof, e.to_string()))?;
    let len = u32::from_be_bytes(len_buf) as usize;
    if len > 16 * 1024 * 1024 {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "message too large"));
    }
    let mut buf = vec![0u8; len];
    recv.read_exact(&mut buf).await
        .map_err(|e| io::Error::new(io::ErrorKind::UnexpectedEof, e.to_string()))?;
    deserialize_message(&buf)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))
}
