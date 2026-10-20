// Which link a pairing uses (desktop v0.6.0): the relay (pairing v1) or Nostr (v2). Both carry protocol v1's frames.
import { NostrLink, type NostrRoute } from './nostrlink';
import { RelayLink, type Connect } from './relay';
import type { Pairing } from './store';

/** The routes over Nostr in use, by pairing, so a new relay list from `status` reaches the next connection. */
const routes = new WeakMap<Pairing, NostrRoute>();

function routeOf(p: Pairing): NostrRoute {
  let r = routes.get(p);
  if (!r) {
    r = { relays: [...(p.relays ?? [])], n: p.n ?? '', secret: p.nsec ?? new Uint8Array() };
    routes.set(p, r);
  }
  return r;
}

export function connectFor(p: Pairing): Connect {
  if (p.v === 2) return () => NostrLink.open(routeOf(p));
  return () => RelayLink.open(p.relay ?? '', p.room ?? '');
}

/** Relays as a pairing takes them: up to five, wss:// (ws:// only on this computer, for tests). */
export function usableRelays(r: unknown): string[] | null {
  if (!Array.isArray(r) || !r.length || r.length > 5) return null;
  const ok = (u: unknown) =>
    typeof u === 'string' && (/^wss:\/\/[^/\s@]+/.test(u) || /^ws:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(u));
  return r.every(ok) ? (r as string[]) : null;
}

/**
 * The desktop's `status` names its relays (over Nostr): when they changed, the next connection uses them, and the
 * pairing keeps them. Returns the pairing to save, or null when nothing changed.
 */
export function followRelays(p: Pairing, relays: unknown): Pairing | null {
  if (p.v !== 2) return null;
  const list = usableRelays(relays);
  if (!list || JSON.stringify(list) === JSON.stringify(p.relays)) return null;
  routeOf(p).relays = [...list];
  p.relays = [...list];
  return p;
}
