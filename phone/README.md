# FreeBank phone page

The web page a phone (iPhone Safari/Firefox, Android Chrome/Firefox) opens to reach its owner's FreeBank
desktop through the relay. Spec: `../relay/PROTOCOL.md` (phone side of Pairing, Session handshake, Requests).
Svelte 4 + Vite 5 + TypeScript; WebCrypto only (P-256 ECDH, HKDF-SHA256, AES-256-GCM, SHA-256), no crypto libraries.
One library, jsQR, reads the desktop's pairing QR code from the camera ("Scan the code on your desktop"); it is its
own file, loaded only when Scan is tapped, and the pictures stay on the phone. Its license, and Svelte's, are in
`public/licenses.txt`, served beside the page.

```bash
npm install
npm run build          # -> dist/ (relative asset paths; the relay serves it at /)
npm test               # vitest: crypto vs ../relay/testvectors/kk-v1.json, QR (decoded with jsQR), api, format
npm run check          # svelte-check / TypeScript
npm run vectors        # regenerate ../relay/testvectors/kk-v1.json (reproducible, fixed keys)
python3 ../relay/testvectors/check_kk_v1.py   # check the vectors independently (Python cryptography)
npm run e2e:setup      # once: Playwright browsers into node_modules (+ WebKit libs, no sudo); again after npm ci,
                       # which empties node_modules
npm run e2e            # build, then smoke test in WebKit (390x844), Chromium (Pixel 7), Firefox (412x915)
node e2e/smoke.mjs --real-relay   # same flow through ../relay/target/debug/fb-relay (mock desktop as host)
node e2e/smoke.mjs --real-relay --relay-bin=../relay/target/release/fb-relay   # another build
node e2e/smoke.mjs --relay-url=https://127.0.0.1:18443   # a relay already running there (it must allow that origin)
```

| Path | What |
|---|---|
| `src/lib/crypto.ts` | b64u, keys, room, pairing encryption, KK session secret, `Session` (per-direction counters, serialised) |
| `src/lib/relay.ts` | `RelayLink`: WebSocket, join/joined/offline, frames, `closed` |
| `src/lib/api.ts` | `PhoneClient`: handshake, reconnect with backoff, request ids, pending map, held sends |
| `src/lib/pair.ts` | pairing flow (with the comparison code); `store.ts` IndexedDB (non-extractable device key); `qr.ts` QR encoder |
| `src/lib/scan.ts`, `homescreen.ts` | reading the pairing QR code with the camera; the Home Screen app (its own storage on iOS), pasted links |
| `src/components/` | Pair, Scanner, Home, Receive, Send, Settings, Qr, Copy, Back, and the rest |
| `scripts/kk-ref.mjs` | a second, independent implementation of the crypto (both sides) in plain JS |
| `scripts/make-vectors.mjs` | writes the interop vectors for the Rust desktop (and the relay's proof) |
| `e2e/mock-desktop.mjs` | fake desktop (pairing with the comparison code, the host proof, handshake, narrow door, held sends) on `kk-ref.mjs` |
| `e2e/smoke.mjs` | static server + mock relay on 127.0.0.1 with a `'self'`-only CSP; screenshots in `e2e/shots/<engine>/` |

## Spec notes (readings I picked where PROTOCOL.md is open)

1. **Relay to phone framing.** fb-relay forwards the bare `d` to phones; the page also accepts
   `{"ch":n,"d":frame}` and unwraps it (the mock relay sends that on even channels to keep it tested).
2. **After `paired`,** the phone closes that connection and opens a fresh one for `hello`. A desktop never has to
   accept `hello` on the channel that paired.
3. **`{"t":"closed"}`** from the relay (desktop went away) ends the connection; the phone reconnects with backoff
   (1 s doubling to 30 s, ±25% jitter). A `join` answered `offline` shows "Desktop offline" and keeps retrying.
   Visibility (page shown again) and the `online` event retry at once.
4. **`denied`** (at hello, or as a bare frame mid-session) stops retrying and tells the user the phone was removed.
   It comes in clear, so a relay could forge it: the screen offers "Try again" (keeps the key) before "Forget".
5. **Byte layouts** are pinned in `relay/testvectors/kk-v1.json` `notes`: ECDH output = 32-byte X coordinate;
   th hashes ASCII `fb-kk-v1` + four 65-byte keys; no AAD anywhere; ct = ciphertext || 16-byte tag; pair nonce is
   12 random bytes carried in `n`; HKDF L = 32 for pairing. Checked also against Python `cryptography` (OpenSSL).
6. **Request ids** count up from a crypto-random safe integer (in [1, 2^52]) chosen per page load, so a late reply
   meant for an earlier load can't match. **A held send stays open across reconnects**: the held reply is
   `{"id","ok":{"pending":"<confirm id>","why":"limit"|"locked"}}`, and the page takes a final reply
   (`{"id","pending",...}`) only for a held request with that same confirm id. It fails a held send itself 11
   minutes after it was held ("Not confirmed on your desktop in time. Check History before trying again."), by
   timer and by the wall clock when the page is shown again (phones pause background timers). `why: "locked"`
   shows "Your desktop wallet is locked: confirm on your desktop." Ordinary requests in flight fail when the
   connection drops ("check your history before trying again", so a lost reply never causes a blind resend), and
   time out after 30 s. An outcome the page can't know is headed "Not confirmed", not "Not sent".
7. **Amounts** are JSON numbers in ECX, rounded to 8 decimals (`1e-8` may appear in JSON). Input accepts a comma
   decimal separator (many phone keypads). Address check on the phone is loose; the desktop validates.
8. **`history`** is asked with `count: 10`; any extra fields are ignored. `receive` is called each time the Receive
   screen opens (a fresh address each time).
9. **Pair link checks:** `v == 1`, `relay` starts `ws(s)://`, `d` is 65-byte uncompressed, `c` is 16 bytes, and
   `room` must equal the hash of `d`. The relay must be this page's own host (`wss://<host>` on https, `ws://` on
   http), so a crafted QR code can't point the page at another server. A link opened while the page is already
   open (hash change) also pairs. Re-pairing replaces the stored pairing.
10. **CSP:** the page needs no inline script or style and no `data:` URLs; it runs under fb-relay's
    `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; ...` in all three
    engines (`connect-src 'self'` covers same-host `ws:`/`wss:`). The smoke test's own server sends the same
    headers.
11. **The comparison code** (PROTOCOL.md; security review P1): as soon as the pair request is out, the waiting
    screen says "Check that your desktop shows 042 917" and keeps it until the phone is paired or refused. It is
    `pairCode` in `crypto.ts` (vector `pair.sas`); a fresh `P` and `E` for each attempt mean a fresh code. The mock
    desktop records each request's code, and in the smoke test its "owner" allows a request only when the phone
    shows the same code (and refuses one that differs).

## Known limits

- iOS keeps Home Screen web apps' storage apart from Safari's: a phone paired in Safari is not paired in a
  Home Screen icon (pair from inside it instead).
- Private browsing windows may refuse IndexedDB; the page says so.
- Firefox for Android is tested with desktop Gecko at a phone viewport (Playwright has no Gecko mobile emulation).
