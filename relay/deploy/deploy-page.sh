#!/usr/bin/env bash
# deploy-page.sh <C> <step>: put the phone page (and the relay) of commit <C> live at app.ecxfreebank.com, each step
# checking what it did. The steps are "Upgrading" in INSTALL.md, as run by hand until 2026-10-03.
#
#   build [<live C>]  a clean export of phone/ and relay/ at <C>; npm ci (no install scripts) and the page's build; the relay's release build
#                     (cargo --locked). With <live C>, and the relay's code unchanged since it, the relay binary is
#                     <live C>'s very file, so only the page changes. The repo's own build of the page must equal the
#                     export's. Writes out/<C>/ with SHA256SUMS-<C>.
#   install           copies out/<C>/ to the droplet, checks the sums there, installs /opt/fb-relay/releases/<C>
#                     (root-owned, read-only, no symlinks in the page). Nothing changes for users.
#   live              /opt/fb-relay/current -> releases/<C>, restarts fb-relay, then checks: active, ws-check.py, the page,
#                     licenses.txt, /feedback (415 for the wrong type), ecxfreebank.com and the explorer, and the live
#                     index.html equal to out/<C>'s.
#   publish           publish-phone.sh <C> <C> publish: the public github.com/mbdrivechains/freebank-phone gets this
#                     build's source (it checks the live page byte for byte first).
#   all               install, live, publish (after build).
#   back <old C>      rollback: current -> releases/<old C>, restart, check.
#
# Never restarts nginx or anything but fb-relay. Each step needs the owner's OK for that deploy; the allow rule for this
# script (as for app/release/release-app.sh) is the standing grant to run it once given.
set -euo pipefail
C=${1:?commit, e.g. a1b2470}
STEP=${2:?build, install, live, publish, all or back}
HERE=$(cd "$(dirname "$0")" && pwd)                      # relay/deploy
REPO=$(cd "$HERE/../.." && pwd)                          # freebank-distribution
HOST=${FB_DROPLET:-freebanktest}
SITE=https://app.ecxfreebank.com
SCRATCH=${DEPLOY_WORK:-$REPO/relay/deploy/out/.build}    # ignored by git, as out/ is
RELAY_CODE=(relay/src relay/tests relay/Cargo.toml relay/Cargo.lock relay/testvectors)

die() { echo "STOP: $*" >&2; exit 1; }
SHA=$(git -C "$REPO" rev-parse --verify "$C^{commit}") || die "no such commit: $C"
[ "${SHA:0:${#C}}" = "$C" ] || die "give the short commit, not a ref: $C"
OUT=$HERE/out/$C
BIN=fb-relay-$C-x86_64-linux-gnu
WWW=fb-relay-www-$C.tar.gz
SUMS=SHA256SUMS-$C
ssh_() { timeout 180 ssh -o BatchMode=yes "$HOST" "$@"; }

build() {
    local live=${1:-}
    git -C "$REPO" merge-base --is-ancestor "$SHA" "$(git -C "$REPO" rev-parse origin/master)" \
        || die "$C is not on svr's master yet: push it first"
    local X=$SCRATCH/$C
    rm -rf "$X"; mkdir -p "$X"
    git -C "$REPO" archive "$SHA" phone relay | tar -x -C "$X"
    # No install scripts (security review of v0.2.6, L5): the lockfile pins the packages, and the page builds without.
    (cd "$X/phone" && timeout 600 npm ci --ignore-scripts --no-audit --no-fund >"$X/npm.log" 2>&1 && timeout 300 npm run build >"$X/vite.log" 2>&1) \
        || die "the page didn't build: $X/npm.log, $X/vite.log"
    mkdir -p "$OUT"
    if [ -n "$live" ] && [ -z "$(git -C "$REPO" diff --name-only "$live" "$SHA" -- "${RELAY_CODE[@]}")" ] \
        && [ -f "$HERE/out/$live/fb-relay-$live-x86_64-linux-gnu" ]; then
        cp "$HERE/out/$live/fb-relay-$live-x86_64-linux-gnu" "$OUT/$BIN"
        echo "relay: code unchanged since $live; its binary reused"
    else
        (cd "$X/relay" && CARGO_BUILD_JOBS=2 timeout 1800 cargo build --release --locked >"$X/cargo.log" 2>&1) \
            || die "the relay didn't build: $X/cargo.log"
        cp "$X/relay/target/release/fb-relay" "$OUT/$BIN"
        echo "relay: built ($(objdump -T "$OUT/$BIN" | grep -o 'GLIBC_[0-9.]*' | sort -uV | tail -1))"
    fi
    tar -czf "$OUT/$WWW" -C "$X/phone/dist" .
    (cd "$OUT" && sha256sum "$BIN" "$WWW" >"$SUMS" && cat "$SUMS")
    if [ "$(git -C "$REPO" rev-parse HEAD)" = "$SHA" ] && [ -z "$(git -C "$REPO" status --porcelain -- phone)" ]; then
        (cd "$REPO/phone" && timeout 300 npm run build >/dev/null 2>&1) && diff -r "$REPO/phone/dist" "$X/phone/dist" >/dev/null \
            || die "the repo's build of the page differs from the clean export's"
        echo "page: the repo's build equals the clean export's, byte for byte"
    fi
}

install_() {
    [ -f "$OUT/$SUMS" ] || die "no build: deploy-page.sh $C build first"
    (cd "$OUT" && sha256sum -c --quiet "$SUMS") || die "out/$C doesn't match its sums"
    echo "live now: $(ssh_ readlink /opt/fb-relay/current)"
    ssh_ "install -d -m 700 ~/fb-relay-install/$C"
    timeout 180 scp -q -o BatchMode=yes "$OUT/$BIN" "$OUT/$WWW" "$OUT/$SUMS" "$HERE/ws-check.py" "$HOST:fb-relay-install/$C/"
    ssh_ "set -e; C=$C; D=~/fb-relay-install/\$C; cd \$D && sha256sum -c $SUMS
sudo install -d -m 755 -o root -g root /opt/fb-relay/releases/\$C /opt/fb-relay/releases/\$C/www
sudo install -m 755 -o root -g root \$D/$BIN /opt/fb-relay/releases/\$C/fb-relay
sudo tar -xzf \$D/$WWW -C /opt/fb-relay/releases/\$C/www --no-same-owner --no-same-permissions
sudo chown -R root:root /opt/fb-relay/releases/\$C && sudo chmod -R go-w /opt/fb-relay/releases/\$C
n=\$(sudo find /opt/fb-relay/releases/\$C/www -type l | wc -l); [ \"\$n\" = 0 ] || { echo 'symlinks in the page'; exit 1; }
/opt/fb-relay/releases/\$C/fb-relay --version; ls /opt/fb-relay/releases/"
    echo "installed: /opt/fb-relay/releases/$C (not live)"
}

switch_to() {
    local to=$1
    ssh_ "set -e; sudo test -x /opt/fb-relay/releases/$to/fb-relay
cd /opt/fb-relay && sudo ln -sfn releases/$to /opt/fb-relay/current && sudo systemctl restart fb-relay && sleep 1
systemctl is-active fb-relay; readlink /opt/fb-relay/current
sudo journalctl -u fb-relay -n 2 --no-pager | cut -c1-150
python3 ~/fb-relay-install/$to/ws-check.py ws://127.0.0.1:8480/ws 2>&1 | tail -1"
    echo "switched at $(date -u +%H:%MZ)"
    local bad=0 code
    code=$(curl -s -o /dev/null -w '%{http_code}' "$SITE/"); echo "page $code"; [ "$code" = 200 ] || bad=1
    code=$(curl -s -o /dev/null -w '%{http_code}' "$SITE/licenses.txt"); echo "licenses $code"; [ "$code" = 200 ] || bad=1
    code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: text/plain' --data x "$SITE/feedback")
    echo "feedback, wrong type: $code"; [ "$code" = 415 ] || bad=1
    code=$(curl -s -o /dev/null -w '%{http_code}' https://ecxfreebank.com/); echo "ecxfreebank.com $code"; [ "$code" = 200 ] || bad=1
    code=$(curl -s -o /dev/null -w '%{http_code}' https://explorer.ecxfreebank.com/); echo "explorer $code"; [ "$code" = 200 ] || bad=1
    if [ -f "$HERE/out/$to/fb-relay-www-$to.tar.gz" ]; then
        if curl -s "$SITE/" | cmp -s - <(tar -xzOf "$HERE/out/$to/fb-relay-www-$to.tar.gz" ./index.html); then
            echo "live index.html = build $to"
        else echo "live index.html differs from build $to"; bad=1; fi
    fi
    [ $bad = 0 ] || die "a check failed after switching to $to (rollback: deploy-page.sh <old C> back)"
}

case $STEP in
    build)   build "${3:-}" ;;
    install) install_ ;;
    live)    switch_to "$C" ;;
    publish) "$REPO/publish/publish-phone.sh" "$C" "$C" publish ;;
    all)     install_; switch_to "$C"; "$REPO/publish/publish-phone.sh" "$C" "$C" publish ;;
    back)    switch_to "$C" ;;
    *)       die "step is build, install, live, publish, all or back" ;;
esac
