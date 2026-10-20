# FreeBank phone relay: protocol v1

The FreeBank phone page lets a phone use the wallet in the FreeBank desktop app, through a relay that only passes
sealed messages along. A phone can:
- show the desktop wallet's balance and history;
- get a receive address;
- send a payment within its daily limit; anything above it waits for the desktop.

Revoking the phone in the desktop app cuts it off.

**Targets:** iPhone (Safari and Firefox, both WebKit) and Android phones (Chrome, and Firefox for Android). Only
standard WebCrypto and IndexedDB are used, tested in WebKit, Chromium (Android profile) and Firefox.

## Three parts

| Part | Where | Language |
|---|---|---|
| **Relay**: a dumb pipe plus a static file server for the phone page | `relay/` in this repo | Rust (tokio, axum 0.8) |
| **Phone page**: the web interface | `phone/` in this repo; built into `phone/dist/`, served by the relay at `/` | Svelte 4 + Vite 5 + TypeScript, WebCrypto only (no crypto libraries) |
| **Desktop side**: pairing, device list, the narrow door, the outbound relay link | the FreeBank app ([mbdrivechains/freebank-app](https://github.com/mbdrivechains/freebank-app), `src-tauri/src/phone/`) | Rust (Tauri backend) + Svelte |

## Keys and crypto (the same on both ends)

- **Curve:** ECDH on **P-256** (WebCrypto `ECDH`, `namedCurve: "P-256"`; Rust crate `p256` 0.13).
- **Public key format:** uncompressed SEC1 (65 bytes), base64url with no padding, called `b64u` below.
- **KDF:** HKDF-SHA256 (WebCrypto `HKDF`; crate `hkdf` 0.12).
- **AEAD:** AES-256-GCM with a 12-byte nonce (WebCrypto `AES-GCM`; crate `aes-gcm` 0.10).
- **Desktop static key `D`:** made once and kept in the app's data folder (file mode 0600). `room = b64u(SHA-256(D_pub))[0..22]`.
- **Phone device key `P`:** made at pairing. It is a **non-extractable** WebCrypto key, kept in IndexedDB.
- **One pairing code `C`:** 16 random bytes, valid for 5 minutes, usable once.

## Pairing

The desktop shows a QR code (Settings, "Pair a phone"). It encodes this URL:

```
https://<relay host>/#pair=<b64u of JSON {"v":1,"relay":"wss://<relay host>/ws","room":"<room>","d":"<b64u D_pub>","c":"<b64u C>"}>
```

The fragment never reaches the relay's logs, because browsers don't send fragments. Opening the URL on the phone
loads the page, which reads the fragment and removes it from the address bar.

1. The phone makes `P` and an ephemeral key `E`. It computes `k = HKDF(ikm=ECDH(E, D_pub), salt=C, info="fb-pair-v1")`
   and sends a join (below), then this pair request as one encrypted message:
   `{"t":"pair","e":"<b64u E_pub>","ct":"<b64u AES-GCM(k, nonce, JSON {"p":"<b64u P_pub>","name":"<device name>"})>","n":"<b64u nonce>"}`
2. The desktop derives the same key and checks that `C` is live and unused. It shows **"Allow this phone? <name>"**,
   with the comparison code (below).
   - On Allow, it stores `P_pub` with the name and the date, marks `C` used, and replies `{"t":"paired"}` in clear.
   - On Deny, or when `C` has expired, it replies `{"t":"pair-refused"}`.
3. The phone saves `{relay, room, D_pub}` and its key `P`.

**The comparison code** (added 2026-09-29, before the relay went public; security review finding P1). Anyone who sees
the QR code during its 5 minutes could otherwise pair first, and "Allow this phone?" couldn't tell the phones apart.
- Both sides compute `h = SHA-256("fb-pair-sas-v1" || D_pub || P_pub || E_pub || C)`, with the keys as raw 65-byte
  points and `C` as its 16 bytes. The code is the first 4 bytes of `h` read as a big-endian unsigned integer, modulo
  1,000,000, written as 6 digits with leading zeros and shown as two groups of three ("042 917").
- The phone shows it as soon as the pair request is out: "Check that your desktop shows 042 917".
- The desktop shows it in "Allow this phone?": "Allow only if your phone shows 042 917".
- A phone paired by someone else gives a code from a different `P` and `E`, so the codes don't match and the owner
  denies it. The desktop shows each pair request that arrives for a live `C` with its own code; allowing one marks `C`
  used and refuses the rest.
- The test vectors (`relay/testvectors/kk-v1.json`) carry the code for the pairing vector.

## Session handshake (each time the phone connects)

This works like Noise KK: both sides know each other's static keys.

1. The phone makes an ephemeral key `eP` and sends `{"t":"hello","p":"<b64u P_pub>","e":"<b64u eP_pub>"}`.
2. The desktop refuses an unknown or revoked `P_pub` with `{"t":"denied"}`. Otherwise it makes an ephemeral key `eD`
   and replies `{"t":"hello-ok","e":"<b64u eD_pub>"}`.
3. Both sides compute
   `ikm = ECDH(eP,eD) || ECDH(eP,D) || ECDH(P,eD)` (phone side; the desktop mirrors it),
   `th = SHA-256("fb-kk-v1" || P_pub || D_pub || eP_pub || eD_pub)`, then
   `k_pd || k_dp = HKDF(ikm, salt=th, info="fb-session-v1", L=64)`.
   `k_pd` encrypts phone to desktop, and `k_dp` encrypts desktop to phone.
4. Nonces are a 12-byte big-endian counter per direction, starting at 0. A message that is out of order or fails to
   decrypt closes the session.
5. All later messages are `{"t":"m","ct":"<b64u>"}`, and the plaintext is JSON (next section).

## Requests: the narrow door

The plaintext is `{"id":<int>,"m":"<method>","a":{...}}`. The reply is `{"id":<int>,"ok":<result>}` or
`{"id":<int>,"err":"<message>"}`.

| Method | Args | Result | Desktop calls |
|---|---|---|---|
| `balance` | — | `{"confirmed":<ECX>,"pending":<ECX>}` | `getbalance`, `getunconfirmedbalance` |
| `history` | `{"count":<=50}` | a list of `{txid, category, amount, confirmations, time, address}` | `listtransactions` |
| `receive` | — | `{"address":"X…"}` | `getnewaddress "" legacy` |
| `send` | `{"address","amount"}` | `{"txid"}` or `{"pending":"<confirm id>"}` | `sendtoaddress` |
| `status` | — | `{"blocks","synced","limit_left","face_id","face_id_sends"}` | `getblockchaininfo` + the limit ledger + the phone's passkey (v0.2.1) |

- **Send limits:**
  - a per-phone daily limit, default **0.1 ECX**, set in desktop Settings;
  - a send above the day's remaining limit is held for **confirmation on the desktop** ("Phone <name> wants to send X
    to Y"). The phone shows "waiting for your desktop";
  - every send is shown and logged on the desktop.
- **A held send** gets its final reply later, under the same `id`: `{"id","ok":{"txid"}}` once confirmed, or
  `{"id","err":"declined on the desktop"}`. The phone keeps the request open until then.
- **Nothing else is reachable:** no raw RPC and no keys. House notes come with desktop v0.2.5 (below). Amounts are in
  ECX only.

## The relay

**`GET /`** and the static assets serve `phone/dist/`. **`GET /ws`** upgrades to a WebSocket. The first frame is
JSON:

- **Desktop:** `{"t":"host","room":"<room>","d":"<b64u D_pub>"}`.
  - The relay checks that room equals `b64u(SHA-256(d))[0..22]`, then sends `{"t":"challenge","n":"<b64u 32 random>"}`.
  - The desktop proves it holds `D` with `{"t":"proof","sig":"<b64u ECDSA-P256-SHA256, fixed 64-byte r||s>"}`,
    using the same `D` key (the `p256` crate has `ecdsa`). The signed message is the ASCII bytes
    `fb-relay-proof-v1` followed by the 32 bytes of `n` (added 2026-09-29, security review finding P4: `D` is also the
    desktop's ECDH key, so its signatures carry a context string and can't be passed off as anything else). A proof
    over the bare `n` is refused.
  - A new proven host replaces the old one.
- **Phone:** `{"t":"join","room":"<room>"}`. The relay gives it a channel number and sends `{"t":"joined","ch":<n>}`
  to the phone, or `{"t":"offline"}` if no host is connected.
- **After that, the relay only forwards:**
  - phone to host as `{"ch":<n>,"d":<the phone's frame, a JSON value, unchanged>}`;
  - host to phone by `{"ch":<n>,"d":…}`;
  - when one side closes, it sends the other `{"t":"closed","ch":<n>}`.
- **Limits:**
  - 64 KiB per frame;
  - 8 phones per room;
  - 20 frames per second per connection;
  - idle timeout 10 minutes, with pings every 30 seconds;
  - no storage and no logging of frame contents.

The relay config takes the listen address (default `127.0.0.1:8480`) and the static directory.

**Details settled while building the relay** (2026-09-29):
- The proof signs the **raw 32 challenge bytes**, not the b64u string, after the context string `fb-relay-proof-v1`
  (P4, above; the vector is `proof` in `testvectors/kk-v1.json`).
- After a good proof the relay sends the host **`{"t":"ready"}`**. Phones can join from then on.
- The host isn't told when a phone joins. It learns the channel from the phone's first frame.
- **The host may drop a phone** with `{"t":"close","ch":<n>}`, for example right after revoking it.
- Frame budgets: phones 20 per second, the host 200 per second (it serves up to 8 phones). Going over closes the
  connection.
- Idle means nothing received at all, pongs included.
- Phones belong to one host connection. When the host leaves or is replaced, they get `closed` and are disconnected.
  Channel numbers are never reused while the room exists (a host that replaces another keeps counting). *(Security
  review, 2026-09-29: they start at a random number, and a room whose host leaves is forgotten; keeping every room's
  counter forever let memory grow without bound.)*
- **Added by the security review (2026-09-29; `relay/README.md` and `SECURITY_REVIEW.md` have the numbers):**
  - byte budgets next to the frame budgets (phones 64 KiB/s, the host 512 KiB/s), and pongs count;
  - bounded queues: a phone that sends faster than its host reads is closed ("host busy"), not the host;
  - at most 512 WebSocket connections (then HTTP 503);
  - browsers' `Origin` must be on the relay's list (`--origin`), else HTTP 403. A request with no `Origin` (the
    desktop app) is allowed;
  - a phone that sends no frame within 30 seconds of joining (pings and pongs don't count) is closed (1008). The
    desktop only learns of a channel from its first frame, so without this a silent stranger with the room id
    would hold one of the 8 slots until the idle timeout (finding P5, the relay's half; the desktop closes a
    channel that doesn't complete `hello` or a pair request).
- Close codes:
  - 1000: normal;
  - 1003: binary frame;
  - 1008: policy (bad handshake or proof, rate limit, room full, slow reader, host busy, a silent phone);
  - 1009: frame too big;
  - 4001: replaced by a new host.

## Local test setup

- Relay on `127.0.0.1:8480`.
- The app pointed at `ws://127.0.0.1:8480/ws`, using a **regtest or throwaway FreeBank node**, never a real wallet.
- The phone page tested in a headless browser (Playwright WebKit if it's available, else Chromium) against the same
  relay.
- WebCrypto needs a secure context, and `http://127.0.0.1` counts as one.
- Reaching a real phone needs HTTPS: put the relay behind a proxy that terminates TLS (`relay/deploy/` has an nginx
  site).

## Details settled while building the phone page (2026-09-29)

- **Byte layouts** (the test vectors, `relay/testvectors/kk-v1.json`, are the reference, and three separate
  implementations agree: the page, a plain-JS copy and Python's `cryptography`, whose check is
  `relay/testvectors/check_kk_v1.py`; the relay's tests check the room and the proof too):
  - ECDH gives the 32-byte X coordinate;
  - AES-GCM uses no AAD, and the 16-byte tag follows the ciphertext;
  - the pairing HKDF output is 32 bytes.
- **Framing:** the relay forwards the phone's frame to the host as a bare `d` value, unchanged.
- **After `paired`**, the phone reconnects and starts a session with `hello`. The desktop never sees `hello` on the
  channel that paired.
- **A held send's final reply** goes on whichever session is current, under the same `id`. Other requests in flight
  fail when the connection drops, and the page tells the user to check history, so a lost reply never leads to a blind
  resend.
- **Request ids** count up by one from a random safe integer chosen on each page load (see "Held sends" below; they
  counted from 1 until 2026-09-29). The desktop must not treat them as unique for longer than a session.
- **Amounts** are JSON numbers in ECX with up to 8 decimals, so a value like `1e-8` can appear. The desktop accepts it
  and checks the address.
- **iOS Home Screen icons** keep their own storage, apart from Safari. A phone paired in Safari has to pair again from
  the icon.

## Details settled while building the desktop side (2026-09-29)

- `th` hashes the **raw 65-byte keys**, as the vectors already assume.
- **Session lost:** a frame with no live session, or one that fails to decrypt, gets `{"t":"closed"}` in clear on
  that channel. The phone then starts again with `hello`.
- **Held sends:**
  - the final reply goes to every live session of that phone;
  - a send the desktop confirmed doesn't count against the phone's daily limit;
  - **settled 2026-09-29 (v0.2.0):**
    - the held reply is `{"id","ok":{"pending":"<confirm id>","why":"limit"|"locked"}}`. `limit` means the send is
      over the day's remaining limit; `locked` means the desktop wallet is encrypted and phone sends aren't unlocked
      (next item). The page shows "waiting for your desktop", and for `locked` adds that the desktop wallet is
      locked;
    - the final reply repeats the confirm id: `{"id","pending":"<confirm id>","ok":{"txid"}}` or
      `{"id","pending":"<confirm id>","err":"<message>"}`. The page accepts a final reply only for a held request
      with that confirm id;
    - a held send **expires 10 minutes** after it was held. The desktop drops it and sends the final `err` "not
      confirmed on the desktop within 10 minutes";
    - held sends are saved in the phone folder (`held.json`, 0600), so a restart doesn't lose them. At start the
      desktop cancels each one and sends the final `err` "the desktop app restarted; nothing was sent" to each new
      session of that phone until that send's 10 minutes are up. **It never pays a held send after a restart;**
    - the page starts its request ids at a random value on each load, so a late final reply can't match a request
      from a newer page load. It also fails a held request itself 11 minutes after it was held: "Not confirmed on
      your desktop in time. Check History before trying again."
- **Encrypted wallets** (v0.2.0 makes the wallet passphrase required): a phone send within the limit goes through
  only while **"Let my phone send while FreeBank is open"** is on in desktop Settings. Turning it on asks for the
  wallet passphrase. The app keeps it in memory only, never on disk or in logs, and forgets it on quit or when the
  setting is turned off. (From app v0.2.1, with "Keep my phone connected when FreeBank is closed", quitting hands it
  over a pipe to the background part, which keeps it in memory until the app opens again; the app says so.) Each such
  send unlocks the wallet for a few seconds and locks it again, unless the wallet was already unlocked. Without it, the send is held with `why: "locked"`, and confirming it on the desktop asks for
  the passphrase.
- **History** is newest first (settled 2026-09-29: the desktop reverses the node's order).
- **Before the relay goes public** (2026-09-29, from the security review):
  - the desktop's default relay is `wss://app.ecxfreebank.com/ws`, and its pairing links are
    `https://app.ecxfreebank.com/#pair=…` naming that relay (the page refuses a link naming another relay);
  - the desktop closes a phone channel that hasn't completed `hello` or a pair request within 30 seconds, so a
    stranger with the room id can't hold the room's 8 phone slots (finding P5);
  - device names are trimmed to 40 characters, with control, bidirectional and zero-width characters removed, before
    they are shown or stored (finding P6).
- **The desktop only connects to the relay** while a phone is paired or a pairing is open. Users who never pair make
  no connection.

## Face ID: passkeys (app v0.2.1)

A phone may add a **passkey**: a WebAuthn credential on the phone's platform
authenticator, used with Face ID, Touch ID, a fingerprint or the phone's passcode. Once a phone has one, **the desktop**
answers that phone's sessions only after it proves it, so a phone picked up unlocked can't use FreeBank without its
owner. The check is the desktop's, so a changed page can't skip it.

- **Relying party.** `rp.id` is the relay's host (`app.ecxfreebank.com`). The desktop takes the expected origin from its
  relay URL: `wss://<host>/ws` gives `https://<host>`; for local tests `ws://localhost:<port>/ws` gives
  `http://localhost:<port>` (an IP address can't be a relying party, so tests use `localhost`).
- **The credential.** ES256 (COSE alg -7) on P-256; `userVerification: "required"`, `attestation: "none"`,
  `authenticatorAttachment: "platform"`. The phone reads its public key from the new credential's authenticator data
  (COSE_Key: kty 2, alg -7, crv 1, x, y) and sends it as a 65-byte uncompressed point, with the credential id.
- **Session methods** (inside the session, beside the narrow door's):

| Method | Args | Result |
|---|---|---|
| `auth-start` | `{"for":"open"}`, `"send"`, `"add"` or `"change"` | `{"challenge":"<b64u 32 bytes>","cred":"<b64u id>"}`; `cred` is absent without a passkey |
| `auth` | `{"ad","cdj","sig"}`, each b64u | `{}`: the session is verified |
| `passkey-add` | `{"pk":"<b64u 65 bytes>","cred":"<b64u id>","sends":<bool>,"ad","cdj","sig"}`, and `"auth"` to replace one | `{}` |
| `passkey-set` | `{"sends":<bool>,"auth":{"ad","cdj","sig"}}` | `{}` |
| `passkey-remove` | `{"auth":{"ad","cdj","sig"}}` | `{}` |

- **The gate.** While a phone has a passkey and its session isn't verified, every request but `auth-start` and `auth`
  is refused with `{"id","err":"<message>","auth":"open"}`; the page then asks for Face ID and verifies. A phone
  without a passkey has nothing to verify. A verified session lapses after **5 minutes without a request** and **30
  minutes in all**; the next request is refused the same way.
- **Changing Face ID takes Face ID** (found by app v0.2.1's security review: someone holding a phone left unlocked
  with FreeBank open). `passkey-set`, `passkey-remove` and `passkey-add` over an existing passkey need a verified session
  and `a.auth`, an assertion with the stored passkey over a `for:"change"` challenge.
- **A challenge** is 32 random bytes from the desktop, for one session and one purpose (`for`), usable once, for 2
  minutes. The first `auth` (or `send`, or `passkey-add`) that uses it uses it up, right or wrong.
- **An assertion is checked** in full, with the phone's stored key (for `passkey-add`, the key being added, whose
  assertion shows it works before it is kept):
  1. `cdj` (clientDataJSON) is JSON with `type` `"webauthn.get"`, `challenge` equal to the live challenge in b64u
     (no padding), `origin` equal to the expected origin, and `crossOrigin` absent or false;
  2. `ad` (authenticatorData) is at least 37 bytes; its first 32 are SHA-256 of the rp id; its flags byte has UP
     (0x01) and UV (0x04);
  3. `sig` is a DER ECDSA P-256 signature over `ad || SHA-256(cdj)`;
  4. the signature counter (`ad` bytes 33 to 36, big-endian): unless it and the stored one are both 0, it must be
     higher than the stored one, which it then replaces. (Apple's passkeys always say 0.)
- **Before each send**, if the phone chose it (`sends`): `send` carries `a.auth = {"ad","cdj","sig"}` over a
  `for:"send"` challenge, checked before anything is reserved or paid. The prompt doesn't show the payment, so the
  daily limit and the desktop's confirmation stay as they are.
- **On the desktop**, Settings > Phone shows which phones have Face ID, and **Remove Face ID** takes a phone's passkey
  away (for a phone that lost it). Revoke works as before.
- **Test vectors:** `relay/testvectors/webauthn-v1.json` (a key, a challenge, an assertion that passes and one for each
  way it fails, and an attestation object to read the key from).

## Wake on demand (app v0.2.4)

The desktop app can start its background part when the user logs in, without its node ("Start when I log in"). Its
link to the relay is up, but the node starts only when a paired phone asks for something: after the session and, for
a phone with a passkey, Face ID have checked out. Never on a bare connection to the relay, a pair request, or a
removed phone.

While the node starts, a request that needs it (`balance`, `history`, `receive`, `status`, `send`, and from v0.2.5
`notes`, `houses`, `note-send`, `note-redeem`, `note-demand`) is answered
`{"id","err":"<message>","starting":true}`, the request that woke it included; so is one that finds the node gone
later (it is woken again). A wake waits up to 10 minutes for the node. If the node can't start, or stops while
starting, such requests are answered with a plain error saying to open FreeBank on the desktop, and the next try
waits two minutes. The page's Home screen shows that the desktop is starting and asks again every 10 seconds, for
5 minutes at most; other screens show the error. While the desktop app stays closed, a node started this way stops
again after 30 minutes with no phone asking. Nothing changes for the relay.

## House notes (app v0.2.5)

A desktop that answers these says so: `status` carries `"credit": true`. An older desktop answers them
`"unknown method"`, and the page shows no Notes.

| Method | Args | Result | Desktop calls |
|---|---|---|---|
| `notes` | — | a list of `{house, name, state, state_name, amount, demanded, redeemable, can_redeem, can_demand, rate_bps, type}` | `listmynotes`, `listhouses` |
| `houses` | — | a list of `{house, name, state, state_name, ratio_bps, outstanding, reserves, attested_at, rate_bps, type}` | `listhouses` |
| `note-send` | `{"house","address","amount"}` | as `send` | `transfernote` |
| `note-redeem` | `{"house","amount"}` | as `send` | `redeemnote` |
| `note-demand` | `{"house","amount"}` | as `send` | `demandnote` |

- **Amounts** are ECX: one note unit is one sat, as on the desktop's Notes tab. `state` is the house's state by letter
  (`o` open, `s` stressed, `d` suspended, `i` insolvent, `w` wound down) and `state_name` its name; `rate_bps` is the
  yearly rate on demands queued while a house is suspended (1000 = 10%). `redeemable` is what can be redeemed now
  (while suspended, only notes under demand).
- **`type`** (desktop v0.2.6): who may hold a house's notes, from node v0.2.19's `listhouses`: `open` (anyone),
  `members` (only the house's members; the node refuses a note sent to anyone else) or `redeem` (members only, and
  notes pass only back to the house or onto the holder's own key, so the page offers no Send). A desktop before v0.2.6
  leaves it out: read that as `open`.
- **The note actions take the send's guard:** Face ID before each one when the phone chose it (`a.auth`, over a
  `for:"send"` challenge); the same daily limit, counted in ECX; held for the desktop above it (or with the wallet
  locked), with the same held and final replies; refused at once with the desktop app closed. The desktop pays them
  with the Notes tab's fee, 0.001 ECX. A redeem or a demand needs one holder's coins summing exactly to the amount;
  when the node refuses one for that, the error says to gather the notes first on the desktop (Notes, Send with the
  address left empty).
- **`notes` needs the wallet unlocked before node v0.2.19** (v0.2.19 lists them locked): freebankd lists a wallet's notes only then. The desktop unlocks it for a moment
  with the phone-send passphrase (as for a send) and locks it again; without that passphrase the phone hears to turn
  on "Let my phone send while FreeBank is open" on the desktop.
- On the desktop, a held note action reads "<phone> wants to redeem 0.5 ECX of house #3's notes", with Redeem or
  Demand as its button, and the phone payments list names it the same way.

## Approve on my phone (app v0.2.5)

"Approve sends on my phone", off unless the owner turns it on in desktop Settings > Phone. Reworked after the v0.2.5
security review (operator 2026-10-03: "yes to that").

**What it asks for:**
- **The desktop's payments.** Once those in the last 24 hours would come to more than the amount, the next one waits
  for a paired phone with Face ID. Approved payments don't count; payments that didn't go out give their count back.
  A locked wallet is unlocked first, so nothing is asked or counted before the passphrase. Every way the app pays
  counts, with its fee:
  - Send, and Speed up's extra fee;
  - the credit tabs' calls that sign (notes, bills, pools, houses; a house's pledges count);
  - a phone's held payment confirmed on the desktop, unless that phone's own Face ID signed it (`for:"send"`). A held
    send counts 0.001 ECX for the fee the node will choose.
- **What would get round it:**
  - turning it off, or a higher amount;
  - a higher daily limit for a phone (within it, that phone pays without the desktop);
  - pairing another phone (the ask shows its comparison code);
  - a paired phone's first Face ID (that would make it an approver, below), and the desktop's "Remove Face ID";
  - showing the recovery words or the master key (xprv) on the desktop;
  - a new wallet, new recovery words, or a restore from a backup file (new words would answer the recovery words'
    path);
  - Obliterate (it removes the phone link's settings, and the wallet may stay).

**The recovery words.** For a lost phone, the wallet's 24 recovery words on the desktop can turn it off or raise the
amount instead.
- The words must make the node wallet's key (`hdmasterkeyid`) and match FreeBank's sealed copy of them. Turning it on
  needs that copy.
- The change waits a day, and every phone that can approve gets a `"scheduled"` ask (below): its Face ID makes the change
  at once, and a decline cancels it. The desktop can cancel it too, and a stronger setting replaces it.

Revoking a phone needs nothing, nor does a phone turning its own Face ID off (that takes its own Face ID). The desktop
warns before it removes the last phone that can approve: with none, nobody can cancel the recovery words' change.

**The ask** has no `id`, as it isn't a reply:
`{"approve": {"id", "what": "send"|"action"|"change"|"scheduled", "amount", "address", "text", "challenge": "<b64u 32
bytes>", "cred", "expires", "secs"}}`
- **Who hears it:** every live session of each phone with a passkey, once that session has passed Face ID (`auth`).
  Someone holding the unlocked phone without Face ID sees nothing. A session that passes `auth` later hears every ask
  still waiting for it.
- **The fields:**
  - `amount` and `address` are a send's;
  - `"action"` is another payment, with `text` saying what it is and `amount` what it costs, fees included;
  - `"change"` has `text`;
  - `"scheduled"` has `amount`, the new amount (null for off), and `text`.
- **The time:** `secs` is the time left, and the page counts from when it arrives (its clock may differ). `expires` is
  the desktop's own clock. The day's total and the recovery words' day follow the desktop's clock too.
- **`cred`** is that phone's passkey id.

**The answer** is a request, `approve`, with the reply `{}`:
- **Approve:** `{"id", "auth": {"ad","cdj","sig"}}`, Face ID over `challenge`. It carries its own Face ID. The desktop
  checks the assertion as for `auth` (origin, rp id, UP and UV, the signature, the counter) against that phone's stored
  key and that ask's challenge. One that fails is refused, and the ask keeps waiting.
- **Decline:** `{"id", "decline": true}`, accepted only from a session that passed Face ID.
- A `"scheduled"` card answers only the change it showed: once that change is replaced, it is gone.
- An ask that is gone answers "That approval is no longer waiting."

**The end:** the first good answer settles it, and the desktop sends `{"approve-done": "<id>"}` to the phones'
sessions.
- The desktop waits 2 minutes for a payment or a change (a day for `"scheduled"`), and its owner can cancel.
- The page drops a card on `approve-done`, on any answer, once its time is up, and on "Not now" (until the next
  session). It starts each session with no cards: the desktop tells it again whatever still waits.

**A first Face ID.** While it is on, `status` carries `"add_asks": true` for a phone without a passkey.
- That phone's `auth-start` with `for:"add"` (and its `passkey-add`) answers an error saying the other phone is asked.
  The desktop then asks the phones with Face ID, once at a time: "Let <name> approve the desktop's payments too".
- The ask says when that phone was paired and last seen. Approved, that phone may add its passkey within 10 minutes;
  declined or unanswered, it can ask again after 10 minutes.
- With no phone left that can approve, the answer says to turn the setting off first.

**What it guards:** FreeBank, not the node. Someone with the computer and the wallet passphrase could still use the
node directly, copy the wallet, or change FreeBank's files or the computer's clock. A phone still pays within its own
daily limit without the desktop. The desktop's Settings say so. A phone link that failed to start while the setting
is on refuses payments rather than letting them through.

**Note actions on the phone** count their fee and up to two 1000-sat carrier outputs against the phone's daily limit
(0.00102 ECX each), as well as the notes.

## Hosted wallets (app v0.2.8)

In short, a shopkeeper
gets a wallet of his own, with his own 24 words, kept on the house's desktop until he moves it to a computer of his.
His phone reaches it through the relay like any phone. **A hosted phone acts for its own wallet only.** It is kept in
its own list (`hosted.json`), not the owner's `devices.json`, and has its own set of methods. Nothing an owner's phone
can do is open to it, and nothing here reaches the owner's wallet.

### Inviting (an owner's phone)

| Method | Args | Result |
|---|---|---|
| `houses-mine` | — | the members-only and redeem-only houses this wallet runs: `[{house, name, type}]` |
| `invite` | `{"house", "auth"}` | `{"url": "https://<host>/#pair=…", "secs": 600}` |

- `invite` needs the phone's own Face ID: a passkey, and `auth` over a `for:"invite"` challenge. A phone without a
  passkey is refused ("Add Face ID first"). It also needs "Let my phone send while FreeBank is open" on, because
  joining the house is signed by the desktop's wallet. Otherwise: "Turn on Let my phone send on your desktop first."
- The invite is a one-time code `C`, as in pairing: 16 random bytes, single use, **10 minutes**, at most 4 live at
  once. Its pairing JSON adds `"h": {"house": <id>, "name": "<house name>", "by": "<inviting phone's name>"}`.
  `relay`, `room` and `d` are the desktop's as usual.
- The house must be one `houses-mine` lists.

### Joining (the shopkeeper's phone)

1. The pair request is as in "Pairing", with `C` the invite's, and the plaintext adds `"hosted": true`. A hosted
   request with an ordinary pairing code, or an ordinary one with an invite code, is refused.
2. **The inviting phone allows it.** The desktop sends that phone's verified sessions
   `{"allow": {"id", "name", "code": "042 917", "house", "challenge", "cred", "secs"}}`. The phone answers with the
   request `allow`: `{"id", "auth"}` (Face ID over `challenge`) or `{"id", "decline": true}`. Desktop Settings ›
   Phone shows the same ask, and Allow there works too. The first answer settles it (`{"allow-done": "<id>"}`). The
   ask waits as long as the invite has left. At most **two** asks wait per invite (a third is refused), and each card
   carries `"others"`: how many other phones opened the same invite. The page warns when it isn't 0 (security review
   of v0.2.8, L4: someone who saw the QR).
3. On allow the desktop replies `{"t":"paired"}` as in pairing, and starts making the wallet. The phone reconnects
   with `hello`.

### A hosted phone's methods

A hosted phone must add a passkey before anything else. Until it has one, only `status`, `auth-start` (`for:"add"`) and
`passkey-add` are answered. The other-phone approval of "A first Face ID" doesn't apply, because a hosted phone never
approves the owner's payments. After that, the Face ID gate is as in "Face ID: passkeys".

| Method | Args | Result | Desktop calls |
|---|---|---|---|
| `status` | — | `{"hosted": true, "house", "house_name", "step", "blocks", "synced", "face_id", "credit": true}` | `getblockchaininfo` |
| `words` | — | `{"words": [24 strings]}` while `step` is `words`; refused after | — |
| `words-ok` | `{"auth"}` | `{}`; `step` becomes `joining` | `addhousemembers` from the desktop's wallet |
| `balance` | — | as `balance` | on the hosted wallet |
| `history` | `{"count"}` | as `history` | on the hosted wallet |
| `notes` | — | as `notes` | on the hosted wallet |
| `houses` | — | as `houses` | `listhouses` |
| `receive` | — | `{"address": "<member address>"}`: always the one member address | — |
| `send`, `note-send`, `note-redeem` | as for an owner's phone, with `auth` **every time** | `{"txid"}` | on the hosted wallet, unlocked with its passphrase for the moment |
| `move-home` | `{"address", "auth"}` | `{}`; `step` becomes `moving`, then `moved` | below, "Moving home" |
| `move-stop` | `{"auth"}` | `{}`; a move that is `moving` or `failed` goes back to `ready` | — |

- **`step`:** `setup` (the wallet is being made, about a minute, during which the node restarts once), `words` (the
  words wait to be shown and confirmed), `joining` (until the member list shows the address active, one block or
  more), `ready`, `moving` (the money is going to his own computer), `moved`. A failure gives `step: "failed"` and
  `"why"`.
- **Payments** need Face ID each time. There's no daily limit and nothing is held: it
  is the shopkeeper's own money. `note-demand` isn't offered.
- **After `moved`,** everything but `status` is refused: "This wallet has moved to your own computer."
- **Amounts, errors and `starting`** are as for an owner's phone.
- **Face ID purposes:** `invite` takes a `for:"invite"` challenge; `words-ok` and `move-home` take `for:"change"`;
  payments take `for:"send"`, as for an owner's phone. The owner's `allow` answer is an assertion over the
  `challenge` in the `allow` message itself (as `approve` works), with no `auth-start`.

### Making the wallet (desktop)

1. `createwallet hosted-<id>`, with `<id>` the phone's device id.
2. `encryptwallet` with a random 32-byte passphrase (hex). The node stops and is started again.
3. Fresh words (BIP39, 24); unlock; `sethdseed true <WIF>` with BIP85 index 0 of the words, as the app's own Setup
   does, so the desktop app's "Restore from recovery words" makes the same wallet; check `hdmasterkeyid`.
4. `getnewaddress "" legacy` gives the member address (the words' first address); lock.
5. The passphrase and, until `words-ok`, the words' entropy are kept in `hosted-keys.json` (0600) beside
   `hosted.json`. The entropy is wiped at `words-ok`.
6. At `words-ok`: unlock the desktop's wallet with the phone-send passphrase, `addhousemembers <house> [address]
   0.001`, then `sendtoaddress <address> 0.01` (a fee float: a note payment needs its fee and small carrier outputs,
   which a wallet holding only notes can't fund; found in the end-to-end run), lock. If the node answers that a
   member change for that house is already in this block, try again each block. A hosted payment the node can't fund
   says so plainly ("Your wallet has no ECX left for this payment's fee…").

### Moving home (to fresh words)

Restoring the shop's words at home
would leave the house's desktop, and its backups, with the same keys for good (security review of v0.2.8, M1). So the
money moves to new words of the shopkeeper's own computer, and the house's copy ends up empty.

1. He installs FreeBank on his computer and sets it up as anyone does, with new words of its own.
2. On his phone, **Move to my own computer** scans that desktop's pairing QR (`#pair=`) and pairs as an owner's
   phone (Face ID included), kept apart from the hosted pairing until it works.
3. The phone asks the new desktop for `receive`, then tells it `move-notice {"address", "house_name"}`: the new
   desktop shows the address and answers `{"mine": <its wallet's?>}` (a QR code from someone else's computer would
   otherwise take the money; the re-review of v0.2.8, N3). Only if `mine`, the phone shows the address ("check that
   your computer shows the same") and with Face ID sends the old host `move-home {"address", "auth"}`
   (`for:"change"`). The house's desktop refuses its own keys and the hosted wallet's own address, and shows its
   owner who is moving and the member it adds (N4). A move names its destination for good: a later `move-home`
   (after `move-stop`) must name the same address, so a hosted phone can't add a string of members (final
   re-review).
4. The house's desktop, `step: "moving"`:
   - checks the address (`validateaddress`) and adds it to the house (`addhousemembers`, signed as at joining);
   - once the member list shows it active, each house's notes the wallet holds, one house at a time, each confirmed
     before the next: sent (`transfernote <house> <all its units> 0.001 <address>`) where the address may hold them
     (this house, an open house, another members-only house it belongs to), redeemed (`redeemnote`) where it may
     not (a redeem-only house, or one it isn't a member of), and left in the copy, said in `why`, when neither works;
   - the house tops up the wallet's ECX for fees (0.01, three times at most);
   - then the rest of the ECX (`sendtoaddress <address> <balance> "" "" true`); under 0.0001 counts as nothing;
   - `step: "moved"` once nothing that can move is left, confirmed. `why` says what it waits for. Six refusals in a
     row turn it `failed`; the phone can `move-stop` it, and the desktop's Try again goes on with it (N1).
   - After `moved`, the old member address is taken off the house (`removehousemembers`), and the old copy is
     watched: money that reaches it later (the shop's old QR code) is sent on (N2). The page tells him to replace his
     QR codes and to keep the old words.
5. The phone, on `moved`, forgets the old host and stays with the new desktop. The new desktop's Receive shows that
   address as his address at the house (below, "Member addresses").
6. The house's desktop asks its owner whether to delete its copy, which now holds nothing. On yes it looks again (money
   that arrived since is sent on first), then removes the phone and, at the node's next start, deletes the wallet file
   and its passphrase: outright only once the old address is off the house (its removal confirmed and in effect);
   until then the copy moves aside, passphrase included (final re-review). A copy that still holds money
   (deleted without moving) moves aside instead, with its passphrase, into `<app data>/hosted-removed/`.

### Member addresses (owners' phones and desktops)

A members-only house's notes go only to its member addresses, and Receive makes a new address each time, which
wouldn't be one. So the owner's `receive` adds the wallet's member addresses: `{"address", "members": [{"house",
"name", "address"}]}`, one per members-only or redeem-only house where an address of this wallet is an active member
(`listhousemembers`, checked against the wallet's addresses). The page shows "Your address at ‹house›" for being
paid in that house's notes; the desktop's Receive does the same.

### Payment links

`https://<host>/#pay=<b64u JSON {"v":1, "a":"<address>", "h":<house>, "u":<ECX or null>, "n":"<shop name>"}>`.
**Scan to pay** in the page reads one, or a bare FreeBank address, and fills a note payment. The page strips the
fragment as it does `#pair=`. On iPhone the Camera opens such a link in Safari, not in the Home Screen icon, so payers
scan from inside the page.

## Over Nostr (desktop v0.6.0)

The same protocol, carried by public Nostr relays instead of fb-relay, so nobody hosts the link. Everything above the pipe is as above: pairing and its comparison
code, the session, the narrow door, held sends, Face ID, approvals, hosted wallets, wake on demand. Both links run side
by side: a phone keeps the one it paired over.

- **Keys:** the desktop's Nostr key `nD` (secp256k1, random, `phone/nostr.key`), and the phone's `nP` (random, kept with
  its pairing). They only sign events; `P`, `D` and the session prove who is talking.
- **Pairing link v2:** `https://<phone page>/#pair=<b64u JSON {"v":2, "r":["wss://…",…], "n":"<nD hex>", "d":"<D_pub>",
  "c":"<C>", "x":<expiry, unix seconds>}>`. At most 5 relays, `wss://` (`ws://` only on 127.0.0.1 or localhost). The
  page refuses a link expired more than 2 minutes ago, or one whose expiry is more than 12 minutes ahead. Invites add `"h"` as in v1. A v2 link
  isn't checked against the page's host, as v1's relay is.
- **The pair request's plaintext adds `"np"`,** the phone's Nostr key. It must equal the key that signed the event, or
  the request is refused. Allowed, the desktop keeps it with the phone (`np` in `devices.json` or `hosted.json`).
- **`pair-seen`:** over Nostr, the desktop answers a pair request that opened (one now waiting for "Allow this phone?")
  with `{"t":"pair-seen"}` in clear. Nothing else tells the phone the desktop is there.
- **A phone's sessions come over the link it paired on:** over Nostr only from its own `nP`, and a phone paired over
  the relay never over Nostr (`hello` is `denied` otherwise).
- **Events:** NIP-01, kind 21913 (ephemeral; the Truthcoin app's link uses it too), tags `p` (the receiver) and
  `expiration` (+300 s). Each goes to every relay; receivers check the id and signature and drop duplicates. The desktop
  drops events more than 300 s from its clock, and, before any signature check, events from keys that aren't a paired
  phone's, unless a pairing code or invite over Nostr is live.
- **Who gets a channel:** a paired phone's key, up to 8 channels (a ninth takes its least active one's place), 64 in
  all. Any other key only for a pair request that opens with a live pairing code or invite and names that key, two per
  key and eight in all; it gets no answer otherwise. A channel starts at `s` 0 in an event made since the desktop's
  relays connected, and a channel forgotten in the last 10 minutes isn't opened again. A phone revoked or removed is
  still heard for an hour, so its next `hello` hears `denied`.
- **One process:** only the app or its background part answers over Nostr, whichever holds `phone/nostr.lock`.
- **Channels:** the content is `{"v":1, "c":"<16 random bytes, hex>", "s":<seq>, "d":<v1 frame>}`. The phone picks a
  channel for each connection (one per RelayLink of before) and starts it at `s` 0; each direction counts from 0.
  Early frames wait 10 s for the ones before them, and a gap that doesn't fill ends the channel. A frame whose JSON is
  over 24,000 bytes goes in parts, `{…,"p":[i,n],"x":"<text>"}` (2 to 16 parts, consecutive `s`). `{…,"bye":true}`
  ends a channel; the page sends it whenever a channel ends but by the desktop, and on `pagehide`. The desktop forgets a
  channel idle for 10 minutes.
- **Offline:** no frame within 8 s of the phone's first on a channel reads as the relay's `offline`.
- **Padding:** session plaintexts are padded with spaces (JSON ignores them) to 1, 4 or 16 KiB, both ways and over both
  links; the desktop pads its longer messages over Nostr to a multiple of 16 KiB, never over the relay (its 64 KiB
  frames).
- **What others see:** anyone can subscribe to kind 21913 on a public relay, not only its operator. They see the
  events' keys, when they are sent and their sizes, and the frames sent in clear: `pair` (sealed inside), `pair-seen`,
  `paired`, `pair-refused`, `hello` (with `P` and `eP`), `hello-ok`, `denied`, and `bye`. The relay operators also see IP
  addresses.
- **Relays:** by default `wss://relay.damus.io`, `wss://nos.lol` and `wss://relay.primal.net`, editable on the desktop
  (five at most). `status` carries `"relays"` for a phone paired over Nostr, and the page follows a changed list; the
  desktop keeps listening on the old list for a week after a change.
- **Face ID:** for a phone paired over Nostr, the origin and relying party come from the desktop's phone page address
  (`https://app.ecxfreebank.com` by default), not the relay's.
- **The page's CSP** allows `connect-src wss:` (fb-relay sends it), since the desktop's relay list is editable. That
  gives up the CSP's block on sending data to other servers, should script ever be injected; `script-src 'self'`
  still stands. An allowlist is for when the page's CSP moves into a `<meta>` tag.

## Not in protocol v1

- volunteer relays, peering, WebRTC;
- Web Push for hosted phones (a payment notification while the page is closed): after v0.2.8.
