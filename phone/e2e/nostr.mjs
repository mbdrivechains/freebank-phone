#!/usr/bin/env node
// The phone link over Nostr, end to end (desktop v0.6.0): this page, built, in a browser, against the FreeBank
// desktop's own Rust code (its test `nostr_page_e2e`, on a mocked node) through a real NIP-01 relay on 127.0.0.1
// (e2e/test-relay.mjs, from the Truthcoin app; it can repeat and reorder events). The page pairs from the desktop's
// v2 link, the codes are compared, then Home shows the desktop wallet's balance.
//
//   npm run build && FB_DESKTOP_TEST=<the app's test binary> node e2e/nostr.mjs [webkit] [chromium] [firefox]
//
// FB_DESKTOP_TEST is the app's unit-test executable (cargo test --no-run prints it). RELAY_REORDER_MS and RELAY_DUP
// pass through to the relay.
import http from 'node:http';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, '../dist');
process.env.PLAYWRIGHT_BROWSERS_PATH = '0';
const wkLibs = resolve(here, '../node_modules/.wk-libs/usr/lib/x86_64-linux-gnu');
if (existsSync(wkLibs)) process.env.LD_LIBRARY_PATH = [wkLibs, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
const { webkit, chromium, firefox, devices } = await import('playwright');

const desktopBin = process.env.FB_DESKTOP_TEST;
if (!desktopBin || !existsSync(desktopBin)) {
  console.error('FB_DESKTOP_TEST must name the app\'s test binary (cargo test --no-run)');
  process.exit(1);
}
if (!existsSync(join(dist, 'index.html'))) {
  console.error('dist/ missing: run npm run build first');
  process.exit(1);
}

// fb-relay's headers, with the page reaching relays over ws: here (127.0.0.1) as it does over wss: for real.
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; " +
  "connect-src 'self' https://ask.ecxfreebank.com wss: ws:; manifest-src 'self'; base-uri 'none'; form-action 'none'; " +
  "frame-ancestors 'none'";
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };

let failed = 0;
const check = (what, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok || !detail ? '' : `: ${detail}`}`);
  if (!ok) failed++;
};

function serve() {
  return new Promise((res) => {
    const srv = http.createServer((req, rsp) => {
      let p = normalize(decodeURIComponent((req.url ?? '/').split('?')[0])).replace(/^(\.\.[/\\])+/, '');
      let f = join(dist, p);
      if (!f.startsWith(dist) || !existsSync(f) || statSync(f).isDirectory()) f = join(dist, 'index.html');
      rsp.writeHead(200, { 'content-type': TYPES[extname(f)] ?? 'application/octet-stream', 'content-security-policy': CSP });
      rsp.end(readFileSync(f));
    });
    srv.listen(0, '127.0.0.1', () => res(srv));
  });
}

function startRelay() {
  return new Promise((res, rej) => {
    const proc = spawn(process.execPath, [join(here, 'test-relay.mjs'), '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
    proc.stdout.on('data', (b) => {
      const m = /listening on (ws:\/\/\S+)/.exec(String(b));
      if (m) res({ url: m[1], proc });
    });
    proc.on('exit', (c) => rej(new Error(`test relay exited ${c}`)));
  });
}

/** The desktop: the app's own phone code, run by its ignored test. */
function startDesktop(relay, out) {
  rmSync(out, { force: true });
  const proc = spawn(desktopBin, ['phone::tests::nostr_link::nostr_page_e2e', '--ignored', '--exact', '--nocapture'], {
    env: { ...process.env, FB_NOSTR_RELAY: relay, FB_NOSTR_OUT: out },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  return proc;
}

async function lineOf(out, key, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (existsSync(out)) {
      const l = readFileSync(out, 'utf8').split('\n').find((x) => x.startsWith(key + ' '));
      if (l) return l.slice(key.length + 1);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

const engines = { webkit: [webkit, devices['iPhone 13']], chromium: [chromium, devices['Pixel 7']], firefox: [firefox, { viewport: { width: 412, height: 915 } }] };
const want = process.argv.slice(2).filter((a) => a in engines);
const srv = await serve();
const origin = `http://localhost:${srv.address().port}`;
const relay = await startRelay();
const shotsRoot = join(here, 'shots', 'nostr');
mkdirSync(shotsRoot, { recursive: true });

for (const name of want.length ? want : ['webkit']) {
  const [type, ctx] = engines[name];
  console.log(`--- ${name}`);
  const out = join(tmpdir(), `fb-nostr-e2e-${process.pid}-${name}.txt`);
  const desk = startDesktop(relay.url, out);
  const browser = await type.launch();
  const problems = [];
  // Playwright's screenshot injects a <style> of its own, which the CSP (rightly) refuses: ignored while one is taken.
  let inShot = false;
  const shot = async (page, label) => {
    inShot = true;
    try {
      await page.screenshot({ path: join(shotsRoot, `${name}-${label}.png`) });
    } finally {
      inShot = false;
    }
  };
  try {
    const link = await lineOf(out, 'link', 120_000);
    check('the desktop made a pairing link over Nostr', !!link && link.includes('#pair='), link ?? 'none');
    const frag = link.split('#pair=')[1];
    const v = JSON.parse(Buffer.from(frag.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
    check('the link is v2 and names the relay', v.v === 2 && v.r?.[0] === relay.url, JSON.stringify(v.r));

    const context = await browser.newContext({ ...ctx, colorScheme: 'dark' });
    const page = await context.newPage();
    page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
    page.on('console', (m) => {
      if (process.env.SMOKE_DEBUG) console.log('    console:', m.type(), m.text());
      if (inShot && /Refused to apply a stylesheet/.test(m.text())) return;
      if (m.type() === 'error' || /Content Security Policy|CSP/i.test(m.text())) problems.push('console: ' + m.text());
    });
    await page.goto(`${origin}/#pair=${frag}`);
    if (name === 'webkit') {
      await page.getByTestId('homescreen-first').waitFor({ timeout: 10000 });
      await page.getByRole('button', { name: 'Pair in this browser instead' }).click();
    }
    await page.getByLabel('Name for this phone').fill(`Nostr ${name}`);
    await page.getByRole('button', { name: 'Pair', exact: true }).click();
    const line = page.getByTestId('pair-code');
    await line.waitFor({ timeout: 20000 });
    const shown = /(\d{3}) (\d{3})/.exec((await line.textContent()) ?? '');
    const deskCode = await lineOf(out, 'code', 20000);
    check('the phone and the desktop show the same comparison code', !!shown && `${shown[1]}${shown[2]}` === deskCode, `${shown?.[0]} vs ${deskCode}`);
    await shot(page, 'waiting');
    await page.getByTestId('home').waitFor({ timeout: 30000 });
    await page.getByTestId('status').getByText('Connected').waitFor({ timeout: 30000 });
    await page.getByTestId('balance').getByText('1.50').waitFor({ timeout: 20000 });
    check('paired over Nostr; Home shows the desktop wallet\'s balance', true);
    await shot(page, 'home');
    // A new session after a reload: the stored pairing (v2) connects again.
    await page.reload();
    await page.getByTestId('status').getByText('Connected').waitFor({ timeout: 30000 });
    check('after a reload, the stored pairing connects over Nostr again', true);
    await context.close();
  } catch (e) {
    check(`${name}: the flow`, false, (e && e.message) || String(e));
  } finally {
    check(`${name}: no page errors or CSP refusals`, problems.length === 0, problems.join(' | '));
    await browser.close();
    desk.kill('SIGTERM');
    rmSync(out, { force: true });
  }
}
relay.proc.kill('SIGTERM');
srv.close();
console.log(failed ? `${failed} FAILED` : 'all ok');
process.exit(failed ? 1 : 0);
