//! Types crossing from the audio engine to the UI.

use serde::{Deserialize, Serialize};

#[derive(Debug, thiserror::Error)]
pub enum AudioError {
    #[error("audio capture is only implemented on Windows")]
    Unsupported,
    #[error("no default playback device")]
    NoDevice,
    #[error("windows error: {0}")]
    Windows(String),
    #[error("{0}")]
    Other(String),
}

#[cfg(windows)]
impl From<windows::core::Error> for AudioError {
    fn from(e: windows::core::Error) -> Self {
        AudioError::Windows(e.message().to_string())
    }
}

/// Which capture strategy is in effect.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CaptureMode {
    /// One capture stream per selected process. Mixer changes affect only the
    /// broadcast. Requires Windows build 20348+.
    PerProcess,
    /// Whole-endpoint loopback. The mixer manipulates the system volume of each
    /// session, so changes are audible locally too.
    SystemLoopback,
    /// No screen audio is being captured.
    Off,
}

/// What this machine can actually do, resolved at runtime.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub windows_build: u32,
    /// True when `ActivateAudioInterfaceAsync` process loopback is available.
    pub per_process_capture: bool,
    /// Human-readable explanation for the UI, including why not.
    pub note: String,
}

impl Capabilities {
    /// The build where `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK` shipped.
    pub const PROCESS_LOOPBACK_BUILD: u32 = 20348;

    #[cfg(windows)]
    pub fn detect() -> Self {
        let build = crate::com::windows_build();
        let per_process = build >= Self::PROCESS_LOOPBACK_BUILD;
        let note = if per_process {
            format!(
                "Windows build {build}: capturing each app separately. Muting an app \
                 affects only the broadcast."
            )
        } else {
            format!(
                "Windows build {build}: per-app capture needs build {}+. Capturing system \
                 audio instead — the mixer changes system volume, so muting an app also \
                 mutes it for you.",
                Self::PROCESS_LOOPBACK_BUILD
            )
        };
        Self {
            windows_build: build,
            per_process_capture: per_process,
            note,
        }
    }

    #[cfg(not(windows))]
    pub fn detect() -> Self {
        Self {
            windows_build: 0,
            per_process_capture: false,
            note: "Audio capture is implemented for Windows only.".into(),
        }
    }
}

/// One application currently holding an audio session on the render endpoint.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppAudioSession {
    /// Stable across a run; derived from Windows' session identifier.
    pub id: String,
    pub pid: u32,
    /// Friendly name, falling back to the executable stem.
    pub name: String,
    /// Executable path, useful as a tooltip.
    pub executable: Option<String>,
    /// `data:image/png;base64,...` extracted from the executable, if available.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    /// Current peak level, 0.0 to 1.0, for the meter.
    pub peak: f32,
    /// Session volume, 0.0 to 1.0.
    pub volume: f32,
    pub muted: bool,
    /// True while the session is actually rendering audio.
    pub active: bool,
    /// Whether this app is included in the outgoing broadcast.
    pub broadcast: bool,
}

/// Per-application gain applied to the broadcast mix.
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackGain {
    pub pid: u32,
    /// Linear gain, 0.0 to 1.0. Applied to the broadcast only in `PerProcess`
    /// mode; in `SystemLoopback` mode it is written to the session volume.
    pub gain: f32,
    pub muted: bool,
}

/// Requests into the audio engine.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum MixerCommand {
    /// Begin capturing broadcast audio.
    Start { mode: CaptureMode },
    Stop,
    /// Replace the set of applications included in the broadcast.
    SetTracks { tracks: Vec<TrackGain> },
    /// Master gain over the whole broadcast mix.
    SetMasterGain { gain: f32 },
    /// Tear the engine down and end its thread.
    Shutdown,
}

/// Periodic state pushed to the UI to drive meters.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MixerSnapshot {
    pub mode: CaptureMode,
    pub sessions: Vec<AppAudioSession>,
    /// Peak of the mixed broadcast, 0.0 to 1.0.
    pub master_peak: f32,
    pub master_gain: f32,
}
