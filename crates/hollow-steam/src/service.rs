//! Runs a [`SteamBackend`] on its own thread and exposes channels.
//!
//! Steamworks is not thread-safe and its callbacks must be pumped on a steady
//! cadence, so the client is confined to one thread and everything else talks
//! to it through channels.

use std::thread::{self, JoinHandle};
use std::time::Duration;

use crossbeam_channel::{Receiver, Sender, unbounded};

use crate::backend::{BackendKind, SteamBackend, SteamCommand, SteamEvent};

/// Callback cadence. Steam's own guidance is at least every frame; 8ms keeps
/// signaling latency well under a video frame without spinning a core.
const TICK: Duration = Duration::from_millis(8);

pub struct SteamService {
    pub commands: Sender<SteamCommand>,
    pub events: Receiver<SteamEvent>,
    handle: Option<JoinHandle<()>>,
}

impl SteamService {
    /// Spawn the backend thread. The first event delivered is always
    /// [`SteamEvent::Ready`].
    pub fn spawn(mut backend: Box<dyn SteamBackend>) -> Self {
        let (cmd_tx, cmd_rx) = unbounded::<SteamCommand>();
        let (evt_tx, evt_rx) = unbounded::<SteamEvent>();

        let handle = thread::Builder::new()
            .name("hollow-steam".into())
            .spawn(move || {
                let _ = evt_tx.send(SteamEvent::Ready {
                    me: backend.me(),
                    backend: backend.kind(),
                });

                let mut out: Vec<SteamEvent> = Vec::with_capacity(32);
                'outer: loop {
                    // Drain every queued command before ticking so a burst of
                    // ICE candidates leaves in one batch.
                    loop {
                        match cmd_rx.try_recv() {
                            Ok(cmd) => {
                                let shutting_down = matches!(cmd, SteamCommand::Shutdown);
                                if let Err(err) = backend.handle(cmd) {
                                    let _ = evt_tx.send(SteamEvent::Error(err.to_string()));
                                }
                                if shutting_down {
                                    break 'outer;
                                }
                            }
                            Err(crossbeam_channel::TryRecvError::Empty) => break,
                            // Every sender is gone: nobody can drive us anymore.
                            Err(crossbeam_channel::TryRecvError::Disconnected) => break 'outer,
                        }
                    }

                    backend.tick(&mut out);
                    for evt in out.drain(..) {
                        // Skip the duplicate Ready the backend may emit itself.
                        if matches!(evt, SteamEvent::Ready { .. }) {
                            continue;
                        }
                        if evt_tx.send(evt).is_err() {
                            break 'outer;
                        }
                    }

                    thread::sleep(TICK);
                }
            })
            .expect("spawn steam thread");

        Self {
            commands: cmd_tx,
            events: evt_rx,
            handle: Some(handle),
        }
    }

    pub fn send(&self, cmd: SteamCommand) {
        let _ = self.commands.send(cmd);
    }
}

impl Drop for SteamService {
    fn drop(&mut self) {
        let _ = self.commands.send(SteamCommand::Shutdown);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

/// Connect to Steam, falling back to the mock backend when the Steam client is
/// not running.
///
/// The fallback is a runtime condition, not a build-time one: the Steamworks
/// SDK is vendored, so a Steam build is the only build there is. Returns a
/// human-readable note the UI shows so the state is never ambiguous.
pub fn build_backend(app_id: u32) -> (Box<dyn SteamBackend>, BackendKind, String) {
    match crate::real::SteamRealBackend::new(app_id) {
        Ok(backend) => (
            Box::new(backend),
            BackendKind::Steam,
            format!("Connected to Steam (app id {app_id})."),
        ),
        Err(err) => {
            tracing::warn!("Steam unavailable, falling back to the mock backend: {err}");
            (
                Box::new(crate::mock::MockBackend::new()),
                BackendKind::Mock,
                format!("{err} Hollow is running with placeholder peers until Steam is up."),
            )
        }
    }
}
