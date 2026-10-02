// The phone's client for the desktop's narrow door (relay/PROTOCOL.md, "Session handshake"
// and "Requests"): keeps one session up (reconnecting with backoff), numbers requests from a
// random start, matches replies, and keeps held sends open until the desktop's final answer
// (which must carry the hold's confirm id) or 11 minutes, whichever comes first.

import { writable, type Readable } from 'svelte/store';
import { b64u, exportPub, fromB64u, genKeyPair, phoneSessionSecret, Session, type Bytes } from './crypto';
import { OfflineError, type Connect, type Transport } from './relay';
import { note } from './activity';

export type Status = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'offline' | 'denied';

export interface Balance {
  confirmed: number;
  pending: number;
}
export interface Tx {
  txid: string;
  category: string;
  amount: number;
  confirmations: number;
  time: number;
  address?: string;
}
export interface NodeStatus {
  blocks: number;
  synced: boolean;
  limit_left: number;
  /** Face ID (desktop v0.2.1): this phone has a passkey; each send asks for it too. */
  face_id?: boolean;
  face_id_sends?: boolean;
}

/** A WebAuthn assertion, each part b64u (passkey.ts). */
export interface AssertionParts {
  ad: string;
  cdj: string;
  sig: string;
}
export type SendResult = { txid: string };

/** Why the desktop is holding a send: over the day's limit, or the desktop wallet is locked. */
export type HeldWhy = 'limit' | 'locked';

/** The page's own limit on a held send: the desktop gives up after 10 minutes (PROTOCOL.md, held sends). */
export const HELD_TIMEOUT_MS = 11 * 60_000;
export const HELD_EXPIRED = 'Not confirmed on your desktop in time. Check History before trying again.';

export class DeniedError extends Error {
  constructor() {
    super('This phone was removed on the desktop.');
  }
}
/** The outcome is unknown: the payment may or may not have gone out. */
export class LostError extends Error {}
/** The desktop wants Face ID before it answers this session (relay/PROTOCOL.md, "Face ID: passkeys"). */
export class LockedError extends Error {}
export class NotConnectedError extends Error {
  constructor() {
    super('Your desktop is not reachable right now.');
  }
}

export interface ClientOptions {
  baseDelayMs?: number; // first reconnect delay
  maxDelayMs?: number;
  handshakeTimeoutMs?: number;
  requestTimeoutMs?: number;
  readyTimeoutMs?: number; // how long call() waits for a session before failing
  heldTimeoutMs?: number; // how long a held send may wait for its final reply
}

interface Held {
  confirmId: string;
  why: HeldWhy;
  at: number; // Date.now() when the page learned of the hold
}

interface Pending {
  method: string;
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  onHeld?: (confirmId: string, why: HeldWhy) => void;
  held: Held | null;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * The first request id of a page load: a random safe integer in [1, 2^52], so ids stay safe integers for 2^52
 * requests, and a late final reply meant for an earlier page load can't match a request of this one.
 */
export function randomStartId(): number {
  const [hi, lo] = globalThis.crypto.getRandomValues(new Uint32Array(2));
  return (hi & 0xfffff) * 2 ** 32 + lo + 1;
}

/** `{"pending":"<confirm id>","why":…}` without a txid: the desktop is holding the send. */
function isHeldReply(ok: any): boolean {
  return !!ok && typeof ok === 'object' && 'pending' in ok && !('txid' in ok);
}

export interface Identity {
  pPriv: CryptoKey;
  pPub: string; // b64u
  d: string; // b64u D_pub
}

export class PhoneClient {
  private readonly _status = writable<Status>('idle');
  readonly status: Readable<Status> = { subscribe: this._status.subscribe };
  /** The desktop asked for Face ID (a new session of a phone with a passkey); false once it is given. */
  private readonly _locked = writable(false);
  readonly locked: Readable<boolean> = { subscribe: this._locked.subscribe };
  private statusNow: Status = 'idle';

  private transport: Transport | null = null;
  private session: Session | null = null;
  private nextId = randomStartId();
  private readonly pending = new Map<number, Pending>();
  private stopped = true;
  private wake: (() => void) | null = null;
  private attempt = 0;
  private readyWaiters: (() => void)[] = [];
  private readonly o: Required<ClientOptions>;

  constructor(
    private readonly id: Identity,
    private readonly connect: Connect,
    opts: ClientOptions = {},
  ) {
    this.o = {
      baseDelayMs: 1000,
      maxDelayMs: 30_000,
      handshakeTimeoutMs: 15_000,
      requestTimeoutMs: 30_000,
      readyTimeoutMs: 12_000,
      heldTimeoutMs: HELD_TIMEOUT_MS,
      ...opts,
    };
  }

  private setStatus(s: Status) {
    if (s !== this.statusNow) note(`link: ${s}`);
    this.statusNow = s;
    this._status.set(s);
    if (s === 'connected') {
      const w = this.readyWaiters;
      this.readyWaiters = [];
      w.forEach((f) => f());
    }
  }

  get current(): Status {
    return this.statusNow;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    void this.loop();
  }

  stop() {
    this.stopped = true;
    this.transport?.close();
    this.wake?.();
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new LostError('Stopped.'));
      this.pending.delete(id);
    }
  }

  /** Reconnect now if we are waiting to (page became visible, network came back). */
  kick() {
    this.expireHeld();
    this.attempt = 0;
    this.wake?.();
  }

  /**
   * Fail held sends whose time is up by the wall clock. Phones pause a background page's timers, so the timer
   * set when the send was held can fire late; this runs when the page comes back.
   */
  expireHeld() {
    const now = Date.now();
    for (const [id, p] of this.pending) {
      if (p.held && now - p.held.at >= this.o.heldTimeoutMs) this.expire(id, p);
    }
  }

  private expire(id: number, p: Pending) {
    if (this.pending.get(id) !== p) return;
    this.finish(id, p);
    p.reject(new LostError(HELD_EXPIRED));
  }

  private async loop() {
    while (!this.stopped) {
      if (this.statusNow !== 'offline') this.setStatus(this.attempt === 0 && this.statusNow === 'idle' ? 'connecting' : 'reconnecting');
      let t: Transport | null = null;
      try {
        t = await this.connect();
        if (this.stopped) {
          t.close();
          break;
        }
        const ended = new Promise<string>((res) => (t!.onEnd = res));
        const hs = await this.handshake(t, ended);
        this.session = hs.session;
        this.transport = t;
        this.attempt = 0;
        t.onFrame = (f) => this.onFrame(f);
        hs.early.forEach((f) => this.onFrame(f));
        this.setStatus('connected');
        await ended;
      } catch (e) {
        t?.close();
        if (e instanceof DeniedError) {
          this.stopped = true;
          this.setStatus('denied');
          this.dropPending(e, true);
          return;
        }
        if (e instanceof OfflineError) this.setStatus('offline');
        else note(`link: ${(e as Error)?.message ?? e}`);
      } finally {
        this.transport = null;
        this.session = null;
      }
      this.dropPending(
        new LostError('The connection dropped before your desktop answered. Check your history before trying again.'),
        false,
      );
      if (this.stopped) break;
      if (this.statusNow === 'connected') this.setStatus('reconnecting');
      const delay = Math.min(this.o.maxDelayMs, this.o.baseDelayMs * 2 ** this.attempt) * (0.75 + Math.random() * 0.5);
      this.attempt = Math.min(this.attempt + 1, 10);
      await new Promise<void>((res) => {
        const timer = setTimeout(res, delay);
        this.wake = () => {
          clearTimeout(timer);
          res();
        };
      });
      this.wake = null;
    }
    if (this.statusNow !== 'denied') this.setStatus('idle');
  }

  private async handshake(t: Transport, ended: Promise<string>): Promise<{ session: Session; early: any[] }> {
    const eP = await genKeyPair(false);
    const ePub = await exportPub(eP.publicKey);
    // The first frame is the handshake reply; anything after it is kept for the session.
    const early: any[] = [];
    let got = false;
    let first!: (f: any) => void;
    const reply = new Promise<any>((res) => (first = res));
    t.onFrame = (f) => {
      if (got) early.push(f);
      else {
        got = true;
        first(f);
      }
    };
    t.send({ t: 'hello', p: this.id.pPub, e: b64u(ePub) });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const closed = ended.then(() => {
      throw new Error('closed during handshake');
    });
    closed.catch(() => {});
    const msg = await Promise.race([
      reply,
      closed,
      new Promise((_, rej) => (timer = setTimeout(() => rej(new Error('handshake timed out')), this.o.handshakeTimeoutMs))),
    ]).finally(() => clearTimeout(timer));
    if (msg?.t === 'denied') throw new DeniedError();
    if (msg?.t !== 'hello-ok' || typeof msg.e !== 'string') throw new Error('bad handshake reply');
    const secret = await phoneSessionSecret({
      pPriv: this.id.pPriv,
      pPub: fromB64u(this.id.pPub),
      ePriv: eP.privateKey,
      ePub,
      dPub: fromB64u(this.id.d),
      eDPub: fromB64u(msg.e),
    });
    return { session: await Session.phone(secret), early };
  }

  private onFrame(f: any) {
    const s = this.session, t = this.transport;
    if (!s || !t) return;
    if (f?.t === 'denied') {
      // Revoked mid-session.
      this.stopped = true;
      this.setStatus('denied');
      this.dropPending(new DeniedError(), true);
      t.close();
      return;
    }
    if (f?.t !== 'm' || typeof f.ct !== 'string') return;
    s.open(f.ct).then(
      (msg) => this.onReply(msg),
      () => t.close(), // out of order or tampered: the session is over
    );
  }

  private onReply(msg: any) {
    if (!msg || typeof msg !== 'object' || typeof msg.id !== 'number') return; // no id: nothing to match
    const p = this.pending.get(msg.id);
    if (!p) return;
    // A held send's final reply repeats its confirm id. Accept it only for the request the desktop held under
    // that id; anything else carrying `pending` (an earlier page load's, another hold's) is not ours.
    if (p.held) {
      if (!('pending' in msg) || msg.pending !== p.held.confirmId) return;
    } else if ('pending' in msg) {
      return;
    }
    if ('err' in msg) {
      this.finish(msg.id, p);
      if (msg.auth === 'open') {
        this._locked.set(true);
        p.reject(new LockedError(String(msg.err)));
      } else p.reject(new Error(String(msg.err)));
    } else if (!p.held && p.method === 'send' && isHeldReply(msg.ok)) {
      const confirmId = msg.ok.pending;
      if (typeof confirmId !== 'string' || !confirmId) {
        this.finish(msg.id, p);
        p.reject(new LostError('Your desktop sent an answer this page does not understand. Check History before trying again.'));
        return;
      }
      const why: HeldWhy = msg.ok.why === 'locked' ? 'locked' : 'limit';
      p.held = { confirmId, why, at: Date.now() };
      clearTimeout(p.timer);
      p.timer = setTimeout(() => this.expire(msg.id, p), this.o.heldTimeoutMs);
      p.onHeld?.(confirmId, why);
    } else {
      this.finish(msg.id, p);
      p.resolve(msg.ok);
    }
  }

  private finish(id: number, p: Pending) {
    clearTimeout(p.timer);
    this.pending.delete(id);
  }

  /** Reject open requests. Held sends survive a dropped connection unless `all`. */
  private dropPending(e: Error, all: boolean) {
    for (const [id, p] of this.pending) {
      if (p.held && !all) continue;
      this.finish(id, p);
      p.reject(e);
    }
  }

  private ready(): Promise<void> {
    if (this.statusNow === 'connected') return Promise.resolve();
    if (this.statusNow === 'denied') return Promise.reject(new DeniedError());
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        this.readyWaiters = this.readyWaiters.filter((f) => f !== ok);
        rej(new NotConnectedError());
      }, this.o.readyTimeoutMs);
      const ok = () => {
        clearTimeout(timer);
        res();
      };
      this.readyWaiters.push(ok);
    });
  }

  /** Number of held sends still waiting for the desktop. */
  get heldCount(): number {
    let n = 0;
    for (const p of this.pending.values()) if (p.held) n++;
    return n;
  }

  /** A request, with its outcome noted for "Include recent activity" (lib/activity.ts). */
  async call<T = any>(method: string, a: Record<string, unknown> = {}, onHeld?: (confirmId: string, why: HeldWhy) => void): Promise<T> {
    const held = onHeld && ((c: string, why: HeldWhy) => (note(`${method}: held (${why})`), onHeld(c, why)));
    const r = this.callRaw<T>(method, a, held);
    r.then(
      () => note(`${method}: ok`),
      (e) => note(`${method}: ${(e as Error)?.message ?? e}`),
    );
    return r;
  }

  private async callRaw<T = any>(
    method: string,
    a: Record<string, unknown> = {},
    onHeld?: (confirmId: string, why: HeldWhy) => void,
  ): Promise<T> {
    await this.ready();
    const s = this.session!, t = this.transport!;
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const p: Pending = { method, resolve, reject, onHeld, held: null };
      p.timer = setTimeout(() => {
        this.finish(id, p);
        reject(new LostError(method === 'send'
          ? 'Your desktop did not answer in time. Check your history before trying again.'
          : 'Your desktop did not answer in time.'));
      }, this.o.requestTimeoutMs);
      this.pending.set(id, p);
      // seal() resolves in counter order, so these sends go out in counter order.
      s.seal({ id, m: method, a }).then(
        (ct) => t.send({ t: 'm', ct }),
        (e) => {
          this.finish(id, p);
          reject(e);
        },
      );
    });
  }

  balance = () => this.call<Balance>('balance');
  history = (count = 10) => this.call<Tx[]>('history', { count: Math.min(50, count) });
  receive = () => this.call<{ address: string }>('receive');
  nodeStatus = () => this.call<NodeStatus>('status');
  /** `auth`: Face ID over a `for: "send"` challenge, when this phone chose Face ID before each send. */
  send = (address: string, amount: number, onHeld?: (confirmId: string, why: HeldWhy) => void, auth?: AssertionParts) =>
    this.call<SendResult>('send', auth ? { address, amount, auth } : { address, amount }, onHeld);

  // Face ID (relay/PROTOCOL.md, "Face ID: passkeys").
  authStart = (purpose: 'open' | 'send' | 'add' | 'change') =>
    this.call<{ challenge: string; cred?: string }>('auth-start', { for: purpose });
  async auth(x: AssertionParts) {
    await this.call<object>('auth', { ...x });
    this._locked.set(false);
  }
  async passkeyAdd(pk: string, cred: string, sends: boolean, x: AssertionParts) {
    await this.call<object>('passkey-add', { pk, cred, sends, ...x });
    this._locked.set(false);
  }
  /** Changing Face ID takes Face ID: `auth` is an assertion over a `for: "change"` challenge. */
  passkeySet = (sends: boolean, auth: AssertionParts) => this.call<object>('passkey-set', { sends, auth });

  /** The desktop took this phone's passkey away (Remove Face ID): if a request now goes through, unlock. */
  async unlockIfOpen(): Promise<boolean> {
    try {
      await this.call('status');
      this._locked.set(false);
      return true;
    } catch {
      return false;
    }
  }
  passkeyRemove = (auth: AssertionParts) => this.call<object>('passkey-remove', { auth });
}

export type { Bytes };
