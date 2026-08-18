//! Streams mixed broadcast PCM to the Electron shell over a Windows named pipe.
//!
//! Not stdio: audio is a continuous 1.5 Mbit/s of f32 samples and interleaving
//! it with the JSON control channel would add latency to both. Not a TCP socket
//! either, because binding one triggers a Windows Firewall prompt the first time
//! and looks alarming for an app that is otherwise all outbound.
//!
//! The renderer feeds these samples into an `AudioWorklet`, whose
//! `MediaStreamAudioDestinationNode` becomes an ordinary WebRTC audio track.

use std::sync::Arc;

use anyhow::Result;
use crossbeam_channel::Receiver;
use hollow_audio::PcmChunk;

/// Pipe name, unique per daemon instance so two Hollow windows never collide.
pub fn pipe_name() -> String {
    format!(r"\\.\pipe\hollow-audio-{}", std::process::id())
}

#[cfg(windows)]
pub fn serve(pcm: Receiver<PcmChunk>, shutdown: Arc<std::sync::atomic::AtomicBool>) -> Result<()> {
    use std::sync::atomic::Ordering;

    use tokio::io::AsyncWriteExt;
    use tokio::net::windows::named_pipe::ServerOptions;

    let name = pipe_name();
    tracing::info!("audio pipe listening at {name}");

    tokio::spawn(async move {
        // One client at a time: the shell. Loop so a renderer reload can
        // reconnect without restarting the daemon.
        while !shutdown.load(Ordering::Relaxed) {
            let server = match ServerOptions::new().first_pipe_instance(false).create(&name) {
                Ok(s) => s,
                Err(err) => {
                    tracing::error!("could not create audio pipe: {err}");
                    return;
                }
            };

            if let Err(err) = server.connect().await {
                tracing::warn!("audio pipe connect failed: {err}");
                continue;
            }
            tracing::info!("audio pipe client attached");

            let mut server = server;
            loop {
                if shutdown.load(Ordering::Relaxed) {
                    return;
                }
                // The capture thread is not async, so take the blocking recv
                // off the runtime's worker threads.
                let pcm = pcm.clone();
                let chunk =
                    match tokio::task::spawn_blocking(move || pcm.recv_timeout(RECV_TIMEOUT)).await
                    {
                        Ok(Ok(chunk)) => chunk,
                        // Timeout just means nothing is being captured yet.
                        Ok(Err(crossbeam_channel::RecvTimeoutError::Timeout)) => continue,
                        Ok(Err(crossbeam_channel::RecvTimeoutError::Disconnected)) => return,
                        Err(_) => return,
                    };

                // f32 little-endian, interleaved stereo. The worklet reads it
                // straight into a Float32Array with no conversion.
                let mut bytes = Vec::with_capacity(chunk.len() * 4);
                for sample in &chunk {
                    bytes.extend_from_slice(&sample.to_le_bytes());
                }

                if let Err(err) = server.write_all(&bytes).await {
                    tracing::info!("audio pipe client detached: {err}");
                    break;
                }
            }
        }
    });

    Ok(())
}

#[cfg(windows)]
const RECV_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(250);

#[cfg(not(windows))]
pub fn serve(_pcm: Receiver<PcmChunk>, _shutdown: Arc<std::sync::atomic::AtomicBool>) -> Result<()> {
    // Broadcast audio capture is Windows-only; nothing to stream.
    Ok(())
}
