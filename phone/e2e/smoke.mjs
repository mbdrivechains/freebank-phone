#!/usr/bin/env node
// End-to-end smoke test of the phone page against a MOCK relay + desktop (all in this process,
// on 127.0.0.1). Runs the same flow in WebKit (iPhone 390x844), Chromium (Pixel 7) and
// Firefox (412x915) when available. Screenshots go to e2e/shots/<engine>/.
//
//   npm run build && node e2e/smoke.mjs [webkit] [chromium] [firefox] [--real-relay] [--relay-bin=<path>]
//
// --real-relay: instead of the in-process mock relay, spawn ../relay/target/debug/fb-relay on
// 127.0.0.1 (serving dist/, allowing only the page's origin) and connect the mock desktop to it as
// the host (with the ECDSA proof). --relay-bin=<path> (or FB_RELAY_BIN) runs another build, such as
// the release binary. --relay-url=<origin> uses a relay that is already running there instead (for
// example under systemd, or behind nginx on https with a test certificate); it must allow that origin.
//
// Browsers live in node_modules (PLAYWRIGHT_BROWSERS_PATH=0); see e2e/setup-browsers.sh.
import http from 'node:http';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { WebSocketServer, WebSocket } from 'ws';
import jsQR from 'jsqr';
import { MockDesktop } from './mock-desktop.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, '../dist');
const shotsRoot = resolve(here, 'shots');
process.env.PLAYWRIGHT_BROWSERS_PATH = '0';
const wkLibs = resolve(here, '../node_modules/.wk-libs/usr/lib/x86_64-linux-gnu');
if (existsSync(wkLibs)) process.env.LD_LIBRARY_PATH = [wkLibs, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
const { webkit, chromium, firefox, devices } = await import('playwright');

if (!existsSync(join(dist, 'index.html'))) {
  console.error('dist/ missing: run npm run build first');
  process.exit(1);
}

// The headers fb-relay sends (relay/src/lib.rs, CSP and PERMISSIONS_POLICY): only 'self'.
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; " +
  "manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const PERMISSIONS = 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), display-capture=(), fullscreen=()';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

// ---------- static server + mock relay (same origin, like the real relay) ----------
let desk = null; // current MockDesktop
let desktopOnline = true;
let nextCh = 1;
const phones = new Set();

const server = http.createServer((req, res) => {
  const p = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
  let f = join(dist, p === '/' ? 'index.html' : p);
  if (!f.startsWith(dist) || !existsSync(f) || statSync(f).isDirectory()) f = join(dist, 'index.html');
  res.writeHead(200, {
    'content-type': TYPES[extname(f)] ?? 'application/octet-stream',
    'content-security-policy': CSP,
    'permissions-policy': PERMISSIONS,
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
  });
  res.end(readFileSync(f));
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
server.on('upgrade', (req, sock, head) => {
  if (new URL(req.url, 'http://x').pathname !== '/ws') return sock.destroy();
  wss.handleUpgrade(req, sock, head, (ws) => onPhone(ws));
});

function onPhone(ws) {
  let chan = null;
  let ch = 0;
  phones.add(ws);
  ws.on('message', (raw) => {
    let f;
    try {
      f = JSON.parse(raw.toString());
    } catch {
      return ws.close();
    }
    if (!chan) {
      if (f?.t !== 'join' || f.room !== desk?.room) return ws.close();
      if (!desktopOnline) {
        ws.send(JSON.stringify({ t: 'offline' }));
        return ws.close();
      }
      ch = nextCh++;
      // Even channels get the {"ch","d"} wrapper, odd ones the bare frame: the page takes both.
      const wrap = ch % 2 === 0;
      chan = desk.channel(
        (d) => ws.readyState === 1 && ws.send(JSON.stringify(wrap ? { ch, d } : d)),
        () => ws.close(),
      );
      ws.send(JSON.stringify({ t: 'joined', ch }));
      return;
    }
    chan.onFrame(f);
  });
  ws.on('close', () => {
    phones.delete(ws);
    chan?.onClose();
  });
}

/** The desktop drops off the relay: phones get {"t":"closed"} and joins get "offline". */
function desktopGoesOffline() {
  desktopOnline = false;
  for (const ws of phones) {
    ws.send(JSON.stringify({ t: 'closed', ch: 0 }));
    ws.close();
  }
}

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const EXTERNAL = process.argv.find((a) => a.startsWith('--relay-url='))?.slice('--relay-url='.length).replace(/\/$/, '') ?? null;
const REAL = process.argv.includes('--real-relay') || !!EXTERNAL;
let port = server.address().port;
let relayProc = null;
if (EXTERNAL) {
  server.close();
  console.log('using the relay at', EXTERNAL);
} else if (REAL) {
  // Borrow a free port for the real relay, then serve through it instead.
  server.close();
  const probe = http.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  port = probe.address().port;
  await new Promise((r) => probe.close(r));
  const binArg = process.argv.find((a) => a.startsWith('--relay-bin='));
  const bin = binArg ? resolve(binArg.slice('--relay-bin='.length)) : process.env.FB_RELAY_BIN
    ? resolve(process.env.FB_RELAY_BIN) : resolve(here, '../../relay/target/debug/fb-relay');
  console.log('relay binary', bin);
  relayProc = spawn(bin, ['--listen', `127.0.0.1:${port}`, '--static', dist, '--origin', `http://127.0.0.1:${port}`],
    { stdio: ['ignore', 'ignore', 'pipe'] });
  relayProc.stderr.on('data', () => {});
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/`)).ok) break;
    } catch {}
    if (i > 100) throw new Error('fb-relay did not start');
    await new Promise((r) => setTimeout(r, 100));
  }
  console.log('real fb-relay pid', relayProc.pid);
}
const origin = EXTERNAL ?? `http://127.0.0.1:${port}`;
const wsUrl = origin.replace(/^http/, 'ws') + '/ws';
const tlsTest = origin.startsWith('https:'); // a test certificate: browsers and the mock desktop skip the check
if (!EXTERNAL) console.log('serving', dist, 'on', origin, REAL ? '(real fb-relay)' : '(mock relay)');

// ---------- mock desktop as a real host on fb-relay ----------
let hostWs = null;
async function hostConnect() {
  const ws = new WebSocket(wsUrl, tlsTest ? { rejectUnauthorized: false } : {});
  const chans = new Map();
  await new Promise((res, rej) => {
    ws.on('error', rej);
    ws.on('open', () => ws.send(JSON.stringify({ t: 'host', room: desk.room, d: desk.dPub })));
    ws.on('message', async (raw) => {
      const f = JSON.parse(raw.toString());
      if (f.t === 'challenge') {
        // Over "fb-relay-proof-v1" || n (mock-desktop.mjs); the relay refuses a proof over the bare n.
        ws.send(JSON.stringify({ t: 'proof', sig: await desk.proof(f.n) }));
      } else if (f.t === 'ready') {
        res();
      } else if (f.t === 'closed') {
        chans.get(f.ch)?.onClose();
        chans.delete(f.ch);
      } else if (typeof f.ch === 'number' && 'd' in f) {
        let c = chans.get(f.ch);
        if (!c) {
          const ch = f.ch;
          c = desk.channel(
            (d) => ws.readyState === 1 && ws.send(JSON.stringify({ ch, d })),
            () => ws.readyState === 1 && ws.send(JSON.stringify({ t: 'close', ch })),
          );
          chans.set(ch, c);
        }
        c.onFrame(f.d);
      }
    });
  });
  hostWs = ws;
}
async function goOffline() {
  if (!REAL) return desktopGoesOffline();
  hostWs?.close();
  hostWs = null;
}
async function goOnline() {
  if (!REAL) {
    desktopOnline = true;
    return;
  }
  await hostConnect();
}

// ---------- the flow ----------
const ENGINES = {
  webkit: { type: webkit, ctx: { ...devices['iPhone 13'], viewport: { width: 390, height: 844 } } },
  chromium: { type: chromium, ctx: { ...devices['Pixel 7'] } },
  firefox: { type: firefox, ctx: { viewport: { width: 412, height: 915 }, hasTouch: true, deviceScaleFactor: 2,
    userAgent: 'Mozilla/5.0 (Android 14; Mobile; rv:128.0) Gecko/128.0 Firefox/128.0' } },
};

async function qrFromPage(page) {
  // Read the QR <svg> the page drew (the gold ghost's shades, then the dark squares), rasterise each path in its
  // own colour here, and decode with jsQR.
  const { paths, size } = await page.evaluate(() => {
    const svg = document.querySelector('[data-testid=qr]');
    const paths = [...svg.querySelectorAll('path')].map((p) => ({ d: p.getAttribute('d'), fill: p.getAttribute('fill') }));
    return { paths, size: Number(svg.getAttribute('viewBox').split(' ')[2]) };
  });
  const scale = 6, w = size * scale;
  const px = new Uint8ClampedArray(w * w * 4).fill(255);
  for (const { d, fill } of paths) {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(fill.slice(i, i + 2), 16));
    for (const [, x, y] of d.matchAll(/M(\d+) (\d+)/g))
      for (let dy = 0; dy < scale; dy++)
        for (let dx = 0; dx < scale; dx++) {
          const o = ((+y * scale + dy) * w + (+x * scale + dx)) * 4;
          px[o] = r;
          px[o + 1] = g;
          px[o + 2] = b;
        }
  }
  return jsQR(px, w, w)?.data ?? null;
}

async function runEngine(name) {
  const { type, ctx } = ENGINES[name];
  const results = [];
  const check = (what, ok, extra = '') => {
    results.push({ what, ok });
    console.log(`  [${name}] ${ok ? 'ok  ' : 'FAIL'} ${what}${extra ? ' — ' + extra : ''}`);
  };
  const shots = join(shotsRoot, REAL ? name + '-real-relay' : name);
  rmSync(shots, { recursive: true, force: true });
  mkdirSync(shots, { recursive: true });
  let n = 0;
  // Playwright's screenshot injects a <style> of its own, which the CSP (rightly) refuses; those
  // console messages are ignored below while a screenshot is being taken.
  let inShot = false;
  const shot = async (page, label) => {
    inShot = true;
    try {
      await page.screenshot({ path: join(shots, `${String(++n).padStart(2, '0')}-${label}.png`), caret: 'initial' });
    } finally {
      inShot = false;
    }
  };

  // checkCode: the mock's "owner" allows a pair request only if the phone shows the same comparison code.
  desk = await MockDesktop.create({ pairDelayMs: 1500, holdDelayMs: 2500, limit: 0.1, checkCode: true });
  desktopOnline = true;

  /**
   * The owner compares the two screens (PROTOCOL.md, "The comparison code"): the phone's code must be the one the
   * desktop worked out for this request (`requestsBefore` = how many requests it had seen before this one).
   */
  const compareCodes = async (page, what, requestsBefore) => {
    const line = page.getByTestId('pair-code');
    await line.waitFor({ timeout: 15000 });
    const text = (await line.textContent()).trim();
    const shown = /^Check that your desktop shows (\d{3} \d{3})$/.exec(text)?.[1] ?? null;
    for (let i = 0; i < 100 && desk.pairs.length === requestsBefore; i++) await page.waitForTimeout(50);
    const desktop = desk.pairs.at(-1)?.code;
    check(`${what}: the phone shows the desktop's comparison code`, !!shown && shown === desktop, `"${text}", desktop ${desktop}`);
    desk.phoneShows = shown ?? 'nothing';
  };
  if (REAL) {
    hostWs?.close();
    await hostConnect();
  }

  const browser = await type.launch();
  const problems = [];
  try {
    const context = await browser.newContext({ ...ctx, colorScheme: 'dark', ignoreHTTPSErrors: tlsTest });
    const page = await context.newPage();
    page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
    page.on('console', (m) => {
      if (process.env.SMOKE_DEBUG) console.log('    console:', m.type(), m.text());
      if (inShot && /Refused to apply a stylesheet/.test(m.text())) return;
      if (m.type() === 'error' || /Content Security Policy|CSP/i.test(m.text())) problems.push('console: ' + m.text());
    });

    // 1. Not paired, no link.
    await page.goto(origin + '/');
    await page.getByText('Open the pairing link from your FreeBank desktop app').waitFor();
    await shot(page, 'not-paired');
    check('not-paired screen', true);

    // 2. Pairing link.
    const link = desk.pairingLink(wsUrl, origin);
    await page.goto(link);
    await page.getByLabel('Name for this phone').waitFor();
    check('fragment stripped from the address bar', !page.url().includes('#pair') && !page.url().includes('pair='), page.url());
    const defName = await page.getByLabel('Name for this phone').inputValue();
    check('default device name', defName === (name === 'webkit' ? 'iPhone' : 'Android phone'), defName);
    await shot(page, 'pair-name');
    await page.getByLabel('Name for this phone').fill(`Test ${name}`);
    let before = desk.pairs.length;
    await page.getByRole('button', { name: 'Pair', exact: true }).click();
    await page.getByText('Allow this phone?').waitFor();
    await shot(page, 'pair-waiting');
    await compareCodes(page, 'pairing', before);
    await page.getByTestId('home').waitFor({ timeout: 15000 });
    check('paired', desk.devices.size === 1, [...desk.devices.values()].map((d) => d.name).join());

    // 3. Home.
    await page.getByTestId('status').getByText('Connected').waitFor({ timeout: 15000 });
    await page.getByTestId('balance').getByText('12.50').waitFor({ timeout: 15000 });
    check('balance shown', true);
    check('pending shown', (await page.getByTestId('pending').textContent()).includes('+0.25'));
    const rows = await page.getByTestId('txs').locator('li').count();
    check('history shown', rows === 4, `${rows} rows`);
    await shot(page, 'home');
    await page.getByTestId('txs').locator('li button.tx').first().click();
    const txid = (await page.getByTestId('txid').first().textContent()).trim();
    check('tx expands with txid', txid === desk.wallet.txs[0].txid);
    await shot(page, 'home-tx-open');

    // Key is stored and non-extractable.
    const keyCheck = await page.evaluate(() => new Promise((res) => {
      const r = indexedDB.open('freebank-phone');
      r.onsuccess = () => {
        const g = r.result.transaction('kv').objectStore('kv').get('pairing');
        g.onsuccess = async () => {
          const p = g.result;
          let exported = true;
          try {
            await crypto.subtle.exportKey('jwk', p.pPriv);
          } catch {
            exported = false;
          }
          res({ stored: !!p, isKey: p?.pPriv instanceof CryptoKey, extractable: p?.pPriv?.extractable, exported });
        };
      };
      r.onerror = () => res({ stored: false });
    }));
    check('device key in IndexedDB, non-extractable', keyCheck.stored && keyCheck.isKey && keyCheck.extractable === false && !keyCheck.exported, JSON.stringify(keyCheck));

    // 4. Receive.
    await page.getByRole('button', { name: 'Receive', exact: true }).click();
    await page.getByTestId('qr').waitFor();
    const address = (await page.getByTestId('address').textContent()).trim();
    const decoded = await qrFromPage(page);
    check('receive QR decodes to the address', decoded === address, `${address} / ${decoded}`);
    await shot(page, 'receive');
    await page.getByRole('button', { name: 'Back' }).click();
    await page.getByTestId('home').waitFor();

    // 5. Send under the limit.
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.getByTestId('limit').getByText('0.10 ECX').waitFor({ timeout: 10000 });
    await page.getByLabel('Pay to address').fill(address);
    await page.getByLabel('Amount').fill('0,05');
    await shot(page, 'send-form');
    await page.getByRole('button', { name: 'Review' }).click();
    await shot(page, 'send-review');
    await page.getByRole('button', { name: 'Send 0.05 ECX' }).click();
    await page.getByTestId('receipt').waitFor({ timeout: 10000 });
    const r1 = (await page.getByTestId('receipt-txid').textContent()).trim();
    check('send receipt with txid', /^[0-9a-f]{64}$/.test(r1) && r1 === desk.wallet.txs[0].txid);
    await shot(page, 'send-receipt');
    await page.getByRole('button', { name: 'Done' }).click();
    await page.getByTestId('home').waitFor();

    // 6. Held send (over the remaining 0.05).
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.getByTestId('limit').getByText('0.05 ECX').waitFor({ timeout: 10000 });
    await page.getByLabel('Pay to address').fill(address);
    await page.getByLabel('Amount').fill('1');
    await page.getByRole('button', { name: 'Review' }).click();
    await page.getByText("more than today's limit").waitFor();
    await page.getByRole('button', { name: 'Send 1.00 ECX' }).click();
    await page.getByTestId('held').waitFor({ timeout: 10000 });
    check('held send shows waiting for desktop', await page.getByText('Waiting for your desktop…').isVisible());
    await shot(page, 'send-held');
    await page.getByTestId('receipt').waitFor({ timeout: 15000 });
    const r2 = (await page.getByTestId('receipt-txid').textContent()).trim();
    check('held send resolves to a receipt', r2 === desk.wallet.txs[0].txid && r2 !== r1);
    await shot(page, 'send-held-receipt');
    await page.getByRole('button', { name: 'Done' }).click();
    await page.getByTestId('home').waitFor();
    await page.getByTestId('balance').getByText('11.45').waitFor({ timeout: 10000 });
    check('balance refreshed after sends', true);

    // 6b. The desktop wallet is locked: a send within the limit is held too, and the page says why.
    desk.locked = true;
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.getByTestId('limit').getByText('0.05 ECX').waitFor({ timeout: 10000 });
    await page.getByLabel('Pay to address').fill(address);
    await page.getByLabel('Amount').fill('0.01');
    await page.getByRole('button', { name: 'Review' }).click();
    await page.getByRole('button', { name: 'Send 0.01 ECX' }).click();
    await page.getByTestId('held-locked').waitFor({ timeout: 10000 });
    check('locked wallet: the page says so',
      (await page.getByTestId('held-locked').textContent()).trim() === 'Your desktop wallet is locked: confirm on your desktop.');
    await shot(page, 'send-held-locked');
    await page.getByTestId('receipt').waitFor({ timeout: 15000 });
    check('locked hold confirmed on the desktop resolves to a receipt',
      (await page.getByTestId('receipt-txid').textContent()).trim() === desk.wallet.txs[0].txid);
    await page.getByRole('button', { name: 'Done' }).click();
    await page.getByTestId('home').waitFor();
    await page.getByTestId('balance').getByText('11.44').waitFor({ timeout: 10000 });
    desk.locked = false;

    // 7. Desktop drops off the relay, then comes back.
    await goOffline();
    await page.getByTestId('status').getByText(/Desktop offline|Reconnecting/).waitFor({ timeout: 10000 });
    await page.getByTestId('status').getByText('Desktop offline').waitFor({ timeout: 10000 });
    check('status shows desktop offline', true);
    await shot(page, 'desktop-offline');
    await goOnline();
    const t0 = Date.now();
    await page.getByTestId('status').getByText('Connected').waitFor({ timeout: 40000 });
    check('reconnected', true, `${Date.now() - t0} ms after the desktop came back`);

    // 8. Reload: still paired (key from IndexedDB, fresh handshake).
    await page.reload();
    await page.getByTestId('status').getByText('Connected').waitFor({ timeout: 15000 });
    await page.getByTestId('balance').getByText('11.44').waitFor({ timeout: 10000 });
    check('reload keeps the pairing', true);

    // Light theme.
    await page.emulateMedia({ colorScheme: 'light' });
    await shot(page, 'home-light');
    await page.emulateMedia({ colorScheme: 'dark' });

    // 9. Revoked on the desktop. "Try again" keeps the key and asks once more (a relay could forge `denied`).
    desk.revokeAll();
    await page.getByText('This phone was removed').waitFor({ timeout: 40000 });
    check('revoked phone is told so', true);
    await shot(page, 'revoked');
    const denials = desk.log.filter((l) => l === 'hello: denied').length;
    await page.getByRole('button', { name: 'Try again' }).click();
    for (let i = 0; i < 100 && desk.log.filter((l) => l === 'hello: denied').length === denials; i++) {
      await page.waitForTimeout(100);
    }
    await page.getByText('This phone was removed').waitFor({ timeout: 10000 });
    check('try again asks the desktop again and keeps the pairing',
      desk.log.filter((l) => l === 'hello: denied').length > denials);

    // 10. Settings: forget.
    await page.getByRole('button', { name: 'Forget this desktop' }).click();
    await page.getByText('Open the pairing link from your FreeBank desktop app').waitFor();
    const gone = await page.evaluate(() => new Promise((res) => {
      const r = indexedDB.open('freebank-phone');
      r.onsuccess = () => {
        const g = r.result.transaction('kv').objectStore('kv').get('pairing');
        g.onsuccess = () => res(g.result === undefined);
      };
    }));
    check('forget deletes the key', gone);

    // Settings screen shot: pair again quickly and open settings.
    const link2 = desk.pairingLink(wsUrl, origin);
    await page.goto(link2);
    before = desk.pairs.length;
    await page.getByRole('button', { name: 'Pair', exact: true }).click();
    await compareCodes(page, 'pairing again', before);
    await page.getByTestId('home').waitFor({ timeout: 15000 });
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('button', { name: 'Forget this desktop' }).click();
    await shot(page, 'settings-forget');
    await page.getByTestId('forget-confirm').click();
    await page.getByText('Open the pairing link from your FreeBank desktop app').waitFor();
    check('forget from settings', true);

    // A pairing link that the desktop refuses (code already used).
    await page.goto(link2);
    await page.getByRole('button', { name: 'Pair', exact: true }).click();
    await page.getByText('Not paired').waitFor({ timeout: 15000 });
    check('pair-refused handled', true);
    await shot(page, 'pair-refused');

    // The owner sees different codes on the two screens (someone else's request) and denies it.
    await page.goto(desk.pairingLink(wsUrl, origin));
    before = desk.pairs.length;
    await page.getByRole('button', { name: 'Pair', exact: true }).click();
    await page.getByTestId('pair-code').waitFor({ timeout: 15000 });
    for (let i = 0; i < 100 && desk.pairs.length === before; i++) await page.waitForTimeout(50);
    desk.phoneShows = desk.pairs.at(-1).code === '000 000' ? '000 001' : '000 000'; // not what the desktop shows
    await page.getByText('Not paired').waitFor({ timeout: 15000 });
    check('codes that differ: the desktop refuses, the phone is not paired', desk.pairs.at(-1).answer === 'refused');

    // A pairing link naming another relay is refused before anything is sent.
    await page.goto(desk.pairingLink('wss://relay.evil.example/ws', origin));
    await page.getByText('This pairing link is for another server').waitFor({ timeout: 10000 });
    check('pairing link for another relay refused', await page.getByRole('button', { name: 'Pair', exact: true }).count() === 0);
    await shot(page, 'pair-other-relay');

    // Browsers log a dropped WebSocket as a console error; that is the network, not the page.
    const netNoise = problems.filter((m) => /WebSocket connection to .* failed/.test(m));
    const real = problems.filter((m) => !netNoise.includes(m));
    if (netNoise.length) console.log(`  [${name}] note: ${netNoise.length} WebSocket drop message(s): ${netNoise[0]}`);
    check('no page errors or CSP violations', real.length === 0, real.join(' | '));
    await context.close();
  } catch (e) {
    check('flow completed', false, e.message.split('\n')[0]);
    if (problems.length) console.log('  problems:', problems.join(' | '));
  } finally {
    await browser.close();
  }
  return results;
}

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const wanted = args.length ? args : Object.keys(ENGINES);
const summary = {};
try {
  for (const name of wanted) {
    console.log(`\n== ${name}`);
    try {
      const r = await runEngine(name);
      summary[name] = `${r.filter((x) => x.ok).length}/${r.length} passed`;
    } catch (e) {
      summary[name] = 'could not run: ' + e.message.split('\n')[0];
      console.log('  ' + summary[name]);
    }
  }
} finally {
  for (const ws of phones) ws.terminate();
  wss.close();
  server.close();
  hostWs?.close();
  if (relayProc) relayProc.kill('SIGTERM'); // by PID, the one we started
}
console.log('\nsummary', summary);
process.exitCode = Object.values(summary).every((s) => /^(\d+)\/\1 passed$/.test(s)) ? 0 : 1;
