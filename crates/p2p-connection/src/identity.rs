use std::io;
use std::path::{Path, PathBuf};

use base64::Engine;
use ring::{digest, rand::SystemRandom, signature};
use ring::signature::KeyPair;

/// Persistent peer identity (Ed25519 keypair).
///
/// - Generated on first use and persisted to disk.
/// - Used to sign challenges during the application-level handshake.
/// - `peer_id` is a stable fingerprint (SHA-256(pubkey) in hex, truncated to 16 bytes).
pub struct Identity {
    keypair: signature::Ed25519KeyPair,
    pub public_key: [u8; 32],
    pub peer_id: String,
}

impl Identity {
    pub fn load_or_generate(app_dir: &Path) -> io::Result<Self> {
        let path = app_dir.join("identity.ed25519.pkcs8");

        let keypair = match std::fs::read(&path) {
            Ok(bytes) => {
                signature::Ed25519KeyPair::from_pkcs8(&bytes).map_err(|_| {
                    io::Error::new(io::ErrorKind::InvalidData, "invalid pkcs8 key")
                })?
            }
            Err(err) if err.kind() == io::ErrorKind::NotFound => {
                if let Some(parent) = path.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                let rng = SystemRandom::new();
                let pkcs8 = signature::Ed25519KeyPair::generate_pkcs8(&rng)
                    .map_err(|_| io::Error::new(io::ErrorKind::Other, "failed to generate key"))?;

                std::fs::write(&path, pkcs8.as_ref())?;
                restrict_permissions(&path);

                signature::Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).map_err(|_| {
                    io::Error::new(io::ErrorKind::Other, "failed to load generated key")
                })?
            }
            Err(err) => return Err(err),
        };

        let pub_bytes = keypair.public_key().as_ref();
        let mut public_key = [0u8; 32];
        public_key.copy_from_slice(pub_bytes);

        let peer_id = fingerprint_peer_id(&public_key);

        Ok(Self { keypair, public_key, peer_id })
    }

    pub fn sign_challenge(&self, challenge: &[u8; 32]) -> Vec<u8> {
        self.keypair.sign(challenge).as_ref().to_vec()
    }

    pub fn public_key_b64(&self) -> String {
        base64::engine::general_purpose::STANDARD.encode(self.public_key)
    }
}

pub fn verify_signature(pubkey: &[u8], challenge: &[u8; 32], signature_bytes: &[u8]) -> bool {
    signature::UnparsedPublicKey::new(&signature::ED25519, pubkey)
        .verify(challenge, signature_bytes)
        .is_ok()
}

pub fn fingerprint_peer_id(public_key: &[u8; 32]) -> String {
    let hash = digest::digest(&digest::SHA256, public_key);
    let bytes = &hash.as_ref()[..16];
    to_hex(bytes)
}

pub fn default_app_dir() -> PathBuf {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")))
        .or_else(|| std::env::var_os("APPDATA").map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from(".p2p_connection"));

    base.join("p2p_connection")
}

fn to_hex(bytes: &[u8]) -> String {
    const LUT: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(LUT[(b >> 4) as usize] as char);
        out.push(LUT[(b & 0x0f) as usize] as char);
    }
    out
}

fn restrict_permissions(_path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(_path, std::fs::Permissions::from_mode(0o600));
    }
}
