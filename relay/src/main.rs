use std::{net::SocketAddr, path::PathBuf};

use clap::Parser;
use fb_relay::Config;

/// FreeBank phone relay: a dumb WebSocket pipe at /ws plus the phone page's static files at /.
#[derive(Parser)]
#[command(version)]
struct Args {
    /// Address to listen on. Keep it on loopback and put a TLS proxy in front for anything public.
    #[arg(long, default_value = "127.0.0.1:8480")]
    listen: SocketAddr,
    /// Directory with the built phone page (index.html is the fallback for unknown paths).
    #[arg(long = "static", default_value = "../phone/dist")]
    static_dir: PathBuf,
    /// A browser origin allowed to open /ws, like https://app.ecxfreebank.com (repeatable). Without any, every
    /// origin is allowed (for local testing). Clients that send no Origin (the desktop app) are always allowed.
    #[arg(long = "origin", value_parser = parse_origin)]
    origins: Vec<String>,
    /// WebSocket connections open at once (hosts and phones together); past it, /ws answers 503.
    #[arg(long, default_value_t = Config::default().max_conns)]
    max_conns: usize,
    /// Take "Send to FreeBank" reports at POST /feedback and keep them in this folder (made if missing,
    /// owner-only). Without it there is no /feedback.
    #[arg(long)]
    feedback_dir: Option<PathBuf>,
}

/// `scheme://host[:port]`, nothing after it: the form browsers send in `Origin`.
fn parse_origin(s: &str) -> Result<String, String> {
    let s = s.trim().trim_end_matches('/');
    let rest = s
        .strip_prefix("https://")
        .or_else(|| s.strip_prefix("http://"))
        .ok_or("an origin starts with https:// or http://")?;
    if rest.is_empty() || rest.contains(['/', '?', '#', '@', ' ']) {
        return Err("an origin is scheme://host[:port], with no path".into());
    }
    Ok(s.to_ascii_lowercase())
}

fn main() -> std::io::Result<()> {
    use std::io::IsTerminal;
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "fb_relay=info".into()),
        )
        // Colours only on a terminal: the journal gets plain lines.
        .with_ansi(std::io::stdout().is_terminal())
        .init();
    let args = Args::parse();
    // A small, fixed blocking pool (static files are read on it): the thread count stays well under a systemd
    // TasksMax, and a burst of page loads can't spawn hundreds of threads.
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .max_blocking_threads(8)
        .build()?
        .block_on(run(args))
}

async fn run(args: Args) -> std::io::Result<()> {
    if !args.static_dir.join("index.html").is_file() {
        tracing::warn!(dir = %args.static_dir.display(), "no index.html in the static directory; / will return 404");
    }
    if !args.listen.ip().is_loopback() {
        tracing::warn!(addr = %args.listen, "listening beyond loopback: the relay speaks plain HTTP, put TLS in front");
    }
    if args.origins.is_empty() {
        tracing::info!("no --origin given: any browser origin may open /ws");
    }
    if let Some(dir) = &args.feedback_dir {
        fb_relay::feedback::prepare(dir)?;
        tracing::info!(dir = %dir.display(), "taking reports at /feedback");
    }
    let cfg = Config {
        static_dir: args.static_dir,
        origins: args.origins,
        max_conns: args.max_conns,
        feedback_dir: args.feedback_dir,
        ..Config::default()
    };
    let listener = tokio::net::TcpListener::bind(args.listen).await?;
    tracing::info!(addr = %listener.local_addr()?, origins = ?cfg.origins, max_conns = cfg.max_conns, "fb-relay listening");
    tokio::select! {
        r = fb_relay::serve(listener, cfg) => r,
        _ = shutdown() => {
            tracing::info!("shutting down");
            Ok(())
        }
    }
}

/// Ctrl-C, or SIGTERM (systemd's stop).
async fn shutdown() {
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("install the SIGTERM handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = term.recv() => {}
        }
    }
    #[cfg(not(unix))]
    let _ = tokio::signal::ctrl_c().await;
}

#[cfg(test)]
mod tests {
    use super::parse_origin;

    #[test]
    fn origins_are_scheme_host_port() {
        assert_eq!(parse_origin("https://App.Example/").unwrap(), "https://app.example");
        assert_eq!(parse_origin("http://127.0.0.1:8480").unwrap(), "http://127.0.0.1:8480");
        assert!(parse_origin("app.example").is_err());
        assert!(parse_origin("https://app.example/ws").is_err());
        assert!(parse_origin("https://").is_err());
        assert!(parse_origin("wss://app.example").is_err());
    }
}
