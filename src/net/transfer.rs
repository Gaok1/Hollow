use std::{
    collections::HashMap,
    io,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc::Sender,
    },
};

use quinn::{ReadError, RecvStream, VarInt};
use tokio::{
    fs::{File, OpenOptions},
    io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt, BufWriter},
    sync::mpsc as tokio_mpsc,
    task,
};

const TRANSFER_BUFFER_SIZE: usize = 4 * 1024 * 1024;
const PROGRESS_EMIT_BYTES: u64 = 1024 * 1024;
const PROGRESS_EMIT_INTERVAL: std::time::Duration = std::time::Duration::from_millis(100);
const JOURNAL_UPDATE_INTERVAL: std::time::Duration = std::time::Duration::from_secs(1);
const MAX_CONCURRENT_STREAMS: usize = 4;

use super::{
    NetCommand, NetEvent, OBSERVED_ENDPOINT_VERSION, PROTOCOL_VERSION, WireMessage,
    serialize_message,
};

use super::journal::{TransferDirection, TransferJournal};

const RESUME_WAIT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);

/// Representa um arquivo que está chegando do par.
pub(crate) struct IncomingTransfer {
    pub path: PathBuf,
    pub handle: tokio::task::JoinHandle<()>,
}

#[derive(Clone, Copy)]
pub(crate) enum SendOutcome {
    Completed,
    Canceled,
    Shutdown,
}

pub(crate) struct SendResult {
    pub outcome: SendOutcome,
    pub next_file_id: u64,
    pub pending_cmds: Vec<NetCommand>,
}

/// Processa mensagens recebidas pela rede, atualizando o estado e retornando
/// `true` se um novo par foi identificado.
pub(crate) async fn handle_incoming_message(
    connection: &quinn::Connection,
    message: WireMessage,
    from: SocketAddr,
    peer_addr: &mut Option<SocketAddr>,
    session_dir: &mut Option<PathBuf>,
    incoming: &mut HashMap<u64, IncomingTransfer>,
    public_endpoint: &mut Option<SocketAddr>,
    evt_tx: &Sender<NetEvent>,
) -> bool {
    let mut new_peer = false;
    if peer_addr.is_none() {
        *peer_addr = Some(from);
        new_peer = true;
    }

    match message {
        WireMessage::Hello { version } => {
            if session_dir.is_none() {
                if let Err(err) = ensure_session_dir(session_dir, evt_tx).await {
                    let _ = evt_tx.send(NetEvent::Log(format!("erro na sessao {err}")));
                }
            }
            if version >= OBSERVED_ENDPOINT_VERSION {
                let _ = send_message(
                    connection,
                    &WireMessage::ObservedEndpoint { addr: from },
                    evt_tx,
                )
                .await;
            }
        }
        WireMessage::ObservedEndpoint { addr } => {
            if *public_endpoint != Some(addr) {
                *public_endpoint = Some(addr);
                let _ = evt_tx.send(NetEvent::PublicEndpoint(addr));
            }
        }
        WireMessage::Punch { .. } => {
            let _ = send_message(
                connection,
                &WireMessage::Hello {
                    version: PROTOCOL_VERSION,
                },
                evt_tx,
            )
            .await;
        }
        WireMessage::Cancel { file_id } => {
            if let Some(entry) = incoming.remove(&file_id) {
                entry.handle.abort();
                let _ = evt_tx.send(NetEvent::ReceiveCanceled {
                    file_id,
                    path: entry.path,
                });
            }
        }
        WireMessage::ResumeQuery {
            file_id,
            name,
            size,
        } => match query_resume_offset(session_dir, file_id, &name, size, evt_tx).await {
            Ok(offset) => {
                let _ = send_message(
                    connection,
                    &WireMessage::ResumeAnswer {
                        file_id,
                        offset,
                        ok: true,
                        reason: None,
                    },
                    evt_tx,
                )
                .await;
            }
            Err(err) => {
                let _ = send_message(
                    connection,
                    &WireMessage::ResumeAnswer {
                        file_id,
                        offset: 0,
                        ok: false,
                        reason: Some(err.to_string()),
                    },
                    evt_tx,
                )
                .await;
            }
        },
        _ => {}
    }

    new_peer
}

pub(crate) async fn handle_incoming_stream(
    file_id: u64,
    name: String,
    size: u64,
    offset: u64,
    from: SocketAddr,
    mut stream: RecvStream,
    session_dir: &mut Option<PathBuf>,
    incoming: &mut HashMap<u64, IncomingTransfer>,
    evt_tx: &Sender<NetEvent>,
    completion_tx: tokio_mpsc::UnboundedSender<u64>,
) -> io::Result<()> {
    let dir = ensure_session_dir(session_dir, evt_tx).await?;
    let safe_name = sanitize_file_name(&name);
    let path = incoming_part_path(&dir, file_id, &safe_name);
    let mut file = OpenOptions::new()
        .create(true)
        .write(true)
        .read(true)
        .open(&path)
        .await?;

    let current_len = file.metadata().await?.len();
    if current_len > offset {
        file.set_len(offset).await?;
    } else if current_len < offset {
        let _ = evt_tx.send(NetEvent::ReceiveFailed {
            file_id,
            path: path.clone(),
        });
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("offset remoto {offset} maior que parcial local {current_len}"),
        ));
    }
    file.seek(std::io::SeekFrom::Start(offset)).await?;

    let _ = evt_tx.send(NetEvent::ReceiveStarted {
        file_id,
        path: path.clone(),
        size,
    });
    let _ = evt_tx.send(NetEvent::Log(format!(
        "recebendo {} (offset {offset})",
        path.display()
    )));

    let evt_tx = evt_tx.clone();
    let completion = completion_tx.clone();
    let task_path = path.clone();
    let handle = task::spawn(async move {
        let mut file = BufWriter::new(file);
        let mut received = offset;
        let mut reported = 0u64;
        let mut last_emit = std::time::Instant::now();
        let mut buffer = vec![0u8; TRANSFER_BUFFER_SIZE];

        loop {
            match stream.read(&mut buffer).await {
                Ok(Some(n)) if n == 0 => {
                    break;
                }
                Ok(Some(n)) => {
                    if let Err(err) = file.write_all(&buffer[..n]).await {
                        let _ = evt_tx.send(NetEvent::Log(format!("erro ao gravar {err}")));
                        let _ = evt_tx.send(NetEvent::ReceiveFailed {
                            file_id,
                            path: task_path.clone(),
                        });
                        let _ = completion.send(file_id);
                        return;
                    }
                    received += n as u64;
                    if should_emit_progress(received, reported, last_emit) {
                        reported = received;
                        last_emit = std::time::Instant::now();
                        let _ = evt_tx.send(NetEvent::ReceiveProgress {
                            file_id,
                            bytes_received: received,
                            size,
                        });
                    }
                }
                Ok(None) => {
                    let _ = file.flush().await;
                    if received > reported {
                        let _ = evt_tx.send(NetEvent::ReceiveProgress {
                            file_id,
                            bytes_received: received,
                            size,
                        });
                    }
                    if received == size {
                        let final_path = unique_download_path(&dir, &safe_name).await;
                        if let Err(err) = tokio::fs::rename(&task_path, &final_path).await {
                            let _ = evt_tx
                                .send(NetEvent::Log(format!("erro ao finalizar arquivo {err}")));
                            let _ = evt_tx.send(NetEvent::ReceiveFailed {
                                file_id,
                                path: task_path.clone(),
                            });
                        } else {
                            let _ = evt_tx.send(NetEvent::FileReceived {
                                file_id,
                                path: final_path.clone(),
                                from,
                            });
                        }
                    } else {
                        let _ = evt_tx.send(NetEvent::Log(format!(
                            "tamanho divergente {received} bytes (esperado {size})"
                        )));
                    }
                    break;
                }
                Err(ReadError::Reset(_)) => {
                    let _ = evt_tx.send(NetEvent::ReceiveCanceled {
                        file_id,
                        path: task_path.clone(),
                    });
                    let _ = completion.send(file_id);
                    return;
                }
                Err(err) => {
                    let _ = evt_tx.send(NetEvent::Log(format!("erro na leitura do stream {err}")));
                    let _ = evt_tx.send(NetEvent::ReceiveFailed {
                        file_id,
                        path: task_path.clone(),
                    });
                    let _ = completion.send(file_id);
                    return;
                }
            }
        }

        let _ = completion.send(file_id);
    });

    incoming.insert(file_id, IncomingTransfer { path, handle });

    Ok(())
}

pub(crate) async fn ensure_session_dir(
    session_dir: &mut Option<PathBuf>,
    evt_tx: &Sender<NetEvent>,
) -> io::Result<PathBuf> {
    if let Some(dir) = session_dir.clone() {
        return Ok(dir);
    }

    let dir = std::env::current_dir()?.join("received");
    tokio::fs::create_dir_all(&dir).await?;
    *session_dir = Some(dir.clone());
    let _ = evt_tx.send(NetEvent::SessionDir(dir.clone()));
    Ok(dir)
}

fn sanitize_file_name(name: &str) -> String {
    Path::new(name)
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("file.bin")
        .to_string()
}

async fn unique_download_path(dir: &Path, file_name: &str) -> PathBuf {
    let mut candidate = dir.join(file_name);
    if !tokio::fs::try_exists(&candidate).await.unwrap_or(false) {
        return candidate;
    }

    let base = Path::new(file_name);
    let stem = base
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("file");
    let ext = base.extension().and_then(|value| value.to_str());

    for idx in 2..=9999_u32 {
        let next_name = match ext {
            Some(ext) => format!("{stem} ({idx}).{ext}"),
            None => format!("{stem} ({idx})"),
        };
        candidate = dir.join(next_name);
        if !tokio::fs::try_exists(&candidate).await.unwrap_or(false) {
            return candidate;
        }
    }

    candidate
}

fn incoming_part_path(dir: &Path, file_id: u64, file_name: &str) -> PathBuf {
    dir.join(format!("{file_id}_{file_name}.part"))
}

async fn query_resume_offset(
    session_dir: &mut Option<PathBuf>,
    file_id: u64,
    name: &str,
    size: u64,
    evt_tx: &Sender<NetEvent>,
) -> io::Result<u64> {
    let dir = ensure_session_dir(session_dir, evt_tx).await?;
    let safe_name = sanitize_file_name(name);
    let part_path = incoming_part_path(&dir, file_id, &safe_name);

    match tokio::fs::metadata(&part_path).await {
        Ok(meta) => {
            let current = meta.len();
            Ok(current.min(size))
        }
        Err(_) => Ok(0),
    }
}

/// Envia um pacote de controle confiável para o par.
pub(crate) async fn send_message(
    connection: &quinn::Connection,
    message: &WireMessage,
    evt_tx: &Sender<NetEvent>,
) -> Result<(), quinn::WriteError> {
    match serialize_message(message) {
        Ok(payload) => {
            let mut stream = connection.open_uni().await?;
            if let Err(err) = write_framed(&mut stream, &payload).await {
                let _ = evt_tx.send(NetEvent::Log(format!("erro ao enviar {err}")));
            }
            let _ = stream.finish();
            Ok(())
        }
        Err(err) => {
            let _ = evt_tx.send(NetEvent::Log(format!("erro ao serializar {err}")));
            Ok(())
        }
    }
}

async fn write_wire_message_framed(
    stream: &mut quinn::SendStream,
    message: &WireMessage,
    evt_tx: &Sender<NetEvent>,
) -> io::Result<()> {
    match serialize_message(message) {
        Ok(payload) => write_framed(stream, &payload).await,
        Err(err) => {
            let _ = evt_tx.send(NetEvent::Log(format!("erro ao serializar {err}")));
            Ok(())
        }
    }
}

async fn write_framed(stream: &mut quinn::SendStream, payload: &[u8]) -> io::Result<()> {
    let len = payload.len() as u32;
    stream.write_all(&len.to_be_bytes()).await?;
    stream.write_all(payload).await?;
    Ok(())
}

/// Processa a fila de comandos durante um envio para detectar cancelamentos ou encerramentos.
pub(crate) fn handle_send_control(
    cmd_rx: &mut tokio_mpsc::UnboundedReceiver<NetCommand>,
    pending_cmds: &mut Vec<NetCommand>,
) -> SendOutcome {
    while let Ok(cmd) = cmd_rx.try_recv() {
        match cmd {
            NetCommand::CancelTransfers => return SendOutcome::Canceled,
            NetCommand::Shutdown => return SendOutcome::Shutdown,
            NetCommand::Rebind(addr) => {
                pending_cmds.push(NetCommand::Rebind(addr));
                return SendOutcome::Canceled;
            }
            // Respostas de resume sao tratadas antes do envio iniciar. Se chegarem depois, podem ser ignoradas.
            NetCommand::InternalResumeAnswer { .. } => {}
            other => pending_cmds.push(other),
        }
    }
    SendOutcome::Completed
}

async fn wait_for_resume_answer(
    cmd_rx: &mut tokio_mpsc::UnboundedReceiver<NetCommand>,
    pending_cmds: &mut Vec<NetCommand>,
    cache: &mut HashMap<u64, (u64, bool, Option<String>)>,
    file_id: u64,
) -> Result<(u64, bool, Option<String>), SendOutcome> {
    if let Some(entry) = cache.remove(&file_id) {
        return Ok(entry);
    }

    let deadline = tokio::time::Instant::now() + RESUME_WAIT_TIMEOUT;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            // Timeout: segue com offset 0.
            return Ok((0, false, Some("timeout aguardando ResumeAnswer".to_string())));
        }

        match tokio::time::timeout(remaining, cmd_rx.recv()).await {
            Ok(Some(cmd)) => match cmd {
                NetCommand::InternalResumeAnswer {
                    file_id: got_id,
                    offset,
                    ok,
                    reason,
                } => {
                    if got_id == file_id {
                        return Ok((offset, ok, reason));
                    }
                    cache.insert(got_id, (offset, ok, reason));
                }
                NetCommand::CancelTransfers => return Err(SendOutcome::Canceled),
                NetCommand::Shutdown => return Err(SendOutcome::Shutdown),
                NetCommand::Rebind(addr) => {
                    pending_cmds.push(NetCommand::Rebind(addr));
                    return Err(SendOutcome::Canceled);
                }
                other => pending_cmds.push(other),
            },
            Ok(None) => {
                // Canal fechado (tarefas encerrando). Trata como shutdown.
                return Err(SendOutcome::Shutdown);
            }
            Err(_) => {
                // Timeout dessa espera.
                return Ok((0, false, Some("timeout aguardando ResumeAnswer".to_string())));
            }
        }
    }
}

/// Envia os arquivos para o par conectado respeitando cancelamentos da UI.
/// Implementa pipeline: envia todos os ResumeQuery de uma vez e processa
/// arquivos em paralelo (até MAX_CONCURRENT_STREAMS streams simultâneas via semáforo).
pub(crate) async fn send_files(
    connection: &quinn::Connection,
    _peer: SocketAddr,
    peer_id: String,
    files: &[PathBuf],
    mut next_file_id: u64,
    evt_tx: &Sender<NetEvent>,
    cmd_rx: &mut tokio_mpsc::UnboundedReceiver<NetCommand>,
    chunk_size: usize,
    journal: Arc<tokio::sync::Mutex<TransferJournal>>,
) -> io::Result<SendResult> {
    let mut pending_cmds: Vec<NetCommand> = Vec::new();

    let _ = send_message(
        connection,
        &WireMessage::Hello {
            version: PROTOCOL_VERSION,
        },
        evt_tx,
    )
    .await;

    // Fase 1: abrir todos os arquivos, coletar metadados, enviar todos os ResumeQuery.
    struct FilePrepared {
        file_id: u64,
        name: String,
        path: PathBuf,
        size: u64,
        file: File,
    }

    let mut prepared: Vec<FilePrepared> = Vec::new();

    for path in files {
        match handle_send_control(cmd_rx, &mut pending_cmds) {
            SendOutcome::Canceled => {
                return Ok(SendResult {
                    outcome: SendOutcome::Canceled,
                    next_file_id,
                    pending_cmds,
                });
            }
            SendOutcome::Shutdown => {
                return Ok(SendResult {
                    outcome: SendOutcome::Shutdown,
                    next_file_id,
                    pending_cmds,
                });
            }
            SendOutcome::Completed => {}
        }

        let file = File::open(path).await?;
        let metadata = file.metadata().await?;
        let size = metadata.len();
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("file.bin")
            .to_string();
        let file_id = next_file_id;
        next_file_id = next_file_id.wrapping_add(1);

        let _ = send_message(
            connection,
            &WireMessage::ResumeQuery {
                file_id,
                name: name.clone(),
                size,
            },
            evt_tx,
        )
        .await;

        prepared.push(FilePrepared {
            file_id,
            name,
            path: path.clone(),
            size,
            file,
        });
    }

    if prepared.is_empty() {
        return Ok(SendResult {
            outcome: SendOutcome::Completed,
            next_file_id,
            pending_cmds,
        });
    }

    // Fase 2: aguardar ResumeAnswer de cada arquivo e construir configuração de envio.
    // Respostas podem chegar fora de ordem; o cache já trata isso.
    struct FileSendConfig {
        file_id: u64,
        name: String,
        path: PathBuf,
        size: u64,
        file: File,
        offset: u64,
    }

    let mut resume_cache: HashMap<u64, (u64, bool, Option<String>)> = HashMap::new();
    let mut send_configs: Vec<FileSendConfig> = Vec::new();

    for prep in prepared {
        let (resume_offset, resume_ok, resume_reason) = match wait_for_resume_answer(
            cmd_rx,
            &mut pending_cmds,
            &mut resume_cache,
            prep.file_id,
        )
        .await
        {
            Ok((offset, ok, reason)) => (offset.min(prep.size), ok, reason),
            Err(outcome) => {
                return Ok(SendResult {
                    outcome,
                    next_file_id,
                    pending_cmds,
                });
            }
        };

        let offset = if resume_ok { resume_offset } else { 0 };
        if offset > 0 {
            let _ = evt_tx.send(NetEvent::Log(format!(
                "retomando envio de {} a partir do byte {offset} (file_id={})",
                prep.name, prep.file_id
            )));
        } else if let Some(reason) = resume_reason {
            let _ = evt_tx.send(NetEvent::Log(format!(
                "resume indisponivel para {} (file_id={}): {reason}; enviando do inicio",
                prep.name, prep.file_id
            )));
        }

        send_configs.push(FileSendConfig {
            file_id: prep.file_id,
            name: prep.name,
            path: prep.path,
            size: prep.size,
            file: prep.file,
            offset,
        });
    }

    // Fase 3: spawnar envio paralelo com semáforo (máx MAX_CONCURRENT_STREAMS streams).
    let semaphore = Arc::new(tokio::sync::Semaphore::new(MAX_CONCURRENT_STREAMS));
    let cancel_flag = Arc::new(AtomicBool::new(false));
    let mut join_set = tokio::task::JoinSet::<bool>::new();

    // Snapshot dos paths para limpeza do journal em caso de cancelamento.
    let path_size_list: Vec<(PathBuf, u64)> = send_configs
        .iter()
        .map(|c| (c.path.clone(), c.size))
        .collect();

    for mut cfg in send_configs {
        // Posiciona arquivo no offset antes de mover para a task.
        if cfg.offset > 0 {
            cfg.file.seek(std::io::SeekFrom::Start(cfg.offset)).await?;
        }

        // Registra no journal antes de iniciar (para retomada pós-crash).
        {
            let mut j = journal.lock().await;
            j.upsert_progress(
                &peer_id,
                TransferDirection::Outgoing,
                &cfg.path,
                cfg.size,
                cfg.offset,
            );
        }

        let conn = connection.clone();
        let evt_tx_task = evt_tx.clone();
        let journal_task = journal.clone();
        let peer_id_task = peer_id.clone();
        let sem = semaphore.clone();
        let cancel = cancel_flag.clone();
        let chunk_sz = chunk_size;

        join_set.spawn(async move {
            let _permit = sem.acquire().await.unwrap();
            if cancel.load(Ordering::Relaxed) {
                return false;
            }
            send_single_file(
                &conn,
                &peer_id_task,
                cfg.file_id,
                &cfg.name,
                cfg.size,
                cfg.offset,
                cfg.file,
                &cfg.path,
                &evt_tx_task,
                chunk_sz,
                journal_task,
            )
            .await
        });
    }

    // Fase 4: aguardar tasks enquanto monitora cmd_rx para cancelamentos.
    loop {
        tokio::select! {
            result = join_set.join_next() => {
                if result.is_none() {
                    break;
                }
                // Ignora resultado individual; erros já foram logados em send_single_file.
            }
            cmd = cmd_rx.recv() => {
                match cmd {
                    Some(NetCommand::CancelTransfers) => {
                        cancel_flag.store(true, Ordering::Relaxed);
                        join_set.abort_all();
                        while join_set.join_next().await.is_some() {}
                        // Remove entradas do journal para todos os arquivos preparados.
                        {
                            let mut j = journal.lock().await;
                            for (path, size) in &path_size_list {
                                j.remove(&peer_id, TransferDirection::Outgoing, path, *size);
                            }
                        }
                        return Ok(SendResult {
                            outcome: SendOutcome::Canceled,
                            next_file_id,
                            pending_cmds,
                        });
                    }
                    Some(NetCommand::Shutdown) => {
                        cancel_flag.store(true, Ordering::Relaxed);
                        join_set.abort_all();
                        while join_set.join_next().await.is_some() {}
                        {
                            let mut j = journal.lock().await;
                            let _ = j.flush();
                        }
                        return Ok(SendResult {
                            outcome: SendOutcome::Shutdown,
                            next_file_id,
                            pending_cmds,
                        });
                    }
                    Some(NetCommand::InternalResumeAnswer { .. }) => {}
                    Some(NetCommand::Rebind(addr)) => {
                        cancel_flag.store(true, Ordering::Relaxed);
                        join_set.abort_all();
                        while join_set.join_next().await.is_some() {}
                        pending_cmds.push(NetCommand::Rebind(addr));
                        return Ok(SendResult {
                            outcome: SendOutcome::Canceled,
                            next_file_id,
                            pending_cmds,
                        });
                    }
                    Some(other) => pending_cmds.push(other),
                    None => break,
                }
            }
        }
    }

    Ok(SendResult {
        outcome: SendOutcome::Completed,
        next_file_id,
        pending_cmds,
    })
}

/// Envia um único arquivo via stream QUIC. Retorna `true` em caso de sucesso.
async fn send_single_file(
    connection: &quinn::Connection,
    peer_id: &str,
    file_id: u64,
    name: &str,
    size: u64,
    offset: u64,
    mut file: File,
    path: &Path,
    evt_tx: &Sender<NetEvent>,
    chunk_size: usize,
    journal: Arc<tokio::sync::Mutex<TransferJournal>>,
) -> bool {
    let mut stream = match connection.open_uni().await {
        Ok(s) => s,
        Err(err) => {
            let _ = evt_tx.send(NetEvent::Log(format!("erro ao abrir stream {err}")));
            return false;
        }
    };

    let _ = write_wire_message_framed(
        &mut stream,
        &WireMessage::FileMeta {
            file_id,
            name: name.to_string(),
            size,
            offset,
        },
        evt_tx,
    )
    .await;

    let _ = evt_tx.send(NetEvent::SendStarted {
        file_id,
        path: path.to_path_buf(),
        size,
    });

    let buf_size = chunk_size.max(TRANSFER_BUFFER_SIZE);
    let mut buffer = vec![0u8; buf_size];
    let mut sent_bytes = offset;
    let mut reported = offset;
    let mut last_emit = std::time::Instant::now();
    let mut last_journal_update = std::time::Instant::now();
    let mut success = true;

    loop {
        let read = match file.read(&mut buffer).await {
            Ok(n) => n,
            Err(err) => {
                let _ = evt_tx.send(NetEvent::Log(format!("erro ao ler arquivo {err}")));
                success = false;
                break;
            }
        };

        if read == 0 {
            break;
        }

        if let Err(err) = stream.write_all(&buffer[..read]).await {
            let _ = evt_tx.send(NetEvent::Log(format!("erro ao enviar {err}")));
            success = false;
            break;
        }
        sent_bytes += read as u64;

        // Journal atualizado de forma throttled (1x/s) para evitar lock no hot loop.
        if last_journal_update.elapsed() >= JOURNAL_UPDATE_INTERVAL {
            let mut j = journal.lock().await;
            j.upsert_progress(peer_id, TransferDirection::Outgoing, path, size, sent_bytes);
            last_journal_update = std::time::Instant::now();
        }

        if should_emit_progress(sent_bytes, reported, last_emit) {
            reported = sent_bytes;
            last_emit = std::time::Instant::now();
            let _ = evt_tx.send(NetEvent::SendProgress {
                file_id,
                bytes_sent: sent_bytes,
                size,
            });
        }
    }

    if success {
        if sent_bytes > reported {
            let _ = evt_tx.send(NetEvent::SendProgress {
                file_id,
                bytes_sent: sent_bytes,
                size,
            });
        }
        let _ = stream.finish();
        let _ = evt_tx.send(NetEvent::FileSent {
            file_id,
            path: path.to_path_buf(),
        });
        {
            let mut j = journal.lock().await;
            j.remove(peer_id, TransferDirection::Outgoing, path, size);
        }
    } else {
        let _ = stream.reset(VarInt::from_u32(0));
        let _ = send_message(connection, &WireMessage::Cancel { file_id }, evt_tx).await;
        let _ = evt_tx.send(NetEvent::SendCanceled {
            file_id,
            path: path.to_path_buf(),
        });
        {
            let mut j = journal.lock().await;
            j.remove(peer_id, TransferDirection::Outgoing, path, size);
        }
    }

    success
}

fn should_emit_progress(total: u64, reported: u64, last_emit: std::time::Instant) -> bool {
    total.saturating_sub(reported) >= PROGRESS_EMIT_BYTES
        || last_emit.elapsed() >= PROGRESS_EMIT_INTERVAL
}
