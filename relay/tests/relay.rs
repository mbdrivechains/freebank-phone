//! Integration tests: start the relay on an ephemeral loopback port and drive it with tokio-tungstenite clients.

use std::{net::SocketAddr, time::Duration};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64U, Engine};
use fb_relay::{close, proof_message, room_for, Config, Stats, PROOF_CONTEXT};
use futures_util::{SinkExt, StreamExt};
use p256::ecdsa::{
    signature::{Signer, Verifier},
    Signature, SigningKey, VerifyingKey,
};
use serde_json::{json, Value};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpSocket, TcpStream},
    time::timeout,
};
use tokio_tungstenite::{
    client_async, connect_async,
    tungstenite::{client::IntoClientRequest, protocol::CloseFrame, Error as WsError, Message},
    MaybeTlsStream, WebSocketStream,
};

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

const T: Duration = Duration::from_secs(5);

fn tmp() -> &'static std::path::Path {
    std::path::Path::new(env!("CARGO_TARGET_TMPDIR"))
}

fn static_dir() -> std::path::PathBuf {
    let dir = tmp().join("fb-relay-static");
    std::fs::create_dir_all(dir.join("assets")).unwrap();
    std::fs::write(dir.join("index.html"), "<!doctype html><title>phone</title><script src=\"/app.js\"></script>").unwrap();
    std::fs::write(dir.join("app.js"), "console.log(1)").unwrap();
    std::fs::write(dir.join("assets/index-abc123.js"), "console.log(2)").unwrap();
    // A file beside the static directory that no request may reach.
    std::fs::write(tmp().join("fb-relay-secret.txt"), "TOPSECRET").unwrap();
    dir
}

async fn start(cfg: Config) -> SocketAddr {
    start_with_stats(cfg).await.0
}

async fn start_with_stats(cfg: Config) -> (SocketAddr, Stats) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let (router, stats) = fb_relay::app(cfg);
    tokio::spawn(async move { axum::serve(listener, router).await });
    (addr, stats)
}

async fn start_default() -> SocketAddr {
    start(Config { static_dir: static_dir(), ..Config::default() }).await
}

async fn connect(addr: SocketAddr) -> Ws {
    connect_async(format!("ws://{addr}/ws")).await.unwrap().0
}

/// Open /ws with an `Origin` header; the HTTP status if the relay refused the upgrade.
async fn connect_origin(addr: SocketAddr, origin: &str) -> Result<Ws, u16> {
    let mut req = format!("ws://{addr}/ws").into_client_request().unwrap();
    req.headers_mut().insert("origin", origin.parse().unwrap());
    match connect_async(req).await {
        Ok((ws, _)) => Ok(ws),
        Err(WsError::Http(r)) => Err(r.status().as_u16()),
        Err(e) => panic!("unexpected error {e}"),
    }
}

/// Wait until `cond` holds (for state the relay updates when a task ends).
async fn until(mut cond: impl FnMut() -> bool) {
    for _ in 0..200 {
        if cond() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("condition never held");
}

async fn send(ws: &mut Ws, v: Value) {
    ws.send(Message::Text(v.to_string().into())).await.unwrap();
}

/// Next text frame as JSON; panics on close or timeout.
async fn recv(ws: &mut Ws) -> Value {
    loop {
        match timeout(T, ws.next()).await.expect("timed out").expect("stream ended").expect("ws error") {
            Message::Text(t) => return serde_json::from_str(t.as_str()).unwrap(),
            Message::Ping(_) | Message::Pong(_) => continue,
            other => panic!("expected text, got {other:?}"),
        }
    }
}

/// Wait for the connection to end. Returns the close code if a close frame came.
async fn closed(ws: &mut Ws) -> Option<u16> {
    loop {
        match timeout(T, ws.next()).await.expect("timed out waiting for close") {
            Some(Ok(Message::Close(Some(CloseFrame { code, .. })))) => return Some(code.into()),
            Some(Ok(Message::Close(None))) | None | Some(Err(_)) => return None,
            Some(Ok(Message::Text(t))) => panic!("expected close, got text {t}"),
            Some(Ok(_)) => continue,
        }
    }
}

struct Desk {
    key: SigningKey,
    d: String,
    room: String,
}

fn desk() -> Desk {
    let key = SigningKey::random(&mut rand::rngs::OsRng);
    let pubkey = key.verifying_key().to_encoded_point(false);
    Desk { d: B64U.encode(pubkey.as_bytes()), room: room_for(pubkey.as_bytes()), key }
}

/// Connect as host and answer the challenge with `signer`'s signature over `fb-relay-proof-v1` || n.
async fn host_with(addr: SocketAddr, desk: &Desk, signer: &SigningKey) -> Ws {
    host_signing(addr, desk, |n| signer.sign(&proof_message(n))).await
}

/// Connect as host and answer the challenge with whatever `sign` makes of the 32 challenge bytes.
async fn host_signing(addr: SocketAddr, desk: &Desk, sign: impl Fn(&[u8]) -> Signature) -> Ws {
    let mut ws = connect(addr).await;
    send(&mut ws, json!({"t":"host","room":desk.room,"d":desk.d})).await;
    let ch = recv(&mut ws).await;
    assert_eq!(ch["t"], "challenge");
    let n = B64U.decode(ch["n"].as_str().unwrap()).unwrap();
    assert_eq!(n.len(), 32);
    let sig = sign(&n);
    assert_eq!(sig.to_bytes().len(), 64);
    send(&mut ws, json!({"t":"proof","sig":B64U.encode(sig.to_bytes())})).await;
    ws
}

async fn host(addr: SocketAddr, desk: &Desk) -> Ws {
    let mut ws = host_with(addr, desk, &desk.key).await;
    let r = recv(&mut ws).await;
    assert_eq!(r["t"], "ready", "a proven host is told it is ready");
    ws
}

/// A proven host whose socket has a small receive buffer, so the relay's writes to it block soon once the test
/// stops reading.
async fn slow_host(addr: SocketAddr, desk: &Desk) -> Ws {
    let sock = TcpSocket::new_v4().unwrap();
    sock.set_recv_buffer_size(4096).unwrap();
    let stream = sock.connect(addr).await.unwrap();
    let (mut ws, _) = client_async(format!("ws://{addr}/ws"), MaybeTlsStream::Plain(stream)).await.unwrap();
    send(&mut ws, json!({"t":"host","room":desk.room,"d":desk.d})).await;
    let ch = recv(&mut ws).await;
    let sig: Signature = desk.key.sign(&proof_message(&B64U.decode(ch["n"].as_str().unwrap()).unwrap()));
    send(&mut ws, json!({"t":"proof","sig":B64U.encode(sig.to_bytes())})).await;
    assert_eq!(recv(&mut ws).await["t"], "ready");
    ws
}

/// Join a room, retrying briefly while the host's proof is still being processed (the relay sends no ack).
async fn join(addr: SocketAddr, room: &str) -> (Ws, u64) {
    for _ in 0..50 {
        let mut ws = connect(addr).await;
        send(&mut ws, json!({"t":"join","room":room})).await;
        let r = recv(&mut ws).await;
        if r["t"] == "joined" {
            return (ws, r["ch"].as_u64().unwrap());
        }
        assert_eq!(r["t"], "offline");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("never joined");
}

#[tokio::test]
async fn host_proves_and_phone_exchanges_both_ways() {
    let addr = start_default().await;
    let d = desk();
    let mut h = host(addr, &d).await;
    let (mut p, ch) = join(addr, &d.room).await;

    let hello = json!({"t":"hello","p":"AAAA","e":"BBBB"});
    send(&mut p, hello.clone()).await;
    assert_eq!(recv(&mut h).await, json!({"ch":ch,"d":hello}));

    let reply = json!({"t":"hello-ok","e":"CCCC"});
    send(&mut h, json!({"ch":ch,"d":reply})).await;
    assert_eq!(recv(&mut p).await, reply);

    // Non-object JSON values pass through too, byte for byte.
    p.send(Message::Text("[1,2,\"x\"]".into())).await.unwrap();
    assert_eq!(recv(&mut h).await, json!({"ch":ch,"d":[1,2,"x"]}));

    // A second phone gets its own channel, and frames stay on their channel.
    let (mut p2, ch2) = join(addr, &d.room).await;
    assert_ne!(ch, ch2);
    send(&mut h, json!({"ch":ch2,"d":{"to":2}})).await;
    send(&mut h, json!({"ch":ch,"d":{"to":1}})).await;
    assert_eq!(recv(&mut p2).await, json!({"to":2}));
    assert_eq!(recv(&mut p).await, json!({"to":1}));
}

#[tokio::test]
async fn wrong_room_is_rejected() {
    let addr = start_default().await;
    let d = desk();
    let other = desk();
    let mut ws = connect(addr).await;
    send(&mut ws, json!({"t":"host","room":other.room,"d":d.d})).await;
    assert_eq!(closed(&mut ws).await, Some(close::POLICY));
}

#[tokio::test]
async fn unproven_host_is_rejected_and_room_stays_offline() {
    let addr = start_default().await;
    let d = desk();
    let impostor = SigningKey::random(&mut rand::rngs::OsRng);
    let mut h = host_with(addr, &d, &impostor).await;
    assert_eq!(closed(&mut h).await, Some(close::POLICY));

    // Garbage in place of a signature is refused too.
    let mut ws = connect(addr).await;
    send(&mut ws, json!({"t":"host","room":d.room,"d":d.d})).await;
    assert_eq!(recv(&mut ws).await["t"], "challenge");
    send(&mut ws, json!({"t":"proof","sig":"AAAA"})).await;
    assert_eq!(closed(&mut ws).await, Some(close::POLICY));

    let mut p = connect(addr).await;
    send(&mut p, json!({"t":"join","room":d.room})).await;
    assert_eq!(recv(&mut p).await, json!({"t":"offline"}));
}

#[tokio::test]
async fn a_proof_over_the_bare_challenge_is_refused() {
    let addr = start_default().await;
    let d = desk();
    // The right key, signing the challenge alone: the form before the context string (security review, P4).
    let mut h = host_signing(addr, &d, |n| d.key.sign(n)).await;
    assert_eq!(closed(&mut h).await, Some(close::POLICY));
    // The context string on its own isn't enough either; the challenge has to follow it.
    let mut h = host_signing(addr, &d, |_| d.key.sign(PROOF_CONTEXT)).await;
    assert_eq!(closed(&mut h).await, Some(close::POLICY));
    // Over `fb-relay-proof-v1` || n, the same key is accepted.
    let _h = host(addr, &d).await;
}

/// `relay/testvectors/kk-v1.json`: the room, and the host proof's message and signature.
#[test]
fn vectors_room_and_proof() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("testvectors/kk-v1.json");
    let v: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let b64 = |s: &Value| B64U.decode(s.as_str().unwrap()).unwrap();
    let hex = |b: &[u8]| b.iter().map(|x| format!("{x:02x}")).collect::<String>();
    let d_pub = b64(&v["keys"]["D"]["pub"]);
    assert_eq!(room_for(&d_pub), v["room"]["room"].as_str().unwrap());

    let p = &v["proof"];
    assert_eq!(p["context"].as_str().unwrap().as_bytes(), PROOF_CONTEXT);
    let n = b64(&p["n"]);
    assert_eq!(n.len(), 32);
    let msg = proof_message(&n);
    assert_eq!(hex(&msg), p["msg_hex"].as_str().unwrap());
    // p256 signs deterministically (RFC 6979), so D's signature over the message is exactly the vector's.
    let key = SigningKey::from_slice(&b64(&v["keys"]["D"]["jwk"]["d"])).unwrap();
    assert_eq!(key.verifying_key().to_encoded_point(false).as_bytes(), &d_pub[..]);
    let sig: Signature = key.sign(&msg);
    assert_eq!(B64U.encode(sig.to_bytes()), p["sig"].as_str().unwrap(), "the RFC 6979 signature over the message");
    let vk = VerifyingKey::from_sec1_bytes(&d_pub).unwrap();
    let vsig = Signature::from_slice(&b64(&p["sig"])).unwrap();
    assert!(vk.verify(&msg, &vsig).is_ok());
    assert!(vk.verify(&n, &vsig).is_err(), "it is not a signature over the bare challenge");
    assert_eq!(p["frame"], json!({"t":"proof","sig":p["sig"]}));
}

#[tokio::test]
async fn offline_when_no_host() {
    let addr = start_default().await;
    let mut p = connect(addr).await;
    send(&mut p, json!({"t":"join","room":desk().room})).await;
    assert_eq!(recv(&mut p).await, json!({"t":"offline"}));
    assert_eq!(closed(&mut p).await, Some(close::NORMAL));
}

#[tokio::test]
async fn bad_first_frame_is_rejected() {
    let addr = start_default().await;
    let mut ws = connect(addr).await;
    send(&mut ws, json!({"t":"join","room":"short"})).await;
    assert_eq!(closed(&mut ws).await, Some(close::POLICY));
    let mut ws = connect(addr).await;
    ws.send(Message::Text("not json".into())).await.unwrap();
    assert_eq!(closed(&mut ws).await, Some(close::POLICY));
}

#[tokio::test]
async fn oversize_frame_closes_and_host_is_told() {
    let addr = start_default().await;
    let d = desk();
    let mut h = host(addr, &d).await;
    let (mut p, ch) = join(addr, &d.room).await;
    let big = Value::String("x".repeat(70 * 1024));
    let _ = p.send(Message::Text(big.to_string().into())).await;
    let code = closed(&mut p).await;
    assert!(code.is_none() || code == Some(close::TOO_BIG), "got {code:?}");
    assert_eq!(recv(&mut h).await, json!({"t":"closed","ch":ch}));

    // A frame just under the limit still passes.
    let (mut p, ch) = join(addr, &d.room).await;
    let ok = Value::String("y".repeat(60 * 1024));
    send(&mut p, ok.clone()).await;
    assert_eq!(recv(&mut h).await, json!({"ch":ch,"d":ok}));
}

#[tokio::test]
async fn rate_limit_closes() {
    let addr = start(Config { static_dir: static_dir(), rate_per_sec: 5, ..Config::default() }).await;
    let d = desk();
    let _h = host(addr, &d).await;
    let (mut p, _) = join(addr, &d.room).await;
    for i in 0..10 {
        if p.send(Message::Text(json!({"i":i}).to_string().into())).await.is_err() {
            break;
        }
    }
    assert_eq!(closed(&mut p).await, Some(close::POLICY));
}

#[tokio::test]
async fn room_full() {
    let addr = start(Config { static_dir: static_dir(), max_phones: 2, ..Config::default() }).await;
    let d = desk();
    let _h = host(addr, &d).await;
    let _p1 = join(addr, &d.room).await;
    let _p2 = join(addr, &d.room).await;
    let mut p3 = connect(addr).await;
    send(&mut p3, json!({"t":"join","room":d.room})).await;
    assert_eq!(closed(&mut p3).await, Some(close::POLICY));
}

#[tokio::test]
async fn a_silent_phone_is_closed() {
    let addr = start(Config {
        static_dir: static_dir(),
        phone_silence: Duration::from_millis(400),
        ping: Duration::from_millis(100), // pinged often: the silent phone's pongs must not count as frames
        ..Config::default()
    })
    .await;
    let d = desk();
    let mut h = host(addr, &d).await;

    // A phone that joins and says nothing (it answers pings while it reads) is closed with 1008 after the deadline.
    let (mut silent, ch) = join(addr, &d.room).await;
    let t0 = std::time::Instant::now();
    let mut pings = 0;
    // One deadline for the whole wait: the relay's pings would otherwise keep a per-read timeout from firing.
    let code = timeout(T, async {
        loop {
            match silent.next().await {
                Some(Ok(Message::Ping(_))) => pings += 1,
                Some(Ok(Message::Close(f))) => break f.map(|f| u16::from(f.code)),
                Some(Ok(other)) => panic!("unexpected {other:?}"),
                Some(Err(_)) | None => break None,
            }
        }
    })
    .await
    .expect("a silent phone is closed well within 5 s");
    assert_eq!(code, Some(close::POLICY), "closed as silent");
    assert!(pings >= 2, "it was pinged, and its pongs went back ({pings} pings)");
    assert!(t0.elapsed() >= Duration::from_millis(300), "not before the deadline: {:?}", t0.elapsed());
    // Its slot is free again, and the host hears the channel closed.
    assert_eq!(recv(&mut h).await, json!({"t":"closed","ch":ch}));

    // A phone that speaks in time stays past the deadline.
    let (mut p, ch2) = join(addr, &d.room).await;
    send(&mut p, json!({"t":"hello"})).await;
    assert_eq!(recv(&mut h).await, json!({"ch":ch2,"d":{"t":"hello"}}));
    tokio::time::sleep(Duration::from_millis(800)).await;
    send(&mut p, json!({"t":"m"})).await;
    assert_eq!(recv(&mut h).await, json!({"ch":ch2,"d":{"t":"m"}}));
}

#[tokio::test]
async fn binary_frames_are_refused() {
    let addr = start_default().await;
    let d = desk();
    let _h = host(addr, &d).await;
    let (mut p, _) = join(addr, &d.room).await;
    p.send(Message::Binary(vec![1, 2, 3].into())).await.unwrap();
    assert_eq!(closed(&mut p).await, Some(close::UNSUPPORTED));
}

#[tokio::test]
async fn new_host_replaces_old_one() {
    let addr = start_default().await;
    let d = desk();
    let mut h1 = host(addr, &d).await;
    let (mut p, ch) = join(addr, &d.room).await;

    let mut h2 = host(addr, &d).await;
    assert_eq!(closed(&mut h1).await, Some(close::REPLACED));
    assert_eq!(recv(&mut p).await, json!({"t":"closed","ch":ch}));
    assert_eq!(closed(&mut p).await, Some(close::NORMAL));

    let (mut p2, ch2) = join(addr, &d.room).await;
    assert_ne!(ch, ch2, "channel numbers are not reused");
    send(&mut p2, json!({"t":"hello"})).await;
    assert_eq!(recv(&mut h2).await, json!({"ch":ch2,"d":{"t":"hello"}}));
    send(&mut h2, json!({"ch":ch2,"d":{"t":"hello-ok"}})).await;
    assert_eq!(recv(&mut p2).await, json!({"t":"hello-ok"}));
}

#[tokio::test]
async fn closed_notices_both_ways() {
    let addr = start_default().await;
    let d = desk();
    let mut h = host(addr, &d).await;

    // Phone leaves: the host hears about its channel.
    let (mut p, ch) = join(addr, &d.room).await;
    p.close(None).await.unwrap();
    assert_eq!(recv(&mut h).await, json!({"t":"closed","ch":ch}));

    // The host drops one channel (extension: {"t":"close","ch":n}).
    let (mut p, ch) = join(addr, &d.room).await;
    send(&mut h, json!({"t":"close","ch":ch})).await;
    assert_eq!(recv(&mut p).await, json!({"t":"closed","ch":ch}));
    assert_eq!(closed(&mut p).await, Some(close::NORMAL));

    // Host leaves: each phone hears about its own channel, then the room is offline.
    let (mut p1, ch1) = join(addr, &d.room).await;
    let (mut p2, ch2) = join(addr, &d.room).await;
    h.close(None).await.unwrap();
    assert_eq!(recv(&mut p1).await, json!({"t":"closed","ch":ch1}));
    assert_eq!(recv(&mut p2).await, json!({"t":"closed","ch":ch2}));
    assert_eq!(closed(&mut p1).await, Some(close::NORMAL));

    let mut p3 = connect(addr).await;
    send(&mut p3, json!({"t":"join","room":d.room})).await;
    assert_eq!(recv(&mut p3).await, json!({"t":"offline"}));
}

#[tokio::test]
async fn idle_connection_is_closed() {
    let addr = start(Config {
        static_dir: static_dir(),
        idle: Duration::from_millis(300),
        ping: Duration::from_millis(100),
        ..Config::default()
    })
    .await;
    let d = desk();
    let mut h = host(addr, &d).await;
    let (mut p, ch) = join(addr, &d.room).await;
    // Neither side reads, so no pongs go back.
    tokio::time::sleep(Duration::from_millis(600)).await;
    // The relay pinged, then closed with "idle". The client may see the close frame, or, when it tries to
    // answer a queued ping after the relay has gone, a broken pipe.
    let mut pings = 0;
    let code = loop {
        match timeout(T, p.next()).await.unwrap() {
            Some(Ok(Message::Ping(_))) => pings += 1,
            Some(Ok(Message::Close(f))) => break f.map(|f| u16::from(f.code)),
            Some(Err(_)) | None => break None,
            other => panic!("unexpected {other:?}"),
        }
    };
    assert!(pings >= 1, "relay pings");
    assert!(code.is_none() || code == Some(close::NORMAL), "got {code:?}");
    let _ = ch;
    let _ = closed(&mut h).await;
}

async fn http_get(addr: SocketAddr, path: &str) -> String {
    let mut s = TcpStream::connect(addr).await.unwrap();
    s.write_all(format!("GET {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
    let mut out = String::new();
    s.read_to_string(&mut out).await.unwrap();
    out
}

/// The value of one response header (lower-cased name), if present.
fn header_of(r: &str, name: &str) -> Option<String> {
    let head = r.split("\r\n\r\n").next().unwrap();
    head.lines().skip(1).find_map(|l| {
        let (k, v) = l.split_once(':')?;
        k.trim().eq_ignore_ascii_case(name).then(|| v.trim().to_string())
    })
}

#[tokio::test]
async fn static_files_with_security_headers() {
    let addr = start_default().await;
    for path in ["/", "/some/app/route", "/app.js", "/assets/index-abc123.js"] {
        let r = http_get(addr, path).await;
        assert!(r.starts_with("HTTP/1.1 200"), "{path}: {r}");
        assert_eq!(header_of(&r, "content-security-policy").as_deref(), Some(fb_relay::CSP), "{path}");
        let csp = fb_relay::CSP;
        assert!(!csp.contains("unsafe-inline") && !csp.contains("data:") && csp.contains("frame-ancestors 'none'"));
        assert_eq!(header_of(&r, "x-content-type-options").as_deref(), Some("nosniff"));
        assert_eq!(header_of(&r, "referrer-policy").as_deref(), Some("no-referrer"));
        assert_eq!(header_of(&r, "x-frame-options").as_deref(), Some("DENY"));
        assert_eq!(header_of(&r, "permissions-policy").as_deref(), Some(fb_relay::PERMISSIONS_POLICY));
        assert_eq!(header_of(&r, "cross-origin-opener-policy").as_deref(), Some("same-origin"));
        assert_eq!(header_of(&r, "cross-origin-resource-policy").as_deref(), Some("same-origin"));
    }
    for path in ["/", "/some/app/route"] {
        let r = http_get(addr, path).await;
        assert!(r.contains("<title>phone</title>"), "{path} falls back to index.html");
        assert!(header_of(&r, "content-type").unwrap().starts_with("text/html"));
        assert_eq!(header_of(&r, "cache-control").as_deref(), Some("no-cache"), "the page is checked on each load");
    }
    let r = http_get(addr, "/app.js").await;
    assert!(r.ends_with("console.log(1)"));
    assert!(header_of(&r, "content-type").unwrap().contains("javascript"));
    assert_eq!(header_of(&r, "cache-control").as_deref(), Some("no-cache"));
    let r = http_get(addr, "/assets/index-abc123.js").await;
    assert!(r.ends_with("console.log(2)"));
    assert_eq!(header_of(&r, "cache-control").as_deref(), Some("public, max-age=31536000, immutable"));
    // A missing asset falls back to the page, which must not be cached as that asset.
    let r = http_get(addr, "/assets/missing-000.js").await;
    assert_eq!(header_of(&r, "cache-control").as_deref(), Some("no-cache"));
}

#[tokio::test]
async fn no_path_traversal() {
    let addr = start_default().await;
    for path in [
        "/../fb-relay-secret.txt",
        "/%2e%2e/fb-relay-secret.txt",
        "/%2E%2E%2Ffb-relay-secret.txt",
        "/..%2ffb-relay-secret.txt",
        "/assets/../../fb-relay-secret.txt",
        "/assets/%2e%2e/%2e%2e/fb-relay-secret.txt",
        "/.%2e/fb-relay-secret.txt",
        "//fb-relay-secret.txt",
        "/..\\fb-relay-secret.txt",
    ] {
        let r = http_get(addr, path).await;
        assert!(!r.contains("TOPSECRET"), "{path} escaped the static directory: {r}");
    }
}

#[tokio::test]
async fn origin_allowlist() {
    let addr = start(Config {
        static_dir: static_dir(),
        origins: vec!["https://app.example".into()],
        ..Config::default()
    })
    .await;
    assert_eq!(connect_origin(addr, "https://evil.example").await.err(), Some(403));
    assert_eq!(connect_origin(addr, "null").await.err(), Some(403));
    let d = desk();
    let mut h = host(addr, &d).await; // no Origin header: the desktop app
    let mut p = connect_origin(addr, "https://app.example").await.expect("the page's own origin");
    send(&mut p, json!({"t":"join","room":d.room})).await;
    let ch = recv(&mut p).await["ch"].clone();
    send(&mut p, json!({"t":"hello"})).await;
    assert_eq!(recv(&mut h).await, json!({"ch":ch,"d":{"t":"hello"}}));
}

#[tokio::test]
async fn connection_cap_and_slots_come_back() {
    let (addr, stats) = start_with_stats(Config { static_dir: static_dir(), max_conns: 2, ..Config::default() }).await;
    let d = desk();
    let h = host(addr, &d).await;
    let (p, _) = join(addr, &d.room).await;
    assert_eq!(stats.connections(), 2);
    assert_eq!(connect_origin(addr, "http://x.example").await.err(), Some(503), "a third connection waits");
    drop(p);
    until(|| stats.connections() == 1).await;
    let (_p, _) = join(addr, &d.room).await;
    drop(h);
}

#[tokio::test]
async fn rooms_go_away_with_their_host() {
    let (addr, stats) = start_with_stats(Config { static_dir: static_dir(), ..Config::default() }).await;
    // Many hosts with fresh keys come and go; nothing about their rooms stays behind.
    for _ in 0..20 {
        let d = desk();
        let mut h = host(addr, &d).await;
        let (p, _) = join(addr, &d.room).await;
        drop(p);
        h.close(None).await.unwrap();
    }
    until(|| stats.rooms() == 0 && stats.connections() == 0).await;
}

#[tokio::test]
async fn channel_numbers_count_up_within_a_room() {
    let addr = start_default().await;
    let d = desk();
    let _h = host(addr, &d).await;
    let (_p1, ch1) = join(addr, &d.room).await;
    let (_p2, ch2) = join(addr, &d.room).await;
    assert_eq!(ch2, ch1 + 1);
    assert!(ch1 >= 1 && ch2 <= u64::from(u32::MAX) + 1);
    // Another room starts somewhere else (a random start), so numbers say nothing about other rooms.
    let e = desk();
    let _h2 = host(addr, &e).await;
    let (_p3, ch3) = join(addr, &e.room).await;
    assert_ne!(ch3, ch2 + 1);
}

#[tokio::test]
async fn byte_rate_limit_closes() {
    let addr = start(Config { static_dir: static_dir(), bytes_per_sec: 16 * 1024, ..Config::default() }).await;
    let d = desk();
    let _h = host(addr, &d).await;
    let (mut p, _) = join(addr, &d.room).await;
    // The burst is two 64 KiB frames; three big frames in a row go over it.
    let big = Value::String("z".repeat(60 * 1024)).to_string();
    for _ in 0..3 {
        if p.send(Message::Text(big.clone().into())).await.is_err() {
            break;
        }
    }
    let code = closed(&mut p).await;
    assert!(code.is_none() || code == Some(close::POLICY), "got {code:?}");
}

#[tokio::test]
async fn pong_floods_are_rate_limited() {
    let addr = start(Config { static_dir: static_dir(), rate_per_sec: 5, ..Config::default() }).await;
    let d = desk();
    let _h = host(addr, &d).await;
    let (mut p, _) = join(addr, &d.room).await;
    for _ in 0..10 {
        if p.send(Message::Pong(vec![0; 8].into())).await.is_err() {
            break;
        }
    }
    assert_eq!(closed(&mut p).await, Some(close::POLICY));
}

#[tokio::test]
async fn a_flooding_phone_is_cut_off_not_the_host() {
    let addr = start(Config {
        static_dir: static_dir(),
        rate_per_sec: 10_000,
        bytes_per_sec: 256 << 20,
        queue_bytes: 32 * 1024,
        ..Config::default()
    })
    .await;
    let d = desk();
    let mut h = slow_host(addr, &d).await;
    let (mut p, ch) = join(addr, &d.room).await;
    // The host stops reading. The phone floods it until the relay closes the phone.
    let blob = "x".repeat(16 * 1024);
    let mut cut = false;
    for i in 0..4000 {
        if p.send(Message::Text(json!({"i":i,"b":blob}).to_string().into())).await.is_err() {
            cut = true;
            break;
        }
    }
    if !cut {
        let code = closed(&mut p).await;
        assert!(code.is_none() || code == Some(close::POLICY), "got {code:?}");
    }
    // The host reads again: what was queued, then the notice that the phone left, and it is still up.
    loop {
        let f = recv(&mut h).await;
        if f["t"] == "closed" {
            assert_eq!(f["ch"], ch);
            break;
        }
        assert_eq!(f["ch"], ch);
    }
    let (mut p2, ch2) = join(addr, &d.room).await;
    send(&mut p2, json!({"t":"hello"})).await;
    assert_eq!(recv(&mut h).await, json!({"ch":ch2,"d":{"t":"hello"}}));
}

#[tokio::test]
async fn deeply_nested_json_passes_through() {
    let addr = start_default().await;
    let d = desk();
    let mut h = host(addr, &d).await;
    let (mut p, ch) = join(addr, &d.room).await;
    // Far deeper than serde_json's recursion limit; the relay only checks it is JSON and must not overflow.
    let deep = format!("{}{}", "[".repeat(30_000), "]".repeat(30_000));
    p.send(Message::Text(deep.clone().into())).await.unwrap();
    let frame = loop {
        match timeout(T, h.next()).await.unwrap().unwrap().unwrap() {
            Message::Text(t) => break t.to_string(),
            _ => continue,
        }
    };
    assert_eq!(frame, format!(r#"{{"ch":{ch},"d":{deep}}}"#));
    // And the relay is fine afterwards.
    send(&mut p, json!({"t":"hello"})).await;
    assert_eq!(recv(&mut h).await, json!({"ch":ch,"d":{"t":"hello"}}));
}
