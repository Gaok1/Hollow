//! The audio engine thread: captures, mixes, meters.
//!
//! Owns every WASAPI object, because COM apartments are per-thread and the
//! capture clients must not travel. Everything else talks to it over channels.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use crossbeam_channel::{Receiver, Sender, TrySendError, bounded, unbounded};

use crate::types::{CaptureMode, MixerCommand, MixerSnapshot, TrackGain};
use crate::{CHANNELS, FRAMES_PER_BUFFER, SAMPLE_RATE};

/// A block of interleaved stereo f32 at 48kHz, ready for the encoder.
pub type PcmChunk = Vec<f32>;

/// How often the session list and meters are refreshed. Fast enough that the
/// meters look live, slow enough that enumerating COM objects stays cheap.
const SNAPSHOT_INTERVAL: Duration = Duration::from_millis(100);

/// Audio is realtime: if the consumer stalls, dropping the oldest block is
/// correct and buffering is not. Sized to about 300ms.
const PCM_QUEUE: usize = 30;

pub struct AudioEngine {
    pub commands: Sender<MixerCommand>,
    pub snapshots: Receiver<MixerSnapshot>,
    pub pcm: Receiver<PcmChunk>,
    handle: Option<std::thread::JoinHandle<()>>,
}

impl AudioEngine {
    pub fn spawn() -> Self {
        let (cmd_tx, cmd_rx) = unbounded::<MixerCommand>();
        let (snap_tx, snap_rx) = unbounded::<MixerSnapshot>();
        let (pcm_tx, pcm_rx) = bounded::<PcmChunk>(PCM_QUEUE);

        let handle = std::thread::Builder::new()
            .name("hollow-audio".into())
            .spawn(move || run(cmd_rx, snap_tx, pcm_tx))
            .expect("spawn audio thread");

        Self {
            commands: cmd_tx,
            snapshots: snap_rx,
            pcm: pcm_rx,
            handle: Some(handle),
        }
    }

    pub fn send(&self, cmd: MixerCommand) {
        let _ = self.commands.send(cmd);
    }
}

impl Drop for AudioEngine {
    fn drop(&mut self) {
        // An explicit command rather than relying on the channel disconnecting:
        // callers are free to clone `commands`, and a surviving clone would
        // otherwise leave the join below waiting forever.
        let _ = self.commands.send(MixerCommand::Shutdown);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

/// Per-application gain state, keyed by pid.
#[derive(Default)]
struct Gains {
    tracks: HashMap<u32, TrackGain>,
    master: f32,
}

impl Gains {
    fn new() -> Self {
        Self {
            tracks: HashMap::new(),
            master: 1.0,
        }
    }

    fn for_pid(&self, pid: u32) -> f32 {
        match self.tracks.get(&pid) {
            Some(t) if t.muted => 0.0,
            Some(t) => t.gain,
            // Apps the user has not touched are not in the broadcast.
            None => 0.0,
        }
    }

    fn included(&self, pid: u32) -> bool {
        self.tracks.get(&pid).is_some_and(|t| !t.muted && t.gain > 0.0)
    }
}

#[cfg(windows)]
fn run(
    commands: Receiver<MixerCommand>,
    snapshots: Sender<MixerSnapshot>,
    pcm: Sender<PcmChunk>,
) {
    use crate::capture::{LoopbackStream, POLL};
    use crate::com::ComGuard;
    use crate::sessions::SessionHost;

    // COM must be initialised on this thread and stay alive for every object
    // created below.
    let _com = ComGuard::new();

    let mut host = match SessionHost::new() {
        Ok(h) => Some(h),
        Err(err) => {
            tracing::warn!("no audio session host: {err}");
            None
        }
    };

    let mut mode = CaptureMode::Off;
    let mut gains = Gains::new();
    // Keyed by pid; 0 is the whole-system stream.
    let mut streams: HashMap<u32, LoopbackStream> = HashMap::new();
    let mut scratch: Vec<f32> = Vec::with_capacity(8192);
    let mut mix: Vec<f32> = Vec::with_capacity(8192);
    let mut pending: Vec<f32> = Vec::with_capacity(8192);
    let mut master_peak = 0.0f32;
    let mut last_snapshot = Instant::now() - SNAPSHOT_INTERVAL;

    loop {
        let mut stop = false;
        loop {
            match commands.try_recv() {
                Ok(MixerCommand::Start { mode: requested }) => {
                    mode = requested;
                    streams.clear();
                    if mode == CaptureMode::SystemLoopback {
                        match LoopbackStream::system() {
                            Ok(s) => {
                                streams.insert(0, s);
                            }
                            Err(err) => tracing::error!("system loopback failed: {err}"),
                        }
                    }
                    // PerProcess streams are opened lazily as tracks arrive.
                }
                Ok(MixerCommand::Stop) => {
                    mode = CaptureMode::Off;
                    streams.clear();
                    pending.clear();
                }
                Ok(MixerCommand::Shutdown) => {
                    stop = true;
                    break;
                }
                Ok(MixerCommand::SetTracks { tracks }) => {
                    gains.tracks = tracks.into_iter().map(|t| (t.pid, t)).collect();

                    if mode == CaptureMode::PerProcess {
                        // Open a stream for each newly included app, close the rest.
                        streams.retain(|pid, _| *pid == 0 || gains.included(*pid));
                        for (pid, track) in &gains.tracks {
                            if track.muted || track.gain <= 0.0 || streams.contains_key(pid) {
                                continue;
                            }
                            match LoopbackStream::process(*pid, format!("pid {pid}")) {
                                Ok(s) => {
                                    streams.insert(*pid, s);
                                }
                                Err(err) => {
                                    tracing::warn!("process loopback for {pid} failed: {err}")
                                }
                            }
                        }
                    }
                }
                Ok(MixerCommand::SetMasterGain { gain }) => {
                    gains.master = gain.clamp(0.0, 2.0);
                }
                Ok(MixerCommand::SetSessionVolume { pid, volume, muted }) => {
                    if let Some(host) = host.as_ref() {
                        if let Err(err) = host.set_session_volume(pid, volume, muted) {
                            tracing::warn!("set session volume for {pid}: {err}");
                        }
                    }
                }
                Err(crossbeam_channel::TryRecvError::Empty) => break,
                Err(crossbeam_channel::TryRecvError::Disconnected) => {
                    stop = true;
                    break;
                }
            }
        }
        if stop {
            break;
        }

        // --- Capture and mix -------------------------------------------------
        if mode != CaptureMode::Off && !streams.is_empty() {
            mix.clear();
            let mut block_peak = 0.0f32;

            for (pid, stream) in streams.iter_mut() {
                scratch.clear();
                match stream.drain(&mut scratch) {
                    Ok(peak) => block_peak = block_peak.max(peak),
                    Err(err) => {
                        tracing::warn!("capture drain failed for {}: {err}", stream.label);
                        continue;
                    }
                }

                // In system-loopback mode the endpoint already carries every
                // app at its system volume, so the only gain left is master.
                let gain = if mode == CaptureMode::PerProcess {
                    gains.for_pid(*pid)
                } else {
                    1.0
                };
                if gain <= 0.0 {
                    continue;
                }

                if mix.len() < scratch.len() {
                    mix.resize(scratch.len(), 0.0);
                }
                for (dst, src) in mix.iter_mut().zip(scratch.iter()) {
                    *dst += src * gain;
                }
            }

            if !mix.is_empty() {
                let master = gains.master;
                for s in mix.iter_mut() {
                    // Soft clip rather than wrap: a mesh of apps summing past
                    // 1.0 is normal and hard clipping sounds like tearing.
                    let v = *s * master;
                    *s = v.clamp(-1.0, 1.0) * (1.0 - 0.25 * (v.abs() - 1.0).max(0.0));
                    master_peak = master_peak.max(s.abs());
                }
                pending.extend_from_slice(&mix);
            }

            // Emit fixed 10ms blocks so the encoder never re-chunks.
            let block = FRAMES_PER_BUFFER * CHANNELS as usize;
            while pending.len() >= block {
                let chunk: PcmChunk = pending.drain(..block).collect();
                match pcm.try_send(chunk) {
                    Ok(()) => {}
                    Err(TrySendError::Full(_)) => {
                        // Consumer is behind. Dropping is the right call for
                        // realtime audio; catching up would only add latency.
                        tracing::debug!("pcm queue full, dropping a block");
                    }
                    Err(TrySendError::Disconnected(_)) => return,
                }
            }
        }

        // --- Meters and session list ----------------------------------------
        if last_snapshot.elapsed() >= SNAPSHOT_INTERVAL {
            last_snapshot = Instant::now();

            if host.is_none() {
                host = SessionHost::new().ok();
            }
            let sessions = host
                .as_mut()
                .and_then(|h| h.enumerate(&|pid| gains.included(pid)).ok())
                .unwrap_or_default();

            let snapshot = MixerSnapshot {
                mode,
                sessions,
                master_peak,
                master_gain: gains.master,
            };
            master_peak *= 0.6; // decay so the meter falls back smoothly
            if snapshots.send(snapshot).is_err() {
                break;
            }
        }

        std::thread::sleep(POLL);
    }
}

#[cfg(not(windows))]
fn run(
    commands: Receiver<MixerCommand>,
    snapshots: Sender<MixerSnapshot>,
    _pcm: Sender<PcmChunk>,
) {
    // Audio capture is Windows-only. Keep answering so the UI shows an empty,
    // clearly-labelled mixer instead of hanging.
    while let Ok(cmd) = commands.recv() {
        if matches!(cmd, MixerCommand::Shutdown) {
            break;
        }
        let _ = snapshots.send(MixerSnapshot {
            mode: CaptureMode::Off,
            sessions: Vec::new(),
            master_peak: 0.0,
            master_gain: 1.0,
        });
    }
}

/// Duration one PCM chunk represents, for anyone pacing playback.
pub const CHUNK_DURATION: Duration =
    Duration::from_nanos((FRAMES_PER_BUFFER as u64 * 1_000_000_000) / SAMPLE_RATE as u64);
