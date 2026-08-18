//! Newline-delimited JSON transport over stdio.

use std::sync::Arc;

use anyhow::Result;
use serde::Serialize;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Stdout};
use tokio::sync::Mutex;
use tokio::sync::mpsc;

use crate::protocol::{Event, Request, Response};

/// Writes framed JSON to stdout. Cheap to clone; every clone shares one lock so
/// concurrent writers cannot interleave halves of a line.
#[derive(Clone)]
pub struct Sink {
    out: Arc<Mutex<Stdout>>,
}

impl Sink {
    pub fn new() -> Self {
        Self {
            out: Arc::new(Mutex::new(tokio::io::stdout())),
        }
    }

    async fn write<T: Serialize>(&self, value: &T) -> Result<()> {
        let mut line = serde_json::to_vec(value)?;
        line.push(b'\n');
        let mut out = self.out.lock().await;
        out.write_all(&line).await?;
        // The shell is waiting on these interactively; buffering a response
        // until the next write would show up as UI lag.
        out.flush().await?;
        Ok(())
    }

    pub async fn respond(&self, response: Response) {
        if let Err(err) = self.write(&response).await {
            // stdout is the only channel we have; if it is gone, so are we.
            tracing::error!("failed writing response: {err}");
        }
    }

    pub async fn emit(&self, event: &'static str, data: serde_json::Value) {
        if let Err(err) = self.write(&Event::new(event, data)).await {
            tracing::error!("failed writing event {event}: {err}");
        }
    }

    /// Convenience for the common `{"message": "..."}` shape.
    pub async fn emit_error(&self, message: impl std::fmt::Display) {
        self.emit("error", serde_json::json!({ "message": message.to_string() }))
            .await;
    }
}

impl Default for Sink {
    fn default() -> Self {
        Self::new()
    }
}

/// Reads requests from stdin until EOF, forwarding them on the returned channel.
///
/// EOF means the Electron shell exited, which is the daemon's shutdown signal.
pub fn read_requests() -> mpsc::UnboundedReceiver<Request> {
    let (tx, rx) = mpsc::unbounded_channel();

    tokio::spawn(async move {
        let mut lines = BufReader::new(tokio::io::stdin()).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    match serde_json::from_str::<Request>(trimmed) {
                        Ok(req) => {
                            if tx.send(req).is_err() {
                                break;
                            }
                        }
                        Err(err) => {
                            tracing::warn!("ignoring malformed request: {err}");
                        }
                    }
                }
                Ok(None) => break,
                Err(err) => {
                    tracing::error!("stdin read failed: {err}");
                    break;
                }
            }
        }
        tracing::info!("stdin closed, shutting down");
    });

    rx
}
