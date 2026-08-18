//! Windows audio capture and per-application mixing for Hollow's broadcasts.
//!
//! # Two capture modes
//!
//! What Hollow can do here depends entirely on the Windows build:
//!
//! * **Build 20348 and later** (Windows 11, Server 2022) expose *process
//!   loopback* via `ActivateAudioInterfaceAsync`. Hollow opens one capture
//!   stream per selected application and mixes them itself. Muting an app in
//!   the mixer removes it from the broadcast and does not change what the local
//!   user hears. This is the mode people actually want.
//!
//! * **Earlier builds** (including Windows 10 22H2, build 19045) have no such
//!   API. Hollow captures the whole render endpoint with
//!   `AUDCLNT_STREAMFLAGS_LOOPBACK` and offers per-session volume through
//!   `ISimpleAudioVolume`. That still gives a working mixer UI, but the
//!   important caveat is that turning an app down turns it down *for the local
//!   user too* — it is the same control the Windows volume mixer exposes.
//!
//! [`Capabilities::detect`] reports which mode is live so the UI can say so
//! plainly rather than silently doing something different from what the user
//! expects.
//!
//! Everything here is Windows-only. On other platforms the crate still compiles
//! but every entry point reports [`AudioError::Unsupported`].

pub mod types;

#[cfg(windows)]
mod com;
#[cfg(windows)]
mod icon;
#[cfg(windows)]
mod capture;
#[cfg(windows)]
mod sessions;

pub mod mixer;

pub use mixer::{AudioEngine, PcmChunk};
pub use types::{
    AppAudioSession, AudioError, CaptureMode, Capabilities, MixerCommand, MixerSnapshot, TrackGain,
};

/// Sample rate every capture stream is converted to before mixing. WebRTC's
/// Opus encoder runs at 48kHz, so resampling anywhere else would be wasted work.
pub const SAMPLE_RATE: u32 = 48_000;

/// Broadcast audio is stereo; screen share with a mono downmix sounds wrong for
/// music and games.
pub const CHANNELS: u16 = 2;

/// Frames per delivered buffer (10ms at 48kHz), matching Opus' native frame
/// size so the encoder never has to re-chunk.
pub const FRAMES_PER_BUFFER: usize = 480;
