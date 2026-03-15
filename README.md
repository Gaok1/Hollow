# Hollow

Peer-to-peer file transfer, directly in your terminal. No relay servers, no cloud — files go straight from your machine to theirs.

---

## Why Hollow

Most file transfer tools route your data through a third-party server. Hollow doesn't. The connection is established directly between peers, encrypted end-to-end with TLS over QUIC, and nothing leaves your machines except what you choose to send.

---

## Features

- **Serverless transfer** — no intermediaries, no cloud storage, your data stays between you and the recipient
- **QUIC + TLS** — encrypted transport with locally generated certificates; no PKI dependency
- **NAT traversal** — automatically detects your public IP via STUN so you can share a single address with the other side
- **Resumable transfers** — interrupted transfers pick up where they left off; large files survive dropped connections
- **Parallel streams** — multiple files sent simultaneously over concurrent QUIC streams
- **Saved profiles** — store frequent peers with a human-readable alias and their public key fingerprint
- **Cryptographic identity** — every instance generates a persistent Ed25519 keypair; verify who you're talking to before transferring anything
- **IPv4 and IPv6** — auto-detects the available address family and switches when connecting to a peer on a different one
- **LAN-aware** — falls back to local IP automatically when STUN is unreachable; works on isolated networks with no internet access
