import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  b64u, fromB64u, roomOf, pairKeyBytes, buildPairFrame, phoneSessionSecret, Session,
  counterNonce, parsePairLink, genKeyPair, exportPub, pairCode, codeFromDigest, showPairCode,
} from './crypto';

const V = JSON.parse(readFileSync(resolve(__dirname, '../../../relay/testvectors/kk-v1.json'), 'utf8'));
const subtle = globalThis.crypto.subtle;
const EC = { name: 'ECDH', namedCurve: 'P-256' };

async function priv(name: string): Promise<CryptoKey> {
  return subtle.importKey('jwk', V.keys[name].jwk, EC, false, ['deriveBits']);
}
async function pubKey(name: string): Promise<CryptoKey> {
  return subtle.importKey('raw', fromB64u(V.keys[name].pub), EC, true, []);
}
const pub = (name: string) => fromB64u(V.keys[name].pub);

describe('encoding', () => {
  it('b64u round-trips without padding', () => {
    for (let n = 0; n < 40; n++) {
      const b = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 255);
      const s = b64u(b);
      expect(s).not.toMatch(/[=+/]/);
      expect(fromB64u(s)).toEqual(b);
      expect(s).toBe(Buffer.from(b).toString('base64url'));
    }
  });
  it('counter nonce is 12-byte big-endian', () => {
    expect(b64u(counterNonce(0))).toBe(b64u(new Uint8Array(12)));
    expect(Array.from(counterNonce(1))).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    expect(Array.from(counterNonce(0x01020304))).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4]);
    expect(Array.from(counterNonce(2 ** 40 + 5))).toEqual([0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 5]);
  });
});

describe('kk-v1 vectors', () => {
  it('room', async () => {
    expect(await roomOf(pub('D'))).toBe(V.room.room);
  });

  it('pairing link parses', async () => {
    const frag = V.pairing_link.url.split('#pair=')[1];
    const link = await parsePairLink(frag);
    expect(link.room).toBe(V.room.room);
    expect(link.d).toBe(V.keys.D.pub);
    expect(link.c).toBe(V.pair.c);
  });

  it('pairing link rejects a room that does not match D', async () => {
    const bad = JSON.parse(V.pairing_link.json);
    bad.room = 'AAAAAAAAAAAAAAAAAAAAAA';
    await expect(parsePairLink(b64u(new TextEncoder().encode(JSON.stringify(bad))))).rejects.toThrow(/match/);
  });

  it('pair key and pair frame', async () => {
    const c = fromB64u(V.pair.c);
    expect(b64u(await pairKeyBytes(await priv('E'), pub('D'), c))).toBe(V.pair.k);
    const frame = await buildPairFrame({
      e: { privateKey: await priv('E'), publicKey: await pubKey('E') },
      dPub: pub('D'),
      c,
      pPub: pub('P'),
      name: 'iPhone',
      nonce: fromB64u(V.pair.nonce),
    });
    expect(frame).toEqual(V.pair.frame);
  });

  it('comparison code (PROTOCOL.md, "The comparison code")', async () => {
    const c = fromB64u(V.pair.c);
    const code = await pairCode(pub('D'), pub('P'), pub('E'), c);
    expect(code).toBe(V.pair.sas.code);
    expect(showPairCode(code)).toBe(V.pair.sas.display);
    expect(codeFromDigest(Uint8Array.from(Buffer.from(V.pair.sas.h_hex, 'hex')))).toBe(V.pair.sas.code);
    // Someone else's phone has another device key and ephemeral key, so another code.
    expect(await pairCode(pub('D'), pub('eP'), pub('E'), c)).not.toBe(code);
    expect(await pairCode(pub('D'), pub('P'), pub('eP'), c)).not.toBe(code);
    // The order of the inputs is part of the definition.
    expect(await pairCode(pub('D'), pub('E'), pub('P'), c)).not.toBe(code);
  });

  it('session secret', async () => {
    const s = await phoneSessionSecret({
      pPriv: await priv('P'), pPub: pub('P'),
      ePriv: await priv('eP'), ePub: pub('eP'),
      dPub: pub('D'), eDPub: pub('eD'),
    });
    expect(b64u(s.th)).toBe(V.session.th);
    expect(b64u(s.kPd)).toBe(V.session.k_pd);
    expect(b64u(s.kDp)).toBe(V.session.k_dp);

    const phone = await Session.phone(s);
    for (const m of V.session.phone_to_desktop) {
      expect(await phone.seal(JSON.parse(m.plaintext))).toBe(m.ct);
    }
    for (const m of V.session.desktop_to_phone) {
      expect(await phone.open(m.ct)).toEqual(JSON.parse(m.plaintext));
    }
  });
});

describe('comparison code arithmetic', () => {
  const digest = (...first4: number[]) => Uint8Array.from([...first4, ...new Array(28).fill(0xee)]);

  it('reads the first 4 bytes big-endian, modulo 1,000,000, with leading zeros', () => {
    expect(codeFromDigest(digest(0x00, 0x00, 0xa4, 0x10))).toBe('042000'); // 42000
    expect(codeFromDigest(digest(0x00, 0x00, 0x00, 0x07))).toBe('000007');
    expect(codeFromDigest(digest(0x00, 0x00, 0x00, 0x00))).toBe('000000');
    expect(codeFromDigest(digest(0xff, 0xff, 0xff, 0xff))).toBe('967295'); // 4294967295: unsigned, not -1
    expect(codeFromDigest(digest(0x80, 0x00, 0x00, 0x00))).toBe('483648'); // 2147483648: the sign bit is data
    expect(codeFromDigest(digest(0x00, 0x0f, 0x42, 0x40))).toBe('000000'); // exactly 1,000,000
  });

  it('shows two groups of three', () => {
    expect(showPairCode('042917')).toBe('042 917');
    expect(showPairCode('000007')).toBe('000 007');
  });

  it('refuses inputs of the wrong size', async () => {
    const k = new Uint8Array(65);
    k[0] = 4;
    await expect(pairCode(k, k, k, new Uint8Array(15))).rejects.toThrow();
    await expect(pairCode(k.slice(1), k, k, new Uint8Array(16))).rejects.toThrow();
  });
});

describe('session behaviour', () => {
  async function pair() {
    const P = await genKeyPair(), D = await genKeyPair(true), eP = await genKeyPair(), eD = await genKeyPair(true);
    const s = await phoneSessionSecret({
      pPriv: P.privateKey, pPub: await exportPub(P.publicKey),
      ePriv: eP.privateKey, ePub: await exportPub(eP.publicKey),
      dPub: await exportPub(D.publicKey), eDPub: await exportPub(eD.publicKey),
    });
    return { phone: await Session.phone(s), desk: await Session.desktop(s) };
  }

  it('round-trips many messages both ways, in order', async () => {
    const { phone, desk } = await pair();
    const cts = await Promise.all([1, 2, 3, 4, 5].map((id) => phone.seal({ id })));
    for (let i = 0; i < cts.length; i++) expect(await desk.open(cts[i])).toEqual({ id: i + 1 });
    expect(await phone.open(await desk.seal({ id: 1, ok: true }))).toEqual({ id: 1, ok: true });
  });

  it('an out-of-order message breaks the session', async () => {
    const { phone, desk } = await pair();
    const a = await phone.seal({ id: 1 });
    const b = await phone.seal({ id: 2 });
    await expect(desk.open(b)).rejects.toThrow();
    await expect(desk.open(a)).rejects.toThrow();
    expect(desk.broken).toBe(true);
  });

  it('non-extractable device key cannot be exported', async () => {
    const P = await genKeyPair();
    await expect(subtle.exportKey('jwk', P.privateKey)).rejects.toThrow();
    expect((await exportPub(P.publicKey)).length).toBe(65);
  });
});
