//! FreeBank phone relay (protocol v1, see PROTOCOL.md "The relay").
//!
//! A dumb pipe: a desktop proves it holds the static key `D` for a room and becomes the room's host; phones
//! join the room and get a channel number; the relay forwards frames between them and never looks inside.
//! It also serves the phone page's static files.
//!
//! Frame contents are never logged or stored, and neither are addresses. At `info` the logs carry counts and
//! channel numbers only; the room prefix (first 6 chars) appears at `debug`.
//!
//! Every resource is bounded (SECURITY_REVIEW.md): frame size, frames and bytes per second per connection,
//! bytes queued per connection, phones per room, WebSocket connections in total, the time allowed for each
//! handshake step and each write, and how long a phone may stay silent after joining. A room's state goes away
//! with its host.

pub mod feedback;

use std::{
    collections::HashMap,
    net::SocketAddr,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, AtomicUsize, Ordering},
        Arc, Mutex, MutexGuard,
    },
    time::Duration,
};

use axum::{
    extract::{
        ws::{CloseFrame, Message, Utf8Bytes, WebSocket, WebSocketUpgrade},
        Request, State,
    },
    http::{header, HeaderMap, HeaderName, HeaderValue, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64U, Engine};
use p256::ecdsa::{signature::Verifier, Signature, VerifyingKey};
use rand::{Rng, RngCore};
use serde::Deserialize;
use serde_json::value::RawValue;
use sha2::{Digest, Sha256};
use tokio::{
    net::TcpListener,
    sync::{mpsc, Notify},
    time::{sleep_until, timeout, Instant, MissedTickBehavior},
};
use tower_http::{
    services::{ServeDir, ServeFile},
    set_header::SetResponseHeaderLayer,
};

/// Close codes the relay uses.
pub mod close {
    /// Normal: idle timeout, host gone, offline.
    pub const NORMAL: u16 = 1000;
    /// A binary frame (the protocol is JSON text only).
    pub const UNSUPPORTED: u16 = 1003;
    /// Bad handshake, bad proof, rate limit, room full, slow reader, host busy.
    pub const POLICY: u16 = 1008;
    /// A frame over the size limit.
    pub const TOO_BIG: u16 = 1009;
    /// This host was replaced by a newly proven host for the same room.
    pub const REPLACED: u16 = 4001;
}

/// The Content-Security-Policy on every response. The page needs nothing but its own scripts, styles, icon and
/// same-origin WebSocket (`phone/README.md`, CSP note), plus FreeBank's helper for Ask FreeBank (phone page v0.4.6,
/// `phone/src/lib/ask.ts`: one fixed https address, ours); no inline code, no `data:` URLs, no third parties.
pub const CSP: &str = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; \
                       connect-src 'self' https://ask.ecxfreebank.com; \
                       manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/// Browser features the page never uses, and the camera for itself alone: "Scan the code on your desktop" reads the
/// pairing QR code on the phone, and no picture leaves it (`phone/src/lib/scan.ts`). (It copies to the clipboard,
/// which needs no policy for a top-level same-origin page.)
pub const PERMISSIONS_POLICY: &str =
    "camera=(self), microphone=(), geolocation=(), payment=(), usb=(), display-capture=(), fullscreen=()";

/// How long one outbound frame may take to write before the connection is dropped.
const SEND_TIMEOUT: Duration = Duration::from_secs(10);

/// tungstenite's read buffer, allocated for every connection up front (its default is 128 KiB).
const READ_BUFFER: usize = 8 * 1024;

/// Relay limits and settings.
#[derive(Clone, Debug)]
pub struct Config {
    /// Directory served at `/` (the phone page build, `phone/dist`).
    pub static_dir: PathBuf,
    /// Largest accepted frame, in bytes.
    pub max_frame: usize,
    /// Phones per room.
    pub max_phones: usize,
    /// Frames per second per connection (token bucket, burst of the same size).
    pub rate_per_sec: u32,
    /// Frames per second for a proven host, which serves up to `max_phones` phones.
    pub host_rate_per_sec: u32,
    /// Bytes per second a connection may send (token bucket; the burst is the larger of this and two frames).
    pub bytes_per_sec: usize,
    /// Bytes per second for a proven host.
    pub host_bytes_per_sec: usize,
    /// Close a connection after this long with nothing received from it (pongs count).
    pub idle: Duration,
    /// Ping interval.
    pub ping: Duration,
    /// Time allowed for the first frame, and for the host's proof.
    pub handshake: Duration,
    /// A phone that has joined must send a frame within this long (pings and pongs don't count), or it is closed
    /// (1008). The desktop only sees a channel once it sends something, so without this a silent stranger with
    /// the room id would hold one of the room's slots until the idle timeout (security review, P5).
    pub phone_silence: Duration,
    /// WebSocket connections open at once, hosts and phones together. Past it, `/ws` answers 503.
    pub max_conns: usize,
    /// Bytes that may wait in a phone's outbound queue. It is also each phone's share of its host's queue: a
    /// phone that has this much on its way to a host that isn't keeping up is closed, not the host.
    pub queue_bytes: usize,
    /// Browser origins allowed to open `/ws`, like `https://app.ecxfreebank.com`. Empty: any. A request with no
    /// `Origin` header (the desktop app, which is not a browser) is always allowed. The same for `/feedback`.
    pub origins: Vec<String>,
    /// Where `POST /feedback` keeps reports (`feedback.rs`). None: there is no such route.
    pub feedback_dir: Option<PathBuf>,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            static_dir: PathBuf::from("../phone/dist"),
            max_frame: 64 * 1024,
            max_phones: 8,
            rate_per_sec: 20,
            host_rate_per_sec: 200,
            bytes_per_sec: 64 * 1024,
            host_bytes_per_sec: 512 * 1024,
            idle: Duration::from_secs(600),
            ping: Duration::from_secs(30),
            handshake: Duration::from_secs(10),
            phone_silence: Duration::from_secs(30),
            max_conns: 512,
            queue_bytes: 128 * 1024,
            origins: Vec::new(),
            feedback_dir: None,
        }
    }
}

/// What a connection's loop can be told to send.
enum Out {
    /// A text frame, and the in-flight counter of the phone that sent it (phone to host), credited once the
    /// frame leaves the queue.
    Text(String, Option<Arc<AtomicUsize>>),
    Close(u16, &'static str),
}

/// Add `len` to `counter` if the total stays within `cap`.
fn reserve(counter: &AtomicUsize, len: usize, cap: usize) -> bool {
    counter
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |q| q.checked_add(len).filter(|n| *n <= cap))
        .is_ok()
}

/// A handle for pushing frames to one connection.
#[derive(Clone)]
struct Peer {
    id: u64,
    tx: mpsc::Sender<Out>,
    kill: Arc<Notify>,
    /// Bytes waiting in this connection's queue.
    queued: Arc<AtomicUsize>,
    budget: usize,
}

impl Peer {
    /// Queue a text frame within this peer's byte budget and, when `from` is given, within the sender's share
    /// (`(counter, cap)`). Returns false, queueing nothing, when either is full.
    fn queue(&self, text: String, from: Option<(&Arc<AtomicUsize>, usize)>) -> bool {
        let len = text.len();
        if !reserve(&self.queued, len, self.budget) {
            return false;
        }
        if let Some((f, cap)) = from {
            if !reserve(f, len, cap) {
                self.queued.fetch_sub(len, Ordering::AcqRel);
                return false;
            }
        }
        if self.tx.try_send(Out::Text(text, from.map(|(f, _)| f.clone()))).is_err() {
            self.queued.fetch_sub(len, Ordering::AcqRel);
            if let Some((f, _)) = from {
                f.fetch_sub(len, Ordering::AcqRel);
            }
            return false;
        }
        true
    }

    /// Queue a frame for a reader that has to keep up. One that has fallen too far behind is cut off rather than
    /// buffered without bound.
    fn send(&self, text: String) {
        if !self.queue(text, None) {
            self.kill.notify_one();
        }
    }

    fn close(&self, code: u16, reason: &'static str) {
        if self.tx.try_send(Out::Close(code, reason)).is_err() {
            self.kill.notify_one();
        }
    }
}

/// The receiving end of a `Peer`, owned by the connection's loop.
struct Inbox {
    rx: mpsc::Receiver<Out>,
    kill: Arc<Notify>,
    queued: Arc<AtomicUsize>,
}

struct Room {
    host: Peer,
    phones: HashMap<u64, Peer>,
    /// The next channel number. It starts at a random number when the room appears and goes away with it; a host
    /// that replaces another keeps counting, so a channel number is never reused while the room exists.
    next_ch: u64,
}

struct Shared {
    cfg: Config,
    rooms: Mutex<HashMap<String, Room>>,
    next_id: AtomicU64,
    /// Open WebSocket connections.
    conns: AtomicUsize,
}

impl Shared {
    /// The rooms. A panic elsewhere never leaves the maps half-changed, so a poisoned lock is still usable, and
    /// one bad task can't take every later connection down with it.
    fn rooms(&self) -> MutexGuard<'_, HashMap<String, Room>> {
        self.rooms.lock().unwrap_or_else(|e| e.into_inner())
    }
}

type AppState = Arc<Shared>;

/// Counters for tests and the startup log. Nothing here identifies a room or a client.
#[derive(Clone)]
pub struct Stats(AppState);

impl Stats {
    /// Rooms with a host.
    pub fn rooms(&self) -> usize {
        self.0.rooms().len()
    }
    /// Open WebSocket connections (hosts, phones, and connections still in their handshake).
    pub fn connections(&self) -> usize {
        self.0.conns.load(Ordering::Acquire)
    }
}

/// First 6 characters of a room id, for debug logs.
fn short(room: &str) -> &str {
    room.get(..6).unwrap_or(room)
}

/// The context string a host proof starts with (PROTOCOL.md, "The relay"; security review finding P4). `D` is
/// also the desktop's ECDH key, so what it signs for the relay says what it is for.
pub const PROOF_CONTEXT: &[u8] = b"fb-relay-proof-v1";

/// What the host signs: `fb-relay-proof-v1` followed by the relay's challenge bytes.
pub fn proof_message(n: &[u8]) -> Vec<u8> {
    [PROOF_CONTEXT, n].concat()
}

/// `room = b64u(SHA-256(D_pub))[0..22]`.
pub fn room_for(d_pub: &[u8]) -> String {
    let mut s = B64U.encode(Sha256::digest(d_pub));
    s.truncate(22);
    s
}

fn valid_room(room: &str) -> bool {
    room.len() == 22 && room.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn closed_notice(ch: u64) -> String {
    format!(r#"{{"t":"closed","ch":{ch}}}"#)
}

/// Whether a `/ws` request may go on, by its `Origin` header.
pub fn origin_allowed(allowed: &[String], origin: Option<&HeaderValue>) -> bool {
    match origin {
        // Not a browser: the desktop app sends no Origin. (A script can forge Origin anyway; this check only
        // stops other websites from using their visitors' browsers against the relay.)
        None => true,
        Some(_) if allowed.is_empty() => true,
        Some(o) => o.to_str().is_ok_and(|o| allowed.iter().any(|a| a.eq_ignore_ascii_case(o))),
    }
}

/// `Cache-Control`: the hashed build assets never change; everything else is checked on each load, so a fixed
/// page reaches phones at once.
async fn cache_control(req: Request, next: Next) -> Response {
    let asset = req.uri().path().starts_with("/assets/");
    let mut res = next.run(req).await;
    let html = res
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.starts_with("text/html"));
    let value = if asset && res.status() == StatusCode::OK && !html {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    res.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static(value));
    res
}

/// Build the router: `GET /ws` plus the static phone page with security headers.
pub fn router(cfg: Config) -> Router {
    app(cfg).0
}

/// The router and a `Stats` handle on its state.
pub fn app(cfg: Config) -> (Router, Stats) {
    let index = cfg.static_dir.join("index.html");
    let files = ServeDir::new(&cfg.static_dir).fallback(ServeFile::new(index));
    let state = Arc::new(Shared {
        cfg,
        rooms: Mutex::new(HashMap::new()),
        next_id: AtomicU64::new(1),
        conns: AtomicUsize::new(0),
    });
    let stats = Stats(state.clone());
    let set = |name: HeaderName, value: &'static str| {
        SetResponseHeaderLayer::overriding(name, HeaderValue::from_static(value))
    };

    let mut router = Router::new().route("/ws", get(ws_handler)).with_state(state.clone());
    if let Some(dir) = state.cfg.feedback_dir.clone() {
        router = router.merge(feedback::routes(dir, state.cfg.origins.clone()));
    }
    let router = router
        .fallback_service(files)
        .layer(middleware::from_fn(cache_control))
        .layer(set(header::CONTENT_SECURITY_POLICY, CSP))
        .layer(set(header::X_CONTENT_TYPE_OPTIONS, "nosniff"))
        .layer(set(header::REFERRER_POLICY, "no-referrer"))
        .layer(set(header::X_FRAME_OPTIONS, "DENY"))
        .layer(set(HeaderName::from_static("permissions-policy"), PERMISSIONS_POLICY))
        .layer(set(HeaderName::from_static("cross-origin-opener-policy"), "same-origin"))
        .layer(set(HeaderName::from_static("cross-origin-resource-policy"), "same-origin"));
    (router, stats)
}

/// Serve on an already-bound listener until the process ends.
pub async fn serve(listener: TcpListener, cfg: Config) -> std::io::Result<()> {
    axum::serve(listener, router(cfg).into_make_service_with_connect_info::<SocketAddr>()).await
}

/// One of the `max_conns` WebSocket slots, given back when dropped.
struct Slot(AppState);

impl Slot {
    fn take(st: &AppState) -> Option<Slot> {
        let max = st.cfg.max_conns;
        st.conns
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| (n < max).then_some(n + 1))
            .ok()
            .map(|_| Slot(st.clone()))
    }
}

impl Drop for Slot {
    fn drop(&mut self) {
        self.0.conns.fetch_sub(1, Ordering::AcqRel);
    }
}

async fn ws_handler(State(st): State<AppState>, headers: HeaderMap, ws: WebSocketUpgrade) -> Response {
    if !origin_allowed(&st.cfg.origins, headers.get(header::ORIGIN)) {
        tracing::debug!("refused: origin not allowed");
        return (StatusCode::FORBIDDEN, "origin not allowed\n").into_response();
    }
    let Some(slot) = Slot::take(&st) else {
        tracing::debug!("refused: connection limit");
        return (StatusCode::SERVICE_UNAVAILABLE, "too many connections, try again later\n").into_response();
    };
    let max = st.cfg.max_frame;
    ws.max_message_size(max)
        .max_frame_size(max)
        .read_buffer_size(READ_BUFFER)
        .write_buffer_size(0) // each frame is written out at once
        .max_write_buffer_size(4 * max)
        .on_upgrade(move |socket| async move {
            let _slot = slot;
            connection(socket, st).await
        })
}

/// Per-connection budget: token buckets for frames and for bytes, refilled continuously.
struct Bucket {
    frames: f64,
    frame_rate: f64,
    bytes: f64,
    byte_rate: f64,
    byte_cap: f64,
    last: Instant,
}

impl Bucket {
    fn new(frame_rate: u32, byte_rate: usize, max_frame: usize) -> Self {
        let byte_cap = (byte_rate as f64).max(2.0 * max_frame as f64);
        Bucket {
            frames: frame_rate as f64,
            frame_rate: frame_rate as f64,
            bytes: byte_cap,
            byte_rate: byte_rate as f64,
            byte_cap,
            last: Instant::now(),
        }
    }
    fn take(&mut self, len: usize) -> bool {
        let now = Instant::now();
        let dt = now.duration_since(self.last).as_secs_f64();
        self.last = now;
        self.frames = (self.frames + dt * self.frame_rate).min(self.frame_rate);
        self.bytes = (self.bytes + dt * self.byte_rate).min(self.byte_cap);
        if self.frames >= 1.0 && self.bytes >= len as f64 {
            self.frames -= 1.0;
            self.bytes -= len as f64;
            true
        } else {
            false
        }
    }
}

/// A received frame, after limits are applied.
enum In {
    Text(Utf8Bytes),
    /// The connection is over; the reason has already been sent (or the peer is gone).
    End,
}

/// The socket plus the per-connection limits.
struct Conn {
    ws: WebSocket,
    bucket: Bucket,
    idle: Duration,
    last_seen: Instant,
}

impl Conn {
    /// Send with a deadline, so a peer that stops reading cannot stall the loop.
    async fn send(&mut self, msg: Message) -> bool {
        matches!(timeout(SEND_TIMEOUT, self.ws.send(msg)).await, Ok(Ok(())))
    }

    async fn close(&mut self, code: u16, reason: &'static str) {
        self.send(Message::Close(Some(CloseFrame { code, reason: Utf8Bytes::from_static(reason) }))).await;
    }

    async fn send_text(&mut self, text: String) -> bool {
        self.send(Message::Text(text.into())).await
    }

    /// Handle one result of `ws.recv()`: rate limits, idle bookkeeping, close on errors and binary frames.
    /// Returns `None` for control frames that need no action. Every frame counts against the budget, pongs too
    /// (a live peer sends one per ping, every 30 s).
    async fn filter(&mut self, msg: Option<Result<Message, axum::Error>>) -> Option<In> {
        self.last_seen = Instant::now();
        let m = match msg {
            None | Some(Ok(Message::Close(_))) => return Some(In::End),
            Some(Err(e)) => {
                if e.to_string().contains("Space limit exceeded") {
                    self.close(close::TOO_BIG, "frame too big").await;
                }
                return Some(In::End);
            }
            Some(Ok(m)) => m,
        };
        let len = match &m {
            Message::Text(t) => t.len(),
            Message::Binary(b) | Message::Ping(b) | Message::Pong(b) => b.len(),
            Message::Close(_) => 0,
        };
        if !self.bucket.take(len) {
            self.close(close::POLICY, "rate limit").await;
            return Some(In::End);
        }
        match m {
            Message::Text(t) => Some(In::Text(t)),
            Message::Binary(_) => {
                self.close(close::UNSUPPORTED, "text frames only").await;
                Some(In::End)
            }
            _ => None, // Ping (tungstenite answers it) or Pong.
        }
    }

    /// Wait for one text frame during the handshake.
    async fn handshake_frame(&mut self, limit: Duration) -> Option<Utf8Bytes> {
        let deadline = Instant::now() + limit;
        loop {
            let msg = match timeout(deadline.saturating_duration_since(Instant::now()), self.ws.recv()).await {
                Ok(m) => m,
                Err(_) => {
                    self.close(close::POLICY, "handshake timeout").await;
                    return None;
                }
            };
            match self.filter(msg).await {
                Some(In::Text(t)) => return Some(t),
                Some(In::End) => return None,
                None => continue,
            }
        }
    }
}

#[derive(Deserialize)]
struct First {
    t: String,
    room: Option<String>,
    d: Option<String>,
}

#[derive(Deserialize)]
struct Proof {
    t: String,
    sig: String,
}

async fn connection(ws: WebSocket, st: AppState) {
    let cfg = &st.cfg;
    let mut conn = Conn {
        ws,
        bucket: Bucket::new(cfg.rate_per_sec, cfg.bytes_per_sec, cfg.max_frame),
        idle: cfg.idle,
        last_seen: Instant::now(),
    };
    let Some(first) = conn.handshake_frame(cfg.handshake).await else { return };
    let Ok(first) = serde_json::from_str::<First>(first.as_str()) else {
        return conn.close(close::POLICY, "bad first frame").await;
    };
    let Some(room) = first.room.filter(|r| valid_room(r)) else {
        return conn.close(close::POLICY, "bad room").await;
    };
    match first.t.as_str() {
        "host" => host(conn, st.clone(), room, first.d).await,
        "join" => phone(conn, st.clone(), room).await,
        _ => conn.close(close::POLICY, "bad first frame").await,
    }
}

/// Check the host's claim and proof. Returns `false` after closing the connection if either fails.
async fn prove_host(conn: &mut Conn, cfg: &Config, room: &str, d: Option<String>) -> bool {
    let key = d
        .and_then(|d| B64U.decode(d).ok())
        .filter(|b| b.len() == 65 && b[0] == 0x04 && room_for(b) == room)
        .and_then(|b| VerifyingKey::from_sec1_bytes(&b).ok());
    let Some(key) = key else {
        conn.close(close::POLICY, "room does not match key").await;
        return false;
    };
    let mut n = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut n);
    if !conn.send_text(format!(r#"{{"t":"challenge","n":"{}"}}"#, B64U.encode(n))).await {
        return false;
    }
    let Some(frame) = conn.handshake_frame(cfg.handshake).await else { return false };
    // Over the context string and the challenge: a signature over the bare challenge is refused.
    let ok = serde_json::from_str::<Proof>(frame.as_str())
        .ok()
        .filter(|p| p.t == "proof")
        .and_then(|p| B64U.decode(p.sig).ok())
        .and_then(|sig| Signature::from_slice(&sig).ok())
        .is_some_and(|sig| key.verify(&proof_message(&n), &sig).is_ok());
    if !ok {
        conn.close(close::POLICY, "bad proof").await;
    }
    ok
}

async fn host(mut conn: Conn, st: AppState, room: String, d: Option<String>) {
    if !prove_host(&mut conn, &st.cfg, &room, d).await {
        tracing::info!("host refused");
        tracing::debug!(room = short(&room), "host refused");
        return;
    }
    // The host's queue holds every phone's share, plus room for the relay's own notices.
    let budget = st.cfg.queue_bytes.saturating_mul(st.cfg.max_phones + 1);
    let (me, inbox) = new_peer(&st, budget);
    {
        let mut rooms = st.rooms();
        let next_ch = rooms.get(&room).map_or_else(|| rand::thread_rng().gen_range(1..=u64::from(u32::MAX)), |r| r.next_ch);
        let old = rooms.insert(room.clone(), Room { host: me.clone(), phones: HashMap::new(), next_ch });
        if let Some(old) = old {
            old.host.close(close::REPLACED, "replaced by a new host");
            for (ch, p) in &old.phones {
                p.send(closed_notice(*ch));
                p.close(close::NORMAL, "host replaced");
            }
            tracing::info!(phones_closed = old.phones.len(), "host replaced");
        } else {
            tracing::info!(rooms = rooms.len(), "host up");
        }
        tracing::debug!(room = short(&room), "host up");
    }
    // The host is registered: phones can join from now on. Tell it so, and give it the larger budget.
    conn.bucket = Bucket::new(st.cfg.host_rate_per_sec, st.cfg.host_bytes_per_sec, st.cfg.max_frame);
    if conn.send_text(r#"{"t":"ready"}"#.to_string()).await {
        pump(&mut conn, &st, inbox, None, |st, text| {
            #[derive(Deserialize)]
            struct HostFrame<'a> {
                ch: Option<u64>,
                t: Option<&'a str>,
                #[serde(borrow)]
                d: Option<&'a RawValue>,
            }
            let Ok(f) = serde_json::from_str::<HostFrame>(text) else { return Ok(()) };
            let Some(ch) = f.ch else { return Ok(()) };
            let mut rooms = st.rooms();
            // Replaced: the close is already queued for us.
            let Some(r) = rooms.get_mut(&room).filter(|r| r.host.id == me.id) else { return Ok(()) };
            match (f.t, f.d) {
                // Extension: the host drops a channel (for example after revoking the phone).
                (Some("close"), _) => {
                    if let Some(p) = r.phones.remove(&ch) {
                        p.send(closed_notice(ch));
                        p.close(close::NORMAL, "closed by host");
                        tracing::info!(ch, phones = r.phones.len(), "host closed channel");
                    }
                }
                (_, Some(d)) => {
                    if let Some(p) = r.phones.get(&ch) {
                        p.send(d.get().to_owned());
                    }
                }
                _ => {}
            }
            Ok(())
        })
        .await;
    }

    let mut rooms = st.rooms();
    if rooms.get(&room).is_some_and(|r| r.host.id == me.id) {
        let r = rooms.remove(&room).expect("checked above");
        for (ch, p) in &r.phones {
            p.send(closed_notice(*ch));
            p.close(close::NORMAL, "host gone");
        }
        tracing::info!(phones_closed = r.phones.len(), rooms = rooms.len(), "host down");
        tracing::debug!(room = short(&room), "host down");
    }
}

async fn phone(mut conn: Conn, st: AppState, room: String) {
    let (me, inbox) = new_peer(&st, st.cfg.queue_bytes);
    let joined = {
        let mut rooms = st.rooms();
        match rooms.get_mut(&room) {
            None => None,
            Some(r) if r.phones.len() >= st.cfg.max_phones => Some(Err(())),
            Some(r) => {
                let ch = r.next_ch;
                r.next_ch += 1;
                r.phones.insert(ch, me.clone());
                Some(Ok((ch, r.phones.len())))
            }
        }
    };
    let ch = match joined {
        None => {
            tracing::info!("join: offline");
            conn.send_text(r#"{"t":"offline"}"#.into()).await;
            return conn.close(close::NORMAL, "offline").await;
        }
        Some(Err(())) => {
            tracing::info!("join: room full");
            return conn.close(close::POLICY, "room full").await;
        }
        Some(Ok((ch, count))) => {
            tracing::info!(ch, phones = count, "phone joined");
            ch
        }
    };
    // The desktop doesn't know about this channel until the phone sends something: a phone that never does is
    // closed, so a stranger with the room id can't sit on one of its slots (P5, the relay's half).
    let speak_by = Instant::now() + st.cfg.phone_silence;
    if !conn.send_text(format!(r#"{{"t":"joined","ch":{ch}}}"#)).await {
        leave_phone(&st, &room, ch, me.id);
        return;
    }

    // Bytes this phone has queued for its host and not yet delivered.
    let inflight = Arc::new(AtomicUsize::new(0));
    let share = st.cfg.queue_bytes;
    pump(&mut conn, &st, inbox, Some(speak_by), |st, text| {
        let Ok(d) = serde_json::from_str::<&RawValue>(text) else { return Err("bad frame") };
        let rooms = st.rooms();
        // Gone from the room: a closed notice and a close are already queued for us.
        let Some(r) = rooms.get(&room).filter(|r| r.phones.get(&ch).is_some_and(|p| p.id == me.id)) else {
            return Ok(());
        };
        // A host that isn't keeping up is not cut off because of one phone: the phone that is sending faster
        // than the host reads is closed instead, and the host and the other phones carry on.
        if r.host.queue(format!(r#"{{"ch":{ch},"d":{}}}"#, d.get()), Some((&inflight, share))) {
            Ok(())
        } else {
            Err("host busy")
        }
    })
    .await;

    leave_phone(&st, &room, ch, me.id);
}

fn leave_phone(st: &AppState, room: &str, ch: u64, id: u64) {
    let mut rooms = st.rooms();
    if let Some(r) = rooms.get_mut(room) {
        if r.phones.get(&ch).is_some_and(|p| p.id == id) {
            r.phones.remove(&ch);
            r.host.send(closed_notice(ch));
            tracing::info!(ch, phones = r.phones.len(), "phone left");
        }
    }
}

fn new_peer(st: &AppState, budget: usize) -> (Peer, Inbox) {
    let (tx, rx) = mpsc::channel(256);
    let kill = Arc::new(Notify::new());
    let queued = Arc::new(AtomicUsize::new(0));
    let id = st.next_id.fetch_add(1, Ordering::Relaxed);
    (Peer { id, tx, kill: kill.clone(), queued: queued.clone(), budget }, Inbox { rx, kill, queued })
}

/// The forwarding loop shared by hosts and phones. `on_text` handles one inbound text frame; `Err(reason)` ends
/// the connection with a policy close. With `speak_by`, the peer must send a text frame by then (pings and pongs
/// don't count) or it is closed as silent.
async fn pump<F>(conn: &mut Conn, st: &AppState, mut inbox: Inbox, mut speak_by: Option<Instant>, mut on_text: F)
where
    F: FnMut(&AppState, &str) -> Result<(), &'static str>,
{
    let mut ping = tokio::time::interval(st.cfg.ping);
    ping.set_missed_tick_behavior(MissedTickBehavior::Delay);
    ping.tick().await; // the first tick is immediate
    loop {
        let idle_at = conn.last_seen + conn.idle;
        let silent_at = speak_by.unwrap_or(idle_at);
        tokio::select! {
            msg = conn.ws.recv() => match conn.filter(msg).await {
                Some(In::Text(t)) => {
                    speak_by = None;
                    if let Err(reason) = on_text(st, t.as_str()) {
                        conn.close(close::POLICY, reason).await;
                        return;
                    }
                }
                Some(In::End) => return,
                None => {}
            },
            out = inbox.rx.recv() => match out {
                Some(Out::Text(t, credit)) => {
                    inbox.queued.fetch_sub(t.len(), Ordering::AcqRel);
                    if let Some(c) = credit {
                        c.fetch_sub(t.len(), Ordering::AcqRel);
                    }
                    if !conn.send_text(t).await {
                        return;
                    }
                }
                Some(Out::Close(code, reason)) => return conn.close(code, reason).await,
                None => return,
            },
            _ = inbox.kill.notified() => return conn.close(close::POLICY, "reader too slow").await,
            _ = ping.tick() => if !conn.send(Message::Ping(Default::default())).await { return },
            _ = sleep_until(silent_at), if speak_by.is_some() => return conn.close(close::POLICY, "silent").await,
            _ = sleep_until(idle_at) => return conn.close(close::NORMAL, "idle").await,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn peer(budget: usize) -> (Peer, Inbox) {
        let (tx, rx) = mpsc::channel(256);
        let kill = Arc::new(Notify::new());
        let queued = Arc::new(AtomicUsize::new(0));
        (Peer { id: 1, tx, kill: kill.clone(), queued: queued.clone(), budget }, Inbox { rx, kill, queued })
    }

    #[test]
    fn queue_is_bounded_by_bytes_and_credited_on_the_way_out() {
        let (p, mut inbox) = peer(100);
        assert!(p.queue("a".repeat(60), None));
        assert!(!p.queue("b".repeat(41), None), "60 + 41 is over the budget");
        assert!(p.queue("c".repeat(40), None), "60 + 40 fits exactly");
        assert_eq!(inbox.queued.load(Ordering::Acquire), 100);
        // What the pump does when a frame leaves.
        let Some(Out::Text(t, None)) = inbox.rx.try_recv().ok() else { panic!("a text frame") };
        inbox.queued.fetch_sub(t.len(), Ordering::AcqRel);
        assert!(p.queue("d".repeat(60), None), "room again once the first frame left");
    }

    #[test]
    fn a_senders_share_is_bounded_too() {
        let (host, mut inbox) = peer(1000);
        let inflight = Arc::new(AtomicUsize::new(0));
        assert!(host.queue("a".repeat(30), Some((&inflight, 50))));
        assert!(!host.queue("b".repeat(30), Some((&inflight, 50))), "the phone's share is 50");
        assert_eq!(inflight.load(Ordering::Acquire), 30);
        assert_eq!(inbox.queued.load(Ordering::Acquire), 30, "a refused frame leaves no charge behind");
        let Some(Out::Text(t, Some(c))) = inbox.rx.try_recv().ok() else { panic!("a text frame with a credit") };
        c.fetch_sub(t.len(), Ordering::AcqRel);
        assert_eq!(inflight.load(Ordering::Acquire), 0);
    }

    #[test]
    fn a_full_queue_kills_a_reader_that_must_keep_up() {
        let (p, inbox) = peer(10);
        p.send("x".repeat(11));
        // The kill permit is stored for the pump to pick up.
        let rt = tokio::runtime::Builder::new_current_thread().enable_time().build().unwrap();
        rt.block_on(async {
            assert!(timeout(Duration::from_millis(100), inbox.kill.notified()).await.is_ok());
        });
    }

    #[test]
    fn byte_bucket() {
        let mut b = Bucket::new(100, 1000, 1000);
        assert!(b.take(1500));
        assert!(b.take(500), "the burst is two frames, 2000 bytes");
        assert!(!b.take(100), "empty now");
    }

    #[test]
    fn origins() {
        let allowed = vec!["https://app.example".to_string()];
        let h = |s: &'static str| HeaderValue::from_static(s);
        assert!(origin_allowed(&allowed, None), "the desktop sends no Origin");
        assert!(origin_allowed(&allowed, Some(&h("https://app.example"))));
        assert!(origin_allowed(&allowed, Some(&h("https://APP.example"))));
        assert!(!origin_allowed(&allowed, Some(&h("https://evil.example"))));
        assert!(!origin_allowed(&allowed, Some(&h("null"))));
        assert!(!origin_allowed(&allowed, Some(&h("https://app.example.evil.example"))));
        assert!(origin_allowed(&[], Some(&h("https://anything.example"))), "no list: any origin");
    }
}
