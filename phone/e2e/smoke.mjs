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
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { WebSocketServer, WebSocket } from 'ws';
import jsQR from 'jsqr';
import qrcode from 'qrcode-generator';
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

// The headers fb-relay sends (relay/src/lib.rs, CSP and PERMISSIONS_POLICY): only 'self', and FreeBank's helper.
const ASK_URL = 'https://ask.ecxfreebank.com/ask';
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; " +
  "connect-src 'self' https://ask.ecxfreebank.com; " +
  "manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const PERMISSIONS = 'camera=(self), microphone=(), geolocation=(), payment=(), usb=(), display-capture=(), fullscreen=()';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

// ---------- static server + mock relay (same origin, like the real relay) ----------
let desk = null; // current MockDesktop
const otherDesks = []; // more desktops on the mock relay (a hosted wallet's move home)
let desktopOnline = true;
let nextCh = 1;
const phones = new Set();

let lastReport = null; // the last report POSTed to the mock relay's /feedback
const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/feedback') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      lastReport = JSON.parse(body);
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end('{"id":"0a1b2c3d"}');
    });
    return;
  }
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
      const target = f?.t === 'join' ? [desk, ...otherDesks].find((d) => d?.room === f.room) : null;
      if (!target) return ws.close();
      if (!desktopOnline) {
        ws.send(JSON.stringify({ t: 'offline' }));
        return ws.close();
      }
      ch = nextCh++;
      // Even channels get the {"ch","d"} wrapper, odd ones the bare frame: the page takes both.
      const wrap = ch % 2 === 0;
      chan = target.channel(
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

/**
 * A video for Chromium's fake camera (--use-file-for-fake-video-capture): each text as a QR code, dark on white,
 * for `frames` frames at 10 a second, in turn (the camera loops it). Y4M 4:2:0: a luma plane, then flat chroma.
 */
function qrVideo(file, texts, frames = 30) {
  const W = 640, H = 480;
  const parts = [Buffer.from(`YUV4MPEG2 W${W} H${H} F10:1 Ip A1:1 C420jpeg\n`)];
  const chroma = Buffer.alloc((W / 2) * (H / 2) * 2, 128);
  for (const text of texts) {
    const q = qrcode(0, 'M');
    q.addData(text, 'Byte');
    q.make();
    const m = q.getModuleCount(), s = Math.floor(Math.min(W, H) / (m + 8));
    const x0 = Math.floor((W - m * s) / 2), y0 = Math.floor((H - m * s) / 2);
    const luma = Buffer.alloc(W * H, 255);
    for (let r = 0; r < m; r++)
      for (let c = 0; c < m; c++)
        if (q.isDark(r, c)) for (let dy = 0; dy < s; dy++) luma.fill(0, (y0 + r * s + dy) * W + x0 + c * s, (y0 + r * s + dy) * W + x0 + (c + 1) * s);
    for (let f = 0; f < frames; f++) parts.push(Buffer.from('FRAME\n'), luma, chroma);
  }
  writeFileSync(file, Buffer.concat(parts));
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
  // On an iPhone, the page a pairing QR code opens leads with the Home Screen app; pairing in Safari comes second.
  const toPairForm = async (page) => {
    if (name !== 'webkit') return;
    await page.getByTestId('homescreen-first').waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: 'Pair in this browser instead' }).click();
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
    await page.getByRole('button', { name: 'Scan the code on your desktop' }).waitFor();
    await shot(page, 'not-paired');
    check('not-paired screen', true);
    check('ask: the ? shows before pairing', (await page.getByTestId('ask-btn').count()) === 1);
    const version = JSON.parse(readFileSync(resolve(here, '../package.json'), 'utf8')).version;
    check('the footer shows the page version', (await page.getByTestId('version').textContent()).trim() === `FreeBank phone page v${version}`);

    // 2. Pairing link.
    const link = desk.pairingLink(wsUrl, origin);
    await page.goto(link);
    if (name === 'webkit') {
      await page.getByTestId('homescreen-first').waitFor();
      check('iPhone: the QR code page leads with the Home Screen app',
        (await page.getByRole('button', { name: 'Copy link for your Home Screen app' }).count()) === 1);
      await shot(page, 'pair-homescreen-first');
    }
    await toPairForm(page);
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

    // 3a. Ask FreeBank (phone page v0.4.6): the header's ?, to the helper's one address (answered here by a stand-in
    // with the helper's CORS header), as plain text; recovery words never leave the phone.
    const asked = [];
    await page.route(ASK_URL, (route) => {
      const r = route.request();
      asked.push({ method: r.method(), body: r.postData(), type: r.headers()['content-type'] ?? '' });
      route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/json', 'access-control-allow-origin': origin },
        body: JSON.stringify({ answer: 'Open the bot and tap Borrow.' }),
      });
    });
    await page.getByTestId('ask-btn').click();
    await page.getByLabel('Your question').fill('How do I borrow?');
    await page.getByRole('button', { name: 'Ask', exact: true }).click();
    await page.getByTestId('ask-answer').getByText('Open the bot and tap Borrow.').waitFor({ timeout: 10000 });
    check('ask: the helper answers', asked.length === 1 && asked[0].method === 'POST' && asked[0].body === '{"q":"How do I borrow?"}'
      && asked[0].type.startsWith('text/plain'), JSON.stringify(asked));
    await shot(page, 'ask-answer');
    await page.getByLabel('Your question').fill('abandon ability able about above absent absorb abstract absurd abuse access accident');
    await page.getByRole('button', { name: 'Ask', exact: true }).click();
    await page.getByTestId('ask-error').getByText(/recovery words/).waitFor({ timeout: 5000 });
    check('ask: recovery words refused, nothing sent', asked.length === 1);
    await page.getByRole('button', { name: 'Back' }).click();
    await page.getByTestId('home').waitFor();
    await page.unroute(ASK_URL);
    await page.getByTestId('txs').locator('li button.tx').first().click();
    const txid = (await page.getByTestId('txid').first().textContent()).trim();
    check('tx expands with txid', txid === desk.wallet.txs[0].txid);
    await shot(page, 'home-tx-open');

    // 3b. Daemon mode (app v0.2.4): the desktop answers "starting" while its node starts; the page says so and asks
    // again by itself (mock desktop only).
    if (!REAL) {
      let left = 3;
      desk.intercept = (req, chan) => {
        if (left > 0 && ['balance', 'history', 'status'].includes(req.m)) {
          left--;
          desk.reply(chan, { id: req.id, err: 'Your desktop is starting FreeBank. It answers in a minute or two.', starting: true });
          return true;
        }
        return false;
      };
      await page.getByRole('button', { name: 'Refresh' }).click();
      await page.getByTestId('starting').waitFor({ timeout: 10000 });
      await shot(page, 'home-starting');
      await page.getByTestId('starting').waitFor({ state: 'detached', timeout: 25000 });
      check('daemon mode: "starting" shown, then the balance again without a tap',
        (await page.getByTestId('balance').textContent()).includes('12.50') && left === 0);
      desk.intercept = null;
    }

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
    await page.getByTestId('limit').getByText('0.10 sECX').waitFor({ timeout: 10000 });
    await page.getByLabel('Pay to address').fill(address);
    await page.getByLabel('Amount').fill('0,05');
    await shot(page, 'send-form');
    await page.getByRole('button', { name: 'Review' }).click();
    await shot(page, 'send-review');
    await page.getByRole('button', { name: 'Send 0.05 sECX' }).click();
    await page.getByTestId('receipt').waitFor({ timeout: 10000 });
    const r1 = (await page.getByTestId('receipt-txid').textContent()).trim();
    check('send receipt with txid', /^[0-9a-f]{64}$/.test(r1) && r1 === desk.wallet.txs[0].txid);
    await shot(page, 'send-receipt');
    await page.getByRole('button', { name: 'Done' }).click();
    await page.getByTestId('home').waitFor();

    // 6. Held send (over the remaining 0.05).
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.getByTestId('limit').getByText('0.05 sECX').waitFor({ timeout: 10000 });
    await page.getByLabel('Pay to address').fill(address);
    await page.getByLabel('Amount').fill('1');
    await page.getByRole('button', { name: 'Review' }).click();
    await page.getByText("more than today's limit").waitFor();
    await page.getByRole('button', { name: 'Send 1.00 sECX' }).click();
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
    await page.getByTestId('limit').getByText('0.05 sECX').waitFor({ timeout: 10000 });
    await page.getByLabel('Pay to address').fill(address);
    await page.getByLabel('Amount').fill('0.01');
    await page.getByRole('button', { name: 'Review' }).click();
    await page.getByRole('button', { name: 'Send 0.01 sECX' }).click();
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

    // 6c. Notes and houses (desktop v0.2.5): one card per house, a redeem over the limit held and approved on the
    // desktop, and the house directory.
    await page.getByTestId('open-notes').click();
    await page.getByTestId('note').first().waitFor({ timeout: 10000 });
    const noteCards = await page.getByTestId('note').count();
    check('notes: one card per house', noteCards === 4, `${noteCards} cards`);
    check('notes: the suspended house says so', await page.getByTestId('note').nth(1).getByText('Suspended').isVisible());
    // Members-only (node v0.2.19): a badge, and Send; redeem-only: a badge, and no Send (its notes go only back).
    const coop = page.getByTestId('note').nth(2), savings = page.getByTestId('note').nth(3);
    check('notes: a members-only house is marked, and its notes can be sent',
      (await coop.getByTestId('note-type').innerText()) === 'Members only' && (await coop.getByRole('button', { name: 'Send' }).count()) === 1);
    check('notes: a redeem-only house is marked, and has no Send',
      (await savings.getByTestId('note-type').innerText()) === 'Redeem only' && (await savings.getByRole('button', { name: 'Send' }).count()) === 0);
    await shot(page, 'notes');
    await page.getByTestId('note').first().getByRole('button', { name: 'Redeem' }).click();
    await page.getByTestId('note-action').waitFor();
    check('redeem: starts from what can be redeemed', (await page.getByLabel('Amount of notes').inputValue()) === '0.5');
    await page.getByRole('button', { name: 'Review' }).click();
    await page.getByRole('button', { name: 'Redeem 0.50 sECX' }).click();
    await page.getByTestId('note-held').waitFor({ timeout: 10000 });
    await shot(page, 'note-held');
    await page.getByTestId('note-receipt').waitFor({ timeout: 15000 });
    check('redeem over the limit: approved on the desktop, then a receipt',
      desk.requests.some((r) => r.m === 'note-redeem' && r.a.house === 3 && r.a.amount === 0.5));
    await shot(page, 'note-receipt');
    await page.getByRole('button', { name: 'Done' }).click();
    await page.getByTestId('note').first().waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: 'All houses' }).click();
    await page.getByTestId('house').first().waitFor({ timeout: 10000 });
    check('houses: the directory', (await page.getByTestId('house').count()) === 4);
    await shot(page, 'houses');
    await page.getByRole('button', { name: /Back/ }).click();
    await page.getByTestId('notes').waitFor();
    await page.getByRole('button', { name: /Back/ }).click();
    await page.getByTestId('home').waitFor();

    // 6d. Approve on my phone (desktop v0.2.5): the desktop asks; the card shows over Home; Decline answers it.
    const aid = desk.askApproval({ what: 'send', amount: 2.5, address, text: null });
    await page.getByTestId('approve-ask').waitFor({ timeout: 10000 });
    check('approval: the card shows what the desktop wants to send',
      (await page.getByTestId('approve-ask').textContent()).includes('2.50') && (await page.getByTestId('approve-ask').textContent()).includes(address));
    await shot(page, 'approve-ask');
    await page.getByRole('button', { name: 'Decline' }).click();
    await page.getByTestId('approve-ask').waitFor({ state: 'detached', timeout: 10000 });
    check('approval: declined on the phone', desk.approvals.get(aid)?.answer === 'declined');
    // A card the desktop gave up on (it quit, or "approve-done" was lost) goes by itself, and a desktop clock ten
    // minutes ahead doesn't end it early.
    desk.askApproval({ what: 'action', amount: 0.05102, address: '', text: `Send 0.05 sECX of house #3's notes to ${address}` }, 3, 600);
    await page.getByTestId('approve-ask').getByText('fees included').waitFor({ timeout: 10000 });
    check('approval: a payment other than a send shows what it costs', true);
    await page.getByTestId('approve-ask').getByText('Your desktop stopped waiting').waitFor({ timeout: 10000 });
    await page.getByTestId('approve-ask').waitFor({ state: 'detached', timeout: 10000 });
    check('approval: a card the desktop gave up on goes by itself', true);
    // The recovery words' change waits a day: "Not now" puts the card away.
    desk.askApproval({ what: 'scheduled', amount: null, address: '', text: 'x' }, 86_400);
    await page.getByTestId('approve-ask').getByText('Your recovery words were used').waitFor({ timeout: 10000 });
    check('approval: the recovery words\' change counts down in hours',
      /\b(23 h 59|24 h 0) min\b/.test(await page.getByTestId('approve-ask').textContent()));
    await shot(page, 'approve-scheduled');
    await page.getByRole('button', { name: 'Not now' }).click();
    await page.getByTestId('approve-ask').waitFor({ state: 'detached', timeout: 10000 });
    check('approval: "Not now" puts it away', true);

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
    // 11.44, plus the 0.50 sECX of notes redeemed in 6c.
    await page.getByTestId('balance').getByText('11.94').waitFor({ timeout: 10000 });
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

    // 9b. Report with recent activity: the page shows exactly what goes, masked, and sends it (mock relay only).
    if (!REAL) {
      await page.getByRole('button', { name: 'Report a problem or suggest something' }).click();
      await page.getByLabel('Your report').fill('Test report from the smoke test.');
      await page.getByLabel('Include recent activity').check();
      const shown = (await page.getByTestId('activity').textContent()).trim();
      check('report: recent activity shown before sending', /link: connected/.test(shown) && /balance: ok/.test(shown), shown.split('\n').length + ' lines');
      check('report: activity masked (no txid, address or IP)', !/[0-9a-f]{64}|\bX[1-9A-HJ-NP-Za-km-z]{25,39}\b|\b\d{1,3}(\.\d{1,3}){3}\b/.test(shown));
      await shot(page, 'report-activity');
      await page.getByRole('button', { name: 'Send to FreeBank' }).click();
      await page.getByText('Sent to FreeBank').waitFor({ timeout: 10000 });
      check('report: sent with the activity shown', lastReport?.activity === shown && lastReport?.from === 'phone', JSON.stringify(lastReport).slice(0, 80));
      await page.getByRole('button', { name: 'Back' }).click();
    }

    // 10. Settings: forget.
    await page.getByRole('button', { name: 'Forget this desktop' }).click();
    await page.getByRole('button', { name: 'Scan the code on your desktop' }).waitFor();
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
    await toPairForm(page);
    before = desk.pairs.length;
    await page.getByRole('button', { name: 'Pair', exact: true }).click();
    await compareCodes(page, 'pairing again', before);
    await page.getByTestId('home').waitFor({ timeout: 15000 });
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('button', { name: 'Forget this desktop' }).click();
    await shot(page, 'settings-forget');
    await page.getByTestId('forget-confirm').click();
    await page.getByRole('button', { name: 'Scan the code on your desktop' }).waitFor();
    check('forget from settings', true);

    // A pairing link that the desktop refuses (code already used).
    await page.goto(link2);
    await toPairForm(page);
    await page.getByRole('button', { name: 'Pair', exact: true }).click();
    await page.getByText('Not paired').waitFor({ timeout: 15000 });
    check('pair-refused handled', true);
    await shot(page, 'pair-refused');

    // The owner sees different codes on the two screens (someone else's request) and denies it.
    await page.goto(desk.pairingLink(wsUrl, origin));
    await toPairForm(page);
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
  if (name === 'chromium' || name === 'webkit') await scanFlow();
  if (name === 'chromium' || name === 'webkit') await hostedFlow();
  return results;

  /**
   * Hosted wallets (desktop v0.2.8): an owner's phone invites a shopkeeper's phone to its house and allows it; the
   * shopkeeper's phone sets up Face ID, confirms its words, joins, shows a payment QR in Shop; the owner pays it with
   * Scan to pay (the link pasted); the Shop screen says Paid; then the wallet moves home to a second desktop. Face ID
   * is a stand-in here (the mock checks an assertion is there, not that it verifies).
   */
  async function hostedFlow() {
    desk = await MockDesktop.create({ pairDelayMs: 300, limit: 1, ownerPasskey: true, setupMs: 1500, joinMs: 1500,
      myHouses: [{ house: 5, name: 'Lanark Co-op', type: 'members' }] });
    desk.linkBase = { relay: wsUrl, origin };
    desktopOnline = true;
    if (REAL) {
      hostWs?.close();
      await hostConnect();
    }
    const att = JSON.parse(readFileSync(resolve(here, '../../relay/testvectors/webauthn-v1.json'), 'utf8')).attestation.object;
    const fakeFaceId = (attestation) => {
      const dec = (t) => {
        let x = t.replace(/-/g, '+').replace(/_/g, '/');
        while (x.length % 4) x += '=';
        return Uint8Array.from(atob(x), (c) => c.charCodeAt(0)).buffer;
      };
      class FakePublicKeyCredential {}
      FakePublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = async () => true;
      window.PublicKeyCredential = FakePublicKeyCredential;
      window.__faceIds = 0;
      Object.defineProperty(navigator, 'credentials', {
        configurable: true,
        value: {
          create: async () => ({ response: { attestationObject: dec(attestation) } }),
          get: async () => {
            window.__faceIds++;
            return { response: { authenticatorData: new Uint8Array(37).buffer,
              clientDataJSON: new TextEncoder().encode('{"type":"webauthn.get"}').buffer, signature: new Uint8Array(70).buffer } };
          },
        },
      });
    };
    const hostedProblems = [];
    const watch = (page) => {
      page.on('pageerror', (e) => hostedProblems.push('pageerror: ' + e.message));
      page.on('console', (m) => {
        if (process.env.SMOKE_DEBUG) console.log('    console:', m.type(), m.text());
        if (inShot && /Refused to apply a stylesheet/.test(m.text())) return;
        if (m.type() === 'error' || /Content Security Policy|CSP/i.test(m.text())) hostedProblems.push('console: ' + m.text());
      });
    };
    const b = await type.launch();
    try {
      const oc = await b.newContext({ ...ctx, colorScheme: 'dark', ignoreHTTPSErrors: tlsTest });
      await oc.addInitScript(fakeFaceId, att);
      const owner = await oc.newPage();
      watch(owner);
      await owner.goto(desk.pairingLink(wsUrl, origin));
      await toPairForm(owner);
      const ownerName = await owner.getByLabel('Name for this phone').inputValue();
      await owner.getByRole('button', { name: 'Pair', exact: true }).click();
      await owner.getByTestId('home').waitFor({ timeout: 15000 });
      await owner.getByTestId('open-invite').waitFor({ timeout: 15000 });
      check('hosted: an owner whose wallet runs a members-only house sees Invite to my house', true);
      await owner.getByTestId('open-invite').click();
      await owner.getByRole('button', { name: 'Show the invite with Face ID' }).click();
      await owner.getByTestId('invite-left').waitFor({ timeout: 10000 });
      const inviteUrl = await qrFromPage(owner);
      const inv = inviteUrl && JSON.parse(Buffer.from(inviteUrl.split('#pair=')[1], 'base64url').toString());
      check('hosted: the invite QR names the house and who invited', inv?.h?.house === 5 && inv.h.name === 'Lanark Co-op' && inv.h.by === ownerName,
        JSON.stringify(inv?.h));
      await shot(owner, 'hosted-invite');

      const sc = await b.newContext({ ...ctx, colorScheme: 'dark', ignoreHTTPSErrors: tlsTest });
      await sc.addInitScript(fakeFaceId, att);
      const shop = await sc.newPage();
      watch(shop);
      await shop.goto(inviteUrl);
      await toPairForm(shop);
      await shop.getByTestId('join-title').waitFor({ timeout: 10000 });
      check('hosted: the invite opens as Join <house>', (await shop.getByTestId('join-title').textContent()) === 'Join Lanark Co-op');
      await shop.getByLabel("Your name, or your shop's").fill('Corner Shop');
      await shot(shop, 'hosted-join');
      await shop.getByRole('button', { name: 'Join', exact: true }).click();
      const line = shop.getByTestId('pair-code');
      await line.waitFor({ timeout: 15000 });
      const shopCode = /(\d{3} \d{3})$/.exec((await line.textContent()).trim())?.[1];
      await owner.getByTestId('allow-ask').waitFor({ timeout: 15000 });
      const ownerCode = (await owner.getByTestId('allow-code').textContent()).trim();
      check("hosted: the owner's Allow card shows the joiner's comparison code", !!shopCode && shopCode === ownerCode, `${shopCode} / ${ownerCode}`);
      await shot(owner, 'hosted-allow');
      await owner.getByRole('button', { name: 'Allow with Face ID' }).click();
      await owner.getByTestId('allow-ask').waitFor({ state: 'detached', timeout: 15000 });
      // The card goes when the answer is in; the desktop then makes the wallet.
      for (let i = 0; i < 100 && desk.hosted.size === 0; i++) await owner.waitForTimeout(50);
      check('hosted: allowed, the card goes', desk.hosted.size === 1 && desk.devices.size === 1);

      await shop.getByTestId('faceid-first').waitFor({ timeout: 15000 });
      check('hosted: Face ID comes first', true);
      await shop.getByRole('button', { name: 'Set up Face ID' }).click();
      await shop.getByRole('button', { name: 'Confirm Face ID' }).click();
      await shop.getByTestId('word-list').waitFor({ timeout: 20000 });
      const words = await shop.locator('[data-testid=word-list] .w').allTextContents();
      check('hosted: 24 words shown once', words.length === 24 && words.join(' ') === [...desk.hosted.values()][0].words.join(' '));
      await shot(shop, 'hosted-words');
      await shop.getByRole('button', { name: "I've written them down" }).click();
      for (const label of await shop.locator('form label').allTextContents()) {
        const n = Number(/Word (\d+)/.exec(label)?.[1]);
        await shop.getByLabel(label, { exact: true }).fill(words[n - 1]);
      }
      await shop.getByRole('button', { name: 'Confirm with Face ID' }).click();
      await shop.getByTestId('step-joining').waitFor({ timeout: 10000 }).catch(() => {});
      await shop.getByTestId('open-shop').waitFor({ timeout: 20000 });
      check('hosted: words confirmed, joined, ready', [...desk.hosted.values()][0].step === 'ready');
      await shot(shop, 'hosted-home');

      await shop.getByTestId('open-shop').click();
      for (const k of ['0', '.', '0', '5']) await shop.getByRole('button', { name: k, exact: true }).click();
      await shop.getByRole('button', { name: 'Show the QR code' }).click();
      await shop.getByTestId('shop-asked').waitFor({ timeout: 10000 });
      const payUrl = await qrFromPage(shop);
      const pay = payUrl && JSON.parse(Buffer.from(payUrl.split('#pay=')[1], 'base64url').toString());
      const member = [...desk.hosted.values()][0].memberAddress;
      check('hosted: the Shop QR is a payment link to the member address', pay?.a === member && pay.h === 5 && pay.u === 0.05 && pay.n === 'Corner Shop',
        JSON.stringify(pay));
      await shot(shop, 'hosted-shop-qr');

      await owner.getByRole('button', { name: 'Back' }).click();
      await owner.getByTestId('open-scanpay').click();
      await owner.getByLabel('Or paste a payment link or address').fill(payUrl);
      await owner.getByRole('button', { name: 'Pay this' }).click();
      await owner.getByTestId('pay-to').waitFor({ timeout: 10000 });
      check('scan to pay: the shop and the amount are filled in',
        (await owner.getByTestId('pay-to').textContent()).includes('Corner Shop') && (await owner.getByLabel('Amount of notes').inputValue()) === '0.05');
      await shot(owner, 'scan-to-pay');
      await owner.getByRole('button', { name: 'Review' }).click();
      await owner.getByRole('button', { name: 'Send 0.05 sECX' }).click();
      await owner.getByTestId('note-receipt').waitFor({ timeout: 15000 });
      check('scan to pay: paid', desk.requests.some((r) => r.m === 'note-send' && r.a.address === member && r.a.house === 5 && r.a.amount === 0.05));
      await shop.getByTestId('shop-paid').waitFor({ timeout: 15000 });
      check("hosted: the Shop screen says Paid, and today's takings list it", (await shop.getByTestId('takings').locator('li').count()) === 1);
      await shot(shop, 'hosted-shop-paid');

      if (REAL) {
        console.log(`  [${name}] note: moving home needs a second desktop on the relay; only with the mock relay`);
      } else {
        const desk2 = await MockDesktop.create({ pairDelayMs: 300 });
        otherDesks.push(desk2);
        await shop.getByRole('button', { name: 'Next customer' }).click();
        await shop.getByRole('button', { name: 'Back' }).click();
        await shop.getByTestId('open-move').click();
        await shop.getByLabel('Or paste its pairing link').fill(desk2.pairingLink(wsUrl, origin));
        await shop.getByRole('button', { name: 'Pair with this link' }).click();
        await shop.getByTestId('move-tell').waitFor({ timeout: 20000 });
        const target = (await shop.getByTestId('move-target').textContent()).trim();
        check('move home: paired with the new computer, shown its address, the house not yet asked',
          desk2.devices.size === 1 && MockDesktop.addresses.get(target) === desk2 && [...desk.hosted.values()][0].step === 'ready', target);
        check('move home: the new computer was told the address first, and it is its own',
          desk2.requests.some((r) => r.m === 'move-notice' && r.a.address === target));
        await shot(shop, 'move-tell');
        const had = desk2.wallet.notes.find((n) => n.house === 5)?.amount ?? 0;
        await shop.getByRole('button', { name: 'Move my money with Face ID' }).click();
        await shop.getByTestId('move-moving').waitFor({ timeout: 10000 }).catch(() => {});
        check('move home: the house was asked with Face ID for that address',
          desk.requests.some((r) => r.m === 'move-home' && r.a.address === target && typeof r.a.auth?.sig === 'string'));
        await shop.getByTestId('move-done').waitFor({ timeout: 20000 });
        check('move home: done says to replace the shop\'s QR codes', (await shop.getByTestId('move-done').textContent()).includes('QR codes'));
        await shop.getByRole('button', { name: 'Done' }).click();
        await shop.getByTestId('home').waitFor({ timeout: 20000 });
        const got = Math.round(((desk2.wallet.notes.find((n) => n.house === 5)?.amount ?? 0) - had) * 1e8) / 1e8;
        check('move home: the money moved to the new computer, and the phone is its own',
          [...desk.hosted.values()][0].step === 'moved' && got === 0.05, `got ${got}`);
        await shot(shop, 'moved-home');
        await shop.reload();
        await shop.getByTestId('home').waitFor({ timeout: 15000 });
        check('move home: after a reload, still the new computer\'s', true);
        await shop.getByRole('button', { name: 'Receive', exact: true }).click();
        await shop.getByTestId('member-address').waitFor({ timeout: 10000 });
        check('move home: Receive shows the member address at the house',
          (await shop.getByTestId('member-address').textContent()).includes(target) &&
          (await shop.getByTestId('member-address').textContent()).includes('Lanark Co-op'));
        await shot(shop, 'member-address');
        otherDesks.length = 0;
      }
      const netNoise = hostedProblems.filter((m) => /WebSocket connection to .* failed/.test(m));
      const real = hostedProblems.filter((m) => !netNoise.includes(m));
      check('hosted: no page errors or CSP violations', real.length === 0, real.join(' | '));
    } catch (e) {
      check('hosted flow completed', false, e.message.split('\n')[0]);
      if (hostedProblems.length) console.log('  problems:', hostedProblems.join(' | '));
    } finally {
      await b.close();
    }
  }

  /**
   * "Scan the code on your desktop" in the Home Screen app (app v0.2.2), started as one (navigator.standalone).
   * Chromium's fake camera shows another QR code, then the pairing code. WebKit here has no camera: the page says
   * why and opens "Paste the pairing link", and the pasted link pairs.
   */
  async function scanFlow() {
    const link = desk.pairingLink(wsUrl, origin);
    const video = join(tmpdir(), `fb-scan-${process.pid}.y4m`);
    const launch = {};
    if (name === 'chromium') {
      qrVideo(video, ['bitcoin:XkPvjfFq8Hj9wy9Wq3pRr1sBdXJxZ5nT2n', link]);
      launch.args = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-video-capture=${video}`];
    }
    const scanProblems = [];
    const b = await type.launch(launch);
    try {
      const context = await b.newContext({ ...ctx, colorScheme: 'dark', ignoreHTTPSErrors: tlsTest });
      if (name === 'chromium') await context.grantPermissions(['camera'], { origin });
      await context.addInitScript(() => {
        Object.defineProperty(navigator, 'standalone', { value: true });
        // Every camera stream the page opens, to check that it turns them off.
        window.__streams = [];
        const md = navigator.mediaDevices;
        if (md?.getUserMedia) {
          const open = md.getUserMedia.bind(md);
          md.getUserMedia = async (c) => {
            const st = await open(c);
            window.__streams.push(st);
            return st;
          };
        }
      });
      const page = await context.newPage();
      page.on('pageerror', (e) => scanProblems.push('pageerror: ' + e.message));
      page.on('console', (m) => {
        if (process.env.SMOKE_DEBUG) console.log('    console:', m.type(), m.text());
        if (inShot && /Refused to apply a stylesheet/.test(m.text())) return;
        if (m.type() === 'error' || /Content Security Policy|CSP/i.test(m.text())) scanProblems.push('console: ' + m.text());
      });
      await page.goto(origin + '/');
      await page.getByRole('heading', { name: name === 'webkit' ? 'Pair this Home Screen app' : 'Pair this phone' }).waitFor();
      const steps = await page.locator('ol.steps li').allTextContents();
      check('Home Screen app: the steps say which device does what',
        steps.length === 3 && /^On your desktop:/.test(steps[0]) && /^On this phone:/.test(steps[1]) && /^On your desktop:/.test(steps[2]),
        steps.map((t) => t.split(':')[0]).join(' / '));
      await shot(page, 'scan-start');
      await page.getByRole('button', { name: 'Scan the code on your desktop' }).click();
      if (name === 'chromium') {
        await page.getByTestId('scan-note').waitFor({ timeout: 15000 });
        check('scan: another QR code is not taken, and the page says so',
          /isn't a pairing code for this page/.test(await page.getByTestId('scan-note').textContent()));
        await shot(page, 'scan-other-code');
        await page.getByLabel('Name for this phone').waitFor({ timeout: 20000 });
        check('scan: the pairing code is read', true);
        const off = await page.evaluate(() =>
          window.__streams.length > 0 && window.__streams.every((st) => st.getTracks().every((t) => t.readyState === 'ended')));
        check('scan: the camera is off once the code is read', off);
      } else {
        await page.getByTestId('scan-error').waitFor({ timeout: 15000 });
        check('scan with no camera says why and opens the paste route', await page.getByLabel('Pairing link').isVisible(),
          (await page.getByTestId('scan-error').textContent()).slice(0, 60));
        await shot(page, 'scan-no-camera');
        await page.getByLabel('Pairing link').fill(link);
        await page.getByRole('button', { name: 'Pair with this link' }).click();
        await page.getByLabel('Name for this phone').waitFor();
      }
      const defName = await page.getByLabel('Name for this phone').inputValue();
      check('Home Screen app: its default name', defName === (name === 'webkit' ? 'iPhone Home Screen' : 'Android phone'), defName);
      const before = desk.pairs.length;
      await page.getByRole('button', { name: 'Pair', exact: true }).click();
      await compareCodes(page, 'pairing the Home Screen app', before);
      await page.getByTestId('home').waitFor({ timeout: 15000 });
      check('Home Screen app paired', true);
      const netNoise = scanProblems.filter((m) => /WebSocket connection to .* failed/.test(m));
      const real = scanProblems.filter((m) => !netNoise.includes(m));
      check('scan: no page errors or CSP violations', real.length === 0, real.join(' | '));
      await context.close();
    } catch (e) {
      check('scan flow completed', false, e.message.split('\n')[0]);
      if (scanProblems.length) console.log('  problems:', scanProblems.join(' | '));
    } finally {
      await b.close();
      rmSync(video, { force: true });
    }
  }
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
