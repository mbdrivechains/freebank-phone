// Reference implementation of relay protocol v1 crypto (../../relay/PROTOCOL.md), both sides,
// in plain JS on WebCrypto. Written independently of src/lib/crypto.ts so the test vectors and
// the e2e mock desktop check the phone code against a second implementation.
// Used by scripts/make-vectors.mjs and e2e/smoke.mjs. Node >= 18.

import { webcrypto } from 'node:crypto';

// Node 18 has no global crypto in ESM; Node >= 20 does. Same object either way.
const subtle = (globalThis.crypto ?? webcrypto).subtle;
const te = new TextEncoder();

export const b64u = (buf) => Buffer.from(buf).toString('base64url');
export const unb64u = (s) => new Uint8Array(Buffer.from(s, 'base64url'));
export const cat = (...parts) => new Uint8Array(Buffer.concat(parts.map((p) => Buffer.from(p))));

const EC = { name: 'ECDH', namedCurve: 'P-256' };

export async function genKey() {
  const kp = await subtle.generateKey(EC, true, ['deriveBits']);
  const pub = new Uint8Array(await subtle.exportKey('raw', kp.publicKey));
  return { priv: kp.privateKey, pub };
}

/** Fixed key from a 32-byte scalar (hex). Returns { priv, pub, jwk }. */
export async function keyFromScalar(hex) {
  const { createECDH } = await import('node:crypto');
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(Buffer.from(hex, 'hex'));
  const pub = new Uint8Array(ecdh.getPublicKey()); // 0x04 || X || Y
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    x: b64u(pub.slice(1, 33)),
    y: b64u(pub.slice(33, 65)),
    d: b64u(Buffer.from(hex, 'hex')),
  };
  const priv = await subtle.importKey('jwk', jwk, EC, false, ['deriveBits']);
  return { priv, pub, jwk };
}

export async function ecdh(priv, pubRaw) {
  const pub = await subtle.importKey('raw', pubRaw, EC, true, []);
  return new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: pub }, priv, 256));
}

export async function hkdf(ikm, salt, info, len) {
  const k = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(
    await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: te.encode(info) }, k, len * 8),
  );
}

export const sha256 = async (b) => new Uint8Array(await subtle.digest('SHA-256', b));

export async function room(dPub) {
  return b64u(await sha256(dPub)).slice(0, 22);
}

export async function seal(keyRaw, nonce, plaintext) {
  const k = await subtle.importKey('raw', keyRaw, 'AES-GCM', false, ['encrypt']);
  return new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: nonce }, k, plaintext));
}

export async function open(keyRaw, nonce, ct) {
  const k = await subtle.importKey('raw', keyRaw, 'AES-GCM', false, ['decrypt']);
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: nonce }, k, ct));
}

export function counterNonce(n) {
  const b = new Uint8Array(12);
  let v = BigInt(n);
  for (let i = 11; i >= 0; i--) {
    b[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return b;
}

/** Desktop side of pairing: k = HKDF(ECDH(D, E_pub), salt=C, info="fb-pair-v1", 32). */
export async function desktopPairKey(dPriv, ePub, c) {
  return hkdf(await ecdh(dPriv, ePub), c, 'fb-pair-v1', 32);
}

/** Phone side of pairing. */
export async function phonePairKey(ePriv, dPub, c) {
  return hkdf(await ecdh(ePriv, dPub), c, 'fb-pair-v1', 32);
}

/**
 * The comparison code both screens show at pairing (PROTOCOL.md, "The comparison code"):
 * h = SHA-256("fb-pair-sas-v1" || D_pub || P_pub || E_pub || C); the first 4 bytes of h as a big-endian
 * unsigned integer, modulo 1,000,000, as 6 digits with leading zeros.
 */
export async function pairCode({ dPub, pPub, ePub, c }) {
  const h = await sha256(cat(te.encode('fb-pair-sas-v1'), dPub, pPub, ePub, c));
  const u32 = Buffer.from(h).readUInt32BE(0);
  return { h, u32, code: String(u32 % 1_000_000).padStart(6, '0') };
}

/** "042917" as the screens show it: "042 917". */
export const showPairCode = (code) => `${code.slice(0, 3)} ${code.slice(3)}`;

/** The host proof signs this: ASCII "fb-relay-proof-v1" followed by the relay's 32 challenge bytes. */
export const PROOF_CONTEXT = 'fb-relay-proof-v1';
export const proofMessage = (n) => cat(te.encode(PROOF_CONTEXT), n);

export async function transcriptHash(pPub, dPub, ePPub, eDPub) {
  return sha256(cat(te.encode('fb-kk-v1'), pPub, dPub, ePPub, eDPub));
}

/** Desktop side of the KK session: mirrors the phone's ikm term by term. */
export async function desktopSession({ dPriv, dPub, eDPriv, eDPub, pPub, ePPub }) {
  const dh1 = await ecdh(eDPriv, ePPub); // ECDH(eP, eD)
  const dh2 = await ecdh(dPriv, ePPub); // ECDH(eP, D)
  const dh3 = await ecdh(eDPriv, pPub); // ECDH(P, eD)
  const ikm = cat(dh1, dh2, dh3);
  const th = await transcriptHash(pPub, dPub, ePPub, eDPub);
  const okm = await hkdf(ikm, th, 'fb-session-v1', 64);
  return { dh1, dh2, dh3, ikm, th, kPd: okm.slice(0, 32), kDp: okm.slice(32, 64) };
}

/** Phone side of the KK session. */
export async function phoneSession({ pPriv, pPub, ePPriv, ePPub, dPub, eDPub }) {
  const dh1 = await ecdh(ePPriv, eDPub);
  const dh2 = await ecdh(ePPriv, dPub);
  const dh3 = await ecdh(pPriv, eDPub);
  const ikm = cat(dh1, dh2, dh3);
  const th = await transcriptHash(pPub, dPub, ePPub, eDPub);
  const okm = await hkdf(ikm, th, 'fb-session-v1', 64);
  return { dh1, dh2, dh3, ikm, th, kPd: okm.slice(0, 32), kDp: okm.slice(32, 64) };
}

/** One direction of a session: counter nonces from 0, strictly in order. */
export class Direction {
  constructor(keyRaw) {
    this.key = keyRaw;
    this.n = 0;
  }
  async seal(obj) {
    return b64u(await seal(this.key, counterNonce(this.n++), te.encode(JSON.stringify(obj))));
  }
  async open(ctB64u) {
    const pt = await open(this.key, counterNonce(this.n++), unb64u(ctB64u));
    return JSON.parse(new TextDecoder().decode(pt));
  }
}
