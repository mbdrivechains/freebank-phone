# fb-relay — the FreeBank phone relay

The relay half of `PROTOCOL.md` ("The relay"): a dumb WebSocket pipe at `GET /ws` between one proven desktop
(the host) and up to 8 phones per room, plus a static file server for the phone page at `/`. It never reads,
stores or logs frame contents or addresses; at `info` the logs carry counts and channel numbers, and the room
prefix (first 6 chars) only at `debug`.

With `--feedback-dir` it also takes "Send to FreeBank" reports at `POST /feedback` (from the app's v0.2.1 and the
phone page) and keeps each as an owner-only file there (`src/feedback.rs`).

Security review and deployment: `SECURITY_REVIEW.md`, `deploy/` (systemd unit, nginx site).

## Build and test

```bash
cd relay
cargo build -j2 --release        # binary: target/release/fb-relay
cargo test -j2                   # integration tests on an ephemeral 127.0.0.1 port
```

## Run

```bash
./target/release/fb-relay                                   # 127.0.0.1:8480, static files from ../phone/dist
./target/release/fb-relay --listen 127.0.0.1:8480 --static /path/to/phone/dist
RUST_LOG=fb_relay=debug ./target/release/fb-relay           # log level (default fb_relay=info)
```

| Flag | Default | Meaning |
|---|---|---|
| `--listen <addr:port>` | `127.0.0.1:8480` | Listen address. Keep it on loopback; put TLS in front for anything else (a warning otherwise). |
| `--static <dir>` | `../phone/dist` (relative to the working directory) | The built phone page. Unknown paths fall back to `index.html`. |
| `--origin <origin>` | none: any | A browser origin allowed to open `/ws` (repeatable), e.g. `https://app.ecxfreebank.com`. Others get 403. A request with no `Origin` (the desktop app) is always allowed. |
| `--max-conns <n>` | `512` | WebSocket connections at once, hosts and phones together; past it `/ws` answers 503. |
| `--feedback-dir <dir>` | none: no `/feedback` | Where reports are kept (made if missing, mode 0700). JSON of at most 16 KiB; kinds problem, idea, security; text up to 8000 characters, no control characters but new lines and tabs; a global burst of 20, then one a minute; at most 1000 waiting. The same `--origin` check as `/ws`. No addresses are kept (nginx passes none on). |

Limits (in `Config`; see `SECURITY_REVIEW.md` for why):

| Limit | Value | Past it |
|---|---|---|
| Frame size | 64 KiB | 1009 |
| Phones per room | 8 | 1008 "room full" |
| Frames per second | phones 20, hosts 200 (burst the same); every frame counts, pongs too | 1008 "rate limit" |
| Bytes per second | phones 64 KiB, hosts 512 KiB (burst: the larger of that and two frames) | 1008 "rate limit" |
| Queued for one connection | 128 KiB (a host's: its phones' shares plus room for notices) | the slow reader is closed, 1008 "reader too slow" |
| A phone's share of its host's queue | 128 KiB | that phone is closed, 1008 "host busy"; the host and the other phones carry on |
| WebSocket connections | 512 in total | HTTP 503 |
| Handshake | 10 s for the first frame, 10 s for the proof | 1008 "handshake timeout" |
| A phone's first frame after joining | 30 s (`phone_silence`); pings and pongs don't count | 1008 "silent" |
| Idle | 10 minutes with nothing received (pongs count); pings every 30 s | 1000 "idle" |
| One outbound write | 10 s | connection dropped |

Every HTTP response carries `Content-Security-Policy` (`default-src 'none'`, then `'self'` for scripts, styles,
images, connections and the manifest; no inline code, no `data:`; `frame-ancestors 'none'`),
`X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, a `Permissions-Policy`
that turns off features the page never uses and keeps the camera to the page itself (it scans the desktop's pairing
QR code), `Cross-Origin-Opener-Policy` and `Cross-Origin-Resource-Policy:
same-origin`, and `Cache-Control` (`no-cache` for the page, `immutable` for the hashed files under `/assets/`).
The exact values are `CSP` and `PERMISSIONS_POLICY` in `src/lib.rs`.

### Close codes

| Code | When |
|---|---|
| 1000 | idle timeout; offline (after `{"t":"offline"}`); the host left, was replaced, or closed the channel (after `{"t":"closed","ch":n}`) |
| 1003 | a binary frame (the protocol is JSON text only) |
| 1008 | bad first frame or room id, room does not match `d`, bad proof, handshake timeout, rate limit, room full, a phone frame that is not JSON, a reader that fell too far behind, a phone that overran its share of a slow host's queue ("host busy"), a phone that sent nothing within 30 s of joining ("silent") |
| 1009 | a frame over 64 KiB (the client may instead just see the connection drop) |
| 4001 | this host was replaced by a newly proven host for the same room |

## Behind TLS

The phone needs a secure context and `wss://`, so anything past loopback needs HTTPS. Keep the relay on
`127.0.0.1:8480` and let a proxy terminate TLS, then run the relay with `--origin https://<your host>`.

The public relay is `app.ecxfreebank.com`. `deploy/` has its hardened systemd unit and its nginx site (TLS, HSTS,
per-address limits, no addresses in logs or passed to the relay), both checked locally (`SECURITY_REVIEW.md`,
"Method"). `deploy/ws-check.py` is a WebSocket smoke test in plain Python.

## Spec notes

Choices made where `PROTOCOL.md` is silent or loose; each is the simplest reading.

- **Proof bytes:** the host signs ASCII `fb-relay-proof-v1` followed by the 32 raw challenge bytes (b64u-decoded
  `n`), ECDSA-P256-SHA256, 64-byte r||s (what WebCrypto `sign` returns); `proof_message` in `src/lib.rs`, vector
  `proof` in `testvectors/kk-v1.json`. A proof over the bare challenge is refused (1008), since 2026-09-29 (P4).
  `d` must be a 65-byte uncompressed SEC1 key.
- **After a good proof** the relay sends `{"t":"ready"}`; a bad proof ends in a 1008 close. A phone joining before
  `ready` gets `offline`.
- **Phones are tied to a host connection.** When the host leaves or is replaced, each phone gets
  `{"t":"closed","ch":n}` and is disconnected; it reconnects and joins again (the new host has no session state
  anyway). Channel numbers count up per room from a random start and are not reused while the room exists, even
  across host replacements; a room that empties is forgotten, and its next host starts somewhere new.
- **The host is not told when a phone joins**; it learns a channel from the first `{"ch":n,"d":…}` it receives.
- **Extension:** the host may send `{"t":"close","ch":n}` to drop one phone (for example right after revoking it).
  The phone gets `{"t":"closed","ch":n}` and a 1000 close.
- **`offline` and `room full`:** after `{"t":"offline"}` the relay closes (1000). A room at 8 phones gets a 1008
  close with reason "room full" and no JSON message, since the spec defines none.
- **Host frames** that are not `{"ch":n,"d":…}` (or the close extension), or name an unknown channel, are dropped
  silently. **Phone frames** must be valid JSON; anything else closes the phone (1008). `d` is forwarded byte for
  byte, not re-serialized.
- **Idle** means nothing at all received for 10 minutes, pongs included. So a live but quiet host or phone stays
  connected (the relay's 30 s pings keep it answering), and a dead or suspended one is dropped. Reading "idle" as
  "no data frames" would drop an idle desktop every 10 minutes.
- **Rate limits** apply to every connection alike, the host included (with its larger budget), and exceeding
  them closes the connection (1008). They count every frame, pongs included, and its bytes.
- **Handshake timeouts:** 10 s for the first frame and 10 s for the proof (not in the spec).
