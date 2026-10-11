#!/usr/bin/env node
// End-to-end test of the token wallet in real browsers, against fb-mint's own code (mint/examples/dev-mint.rs, a fake
// node behind it). Two phones, each with its own storage:
//   phone A sets up a wallet (words checked), gets tokens for notes, sends some as a link;
//   phone B opens the link, sets up its wallet, takes the tokens in, turns some into notes;
//   phone A can't take the claimed link back.
//
//   npm run e2e:tokens [webkit] [chromium] [firefox]
//
// It builds the page with VITE_FB_MINT set to the dev mint, serves it on 127.0.0.1 with the relay's CSP plus the
// mint's origin in connect-src, and starts the dev mint (FB_DEV_MINT_BIN, default its debug build).
import http from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
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

const MINT = 'http://127.0.0.1:47339';
const CONTROL = 'http://127.0.0.1:47340';
const bin = process.env.FB_DEV_MINT_BIN ?? resolve(here, '../../mint/target/debug/examples/dev-mint');
if (!existsSync(bin)) {
  console.error(`no dev mint at ${bin}: cd ../mint && cargo build --example dev-mint`);
  process.exit(1);
}
// The page's own script must carry the dev mint's address (App.svelte reads VITE_FB_MINT).
const script = /src="\.\/(assets\/index-[^"]+\.js)"/.exec(readFileSync(join(dist, 'index.html'), 'utf8'))?.[1];
if (!script || !readFileSync(join(dist, script), 'utf8').includes(MINT)) {
  console.error('dist/ was not built for the dev mint: npm run e2e:tokens builds it');
  process.exit(1);
}

const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; " +
  `connect-src 'self' ${MINT}; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  const p = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
  let f = join(dist, p === '/' ? 'index.html' : p);
  if (!f.startsWith(dist) || !existsSync(f) || statSync(f).isDirectory()) f = join(dist, 'index.html');
  res.writeHead(200, {
    'content-type': TYPES[extname(f)] ?? 'application/octet-stream',
    'content-security-policy': CSP,
    'cache-control': 'no-store',
  });
  res.end(readFileSync(f));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const data = mkdtempSync(join(tmpdir(), 'fb-dev-mint-'));
const mint = spawn(bin, ['--datadir', data], { stdio: ['ignore', 'pipe', 'pipe'] });
let mintOut = '';
mint.stdout.on('data', (d) => (mintOut += d));
mint.stderr.on('data', (d) => (mintOut += d));
for (let i = 0; i < 100 && !/dev-mint on/.test(mintOut); i++) await new Promise((r) => setTimeout(r, 100));
if (!/dev-mint on/.test(mintOut)) {
  console.error('the dev mint did not start:\n' + mintOut);
  process.exit(1);
}

const engines = { webkit: [webkit, devices['iPhone 13']], chromium: [chromium, devices['Pixel 7']], firefox: [firefox, { viewport: { width: 412, height: 915 } }] };
const wanted = process.argv.slice(2).filter((a) => engines[a]);
let failed = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(cond, what) {
  if (!cond) throw new Error('FAILED: ' + what);
  console.log('  ok  ' + what);
}

/** Sets up a wallet on the Tokens screen: reads the twelve words, then answers the two asked for. */
async function setUp(page) {
  await page.getByTestId('tokens-new').click();
  const words = (await page.getByTestId('tokens-words').locator('.mono').allTextContents()).map((w) => w.trim());
  check(words.length === 12, 'twelve words shown');
  await page.getByRole('button', { name: 'I wrote them down' }).click();
  for (const i of [0, 1]) {
    const label = await page.getByTestId(`tokens-word-${i}`).locator('xpath=..').textContent();
    const n = Number(/Word (\d+)/.exec(label)[1]);
    await page.getByTestId(`tokens-word-${i}`).fill(words[n - 1]);
  }
  await page.getByRole('button', { name: 'Set up the wallet' }).click();
  return words;
}

async function balance(page) {
  return (await page.getByTestId('tokens-balance').textContent()).replace(/\s+/g, ' ').trim();
}

for (const name of wanted.length ? wanted : Object.keys(engines)) {
  const [type, device] = engines[name];
  let browser;
  try {
    browser = await type.launch();
  } catch (e) {
    console.log(`${name}: not available (${e.message.split('\n')[0]})`);
    continue;
  }
  console.log(name);
  try {
    const a = await (await browser.newContext({ ...device })).newPage();
    const errors = [];
    a.on('pageerror', (e) => errors.push(e.message));
    // The mint's 400 for a spent token is expected; browsers log any failed request as a console error.
    a.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
    await a.goto(origin + '/');
    await a.getByTestId('open-tokens').click();
    await setUp(a);
    check((await balance(a)) === '0.00 sECX', 'phone A: a wallet, empty');

    // Notes in: 0.00001 sECX (1,000 units) paid to the quote's address.
    await a.getByTestId('tokens-get').click();
    await a.getByTestId('tokens-amount').fill('0.00001');
    await a.getByRole('button', { name: 'Get the address' }).click();
    const address = (await a.getByTestId('tokens-get-address').textContent()).trim();
    check(address.startsWith('XdevMint'), `phone A: pay notes to ${address}`);
    await fetch(`${CONTROL}/pay?address=${address}&units=1000`, { method: 'POST' });
    // The page checks every 15 s; the mint asks its node about a quote at most every 10 s.
    await a.getByTestId('tokens-balance').waitFor({ timeout: 45_000 });
    check((await balance(a)) === '0.00001 sECX', 'phone A: 0.00001 sECX in tokens arrived');

    // Send 0.000003 sECX as a link.
    await a.getByRole('button', { name: 'Send', exact: true }).click();
    await a.getByTestId('tokens-amount').fill('0.000003');
    await a.getByRole('button', { name: 'Make the link' }).click();
    const link = await a.getByTestId('tokens-link').inputValue();
    check(link.startsWith(origin + '/#token=cashuB'), 'phone A: a token link');
    await a.getByRole('button', { name: 'Done' }).click();
    check((await balance(a)) === '0.000007 sECX', 'phone A: 0.000007 sECX left');

    // Phone B opens the link: the token leaves the address bar, a wallet is set up, the tokens come in.
    const b = await (await browser.newContext({ ...device })).newPage();
    b.on('pageerror', (e) => errors.push(e.message));
    b.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
    await b.goto(link);
    check(!b.url().includes('token='), 'phone B: the token left the address bar');
    await b.getByTestId('tokens-link-says').waitFor();
    check((await b.getByTestId('tokens-link-says').textContent()).includes('0.000003 sECX'), 'phone B: what the link says it carries');
    await setUp(b);
    await b.getByTestId('tokens-notice').or(b.locator('.error')).first().waitFor();
    if ((await balance(b).catch(() => '')) !== '0.000003 sECX') console.log('  page shows: ' + (await b.locator('body').innerText()).replace(/\s+/g, ' '));
    check((await balance(b)) === '0.000003 sECX', 'phone B: 0.000003 sECX taken in');

    // Phone A can no longer take its link back.
    await a.getByRole('button', { name: 'Take it back' }).click();
    await a.getByText('Those tokens were already spent.').waitFor();
    check(true, 'phone A: the claimed link can no longer be taken back');

    // A link not taken in comes back to the sender.
    await a.getByRole('button', { name: 'Send', exact: true }).click();
    await a.getByTestId('tokens-amount').fill('0.000001');
    await a.getByRole('button', { name: 'Make the link' }).click();
    await a.getByRole('button', { name: 'Done' }).click();
    check((await balance(a)) === '0.000006 sECX', 'phone A: 0.000001 sECX sent as a second link');
    await a.getByRole('button', { name: 'Take it back' }).click();
    await a.getByText('Taken back:').waitFor();
    check((await balance(a)) === '0.000007 sECX', 'phone A: the unclaimed link taken back');

    // Phone B turns 0.0000025 sECX into notes at a FreeBank address.
    const to = 'X' + 'b'.repeat(33);
    await b.getByTestId('tokens-redeem').click();
    await b.getByTestId('tokens-address').fill(to);
    await b.getByTestId('tokens-amount').fill('0.0000025');
    await b.getByRole('button', { name: 'Pay out as notes' }).click();
    await b.getByTestId('tokens-notice').waitFor();
    check((await balance(b)) === '0.0000005 sECX', 'phone B: 0.0000005 sECX left');
    const payouts = await (await fetch(`${CONTROL}/payouts`)).json();
    check(payouts.some(([x, u]) => x === to && u === 250), 'the mint paid 250 units of notes to the address');
    check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  } catch (e) {
    failed++;
    console.log('  ' + e.message);
  } finally {
    await browser.close();
  }
}

mint.kill();
server.close();
rmSync(data, { recursive: true, force: true });
console.log(failed ? `${failed} engine(s) failed` : 'all passed');
process.exit(failed ? 1 : 0);
