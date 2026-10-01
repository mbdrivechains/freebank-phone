#!/usr/bin/env bash
# Install Playwright's browsers into node_modules (not ~/.cache) and, for WebKit on Ubuntu 24.04
# without root, the few system libraries it lacks (extracted from .deb files, no sudo).
set -euo pipefail
cd "$(dirname "$0")/.."
export PLAYWRIGHT_BROWSERS_PATH=0
npx playwright install webkit chromium firefox

LIBS=node_modules/.wk-libs
mkdir -p "$LIBS/deb"
( cd "$LIBS/deb" && apt-get download libwoff1 libavif16 libgav1-1 libyuv0 )
for f in "$LIBS"/deb/*.deb; do dpkg-deb -x "$f" "$LIBS"; done
# The WPE MiniBrowser wrapper resets LD_LIBRARY_PATH, so the libs also go next to it.
for d in node_modules/playwright-core/.local-browsers/webkit-*/minibrowser-wpe/sys/lib; do
  cp -a "$LIBS"/usr/lib/x86_64-linux-gnu/* "$d"/
done
echo "browsers ready"
