// The phone link over Nostr (desktop v0.6.0; PROTOCOL.md, "Over Nostr"): the relay link's frames,
// carried in Nostr events between this phone's Nostr key and the desktop's, through public relays. One NostrLink is
// one channel (one RelayLink's worth): 16 random bytes, a sequence number each way, frames in order. The protocol
// inside is v1's, unchanged.
//
// Event contents: {"v":1,"c":"<channel>","s":<seq>,"d":<frame>}, a part {…,"p":[i,n],"x":"<text>"}, or the end of the
// channel {…,"bye":true}. Several relays deliver out of order: early frames wait (GAP_MS), and a gap that doesn't
// fill ends the channel, as a dropped WebSocket does (api.ts starts again with `hello`).
import { hex, randomBytes } from './bytes';
import { fromTo, KIND, messageEvent, nostrPub, type NostrEvent } from './nostr';
import { browserWs, RelayPool, type WsFactory } from './relaypool';
import type { Transport } from './relay';

export interface NostrRoute {
  /** The relays (wss://), from the pairing link and then from the desktop's `status`. */
  relays: string[];
  /** The desktop's Nostr key. */
  n: string;
  /** This phone's Nostr secret key (it only signs events). */
  secret: Uint8Array;
}

/** A frame whose JSON text is longer than this goes in parts (the desktop's PART). */
const PART = 24_000;
const MAX_PARTS = 16;
const GAP_MS = 10_000;
/** No frame from the desktop within this long of our first: it isn't answering. */
export const OFFLINE_MS = 8_000;
const MAX_EARLY = 64;

/** The relays, one pool per (this phone's key, desktop's key), shared by that pairing's links and kept while the page
 * lives: one subscription on each relay. Moving a hosted wallet home talks to two desktops at once. */
const pools = new Map<string, { pool: RelayPool; subs: Set<(e: NostrEvent) => void> }>();

function poolFor(route: NostrRoute, ws: WsFactory) {
  const me = nostrPub(route.secret);
  const key = `${me}|${route.n}`;
  const have = pools.get(key);
  if (have) {
    have.pool.setRelays(route.relays);
    return have;
  }
  const subs = new Set<(e: NostrEvent) => void>();
  const pool = new RelayPool({
    relays: route.relays,
    filter: () => ({ kinds: [KIND], '#p': [me], since: Math.floor(Date.now() / 1000) - 120 }),
    accept: fromTo(route.n, me),
    onEvent: (e) => subs.forEach((f) => f(e)),
    ws,
  });
  pool.start();
  const sh = { pool, subs };
  pools.set(key, sh);
  return sh;
}

/** Forget the relays (unpaired, or tests). */
export function stopNostr() {
  for (const sh of pools.values()) sh.pool.stop();
  pools.clear();
}

/** The relays as they stand, for Settings. */
export function nostrRelays(route: NostrRoute) {
  return pools.get(`${nostrPub(route.secret)}|${route.n}`)?.pool.info() ?? [];
}

/** `text` in pieces of at most `max` characters, whole code points. */
function pieces(text: string, max: number): string[] {
  const out: string[] = [];
  if (/^[\x00-\x7f]*$/.test(text)) {
    for (let i = 0; i < text.length; i += max) out.push(text.slice(i, i + max));
    return out;
  }
  // Not ASCII: count in UTF-8 bytes, as the desktop does, and never cut a character.
  let cur = '';
  let bytes = 0;
  for (const ch of text) {
    const b = new TextEncoder().encode(ch).length;
    if (bytes + b > max) {
      out.push(cur);
      cur = '';
      bytes = 0;
    }
    cur += ch;
    bytes += b;
  }
  if (cur) out.push(cur);
  return out;
}

export class NostrLink implements Transport {
  onFrame: (frame: any) => void = () => {};
  onEnd: (why: string) => void = () => {};
  private readonly cid = hex(randomBytes(16));
  private sOut = 0;
  private sIn = 0;
  private early = new Map<number, any>();
  private parts: string[] = [];
  private partsN = 0;
  private ended = false;
  private heard = false;
  private offlineTimer: ReturnType<typeof setTimeout> | undefined;
  private gapTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly handler: (e: NostrEvent) => void;

  private constructor(
    private readonly route: NostrRoute,
    private readonly sh: { pool: RelayPool; subs: Set<(e: NostrEvent) => void> },
  ) {
    this.handler = (e) => this.receive(e);
    sh.subs.add(this.handler);
  }

  /** A new channel, once a relay is open (within `reachMs`; else "Cannot reach the relays"). */
  static async open(route: NostrRoute, opts: { ws?: WsFactory; reachMs?: number } = {}): Promise<NostrLink> {
    if (!route.relays.length) throw new Error('No relays to reach your desktop through. Pair again.');
    const sh = poolFor(route, opts.ws ?? browserWs);
    const deadline = Date.now() + (opts.reachMs ?? 10_000);
    while (sh.pool.openCount() === 0) {
      if (Date.now() >= deadline) throw new Error('Cannot reach the relays. Is this phone online?');
      sh.pool.kick();
      await new Promise((r) => setTimeout(r, 100));
    }
    return new NostrLink(route, sh);
  }

  send(frame: unknown) {
    if (this.ended) return;
    const text = JSON.stringify(frame);
    if (text.length <= PART) this.publish({ d: frame });
    else {
      const ps = pieces(text, PART);
      if (ps.length > MAX_PARTS) return;
      ps.forEach((x, i) => this.publish({ p: [i, ps.length], x }));
    }
    if (!this.heard && this.offlineTimer === undefined) {
      this.offlineTimer = setTimeout(() => {
        if (!this.heard) this.end('offline');
      }, OFFLINE_MS);
    }
  }

  close() {
    this.end('closed by phone');
  }

  private publish(body: Record<string, unknown>) {
    const content = JSON.stringify({ v: 1, c: this.cid, s: this.sOut++, ...body });
    void this.sh.pool.publish(messageEvent(this.route.secret, this.route.n, content, Math.floor(Date.now() / 1000)));
  }

  private receive(e: NostrEvent) {
    if (this.ended) return;
    let c: any;
    try {
      c = JSON.parse(e.content);
    } catch {
      return;
    }
    if (c?.v !== 1 || c.c !== this.cid || !Number.isSafeInteger(c.s) || c.s < this.sIn) return;
    this.heard = true;
    clearTimeout(this.offlineTimer);
    if (c.s > this.sIn) {
      if (this.early.size < MAX_EARLY) this.early.set(c.s, c);
      if (this.gapTimer === undefined) this.gapTimer = setTimeout(() => this.end('a message went missing'), GAP_MS);
      return;
    }
    let next: any = c;
    while (next !== undefined) {
      this.sIn++;
      if (!this.piece(next)) return;
      next = this.early.get(this.sIn);
      this.early.delete(this.sIn);
    }
    clearTimeout(this.gapTimer);
    this.gapTimer = undefined;
    if (this.early.size) this.gapTimer = setTimeout(() => this.end('a message went missing'), GAP_MS);
  }

  /** One frame in order; false once the channel has ended. */
  private piece(c: any): boolean {
    if (c.bye === true) {
      this.end('desktop closed');
      return false;
    }
    if (Array.isArray(c.p) && typeof c.x === 'string') {
      const [i, n] = c.p;
      const fits = Number.isSafeInteger(i) && Number.isSafeInteger(n) && n >= 2 && n <= MAX_PARTS && i < n
        && i === this.parts.length && (i === 0 || n === this.partsN);
      if (!fits) {
        this.close();
        return false;
      }
      this.partsN = n;
      this.parts.push(c.x);
      if (i + 1 < n) return true;
      const text = this.parts.join('');
      this.parts = [];
      let f: unknown;
      try {
        f = JSON.parse(text);
      } catch {
        this.close();
        return false;
      }
      this.onFrame(f);
      return !this.ended;
    }
    if (!('d' in c) || this.parts.length) {
      this.close();
      return false;
    }
    this.onFrame(c.d);
    return !this.ended;
  }

  /** The channel ends; the desktop hears `bye` (best effort) unless it ended it, so channels don't pile up there
   * (security review of v0.6.0, M2). */
  private end(why: string) {
    if (this.ended) return;
    if (why !== 'desktop closed') this.publish({ bye: true });
    this.ended = true;
    clearTimeout(this.offlineTimer);
    clearTimeout(this.gapTimer);
    this.sh.subs.delete(this.handler);
    this.onEnd(why);
  }
}
