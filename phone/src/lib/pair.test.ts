import { describe, expect, it } from 'vitest';
import { relayMatchesPage } from './pair';
import { buildPairFrame, exportPub, fromB64u, genKeyPair, pairCode, parsePairLink, showPairCode } from './crypto';
// @ts-ignore -- plain JS test helper
import { MockDesktop } from '../../e2e/mock-desktop.mjs';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout');
    await tick(5);
  }
}

describe('the comparison code at pairing (security review P1)', () => {
  /** A phone's pair request for `link`, as pairPhone builds it, and the code that phone shows. */
  async function phoneRequest(link: { d: string; c: string }, name: string) {
    const P = await genKeyPair(false);
    const E = await genKeyPair(false);
    const pPub = await exportPub(P.publicKey);
    const dPub = fromB64u(link.d);
    const c = fromB64u(link.c);
    const frame = await buildPairFrame({ e: E, dPub, c, pPub, name });
    return { frame, shows: showPairCode(await pairCode(dPub, pPub, await exportPub(E.publicKey), c)) };
  }

  it('phone and desktop compute the same code, and an intruder with the same QR code gets another', async () => {
    const desk = await MockDesktop.create({ pairDelayMs: 10, checkCode: true });
    const url: string = desk.pairingLink('wss://relay.example/ws');
    const link = await parsePairLink(url.split('#pair=')[1]);
    const intruder = await phoneRequest(link, 'iPhone');
    const owner = await phoneRequest(link, 'iPhone');
    expect(intruder.shows).not.toBe(owner.shows);

    // The owner is looking at their own phone.
    desk.phoneShows = owner.shows;
    const answers: string[] = [];
    // The intruder's request arrives first: the desktop shows the intruder's code, which isn't the owner's.
    desk.channel((f: any) => answers.push('intruder ' + f.t), () => {}).onFrame(intruder.frame);
    await until(() => answers.length === 1);
    expect(desk.pairs[0].code).toBe(intruder.shows);
    expect(answers).toEqual(['intruder pair-refused']);
    // Then the owner's own request: same code on both screens, allowed.
    desk.channel((f: any) => answers.push('owner ' + f.t), () => {}).onFrame(owner.frame);
    await until(() => answers.length === 2);
    expect(desk.pairs[1].code).toBe(owner.shows);
    expect(answers).toEqual(['intruder pair-refused', 'owner paired']);
    expect(desk.devices.size).toBe(1);
  });
});

describe('a pairing link must name this page’s own relay', () => {
  const https = { protocol: 'https:', host: 'app.ecxfreebank.com' };
  const local = { protocol: 'http:', host: '127.0.0.1:8480' };

  it('accepts the page’s own host', () => {
    expect(relayMatchesPage('wss://app.ecxfreebank.com/ws', https)).toBe(true);
    expect(relayMatchesPage('ws://127.0.0.1:8480/ws', local)).toBe(true);
  });

  it('refuses another host, port or scheme', () => {
    expect(relayMatchesPage('wss://evil.example/ws', https)).toBe(false);
    expect(relayMatchesPage('wss://app.ecxfreebank.com.evil.example/ws', https)).toBe(false);
    expect(relayMatchesPage('wss://app.ecxfreebank.com:8443/ws', https)).toBe(false);
    expect(relayMatchesPage('ws://app.ecxfreebank.com/ws', https)).toBe(false); // no plain ws from an https page
    expect(relayMatchesPage('wss://127.0.0.1:8480/ws', local)).toBe(false);
    expect(relayMatchesPage('ws://127.0.0.1:9999/ws', local)).toBe(false);
  });

  it('refuses credentials and junk', () => {
    expect(relayMatchesPage('wss://user:pw@app.ecxfreebank.com/ws', https)).toBe(false);
    expect(relayMatchesPage('not a url', https)).toBe(false);
    expect(relayMatchesPage('https://app.ecxfreebank.com/ws', https)).toBe(false);
    expect(relayMatchesPage('wss://app.ecxfreebank.com/ws', { protocol: 'file:', host: '' })).toBe(false);
  });
});
