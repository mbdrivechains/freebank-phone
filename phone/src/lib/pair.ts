// Phone side of pairing (relay/PROTOCOL.md, "Pairing" and "The comparison code").
import { buildPairFrame, exportPub, fromB64u, genKeyPair, b64u, pairCode, type PairLink } from './crypto';
import { RelayLink } from './relay';
import { savePairing, type Pairing } from './store';
import { note } from './activity';

export class PairRefusedError extends Error {
  constructor() {
    super('The desktop said no, or the pairing code has expired. Make a new pairing QR code on the desktop and try again.');
  }
}

const PAIR_WAIT_MS = 5 * 60_000; // the pairing code lives 5 minutes
const INVITE_WAIT_MS = 10 * 60_000; // an invite lives 10 minutes (desktop v0.2.8)

/**
 * The page talks only to the relay it was loaded from: wss://<this host> on https (ws:// on http, for local
 * tests). A link naming another relay is refused, so a crafted QR code can't point this page (and the keys it
 * keeps) at someone else's server. The relay's CSP (`connect-src 'self'`) blocks it too; this says why.
 */
export function relayMatchesPage(relay: string, page: { protocol: string; host: string }): boolean {
  let u: URL;
  try {
    u = new URL(relay);
  } catch {
    return false;
  }
  const want = page.protocol === 'https:' ? 'wss:' : page.protocol === 'http:' ? 'ws:' : null;
  return u.protocol === want && u.host === page.host && !u.username && !u.password;
}

/**
 * Make the device key P, send the encrypted pair request, and wait for the desktop's answer.
 * `onWaiting(code)` fires once the request is out: the desktop is now showing "Allow this phone?" with its
 * comparison code, and the phone shows `code` (6 digits) for the user to compare.
 */
export async function pairPhone(
  link: PairLink,
  name: string,
  onWaiting: (code: string) => void,
  save: (p: Pairing) => Promise<void> = savePairing,
): Promise<Pairing> {
  const P = await genKeyPair(false); // non-extractable device key
  const E = await genKeyPair(false); // pairing ephemeral
  const pPub = await exportPub(P.publicKey);
  const dPub = fromB64u(link.d);
  const c = fromB64u(link.c);
  // An invite's link (`h`) joins a wallet kept at a house (desktop v0.2.8): the request says so.
  const frame = await buildPairFrame({ e: E, dPub, c, pPub, name, hosted: !!link.h });
  const code = await pairCode(dPub, pPub, await exportPub(E.publicKey), c);

  const relay = await RelayLink.open(link.relay, link.room);
  try {
    const answer = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(link.h
          ? 'No answer in 10 minutes. Ask for a new invite QR code and try again.'
          : 'No answer from the desktop in 5 minutes. Make a new pairing QR code and try again.')),
        link.h ? INVITE_WAIT_MS : PAIR_WAIT_MS,
      );
      relay.onFrame = (f) => {
        if (f?.t === 'paired' || f?.t === 'pair-refused') {
          clearTimeout(timer);
          resolve(f.t);
        }
      };
      relay.onEnd = () => {
        clearTimeout(timer);
        reject(new Error('The connection to your desktop dropped while pairing. Try again.'));
      };
      relay.send(frame);
      note('pairing: asked the desktop');
      onWaiting(code);
    });
    note(`pairing: ${answer}`);
    if (answer !== 'paired') throw new PairRefusedError();
  } finally {
    relay.onEnd = () => {};
    relay.close();
  }

  const pairing: Pairing = {
    v: 1,
    relay: link.relay,
    room: link.room,
    d: link.d,
    pPub: b64u(pPub),
    pPriv: P.privateKey,
    name,
    pairedAt: Date.now(),
    kind: link.h ? 'hosted' : 'owner',
    ...(link.h ? { house: link.h } : {}),
  };
  await save(pairing);
  return pairing;
}
