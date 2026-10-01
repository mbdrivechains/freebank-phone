# FreeBank phone page and relay

Use your FreeBank desktop wallet from your phone's browser. This repository has:
- **`phone/`**: the web page your phone opens, served at https://app.ecxfreebank.com (Svelte 4, Vite 5, TypeScript;
  WebCrypto only, no crypto libraries);
- **`relay/`**: the relay that passes sealed messages between your phone and your desktop (Rust, axum), and
  [`relay/PROTOCOL.md`](relay/PROTOCOL.md), the protocol both ends speak;
- **test vectors** for both ends (`relay/testvectors/`), with independent checks in Python.

The desktop side is in the FreeBank app: [mbdrivechains/freebank-app](https://github.com/mbdrivechains/freebank-app)
(`src-tauri/src/phone/`).

## What the relay can and can't do

- It only passes sealed messages along. The phone and the desktop agree keys the relay never sees (P-256 ECDH,
  HKDF-SHA256, AES-256-GCM).
- Your desktop decides what a phone may do: its daily limit, your approval for anything above it, and Face ID if you
  turned it on.
- But the relay's server also serves the page your phone runs, and a changed page could misbehave. So check that the
  page you get is built from this source (below; [`relay/SECURITY_REVIEW.md`](relay/SECURITY_REVIEW.md), P2).

## Check that the live page is this source

The page builds byte for byte the same. With Node 18 (checked with 18.19.1):

```sh
git clone https://github.com/mbdrivechains/freebank-phone
cd freebank-phone/phone
npm ci
npm run build
(cd dist && find . -type f | sort | xargs sha256sum)
```

Then fetch the same files from app.ecxfreebank.com and hash them:

```sh
mkdir live && cd live
curl -s -o index.html https://app.ecxfreebank.com/
for f in $(grep -oE '(src|href)="\./[^"]+"' index.html | sed 's/.*="\.\///; s/"$//') icon-192.png icon-512.png; do
  mkdir -p "$(dirname "$f")"; curl -s -o "$f" "https://app.ecxfreebank.com/$f"
done
find . -type f | sort | xargs sha256sum
```

The two lists must be the same eight files with the same hashes. If they differ, please report it (Security, below).
Each commit here names the build of app.ecxfreebank.com it matches; the newest commit is the live one.

The relay's own binary isn't reproducible yet. It never sees your keys or what you send, but it does serve the page,
which is why the check above matters.

## Build and test

- The page: [`phone/README.md`](phone/README.md) (`npm ci`, `npm test`, `npm run build`, end-to-end tests in WebKit,
  Chromium and Firefox).
- The relay: [`relay/README.md`](relay/README.md) (`cargo build --release`, `cargo test`, its options and limits).
- The hardened systemd unit and nginx site that run app.ecxfreebank.com are in `relay/deploy/`.

## Security

Please report problems privately, through GitHub's private vulnerability reporting on this repository (Security,
then Report a vulnerability). See [`SECURITY.md`](SECURITY.md). The security review of the relay and the page is
[`relay/SECURITY_REVIEW.md`](relay/SECURITY_REVIEW.md).

FreeBank is experimental, pre-audit software.

## License

MIT; see [`LICENSE`](LICENSE).
