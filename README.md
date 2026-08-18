# Hollow

Peer-to-peer calls, screen sharing and file transfer, connected through Steam.

Your Steam account is your identity. Your Steam friends list is your contact list. Media travels directly between machines — no Hollow server exists to route it through, because there isn't one.

---

## What it does

- **Group calls** — up to six people, full mesh, Opus audio with echo cancellation
- **Screen sharing with audio** — share a screen or a single window, and send what your machine is playing along with it
- **Per-application audio mixer** — choose exactly which apps are heard in your broadcast, with live meters and per-app volume
- **Steam-native** — identity, presence, friends, invites and lobbies all come from Steam; no accounts, no signup
- **File transfer** — send files to anyone in the call, chunked and flow-controlled
- **Room chat** — text alongside the call, on Steam's own channel; it lives in memory and is gone when the call ends
- **Serverless media** — WebRTC peer connections carry audio and video; nothing is stored or relayed by us

---

## How it fits together

```
┌──────────────────────────────────────────────┐
│  Electron shell                              │
│  • React UI                                  │
│  • WebRTC mesh: audio, camera, screen        │
│  • Screen capture via desktopCapturer        │
└───────────────┬──────────────────────────────┘
                │  JSON-RPC over stdio  ·  PCM over a named pipe
┌───────────────┴──────────────────────────────┐
│  hollow-core (Rust)                          │
│  • hollow-steam  — identity, lobbies, P2P    │
│  • hollow-audio  — WASAPI capture and mixing │
│  • file transfer with flow control           │
└──────────────────────────────────────────────┘
```

**Steam carries signaling, not media.** Lobby membership and WebRTC's SDP/ICE exchange ride Steam's authenticated peer channel, which already solves NAT traversal and falls back to Valve's relay network. Once peers have exchanged descriptions, audio and video negotiate their own direct path.

That split is deliberate: Steam gives us identity and a reliable control channel for free, and WebRTC gives us an encoder stack — congestion control, packet loss recovery, jitter buffering, echo cancellation — that would take years to reimplement.

---

## Audio: what works on which Windows

The per-application mixer has two modes, chosen automatically at startup. The app tells you which one it is using.

| Windows build | Mode | What muting an app does |
|---|---|---|
| **20348+** (Windows 11) | Per-process capture | Removes it from the broadcast only. You still hear it. |
| **Earlier** (incl. 10 22H2, build 19045) | System loopback | Changes the Windows session volume — so it also mutes locally. |

The API that captures a single process's audio (`ActivateAudioInterfaceAsync` with `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`) shipped in build 20348. There is no supported way to do it on earlier builds without installing an audio driver, so on those Hollow captures the whole endpoint and gives you the Windows volume mixer's own controls instead. The app list, icons and live meters work identically in both modes.

---

## Building

Windows only for now. The audio engine is built directly on WASAPI.

### Prerequisites

- Rust (stable) and Node 20+ to build
- **A running Steam client** to use it. That's the whole list.

There is no SDK to download and no environment variable to set. The `steamworks-sys` crate vendors the Steamworks SDK, and cargo emits Valve's redistributable `steam_api64.dll` next to the binary. Building is just:

```bash
cargo build --release
```

Hollow uses app id **480** (Spacewar, Valve's public test app), which gives working friends, lobbies and P2P between real Steam accounts. Override it with `HOLLOW_STEAM_APP_ID` if you register your own.

If Steam isn't running, Hollow starts anyway with placeholder peers and says so in the sidebar, so the interface can be worked on without it.

### Desktop app

```bash
cd desktop && npm install && npm run dev
```

`npm run dev` expects `hollow-core` in `target/release` or `target/debug`. To produce an installer:

```bash
cd desktop && npm run dist
```

---

## Known limits

- **Six participants.** Mesh means the person sharing their screen uploads one copy per viewer. Past six, a typical residential uplink cannot keep up, and there is no media server to fan out from.
- **Symmetric NAT needs TURN.** Steam gets the call set up regardless, but media negotiates independently and two peers behind strict NAT cannot find each other with STUN alone. Settings has a TURN field for that case; Hollow does not host one.
- **Per-process audio is untested.** It requires build 20348+, which the development machine does not run. The system-loopback path is the exercised one.
- **App id 480 is shared.** Spacewar is Valve's public test app, so lobbies live in the same pool as everyone else's experiments. Hollow stamps its lobbies and refuses to join anything unstamped, but registering your own app id is the real fix.

---

## Repository layout

| Path | What |
|---|---|
| `crates/hollow-core` | The daemon: RPC, orchestration, file transfer |
| `crates/hollow-steam` | Steam identity, lobbies, P2P messaging (real + mock) |
| `crates/hollow-audio` | WASAPI session enumeration, loopback capture, mixing |
| `crates/p2p-connection` | Standalone QUIC peer library — Hollow's original transport, kept as a reusable crate |
| `desktop` | Electron shell and React UI |

---

## License

MIT
