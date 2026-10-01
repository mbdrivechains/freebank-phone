# Security review: FreeBank phone relay and phone page

> **Read this as of its date.** Since then: the pairing comparison code (P1) shipped in app v0.2.0, and Face ID
> passkeys (residual risk 3) in app v0.2.1. The page served at `app.ecxfreebank.com` can now be checked against
> this source byte for byte (P2; the top-level README says how). App v0.2.1 had a review of its own. App v0.2.2
> lets the page use the phone's camera, for "Scan the code on your desktop": `Permissions-Policy` now has
> `camera=(self)` (R9 below says the camera was off), and that release's review covered the camera and the scanned
> input.

**Date:** 2026-09-29. **Reviewer:** an AI reviewer (Claude) for the FreeBank team, before the relay went public at
`app.ecxfreebank.com`. **Baseline:** `5b02f5f` (this repo). **Fixes:** the commits that follow it (relay, page,
then this file and `deploy/`), and a follow-up the same day for P1 and P4 after the spec took them (69d1f51).

## Scope

- `relay/` (fb-relay: Rust, axum 0.8, tokio, p256): the WebSocket pipe, host proof, limits, static file serving,
  headers, logging.
- `phone/` (Svelte 4, Vite 5, WebCrypto): keys and storage, pairing, the KK session, requests and held sends,
  rendering, network use.
- `PROTOCOL.md` as a design: what the relay can and can't do to users.
- Running behind nginx on the Singapore droplet: `deploy/` (systemd unit, nginx site).
- Dependencies: `cargo audit`, `npm audit`.

**Out of scope:** the desktop app's code (read only, and being changed by another agent while this ran; findings
that need it are listed, not fixed), the FreeBank node, the droplet itself (SSH, firewall, the other services on
it), DNS, the Let's Encrypt account, phone operating systems and browsers, the crypto primitives (WebCrypto, the
`p256` crate), and BitWindow.

## Method

- Read every line of `relay/src`, `relay/tests`, `phone/src`, `phone/e2e`, `PROTOCOL.md`, and the desktop's
  `src-tauri/src/phone/` (for how it uses the relay).
- Checked library behaviour in the crates' source: serde_json's raw-value parsing (iterative, no stack
  overflow), tower-http `ServeDir` path handling (rejects `..` after decoding), tungstenite buffer defaults
  (128 KiB read buffer allocated per connection, unbounded write buffer), axum's server (no header-read timeout).
- Reproduced the main relay findings on the baseline with tests written against its API (kept outside the repo):
  a flooding phone gets its host closed with 1008 "reader too slow"; 2000 unsolicited pongs pass a 5 frames/s
  limit; 1500 idle WebSocket connections are all accepted; the CSP allows `'unsafe-inline'`.
- Wrote a test for each fix. Checked the page's new held-send rules with mutants (each rule removed in turn; the
  intended test fails each time).
- Ran the Playwright smoke test (WebKit as iPhone, Chromium as Pixel 7, Firefox), all passing:
  - against the mock relay;
  - through fb-relay, debug and release builds, with the relay's real headers and Origin check;
  - through the release binary running as a transient systemd service under the unit's seccomp-based restrictions
    (the syscall filter, W^X, address families, namespaces, memory, tasks and file limits);
  - through the proposed nginx site over TLS in front of that service.

  It had 26 checks each in the first round and 29 after the P1 follow-up, which added checks of the comparison code.
  All four were run again after the follow-ups, the last three with the packaged release build of `b30b9f6` (the
  one with the 30-second limit on silent phones).
- **The nginx site:** `nginx -t` on both stages (nginx 1.24.0, the version in Ubuntu 24.04), then a live run in a
  container bound to loopback, with only the listen addresses, certificate paths and upstream port changed. 26
  checks passed:
  - the redirect and the ACME path;
  - one copy of each security header;
  - cache headers, 405, 413, `robots.txt`;
  - `wss://` with and without Origin, and 403 for a foreign one;
  - 429s at 30 simultaneous upgrades;
  - no addresses in the access log.
- **The systemd unit:** `systemd-analyze verify` is clean; `systemd-analyze security` scores it 0.9 ("SAFE"). The
  mount-namespace options (`ProtectSystem`, `TemporaryFileSystem`, …) need a system manager, so they were checked
  only offline.
- **The vectors** (`testvectors/kk-v1.json`), including the comparison code and the host proof added for P1 and P4:
  - the page's tests, `kk-ref.mjs` (a second JS implementation) and `testvectors/check_kk_v1.py` (Python
    `cryptography`, 44 checks) agree;
  - the relay's tests re-make the proof's RFC 6979 signature with the `p256` crate.
- `cargo audit` (RustSec database of 2026-09-29, 1273 advisories) and `npm audit`.

## Findings

Severity is for the public relay as deployed, before the fix. Status: **fixed** (in this branch, with a test),
**open** (needs a protocol, desktop or ops change; described, not made), **accepted** (a known limit, kept).

### Relay

| # | Severity | Finding | Status |
|---|---|---|---|
| R1 | Medium | **A phone could knock its desktop off the relay.** A phone sending faster than its host read filled the host's 256-message queue, and the relay then closed the *host* ("reader too slow"), and with it every phone in the room. Anyone who knows a room id can do this (the id is in the pairing QR code, the phone's Settings screen and the browser's history), over and over. Reproduced on the baseline. | Fixed: queues are bounded in bytes; a phone has a share of its host's queue, and the phone that overruns it is closed ("host busy"), not the host. Test `a_flooding_phone_is_cut_off_not_the_host`. |
| R2 | Medium | **Memory grew without bound.** The per-room channel counter map (`next_ch`) got an entry for every room ever hosted and never lost one; anyone can host a new room with a fresh key per connection. | Fixed: the counter lives in the room and goes with it (random start; a host that replaces another keeps counting). Test `rooms_go_away_with_their_host`. |
| R3 | Medium | **No cap on connections or per-connection memory.** 1500 idle connections were accepted on the baseline; each allocated a 128 KiB read buffer up front, and each queue could hold 256 × 64 KiB = 16 MiB. | Fixed: at most 512 WebSocket connections (`--max-conns`; 503 past it), 128 KiB queues (a host's: its phones' shares plus room for notices), an 8 KiB read buffer, a bounded write buffer, and systemd `MemoryMax` (256M first; 128M on the droplet, with `--max-conns 256` and `OOMScoreAdjust=900`, freebankd's conditions for that box). Test `connection_cap_and_slots_come_back`. By arithmetic, the worst case at the cap (every connection stalled, full queues, half-read big frames) is about 210 MiB; a normal run peaked at 2.6 MB. |
| R4 | Low | **Bytes weren't rate limited**, only frames: 20 frames/s × 64 KiB = 1.25 MiB/s per phone connection, a free high-bandwidth pipe. | Fixed: byte buckets as well (phones 64 KiB/s, hosts 512 KiB/s, bursts of two frames). Test `byte_rate_limit_closes`. |
| R5 | Low | **Pongs weren't counted** by the rate limiter, so a client could make the relay wake up as often as its link allowed. Reproduced on the baseline. | Fixed: every frame counts (a live peer sends one pong per 30 s ping). Test `pong_floods_are_rate_limited`. |
| R6 | Low | A host whose `ready` write failed returned **without removing its room**: phones then joined a room nobody served, their frames vanished, and the entry stayed until another host replaced it. | Fixed: cleanup runs on every path. |
| R7 | Low | **One panic could break every later connection.** Each `lock().unwrap()` would panic after the rooms lock was poisoned, leaving a process that runs but serves nobody, which systemd wouldn't restart. No panic path under the lock was found; this is defence in depth. | Fixed: a poisoned lock is recovered (the maps are never left half-changed). |
| R8 | Low | **No Origin check**: any website could have its visitors' browsers open relay connections, for example to help fill rooms or connection slots. | Fixed: `--origin` allowlist (the unit allows only `https://app.ecxfreebank.com`); a request with no Origin (the desktop app) is allowed. Test `origin_allowlist`. A non-browser client can forge Origin; this only stops drive-by use of browsers. |
| R9 | Low | **Headers were loose**: CSP allowed `style-src 'unsafe-inline'` and `img-src data:`, which the page doesn't need; no Permissions-Policy, COOP or CORP; no Cache-Control, so heuristic caching could keep a fixed page stale on phones. | Fixed: CSP `default-src 'none'` plus exactly what the page uses; Permissions-Policy (camera, microphone, geolocation, payment, usb, display-capture, fullscreen off); COOP and CORP `same-origin`; `no-cache` for the page, `immutable` only for hashed assets. Tests `static_files_with_security_headers`, and the smoke test runs the page under these headers in three engines. |
| R10 | Info | **Logs**: the room prefix was logged at info, which leaves a per-room activity trail in the journal. | Fixed: counts and channel numbers at info, the room prefix only at debug. The relay never sees addresses: the proposed nginx site passes none. |
| R11 | Info | A room's u32 channel counter could wrap in a release build after 2^32 joins and reassign a live channel. Unreachable in practice. | Fixed: u64 from a random 32-bit start; release builds keep overflow checks on. |
| R12 | Info | Tokio's blocking pool (used to read static files) can grow to 512 threads, far past the unit's `TasksMax`, so thread creation could fail under a burst of page loads. | Fixed: 8 blocking threads. |
| R13 | Info | axum's server sets no header-read timeout, so the relay's own port can be slowlorised. | Accepted: it listens on loopback only; nginx reads whole requests and enforces `client_header_timeout`. |
| R14 | Info | The relay is an open pipe: anyone can host a room with a fresh key and pass data between their own host and phones. | Accepted: inherent (rooms are self-certifying); bounded by the rates, the connection cap and nginx's per-address limits. Worth watching once public. |

Checked and fine: host proof (a fresh 32-byte challenge, ECDSA P-256 over it, `room` = 132 bits of SHA-256 of
`D`, so no takeover without `D`); path traversal (`ServeDir` rejects `..` after decoding; test `no_path_traversal`
covers nine forms); MIME types (by extension, with `nosniff`); no directory listings; deep JSON nesting (30,000
levels pass through without recursion; test `deeply_nested_json_passes_through`); frame size (64 KiB; 1009);
handshake timeouts (10 s per step); idle timeout (10 minutes, pings every 30 s); slow readers (10 s per write).

### Protocol and desktop (need a spec or desktop change)

| # | Severity | Finding | Status |
|---|---|---|---|
| P1 | Medium | **Pairing can be hijacked by anyone who sees the QR code** in its 5 minutes (over a shoulder, on a screen share, in a photo). Their phone's request arrives first, and "Allow this phone? <name>" can't tell phones apart, because each phone picks its own name. The owner's phone then gets "Not paired", but a user who expects the prompt will likely tap Allow. | **Fixed in the spec, the page and the desktop** (the desktop on `mb/phone-relay` 339c48e, not yet released). PROTOCOL.md, "The comparison code" (69d1f51): both screens show 6 digits from SHA-256 of `"fb-pair-sas-v1" ‖ D_pub ‖ P_pub ‖ E_pub ‖ C`. The page says "Check that your desktop shows 042 917" from the moment its request is out until it is paired or refused; the desktop shows the code in "Allow this phone?". Checks: the vector `pair.sas`, agreed by the page, `kk-ref.mjs`, Python (`testvectors/check_kk_v1.py`) and the desktop's tests; unit tests including an intruder whose request comes first and is refused on the codes; the smoke test compares both screens, and codes that differ are refused. |
| P2 | Medium | **The page's code comes from the relay's host.** Whoever controls the files on `app.ecxfreebank.com` (a droplet shared with the explorer's containers and the seed) controls the phone UI. They can use the phone's key within its send limit and, worse, show their own address on Receive, where no limit applies to what others pay. End-to-end encryption protects against a relay that only relays. | Accepted for the beta, with this deployment's mitigations: a dedicated user, root-owned read-only files, a sandboxed unit, and nothing else served on that origin. Later: the desktop shows each receive address it hands out; a separate host for the relay; a way for the desktop to check the page build's hash. |
| P3 | Low | **Clear-text control frames can be forged by the relay**: `denied`, `paired`, `pair-refused`, `closed` and `hello-ok`. Only availability is at stake (a forged `hello-ok` fails at the first sealed message), but a forged `denied` led to a screen whose only button deleted the phone's key. | Page part fixed: the screen offers "Try again" first (smoke test). Open: an authenticated `denied` (signed with `D`, bound to the phone's ephemeral key). |
| P4 | Low | **The relay proof signs raw relay-chosen bytes with `D`**, the desktop's long-term ECDH key, with no context string. A relay the desktop connects to can use it as a signing oracle over 32-byte values, for example to forward another relay's challenge and host the room there. The impact is low today: nothing else checks signatures by `D`, and phones use the relay their pairing names. | **Fixed in the spec, the relay and the desktop** (the desktop on `mb/phone-relay` 339c48e, not yet released). The relay verifies the proof over `"fb-relay-proof-v1" ‖ n` and refuses one over the bare `n` (69d1f51; test `a_proof_over_the_bare_challenge_is_refused`). The vector `proof` holds the message and D's RFC 6979 signature, which the relay's tests and the desktop's re-make with the `p256` crate and Python verifies. **The new relay refuses a desktop released before 339c48e: they ship together.** Accepted: the spec leaves out the relay's name that I first suggested, so a relay the desktop is set to use could still pass another relay's challenge through and stand in for it there. That only touches availability, because sessions need `D`'s private key. |
| P5 | Low | **Anyone who knows a room id can hold its 8 phone slots.** The relay can't tell phones apart, and the desktop doesn't close channels that never authenticate. | **Fixed, in two halves.** The desktop's (`mb/phone-relay` 339c48e, spec 69d1f51) closes a phone channel that hasn't completed `hello` or a pair request within 30 seconds. But the desktop only sees a channel once it sends something, so the relay's half closes a phone that sends no frame within 30 seconds of joining (pings and pongs don't count) with 1008 "silent" (`phone_silence`; test `a_silent_phone_is_closed`). A stranger with the room id can still take a slot, but only for about 30 seconds at a time, within the per-address limits. |
| P6 | Low | **Device names** in "Allow this phone?" keep Unicode format characters (bidi overrides, zero-width); the desktop strips only control characters. | **Fixed on the desktop** (`mb/phone-relay` 339c48e, spec 69d1f51): names are trimmed to 40 characters, with control, bidirectional and zero-width characters removed, before they are shown or stored. |
| P7 | Info | **The pairing URL is kept in browser history.** The page removes the `#pair=` fragment from the address bar and the tab's history entry before anything renders, but the browser has already recorded the full URL in its global history, which it may sync (iCloud, Google, Firefox Sync). The code inside is single-use and dies in 5 minutes; the room id enables P5. This is how browsers behave; not checked on devices. | Accepted. |
| P8 | Info | **What the relay can see**: room ids, when each phone connects, and frame sizes and timing (a send looks different from a balance check). | Accepted for v1; padding frames to fixed sizes would hide the kind of request. |

### Phone page

| # | Severity | Finding | Status |
|---|---|---|---|
| W1 | Low | **A pairing link could name any relay.** Only the CSP (`connect-src 'self'`) stopped the page from pairing through someone else's server named in a crafted QR code. | Fixed: the link's relay must be this page's host (`wss://<host>`, or `ws://` on http), else "This pairing link is for another server". Tests in `pair.test.ts` and the smoke test. |
| W2 | Low | The "removed" screen's only action deleted the key (see P3). | Fixed: "Try again" keeps the key and asks the desktop again. |
| W3 | Info | **An unknown outcome read "Not sent"** (no answer, a dropped connection, a held send timing out), though the payment may have gone out. | Fixed: headed "Not confirmed", with "Check History before trying again". |

Checked and fine:
- **Keys.** The device key `P` is a non-extractable WebCrypto key in IndexedDB (the smoke test checks that
  `exportKey` fails), and ephemeral and AES keys are non-extractable. The spec derives 64 bytes and splits them, so
  raw session key bytes pass through JS memory for a moment; that's inherent and accepted.
- **Pairing fragment.** It is read and stripped before the app renders (the smoke test checks the address bar).
- **Rendering.** Desktop-supplied strings render as text: no `{@html}`, and the bundle's `innerHTML` uses are
  compile-time constants.
- **Nonces.** Per-direction keys, fresh each session, 12-byte counters from 0, serialised seal and open, a
  safe-integer guard, and any decrypt failure ends the session. So replayed, reordered or dropped frames fail
  closed.
- **Pairing code.** 128 bits, single use, 5 minutes. The desktop refuses a frame that doesn't open, without spending
  the code.
- **Revocation.** `denied` plus a channel close; held sends are dropped.
- **Third-party requests.** None: the bundle names no external URL, and the CSP is `default-src 'none'`.

**Held sends (today's spec, built in this branch):**
- request ids start at a crypto-random safe integer each page load;
- a final reply counts only for a held request with the same confirm id;
- the page fails a held send after 11 minutes, by timer and by wall clock when shown again;
- the `locked` reason is shown.

**These need the desktop's v0.2.0 replies:** a desktop that still sends final replies without `pending` would have
confirmed held sends shown as "Not confirmed on your desktop in time" after 11 minutes, though they were paid. The
page and the desktop must ship together.

### Dependencies

- **`cargo audit`:** 140 crates, no advisories, no warnings.
- **`npm audit`:** 10 advisories (1 critical, 2 high, 7 moderate), all in development tools or in Svelte's
  server-side rendering. None reach the shipped bundle, which holds only the Svelte 4 runtime.
  - The one client-side Svelte advisory (GHSA-rcqx-6q8c-2c42, DOM clobbering) needs attribute spreading on forms,
    which the page doesn't use.
  - The vitest UI server (critical) matters only with `--ui`.
  - The vite and esbuild dev-server advisories matter only with `npm run dev`, which binds to 127.0.0.1.
  - Playwright's unverified browser download (high) matters only in `npm run e2e:setup`.
  - **Open (low):** upgrade the dev tools (vitest 3.2.6 or later, vite later than 6.4.2, Playwright 1.55.1 or
    later) in a change of its own. The phone folder's `node_modules` is shared with other checkouts, so it wasn't
    changed here. Svelte 4 gets no fixes for these advisories; the fixed releases are Svelte 5.

## Deployment (`deploy/`)

- **The relay.**
  - It listens on 127.0.0.1:8480 only, as the dedicated system user `fb-relay`, from root-owned read-only files.
  - It accepts only the Origin `https://app.ecxfreebank.com`.
- **The sandbox:**
  - `ProtectSystem=strict` and `ProtectHome`;
  - private `/tmp` and devices, private users, the kernel `Protect*` options;
  - no capabilities, `IPAddressDeny=any` except localhost, `@system-service` syscalls without
    `@privileged @resources`;
  - W^X memory, and `/opt` hidden except `/opt/fb-relay`;
  - `MemoryMax=128M` with `OOMScoreAdjust=900` (killed before anything else on the droplet), `--max-conns 256` so the
    worst case stays near 105 MiB, `TasksMax=64`, `LimitNOFILE=4096`, and a CPU share below the seed's.
- **nginx.**
  - It terminates TLS (certbot, webroot as for the explorer) and redirects port 80, keeping the ACME path.
  - Limits:
    - per address: 2 new WebSockets/s (burst 10), 10 page loads/s (burst 40), 16 open connections;
    - the whole site: 300 connections, so a flood can't take nginx's `worker_connections` from ecxfreebank.com and
      the explorer.
  - Bodies are limited to 1 KiB, and only GET and HEAD are allowed.
  - The access log has no addresses, user agents, referrers or query strings. Requests refused by the limits are
    logged below the error log's level (a body over 1 KiB still leaves an address there). No address reaches the
    relay.
  - It adds HSTS, and the other security headers only on responses it makes itself: the relay's pass through
    unchanged, so there is one source for them.

## Residual risks

1. **The page is only as trustworthy as the droplet (P2).** A compromise of `app.ecxfreebank.com`'s files can
   redirect incoming payments through the Receive screen.
2. **Pairing hijack by someone who sees the QR code (P1)**, only if the owner allows a request whose comparison code
   doesn't match their phone's (and, until the desktop release with the code is out, at all).
3. **A stolen, unlocked phone can spend up to its daily limit** (default 0.1 ECX) until it is revoked on the
   desktop. Passkeys are the next pass.
4. **Availability rests on the relay operator**, who can drop, delay or forge the clear-text frames (P3), and on
   anyone who knows a room id (P5).
5. **The relay is shared infrastructure** on a box with the seed and the explorer. The caps bound its share, but a
   flood still costs bandwidth. A flood that fills the site's connection cap keeps new phones and desktops out
   until it stops; the cap is global, and the per-address limits mean such a flood needs many addresses.
6. **Metadata (P8) and browser history (P7).**
