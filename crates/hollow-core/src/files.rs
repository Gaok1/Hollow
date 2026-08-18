//! File transfer over Steam's reliable peer channel.
//!
//! Hollow began as a file transfer tool and keeps that ability, now riding the
//! same Steam session as everything else instead of its own QUIC endpoint. The
//! direct-QUIC implementation still lives in the `p2p-connection` crate for
//! anyone who wants transfers without Steam in the path.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow};
use hollow_steam::{Channel, SteamCommand, SteamId};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

use crate::protocol::{FILE_CHUNK, FILE_WINDOW, FileFrame};
use crate::rpc::Sink;

/// Outgoing transfer waiting for, or in the middle of, delivery.
struct Outgoing {
    peer: SteamId,
    path: PathBuf,
    size: u64,
    /// Highest offset the receiver has confirmed.
    acked: u64,
    /// How far the sender has pushed. Tracked separately from `acked` because
    /// the window lets sending run ahead of confirmation — conflating the two
    /// would re-send everything already in flight on every acknowledgement.
    sent: u64,
    cancelled: bool,
}

/// Incoming transfer being written to disk.
struct Incoming {
    peer: SteamId,
    /// Written to `<name>.part` and renamed on completion, so a partial file is
    /// never mistaken for a finished one.
    temp: PathBuf,
    final_path: PathBuf,
    file: tokio::fs::File,
    size: u64,
    received: u64,
}

#[derive(Default)]
pub struct FileTransfers {
    outgoing: HashMap<u64, Outgoing>,
    incoming: HashMap<u64, Incoming>,
    /// Offers announced to the UI and awaiting a decision: id -> (peer, name, size).
    pending: HashMap<u64, (SteamId, String, u64)>,
    next_id: u64,
    download_dir: PathBuf,
}

impl FileTransfers {
    pub fn new(download_dir: PathBuf) -> Self {
        Self {
            download_dir,
            next_id: 1,
            ..Default::default()
        }
    }

    pub fn download_dir(&self) -> &Path {
        &self.download_dir
    }

    /// Offer a set of files to a peer. Nothing moves until they accept.
    pub async fn offer(
        &mut self,
        steam: &crossbeam_channel::Sender<SteamCommand>,
        sink: &Sink,
        to: SteamId,
        paths: Vec<PathBuf>,
    ) -> Result<Vec<u64>> {
        let mut ids = Vec::with_capacity(paths.len());

        for path in paths {
            let meta = tokio::fs::metadata(&path)
                .await
                .with_context(|| format!("cannot stat {}", path.display()))?;
            if !meta.is_file() {
                continue;
            }

            let id = self.next_id;
            self.next_id += 1;
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| "file".into());

            send_frame(
                steam,
                to,
                &FileFrame::Offer {
                    id,
                    name: name.clone(),
                    size: meta.len(),
                },
            )?;

            self.outgoing.insert(
                id,
                Outgoing {
                    peer: to,
                    path: path.clone(),
                    size: meta.len(),
                    acked: 0,
                    sent: 0,
                    cancelled: false,
                },
            );
            ids.push(id);

            sink.emit(
                "file.offered",
                serde_json::json!({
                    "id": id, "to": to.to_string(), "name": name, "size": meta.len(),
                }),
            )
            .await;
        }

        Ok(ids)
    }

    /// Accept an offer we received.
    pub async fn accept(
        &mut self,
        steam: &crossbeam_channel::Sender<SteamCommand>,
        id: u64,
        from: SteamId,
        name: &str,
        size: u64,
    ) -> Result<()> {
        tokio::fs::create_dir_all(&self.download_dir).await.ok();

        let final_path = unique_path(&self.download_dir, name).await;
        let temp = final_path.with_extension(format!(
            "{}.part",
            final_path
                .extension()
                .map(|e| e.to_string_lossy().into_owned())
                .unwrap_or_default()
        ));

        let file = tokio::fs::File::create(&temp)
            .await
            .with_context(|| format!("cannot create {}", temp.display()))?;

        self.incoming.insert(
            id,
            Incoming {
                peer: from,
                temp,
                final_path,
                file,
                size,
                received: 0,
            },
        );

        send_frame(steam, from, &FileFrame::Accept { id, offset: 0 })
    }

    /// Accept an offer the UI previously surfaced.
    pub async fn accept_pending(
        &mut self,
        steam: &crossbeam_channel::Sender<SteamCommand>,
        id: u64,
    ) -> Result<()> {
        let (from, name, size) = self
            .pending
            .remove(&id)
            .ok_or_else(|| anyhow!("no pending offer {id}"))?;
        self.accept(steam, id, from, &name, size).await
    }

    /// Decline an offer the UI previously surfaced.
    pub fn reject_pending(
        &mut self,
        steam: &crossbeam_channel::Sender<SteamCommand>,
        id: u64,
    ) -> Result<()> {
        let (from, _, _) = self
            .pending
            .remove(&id)
            .ok_or_else(|| anyhow!("no pending offer {id}"))?;
        send_frame(
            steam,
            from,
            &FileFrame::Reject {
                id,
                reason: "declined".into(),
            },
        )
    }

    pub fn cancel(&mut self, steam: &crossbeam_channel::Sender<SteamCommand>, id: u64) {
        if let Some(out) = self.outgoing.get_mut(&id) {
            out.cancelled = true;
            let _ = send_frame(steam, out.peer, &FileFrame::Cancel { id });
        }
        if let Some(inc) = self.incoming.remove(&id) {
            let _ = send_frame(steam, inc.peer, &FileFrame::Cancel { id });
            let temp = inc.temp.clone();
            tokio::spawn(async move {
                let _ = tokio::fs::remove_file(temp).await;
            });
        }
    }

    /// Handle one inbound frame. Returns an offer for the UI to confirm, if any.
    pub async fn handle(
        &mut self,
        steam: &crossbeam_channel::Sender<SteamCommand>,
        sink: &Sink,
        from: SteamId,
        frame: FileFrame,
    ) -> Result<()> {
        match frame {
            FileFrame::Offer { id, name, size } => {
                // The UI decides; it calls back with files.accept or files.reject.
                self.pending.insert(id, (from, name.clone(), size));
                sink.emit(
                    "file.offer",
                    serde_json::json!({
                        "id": id, "from": from.to_string(), "name": name, "size": size,
                    }),
                )
                .await;
            }

            FileFrame::Accept { id, offset } => {
                let Some(out) = self.outgoing.get_mut(&id) else {
                    return Ok(());
                };
                // A non-zero offset is a resumed transfer: the receiver already
                // has that many bytes on disk.
                out.acked = offset;
                out.sent = offset;
                self.pump(steam, sink, id).await?;
            }

            FileFrame::Reject { id, reason } => {
                self.outgoing.remove(&id);
                sink.emit(
                    "file.rejected",
                    serde_json::json!({ "id": id, "reason": reason }),
                )
                .await;
            }

            FileFrame::Chunk { id, offset, data } => {
                let Some(inc) = self.incoming.get_mut(&id) else {
                    return Ok(());
                };
                if offset != inc.received {
                    // Steam's reliable channel is ordered, so a gap means the
                    // sender is confused rather than that packets reordered.
                    return Err(anyhow!(
                        "chunk for {id} arrived at {offset}, expected {}",
                        inc.received
                    ));
                }
                inc.file.write_all(&data).await?;
                inc.received += data.len() as u64;

                send_frame(
                    steam,
                    from,
                    &FileFrame::Ack {
                        id,
                        offset: inc.received,
                    },
                )?;

                sink.emit(
                    "file.progress",
                    serde_json::json!({
                        "id": id, "direction": "in",
                        "transferred": inc.received, "size": inc.size,
                    }),
                )
                .await;
            }

            FileFrame::Ack { id, offset } => {
                if let Some(out) = self.outgoing.get_mut(&id) {
                    out.acked = out.acked.max(offset);
                    self.pump(steam, sink, id).await?;
                }
            }

            FileFrame::Done { id } => {
                if let Some(mut inc) = self.incoming.remove(&id) {
                    inc.file.flush().await?;
                    drop(inc.file);
                    tokio::fs::rename(&inc.temp, &inc.final_path).await?;
                    sink.emit(
                        "file.done",
                        serde_json::json!({
                            "id": id, "direction": "in",
                            "path": inc.final_path.to_string_lossy(),
                        }),
                    )
                    .await;
                }
            }

            FileFrame::Cancel { id } => {
                self.outgoing.remove(&id);
                if let Some(inc) = self.incoming.remove(&id) {
                    let _ = tokio::fs::remove_file(&inc.temp).await;
                }
                sink.emit("file.cancelled", serde_json::json!({ "id": id }))
                    .await;
            }
        }
        Ok(())
    }

    /// Send whatever the flow-control window currently allows.
    ///
    /// Resumes from `sent`, never from `acked`: with a 64-chunk window there
    /// are up to 4MB in flight at any moment, and restarting from the last
    /// acknowledgement would re-send every one of them.
    async fn pump(
        &mut self,
        steam: &crossbeam_channel::Sender<SteamCommand>,
        sink: &Sink,
        id: u64,
    ) -> Result<()> {
        let Some(out) = self.outgoing.get(&id) else {
            return Ok(());
        };
        let (peer, path, size, acked, mut cursor) =
            (out.peer, out.path.clone(), out.size, out.acked, out.sent);

        let mut file = tokio::fs::File::open(&path).await?;
        file.seek(std::io::SeekFrom::Start(cursor)).await?;

        let mut buf = vec![0u8; FILE_CHUNK];
        while cursor < size && cursor.saturating_sub(acked) < FILE_WINDOW {
            if self.outgoing.get(&id).is_none_or(|o| o.cancelled) {
                return Ok(());
            }

            let read = file.read(&mut buf).await?;
            if read == 0 {
                break;
            }

            send_frame(
                steam,
                peer,
                &FileFrame::Chunk {
                    id,
                    offset: cursor,
                    data: buf[..read].to_vec(),
                },
            )?;
            cursor += read as u64;
            if let Some(out) = self.outgoing.get_mut(&id) {
                out.sent = cursor;
            }

            sink.emit(
                "file.progress",
                serde_json::json!({
                    "id": id, "direction": "out", "transferred": cursor, "size": size,
                }),
            )
            .await;
        }

        // Done only once the receiver has confirmed everything, not merely when
        // the last chunk has been handed to Steam.
        if acked >= size {
            send_frame(steam, peer, &FileFrame::Done { id })?;
            self.outgoing.remove(&id);
            sink.emit(
                "file.done",
                serde_json::json!({
                    "id": id, "direction": "out", "path": path.to_string_lossy(),
                }),
            )
            .await;
        }

        Ok(())
    }
}

fn send_frame(
    steam: &crossbeam_channel::Sender<SteamCommand>,
    to: SteamId,
    frame: &FileFrame,
) -> Result<()> {
    let payload = serde_json::to_vec(frame)?;
    steam
        .send(SteamCommand::Send {
            to,
            channel: Channel::Files,
            payload,
        })
        .map_err(|_| anyhow!("steam thread is gone"))
}

/// Pick a name that does not collide, appending ` (2)`, ` (3)` and so on.
async fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let candidate = dir.join(name);
    if tokio::fs::metadata(&candidate).await.is_err() {
        return candidate;
    }

    let stem = Path::new(name)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| name.to_string());
    let ext = Path::new(name)
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();

    for n in 2..1000 {
        let candidate = dir.join(format!("{stem} ({n}){ext}"));
        if tokio::fs::metadata(&candidate).await.is_err() {
            return candidate;
        }
    }
    dir.join(format!("{stem}-{}{ext}", std::process::id()))
}
