// Payment links (relay/PROTOCOL.md, "Hosted wallets", desktop v0.2.8): a shop's QR code says where to pay, in which
// house's notes, how much (or leaves the amount to the payer) and the shop's name.
//   https://<host>/#pay=<b64u JSON {"v":1, "a":"<address>", "h":<house>, "u":<ECX or null>, "n":"<shop name>"}>
// "Scan to pay" reads one, or a bare FreeBank address.
import { b64u, cleanText, fromB64u, utf8 } from './crypto';

export interface PayRequest {
  address: string;
  /** The house whose notes to pay in; null for a bare address (the payer picks). */
  house: number | null;
  /** ECX; null leaves the amount to the payer. */
  amount: number | null;
  /** The shop's name, cleaned for showing; empty when none. */
  name: string;
}

/** A FreeBank address: base58, starting with X (freebankd's PUBKEY_ADDRESS prefix on both networks). */
export const ADDRESS_RE = /^X[1-9A-HJ-NP-Za-km-z]{24,40}$/;

const NOT_A_PAYMENT = "That isn't a FreeBank payment code. Scan the shop's payment QR code, or paste its link or address.";

/** The most anyone can ask for in one payment: ECX's supply (21 million), so a crafted amount can't overflow. */
const MAX_ECX = 21_000_000;

function amountOf(u: unknown): number | null {
  if (u === null || u === undefined) return null;
  if (typeof u !== 'number' || !Number.isFinite(u) || u <= 0 || u > MAX_ECX) throw new Error('This payment link asks for an amount that makes no sense.');
  // Whole sats only (8 decimals).
  const sats = Math.round(u * 1e8);
  if (Math.abs(sats - u * 1e8) > 1e-3) throw new Error('This payment link asks for an amount with more than 8 decimals.');
  return sats / 1e8;
}

/** Read the `#pay=` value (base64url JSON). Throws with a user-facing message. */
export function parsePayValue(value: string): PayRequest {
  let obj: any;
  try {
    obj = JSON.parse(new TextDecoder().decode(fromB64u(value)));
  } catch {
    throw new Error('This payment link is damaged. Ask the shop to show it again.');
  }
  if (obj?.v !== 1) throw new Error('This payment link is from a newer or older version of FreeBank.');
  const address = String(obj.a ?? '');
  if (!ADDRESS_RE.test(address)) throw new Error('This payment link has no valid address.');
  if (!Number.isSafeInteger(obj.h) || obj.h < 0) throw new Error('This payment link names no house.');
  return { address, house: obj.h, amount: amountOf(obj.u), name: cleanText(obj.n, 40) };
}

/**
 * What a scanned or pasted text asks to pay: a payment link for this page (`<origin>/…#pay=…`), the `#pay=` value on
 * its own, or a bare address. A link to another site is refused.
 */
export function parsePayText(text: string, origin: string): PayRequest {
  const t = text.trim();
  if (ADDRESS_RE.test(t)) return { address: t, house: null, amount: null, name: '' };
  const at = t.indexOf('#pay=');
  if (at < 0) {
    if (/^[A-Za-z0-9_-]{20,}$/.test(t)) return parsePayValue(t);
    throw new Error(NOT_A_PAYMENT);
  }
  if (/^https?:\/\//i.test(t)) {
    let url: URL;
    try {
      url = new URL(t);
    } catch {
      throw new Error(NOT_A_PAYMENT);
    }
    if (url.origin !== origin) throw new Error(`This payment link is for another site (${cleanText(url.host, 60)}), not this page.`);
  }
  return parsePayValue(t.slice(at + '#pay='.length).split(/\s/)[0]);
}

/** Scanning: a payment code for this page, or why the camera should keep looking (the shape `Scanner` takes). */
export function scannedPay(text: string, origin: string): { value: string } | { wrong: string } {
  try {
    parsePayText(text, origin);
    return { value: text };
  } catch (e) {
    return { wrong: (e as Error).message };
  }
}

/** The link a shop shows: `amount` null leaves the amount to the payer (the counter QR). */
export function payLinkFor(origin: string, pathname: string, r: { address: string; house: number; amount: number | null; name: string }): string {
  const json = JSON.stringify({ v: 1, a: r.address, h: r.house, u: r.amount, n: cleanText(r.name, 40) });
  return `${origin}${pathname}#pay=${b64u(utf8(json))}`;
}
