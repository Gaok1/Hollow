//! Hollow's headless daemon.
//!
//! Speaks newline-delimited JSON over stdio and is spawned as a child of the
//! Electron shell. It owns Steam connectivity, Windows audio capture and file
//! transfer; the shell owns the window and all WebRTC media.
//!
//! Run it directly to poke at the protocol by hand:
//!
//! ```text
//! echo '{"id":1,"method":"app.info"}' | hollow-core
//! ```

mod app;
mod files;
mod pipe;
mod protocol;
mod rpc;

use anyhow::Result;
use tracing_subscriber::EnvFilter;

fn main() -> Result<()> {
    init_tracing();

    let app_id = hollow_steam::configured_app_id();

    // A current-thread runtime is the right shape here: the work is IO-bound
    // message shuffling, and the two CPU-bound producers (Steam callbacks,
    // WASAPI capture) already live on their own dedicated OS threads.
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;

    runtime.block_on(async move {
        let sink = rpc::Sink::new();
        let requests = rpc::read_requests();

        match app::App::new(sink.clone(), app_id) {
            Ok(app) => app.run(requests).await,
            Err(err) => {
                // Report through the protocol as well as the log: the shell
                // reads stdout, and a startup failure should reach the UI.
                sink.emit_error(format!("failed to start: {err}")).await;
                Err(err)
            }
        }
    })
}

/// Logs go to stderr so they never corrupt the JSON stream on stdout.
///
/// Electron forwards stderr into its own console, which makes `HOLLOW_LOG=debug`
/// the way to trace a session.
fn init_tracing() {
    let filter = EnvFilter::try_from_env("HOLLOW_LOG")
        .unwrap_or_else(|_| EnvFilter::new("hollow_core=info,hollow_steam=info,hollow_audio=info"));

    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(std::io::stderr)
        .with_target(true)
        .init();
}
