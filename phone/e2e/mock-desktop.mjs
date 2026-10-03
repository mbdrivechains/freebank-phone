// A fake FreeBank desktop for tests: the desktop side of pairing, the KK handshake and the
// narrow door, on the reference crypto in scripts/kk-ref.mjs (independent of src/lib/crypto.ts).
// Wallet data is made up. Used by src/lib/api.test.ts and e2e/smoke.mjs.
//
// Held sends follow relay/PROTOCOL.md as settled 2026-09-29 (v0.2.0):
// - the held reply is {id, ok: {pending, why: "limit" | "locked"}};
// - the final reply repeats the confirm id, {id, pending, ok: {txid}} or {id, pending, err}, and goes to every live
//   session of that phone;
// - a held send expires after 10 minutes with the final err "not confirmed on the desktop within 10 minutes";
// - restart() cancels held sends (never paying them) and sends each new session of that phone the final err "the
//   desktop app restarted; nothing was sent" until that send's 10 minutes are up;
// - locked: an encrypted wallet whose phone sends aren't unlocked holds sends within the limit too (why "locked").
//
// Pairing shows the comparison code (PROTOCOL.md, "The comparison code"): each pair request is recorded in `pairs`
// with its code. With `checkCode`, the "user" allows a request only if its code is what the phone shows: a test
// reads the code off the phone and sets `phoneShows` ("042 917"), as the owner compares the two screens.
// The host proof (`proof(n)`) signs "fb-relay-proof-v1" || n (PROTOCOL.md, "The relay").
import {
  b64u, unb64u, genKey, room as roomOf, desktopPairKey, open as aesOpen, desktopSession, Direction,
  pairCode, showPairCode, proofMessage,
} from '../scripts/kk-ref.mjs';
import { webcrypto } from 'node:crypto';

const rand = (n) => (globalThis.crypto ?? webcrypto).getRandomValues(new Uint8Array(n));
const hex = (b) => Buffer.from(b).toString('hex');
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const fakeAddress = () => 'X' + Array.from(rand(33), (x) => B58[x % 58]).join('');

export const EXPIRED = 'not confirmed on the desktop within 10 minutes';
export const RESTARTED = 'the desktop app restarted; nothing was sent';
export const DECLINED = 'declined on the desktop';

export class MockDesktop {
  static async create(opts = {}) {
    const D = await genKey();
    const d = new MockDesktop(D, await roomOf(D.pub), opts);
    return d;
  }

  constructor(D, room, opts) {
    this.D = D;
    this.room = room;
    this.dPub = b64u(D.pub);
    this.devices = new Map(); // b64u P_pub -> { name, chans: Set }
    this.code = null;
    this.codeUsed = false;
    this.pairDecision = opts.pairDecision ?? 'allow';
    this.pairDelayMs = opts.pairDelayMs ?? 300;
    this.checkCode = opts.checkCode ?? false; // allow only a request whose code equals phoneShows
    this.phoneShows = null; // the code the owner reads off the phone, "042 917"
    this.pairs = []; // every pair request that opened: { name, code, answer }
    this.holdDecision = opts.holdDecision ?? 'allow'; // 'allow' | 'deny' | 'none' (nobody answers; it expires)
    this.holdDelayMs = opts.holdDelayMs ?? 1500;
    this.holdExpiryMs = opts.holdExpiryMs ?? 10 * 60_000;
    this.locked = opts.locked ?? false;
    this.credit = opts.credit ?? true; // desktop v0.2.5: notes, houses and the note actions
    this.held = new Map(); // confirm id -> { id, dev, amount, address, at, why, cancelled, timer, expiry }
    this.approvals = new Map(); // approval id -> { msg, answer: null | 'approved' | 'declined', auth }
    this.requests = []; // every request the narrow door opened: { id, m, a }
    this.intercept = null; // tests: (req, chan) => true leaves a request unanswered
    this.log = [];
    this.wallet = {
      confirmed: 12.5,
      pending: 0.25,
      limitLeft: opts.limit ?? 0.1,
      blocks: 1234,
      txs: [ // newest first, as the desktop sends them
        { txid: hex(rand(32)), category: 'receive', amount: 0.25, confirmations: 0, time: 1759100000, address: fakeAddress() },
        { txid: hex(rand(32)), category: 'receive', amount: 10, confirmations: 42, time: 1759000000, address: fakeAddress() },
        { txid: hex(rand(32)), category: 'send', amount: -1.5, confirmations: 120, time: 1758900000, address: fakeAddress() },
        { txid: hex(rand(32)), category: 'receive', amount: 4, confirmations: 300, time: 1758800000, address: fakeAddress() },
      ],
      // Notes by house (desktop v0.2.5): house 3 open, house 4 suspended with some notes under demand.
      notes: [
        { house: 3, name: 'Bank of Leith', state: 'o', state_name: 'Open', amount: 0.5, demanded: 0, redeemable: 0.5,
          can_redeem: true, can_demand: true, rate_bps: 1000 },
        { house: 4, name: 'Ayr Bank', state: 'd', state_name: 'Suspended', amount: 0.2, demanded: 0.05, redeemable: 0.05,
          can_redeem: true, can_demand: true, rate_bps: 1000 },
      ],
      houses: [
        { house: 3, name: 'Bank of Leith', state: 'o', state_name: 'Open', ratio_bps: 12500, outstanding: 0.9,
          reserves: 1.2, attested_at: 1200, rate_bps: 1000 },
        { house: 4, name: 'Ayr Bank', state: 'd', state_name: 'Suspended', ratio_bps: 6000, outstanding: 0.4,
          reserves: 0.24, attested_at: 1100, rate_bps: 1000 },
      ],
    };
  }

  /** A fresh pairing link (what the desktop's QR code holds). */
  pairingLink(relayUrl, pageOrigin = 'https://relay.example') {
    this.code = rand(16);
    this.codeUsed = false;
    this.phoneShows = null;
    const json = JSON.stringify({ v: 1, relay: relayUrl, room: this.room, d: this.dPub, c: b64u(this.code) });
    return pageOrigin + '/#pair=' + b64u(new TextEncoder().encode(json));
  }

  /** Register a phone as if it had paired (tests). */
  addDevice(pPub, name = 'test') {
    const dev = { name, chans: new Set() };
    this.devices.set(pPub, dev);
    return dev;
  }

  revokeAll() {
    for (const dev of this.devices.values()) for (const c of dev.chans) c.kill?.();
    for (const [confirmId, h] of this.held) if (!h.cancelled) this.drop(confirmId);
    this.devices.clear();
  }

  /** The app quits and starts again: every session ends, and held sends are cancelled, never paid. */
  restart() {
    for (const h of this.held.values()) {
      clearTimeout(h.timer);
      clearTimeout(h.expiry);
      h.cancelled = true;
    }
    for (const dev of this.devices.values()) {
      for (const c of dev.chans) {
        c.state = 'dead';
        c.kill?.();
      }
      dev.chans.clear();
    }
    this.log.push('restart');
  }

  /** One phone connection (a relay channel). `toPhone(frame)` delivers a frame; `kill()` drops the connection. */
  channel(toPhone, kill) {
    const chan = { toPhone, kill, state: 'new', tx: null, rx: null, device: null, q: Promise.resolve() };
    const handle = async (f) => {
      if (f?.t === 'pair') return this.onPair(chan, f);
      if (f?.t === 'hello') return this.onHello(chan, f);
      if (f?.t === 'm' && chan.state === 'session') return this.onMessage(chan, f);
    };
    return {
      // Keep frames strictly in order per channel.
      onFrame: (f) => (chan.q = chan.q.then(() => handle(f)).catch((e) => {
        this.log.push('error: ' + e.message);
        chan.state = 'dead';
        chan.device?.chans.delete(chan);
        kill();
      })),
      onClose: () => {
        chan.state = 'dead';
        chan.device?.chans.delete(chan);
      },
    };
  }

  async onPair(chan, f) {
    let req;
    let code;
    try {
      const k = await desktopPairKey(this.D.priv, unb64u(f.e), this.code);
      req = JSON.parse(new TextDecoder().decode(await aesOpen(k, unb64u(f.n), unb64u(f.ct))));
      ({ code } = await pairCode({ dPub: this.D.pub, pPub: unb64u(req.p), ePub: unb64u(f.e), c: this.code }));
    } catch {
      this.log.push('pair: bad');
      return chan.toPhone({ t: 'pair-refused' });
    }
    // "Allow this phone? <name>. Allow only if your phone shows <code>."
    const entry = { name: req.name, code: showPairCode(code), answer: null };
    this.pairs.push(entry);
    this.log.push(`pair: request ${req.name} ${entry.code}`);
    await new Promise((r) => setTimeout(r, this.pairDelayMs));
    const refuse = (why) => {
      entry.answer = 'refused';
      this.log.push(`pair: refused ${req.name} (${why})`);
      chan.toPhone({ t: 'pair-refused' });
    };
    if (this.codeUsed) return refuse('code used');
    if (this.pairDecision !== 'allow') return refuse('denied');
    if (this.checkCode) {
      // The owner looks at the phone (a test sets phoneShows once the phone shows its code).
      for (let i = 0; i < 100 && this.phoneShows === null; i++) await new Promise((r) => setTimeout(r, 50));
      if (this.codeUsed) return refuse('code used'); // another request was allowed meanwhile
      if (this.phoneShows !== entry.code) return refuse(`the phone shows ${this.phoneShows}`);
    }
    this.codeUsed = true;
    this.phoneShows = null;
    entry.answer = 'paired';
    this.addDevice(req.p, req.name);
    this.log.push('pair: allowed ' + req.name);
    chan.toPhone({ t: 'paired' });
  }

  /** The host's answer to the relay's challenge: ECDSA P-256/SHA-256, r || s, over "fb-relay-proof-v1" || n. */
  async proof(nB64u) {
    const subtle = (globalThis.crypto ?? webcrypto).subtle;
    const jwk = await subtle.exportKey('jwk', this.D.priv);
    const key = await subtle.importKey('jwk', { ...jwk, key_ops: undefined }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    return b64u(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, proofMessage(unb64u(nB64u))));
  }

  async onHello(chan, f) {
    const dev = this.devices.get(f.p);
    if (!dev) {
      this.log.push('hello: denied');
      return chan.toPhone({ t: 'denied' });
    }
    const eD = await genKey();
    const s = await desktopSession({
      dPriv: this.D.priv, dPub: this.D.pub, eDPriv: eD.priv, eDPub: eD.pub, pPub: unb64u(f.p), ePPub: unb64u(f.e),
    });
    chan.tx = new Direction(s.kDp);
    chan.rx = new Direction(s.kPd);
    chan.state = 'session';
    chan.device = dev;
    dev.chans.add(chan);
    this.log.push('hello: ok ' + dev.name);
    chan.toPhone({ t: 'hello-ok', e: b64u(eD.pub) });
    // After a restart: each new session of this phone hears about its cancelled sends until their 10 minutes are up.
    for (const [confirmId, h] of this.held) {
      if (!h.cancelled || h.dev !== dev) continue;
      if (Date.now() >= h.at + this.holdExpiryMs) {
        this.held.delete(confirmId);
        continue;
      }
      await this.reply(chan, { id: h.id, pending: confirmId, err: RESTARTED });
    }
  }

  async reply(chan, obj) {
    // Seal and hand over in one step per channel so counters and delivery order match.
    const ct = await chan.tx.seal(obj);
    chan.toPhone({ t: 'm', ct });
  }

  /** Seal `obj` to every live session of `dev` (a held send's final reply; tests use it for anything). */
  toDevice(dev, obj) {
    let n = 0;
    for (const c of dev.chans) {
      if (c.state !== 'session') continue;
      c.q = c.q.then(() => this.reply(c, obj));
      n++;
    }
    if (!n) this.log.push('final reply undeliverable');
    return n;
  }

  /** Pay `h` ({kind, house, amount, address}): ECX out, or a house's notes sent, redeemed or demanded. */
  pay(h) {
    const w = this.wallet;
    const txid = hex(rand(32));
    const kind = h.kind ?? 'send';
    const n = w.notes.find((x) => x.house === h.house);
    const round = (v) => Math.round(v * 1e8) / 1e8;
    if (kind === 'send') {
      w.confirmed -= h.amount;
      w.txs.unshift({ txid, category: 'send', amount: -h.amount, confirmations: 0, time: Math.floor(Date.now() / 1000), address: h.address });
    } else if (kind === 'note-send') {
      n.amount = round(n.amount - h.amount);
    } else if (kind === 'note-redeem') {
      n.amount = round(n.amount - h.amount);
      n.redeemable = round(n.redeemable - h.amount);
      if (n.state === 'd') n.demanded = round(n.demanded - h.amount);
      w.confirmed += h.amount;
    } else if (kind === 'note-demand') {
      n.demanded = round(n.demanded + h.amount);
      if (n.state === 'd') n.redeemable = round(n.redeemable + h.amount);
    }
    return txid;
  }

  /** The desktop's answer to a held send. A confirmed send does not count against the phone's limit. */
  decide(confirmId, allow) {
    const h = this.held.get(confirmId);
    if (!h || h.cancelled) return false;
    this.held.delete(confirmId);
    clearTimeout(h.timer);
    clearTimeout(h.expiry);
    const final = allow
      ? { id: h.id, pending: confirmId, ok: { txid: this.pay(h) } }
      : { id: h.id, pending: confirmId, err: DECLINED };
    this.log.push(`send: ${allow ? 'confirmed' : 'declined'} ${confirmId}`);
    this.toDevice(h.dev, final);
    return true;
  }

  /** Ask every paired phone to approve something (desktop v0.2.5). `what`: {what, amount, address, text}. `clockSkew`:
   * seconds this desktop's clock is ahead of the phone's (the page counts from `secs`, not `expires`). */
  askApproval(what, secs = 120, clockSkew = 0) {
    const id = 'a' + hex(rand(8));
    const expires = Math.floor(Date.now() / 1000) + clockSkew + secs;
    const msg = { approve: { id, ...what, challenge: b64u(rand(32)), cred: 'Y3JlZC1pZA', expires, secs } };
    this.approvals.set(id, { msg, answer: null, auth: null });
    for (const dev of this.devices.values()) this.toDevice(dev, msg);
    return id;
  }

  /** Stop waiting for approval `id`: the phones' cards go. */
  endApproval(id) {
    this.approvals.delete(id);
    for (const dev of this.devices.values()) this.toDevice(dev, { 'approve-done': id });
  }

  /** Forget a held send without a final reply (the phone was revoked). */
  drop(confirmId) {
    const h = this.held.get(confirmId);
    if (!h) return;
    clearTimeout(h.timer);
    clearTimeout(h.expiry);
    this.held.delete(confirmId);
  }

  expire(confirmId) {
    const h = this.held.get(confirmId);
    if (!h || h.cancelled) return;
    this.held.delete(confirmId);
    clearTimeout(h.timer);
    this.log.push('send: expired ' + confirmId);
    this.toDevice(h.dev, { id: h.id, pending: confirmId, err: EXPIRED });
  }

  async onMessage(chan, f) {
    const req = await chan.rx.open(f.ct); // throws on bad ct -> channel killed
    const w = this.wallet;
    this.requests.push({ id: req.id, m: req.m, a: req.a });
    this.log.push('req: ' + req.m);
    if (this.intercept?.(req, chan)) return;
    const ok = (v) => this.reply(chan, { id: req.id, ok: v });
    const err = (e) => this.reply(chan, { id: req.id, err: e });
    switch (req.m) {
      case 'balance':
        return ok({ confirmed: w.confirmed, pending: w.pending });
      case 'history':
        return ok(w.txs.slice(0, Math.min(50, req.a?.count ?? 10)));
      case 'receive':
        return ok({ address: fakeAddress() });
      case 'status':
        return ok({ blocks: w.blocks, synced: true, limit_left: Math.round(w.limitLeft * 1e8) / 1e8, ...(this.credit ? { credit: true } : {}) });
      case 'approve': {
        const a = this.approvals.get(req.a?.id);
        if (!a || a.answer) return err('That approval is no longer waiting.');
        if (req.a.decline === true) a.answer = 'declined';
        else if (req.a.auth && typeof req.a.auth.sig === 'string') {
          a.answer = 'approved';
          a.auth = req.a.auth;
        } else return err("Face ID didn't check out. Try again.");
        return ok({});
      }
      case 'notes':
        return this.credit ? ok(w.notes.filter((n) => n.amount > 0)) : err('unknown method');
      case 'houses':
        return this.credit ? ok(w.houses) : err('unknown method');
      case 'send':
      case 'note-send':
      case 'note-redeem':
      case 'note-demand': {
        if (req.m !== 'send' && !this.credit) return err('unknown method');
        const { address, amount, house } = req.a ?? {};
        const needsAddress = req.m === 'send' || req.m === 'note-send';
        if (needsAddress && (typeof address !== 'string' || !address.startsWith('X'))) return err('Invalid address');
        if (typeof amount !== 'number' || !(amount > 0)) return err('Invalid amount');
        if (req.m === 'send' && amount > w.confirmed) return err('Insufficient funds');
        const n = w.notes.find((x) => x.house === house);
        if (req.m !== 'send' && !n) return err('No notes of that house');
        if (req.m === 'note-redeem' && amount > n.redeemable + 1e-12) return err('More than can be redeemed now');
        const p = { kind: req.m, house, amount, address: needsAddress ? address : '' };
        // A note action's fee and carriers count against the limit too (desktop v0.2.5).
        const cost = req.m === 'send' ? amount : amount + 0.00102;
        const within = cost <= w.limitLeft + 1e-12;
        if (within && !this.locked) {
          w.limitLeft -= cost;
          return ok({ txid: this.pay(p) });
        }
        const why = within ? 'locked' : 'limit';
        const confirmId = 'c' + hex(rand(8));
        const h = { id: req.id, dev: chan.device, ...p, at: Date.now(), why, cancelled: false, timer: null, expiry: null };
        this.held.set(confirmId, h);
        this.log.push(`send: held ${confirmId} (${why})`);
        await ok({ pending: confirmId, why });
        if (this.holdDecision !== 'none') {
          h.timer = setTimeout(() => this.decide(confirmId, this.holdDecision === 'allow'), this.holdDelayMs);
        }
        h.expiry = setTimeout(() => this.expire(confirmId), this.holdExpiryMs);
        h.expiry.unref?.(); // a 10-minute timer must not keep a finished test run alive
        return;
      }
      default:
        return err('unknown method');
    }
  }
}
