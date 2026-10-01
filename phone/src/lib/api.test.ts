import { describe, expect, it, afterEach, vi } from 'vitest';
import { get } from 'svelte/store';
import { PhoneClient, DeniedError, LostError, HELD_EXPIRED, randomStartId, type Identity } from './api';
import { createSendFlow } from './sendflow';
import { OfflineError, type Transport } from './relay';
import { b64u, exportPub, genKeyPair } from './crypto';
// @ts-ignore -- plain JS test helper
import { MockDesktop, EXPIRED, RESTARTED, DECLINED } from '../../e2e/mock-desktop.mjs';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout');
    await tick(5);
  }
}

/** In-memory relay: one MockDesktop host; `online` toggles whether joins succeed. */
class FakeRelay {
  online = true;
  links: Transport[] = [];
  constructor(public desk: any) {}
  connect = async (): Promise<Transport> => {
    if (!this.online) throw new OfflineError();
    let ended = false;
    const link: Transport = {
      onFrame: () => {},
      onEnd: () => {},
      send: (f) => !ended && ch.onFrame(JSON.parse(JSON.stringify(f))),
      close: () => {
        if (ended) return;
        ended = true;
        ch.onClose();
        link.onEnd('closed');
      },
    };
    const ch = this.desk.channel(
      (f: any) => !ended && setTimeout(() => !ended && link.onFrame(JSON.parse(JSON.stringify(f)))),
      () => link.close(),
    );
    this.links.push(link);
    return link;
  };
  dropAll() {
    this.links.forEach((l) => l.close());
    this.links = [];
  }
}

async function pairedPhone(desk: any): Promise<Identity> {
  const P = await genKeyPair(false);
  const pPub = b64u(await exportPub(P.publicKey));
  desk.addDevice(pPub, 'test');
  return { pPriv: P.privateKey, pPub, d: desk.dPub };
}

/** The one phone the tests pair: where the mock sends a device's replies. */
const theDevice = (desk: any) => [...desk.devices.values()][0];
const lastRequest = (desk: any, m: string) => desk.requests.filter((r: any) => r.m === m).at(-1);

const fast = { baseDelayMs: 10, maxDelayMs: 40, requestTimeoutMs: 2000, readyTimeoutMs: 2000 };
let client: PhoneClient | null = null;
let client2: PhoneClient | null = null;
afterEach(() => {
  client?.stop();
  client2?.stop();
  client2 = null;
  vi.restoreAllMocks();
});

describe('PhoneClient', () => {
  it('handshakes and answers requests', async () => {
    const desk = await MockDesktop.create();
    const relay = new FakeRelay(desk);
    client = new PhoneClient(await pairedPhone(desk), relay.connect, fast);
    client.start();
    const [bal, hist, st, rcv] = await Promise.all([client.balance(), client.history(10), client.nodeStatus(), client.receive()]);
    expect(get(client.status)).toBe('connected');
    expect(bal).toEqual({ confirmed: 12.5, pending: 0.25 });
    expect(hist.length).toBe(4);
    expect(st.limit_left).toBe(0.1);
    expect(rcv.address).toMatch(/^X/);
  });

  it('sends under the limit straight away', async () => {
    const desk = await MockDesktop.create();
    client = new PhoneClient(await pairedPhone(desk), new FakeRelay(desk).connect, fast);
    client.start();
    let held = false;
    const r = await client.send('Xabc', 0.05, () => (held = true));
    expect(r.txid).toMatch(/^[0-9a-f]{64}$/);
    expect(held).toBe(false);
    expect((await client.nodeStatus()).limit_left).toBe(0.05);
  });

  it('keeps a held send open until the final reply', async () => {
    const desk = await MockDesktop.create({ holdDelayMs: 150 });
    client = new PhoneClient(await pairedPhone(desk), new FakeRelay(desk).connect, fast);
    client.start();
    let confirmId = '';
    let why = '';
    const p = client.send('Xabc', 1, (c, w) => ((confirmId = c), (why = w)));
    await until(() => confirmId !== '');
    expect(why).toBe('limit');
    expect(client.heldCount).toBe(1);
    const r = await p;
    expect(r.txid).toMatch(/^[0-9a-f]{64}$/);
    expect(client.heldCount).toBe(0);
  });

  it('a declined held send rejects with the desktop message', async () => {
    const desk = await MockDesktop.create({ holdDelayMs: 50, holdDecision: 'deny' });
    client = new PhoneClient(await pairedPhone(desk), new FakeRelay(desk).connect, fast);
    client.start();
    await expect(client.send('Xabc', 1)).rejects.toThrow(DECLINED);
  });

  it('a held send survives a reconnect; plain requests in flight fail', async () => {
    const desk = await MockDesktop.create({ holdDelayMs: 300 });
    const relay = new FakeRelay(desk);
    client = new PhoneClient(await pairedPhone(desk), relay.connect, fast);
    client.start();
    let held = false;
    const p = client.send('Xabc', 1, () => (held = true));
    await until(() => held);
    relay.dropAll();
    await until(() => get(client!.status) === 'reconnecting');
    await until(() => get(client!.status) === 'connected');
    const r = await p;
    expect(r.txid).toMatch(/^[0-9a-f]{64}$/);
  });

  it('desktop offline, then back', async () => {
    const desk = await MockDesktop.create();
    const relay = new FakeRelay(desk);
    relay.online = false;
    client = new PhoneClient(await pairedPhone(desk), relay.connect, fast);
    client.start();
    await until(() => get(client!.status) === 'offline');
    relay.online = true;
    await until(() => get(client!.status) === 'connected');
    expect((await client.balance()).confirmed).toBe(12.5);
  });

  it('an unknown phone is denied and stops retrying', async () => {
    const desk = await MockDesktop.create();
    const P = await genKeyPair(false);
    let joins = 0;
    const relay = new FakeRelay(desk);
    const connect = () => (joins++, relay.connect());
    client = new PhoneClient({ pPriv: P.privateKey, pPub: b64u(await exportPub(P.publicKey)), d: desk.dPub }, connect, fast);
    client.start();
    await until(() => get(client!.status) === 'denied');
    await tick(100);
    expect(joins).toBe(1);
    await expect(client.balance()).rejects.toBeInstanceOf(DeniedError);
  });

  it('a request times out as LostError when the desktop never answers', async () => {
    const desk = await MockDesktop.create();
    desk.intercept = () => true; // swallow requests
    client = new PhoneClient(await pairedPhone(desk), new FakeRelay(desk).connect, { ...fast, requestTimeoutMs: 100 });
    client.start();
    await expect(client.balance()).rejects.toBeInstanceOf(LostError);
  });

  it('a tampered frame closes the session and the client reconnects', async () => {
    const desk = await MockDesktop.create();
    const relay = new FakeRelay(desk);
    client = new PhoneClient(await pairedPhone(desk), relay.connect, fast);
    client.start();
    await client.balance();
    const link = relay.links[relay.links.length - 1];
    link.onFrame({ t: 'm', ct: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' });
    await until(() => get(client!.status) !== 'connected');
    await until(() => get(client!.status) === 'connected');
    expect(relay.links.length).toBe(2);
  });
});

describe('request ids (PROTOCOL.md: random start on each page load)', () => {
  it('start at a random safe integer and count up by one', async () => {
    const desk = await MockDesktop.create();
    const relay = new FakeRelay(desk);
    const id = await pairedPhone(desk);
    client = new PhoneClient(id, relay.connect, fast);
    client.start();
    await client.balance();
    await client.balance();
    const [a1, a2] = desk.requests.map((r: any) => r.id);
    // A second page load: a new client, a new start.
    client2 = new PhoneClient(id, relay.connect, fast);
    client2.start();
    await client2.balance();
    const b1 = desk.requests[2].id;
    for (const x of [a1, a2, b1]) {
      expect(Number.isSafeInteger(x)).toBe(true);
      expect(x).toBeGreaterThanOrEqual(1);
    }
    expect(a2).toBe(a1 + 1);
    expect(b1).not.toBe(a1);
    expect(a1).not.toBe(1); // 1 in 2^52
  });

  it('randomStartId stays in [1, 2^52] and varies', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 1000; i++) {
      const x = randomStartId();
      expect(Number.isSafeInteger(x)).toBe(true);
      expect(x).toBeGreaterThanOrEqual(1);
      expect(x).toBeLessThanOrEqual(2 ** 52);
      expect(Number.isSafeInteger(x + 2 ** 52 - 1)).toBe(true); // room to count up
      seen.add(x);
    }
    expect(seen.size).toBe(1000);
  });
});

describe('held sends (PROTOCOL.md, settled 2026-09-29, v0.2.0)', () => {
  it('a final reply counts only with the hold’s confirm id', async () => {
    const desk = await MockDesktop.create({ holdDecision: 'none' });
    client = new PhoneClient(await pairedPhone(desk), new FakeRelay(desk).connect, fast);
    client.start();
    let confirmId = '';
    let settled = false;
    const p = client.send('Xabc', 1, (c) => (confirmId = c));
    p.then(() => (settled = true), () => (settled = true));
    await until(() => confirmId !== '');
    const { id } = lastRequest(desk, 'send');
    const dev = theDevice(desk);
    desk.toDevice(dev, { id, pending: 'c-another-hold', ok: { txid: 'f'.repeat(64) } });
    desk.toDevice(dev, { id, pending: 'c-another-hold', err: 'declined on the desktop' });
    desk.toDevice(dev, { id, ok: { txid: 'e'.repeat(64) } }); // no confirm id: the old form, refused
    desk.toDevice(dev, { id, err: 'no confirm id' });
    await tick(80);
    expect(settled).toBe(false);
    expect(client.heldCount).toBe(1);
    expect(desk.decide(confirmId, true)).toBe(true);
    const r = await p;
    expect(r.txid).toBe(desk.wallet.txs[0].txid);
    expect(r.txid).not.toBe('f'.repeat(64));
  });

  it('a final reply for a request that was never held is not taken', async () => {
    const desk = await MockDesktop.create();
    desk.intercept = (req: any) => req.m === 'balance'; // leave it unanswered for now
    client = new PhoneClient(await pairedPhone(desk), new FakeRelay(desk).connect, fast);
    client.start();
    const b = client.balance();
    await until(() => !!lastRequest(desk, 'balance'));
    const { id } = lastRequest(desk, 'balance');
    desk.toDevice(theDevice(desk), { id, pending: 'c1234', ok: { confirmed: 999, pending: 0 } });
    await tick(50);
    desk.toDevice(theDevice(desk), { id, ok: { confirmed: 1, pending: 0 } });
    expect((await b).confirmed).toBe(1);
  });

  it('a held reply says why: a locked wallet holds a send within the limit', async () => {
    const desk = await MockDesktop.create({ locked: true, holdDelayMs: 50 });
    client = new PhoneClient(await pairedPhone(desk), new FakeRelay(desk).connect, fast);
    client.start();
    const whys: string[] = [];
    const r = await client.send('Xabc', 0.01, (_c, w) => whys.push(w));
    expect(whys).toEqual(['locked']);
    expect(r.txid).toMatch(/^[0-9a-f]{64}$/);
    // Over the limit it is the limit that holds it, locked or not.
    await client.send('Xabc', 1, (_c, w) => whys.push(w));
    expect(whys).toEqual(['locked', 'limit']);
  });

  it('the page fails a held send itself when its time is up, and ignores a late answer', async () => {
    const desk = await MockDesktop.create({ holdDecision: 'none' });
    client = new PhoneClient(await pairedPhone(desk), new FakeRelay(desk).connect, { ...fast, heldTimeoutMs: 150 });
    client.start();
    let confirmId = '';
    const p = client.send('Xabc', 1, (c) => (confirmId = c));
    const e = await p.catch((x) => x);
    expect(e).toBeInstanceOf(LostError);
    expect(e.message).toBe(HELD_EXPIRED);
    expect(e.message).toBe('Not confirmed on your desktop in time. Check History before trying again.');
    expect(client.heldCount).toBe(0);
    desk.decide(confirmId, true); // too late: nothing is waiting for it
    await tick(50);
    expect(get(client.status)).toBe('connected');
  });

  it('a page that slept past the limit fails the held send when it wakes (wall clock)', async () => {
    const desk = await MockDesktop.create({ holdDecision: 'none' });
    client = new PhoneClient(await pairedPhone(desk), new FakeRelay(desk).connect, fast);
    client.start();
    let held = false;
    const p = client.send('Xabc', 1, () => (held = true));
    await until(() => held);
    const now = Date.now();
    client.kick(); // the page is shown again, still inside the 11 minutes
    expect(client.heldCount).toBe(1);
    vi.spyOn(Date, 'now').mockReturnValue(now + 11 * 60_000 + 1);
    client.kick(); // shown again after 11 minutes asleep: the timer hasn't fired, the clock says it's over
    await expect(p).rejects.toThrow(HELD_EXPIRED);
  });

  it('the desktop’s own 10-minute expiry reaches the page', async () => {
    const desk = await MockDesktop.create({ holdDecision: 'none', holdExpiryMs: 100 });
    client = new PhoneClient(await pairedPhone(desk), new FakeRelay(desk).connect, fast);
    client.start();
    await expect(client.send('Xabc', 1)).rejects.toThrow(EXPIRED);
  });

  it('after a desktop restart the held send fails with "nothing was sent"', async () => {
    const desk = await MockDesktop.create({ holdDecision: 'none' });
    const relay = new FakeRelay(desk);
    client = new PhoneClient(await pairedPhone(desk), relay.connect, fast);
    client.start();
    let held = false;
    const p = client.send('Xabc', 1, () => (held = true));
    await until(() => held);
    const txs = desk.wallet.txs.length;
    desk.restart(); // every session ends; the phone reconnects and says hello to the "new" app
    await expect(p).rejects.toThrow(RESTARTED);
    expect(desk.wallet.txs.length).toBe(txs); // never paid
    expect(get(client.status)).toBe('connected');
  });
});

describe('send flow', () => {
  it('sending, held (locked), done', async () => {
    const desk = await MockDesktop.create({ locked: true, holdDelayMs: 80 });
    client = new PhoneClient(await pairedPhone(desk), new FakeRelay(desk).connect, fast);
    client.start();
    const flow = createSendFlow();
    const seen: string[] = [];
    const un = flow.subscribe((s) => seen.push(s.k === 'held' ? `held:${s.why}` : s.k));
    await flow.start(client, 'Xabc', 0.01);
    un();
    expect(seen).toEqual(['form', 'sending', 'held:locked', 'done']);
  });

  it('a hold that runs out ends "unsure"; a declined one does not', async () => {
    const desk = await MockDesktop.create({ holdDecision: 'none' });
    client = new PhoneClient(await pairedPhone(desk), new FakeRelay(desk).connect, { ...fast, heldTimeoutMs: 100 });
    client.start();
    const flow = createSendFlow();
    await flow.start(client, 'Xabc', 1);
    expect(get(flow)).toMatchObject({ k: 'error', unsure: true, msg: HELD_EXPIRED });

    const desk2 = await MockDesktop.create({ holdDecision: 'deny', holdDelayMs: 30 });
    client2 = new PhoneClient(await pairedPhone(desk2), new FakeRelay(desk2).connect, fast);
    client2.start();
    const flow2 = createSendFlow();
    await flow2.start(client2, 'Xabc', 1);
    expect(get(flow2)).toMatchObject({ k: 'error', unsure: false, msg: DECLINED });
  });
});
