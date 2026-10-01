#!/usr/bin/env node
// Writes ../relay/testvectors/kk-v1.json: interop vectors for relay protocol v1
// (room, pairing key + ciphertext + comparison code, KK session keys + first messages each way,
// the host proof). Every key is FIXED (scalar = SHA-256 of a label), and every nonce is fixed, so
// the file is byte-for-byte reproducible. Run: node scripts/make-vectors.mjs
// Independent checks: ../../relay/testvectors/check_kk_v1.py (Python cryptography) and the
// relay's and the page's tests.
import { createHash, webcrypto } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  b64u, unb64u, keyFromScalar, room, phonePairKey, desktopPairKey, seal, open, counterNonce,
  phoneSession, desktopSession, pairCode, showPairCode, PROOF_CONTEXT, proofMessage,
} from './kk-ref.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, '../../relay/testvectors/kk-v1.json');
const te = new TextEncoder();

const scalar = (label) => createHash('sha256').update(label).digest('hex');
const eq = (a, b) => Buffer.from(a).equals(Buffer.from(b));
function must(cond, what) {
  if (!cond) throw new Error('self-check failed: ' + what);
}

const D = await keyFromScalar(scalar('fb-vector-D')); // desktop static
const P = await keyFromScalar(scalar('fb-vector-P')); // phone device key
const E = await keyFromScalar(scalar('fb-vector-E')); // phone pairing ephemeral
const eP = await keyFromScalar(scalar('fb-vector-eP')); // phone session ephemeral
const eD = await keyFromScalar(scalar('fb-vector-eD')); // desktop session ephemeral

const C = Uint8Array.from({ length: 16 }, (_, i) => 0xc0 + i); // pairing code c0..cf
const pairNonce = Uint8Array.from({ length: 12 }, (_, i) => i); // 00..0b

// --- room
const roomId = await room(D.pub);

// --- pairing link
const link = { v: 1, relay: 'wss://relay.example/ws', room: roomId, d: b64u(D.pub), c: b64u(C) };
const linkJson = JSON.stringify(link);
const pairUrl = 'https://relay.example/#pair=' + b64u(te.encode(linkJson));

// --- pairing message
const kPhone = await phonePairKey(E.priv, D.pub, C);
const kDesk = await desktopPairKey(D.priv, E.pub, C);
must(eq(kPhone, kDesk), 'pair key both sides');
const pairPlain = JSON.stringify({ p: b64u(P.pub), name: 'iPhone' });
const pairCt = await seal(kPhone, pairNonce, te.encode(pairPlain));
must(new TextDecoder().decode(await open(kDesk, pairNonce, pairCt)) === pairPlain, 'pair decrypt');
const pairFrame = { t: 'pair', e: b64u(E.pub), ct: b64u(pairCt), n: b64u(pairNonce) };

// --- the comparison code both screens show (PROTOCOL.md, "The comparison code")
const sas = await pairCode({ dPub: D.pub, pPub: P.pub, ePub: E.pub, c: C });
must(
  sas.code === String(BigInt('0x' + Buffer.from(sas.h.slice(0, 4)).toString('hex')) % 1000000n).padStart(6, '0'),
  'comparison code, computed a second way',
);

// --- the host proof (PROTOCOL.md, "The relay"): ECDSA P-256/SHA-256 over "fb-relay-proof-v1" || n
const challenge = Uint8Array.from({ length: 32 }, (_, i) => 0xa0 + i); // a0..bf
const proofMsg = proofMessage(challenge);
// D's RFC 6979 (deterministic) signature, as the p256 crate's SigningKey::sign makes it; the relay's tests
// (vectors_room_and_proof) re-make it. WebCrypto signs with a random nonce, so it is fixed here and checked.
const PROOF_SIG = 'I5ppehCLwTErYvYPzttCmUWOOh3aAbVSeuRBdnFERiyFq0UvNNhqKqNgUU7EtUYWmsi2nNVIEfDxCs2awO6AnQ';
const subtle = (globalThis.crypto ?? webcrypto).subtle;
const dVerify = await subtle.importKey('raw', D.pub, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
const verifies = (msg) => subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, dVerify, unb64u(PROOF_SIG), msg);
must(await verifies(proofMsg), 'the proof signature verifies over the proof message');
must(!(await verifies(challenge)), 'the proof signature is not over the bare challenge');

// --- session
const ps = await phoneSession({ pPriv: P.priv, pPub: P.pub, ePPriv: eP.priv, ePPub: eP.pub, dPub: D.pub, eDPub: eD.pub });
const ds = await desktopSession({ dPriv: D.priv, dPub: D.pub, eDPriv: eD.priv, eDPub: eD.pub, pPub: P.pub, ePPub: eP.pub });
for (const f of ['dh1', 'dh2', 'dh3', 'ikm', 'th', 'kPd', 'kDp']) must(eq(ps[f], ds[f]), 'session ' + f);

const pdPlain = [
  JSON.stringify({ id: 1, m: 'balance', a: {} }),
  JSON.stringify({ id: 2, m: 'send', a: { address: 'XexampleAddr', amount: 0.05 } }),
];
const dpPlain = [JSON.stringify({ id: 1, ok: { confirmed: 1.5, pending: 0 } })];
const pd = [];
for (let n = 0; n < pdPlain.length; n++) {
  const ct = await seal(ps.kPd, counterNonce(n), te.encode(pdPlain[n]));
  pd.push({ counter: n, nonce: b64u(counterNonce(n)), plaintext: pdPlain[n], ct: b64u(ct), frame: { t: 'm', ct: b64u(ct) } });
}
const dp = [];
for (let n = 0; n < dpPlain.length; n++) {
  const ct = await seal(ds.kDp, counterNonce(n), te.encode(dpPlain[n]));
  dp.push({ counter: n, nonce: b64u(counterNonce(n)), plaintext: dpPlain[n], ct: b64u(ct), frame: { t: 'm', ct: b64u(ct) } });
}

const keyEntry = (k, scalarLabel) => ({ scalar_label: scalarLabel, jwk: k.jwk, pub: b64u(k.pub) });

const vectors = {
  name: 'FreeBank phone relay protocol v1 interop vectors',
  spec: 'distribution/relay/PROTOCOL.md',
  generator: 'distribution/phone/scripts/make-vectors.mjs (Node WebCrypto; reproducible)',
  notes: [
    'Encoding: b64u = base64url, no padding (RFC 4648 section 5). All byte strings below are b64u unless the field says hex or plaintext.',
    'Keys: P-256. Private keys are JWK {kty:"EC",crv:"P-256",x,y,d}; d is the 32-byte big-endian scalar = SHA-256(ASCII scalar_label). "pub" is uncompressed SEC1: 0x04 || X(32) || Y(32) = 65 bytes.',
    'ECDH output: the 32-byte big-endian X coordinate of the shared point (WebCrypto deriveBits(256); p256 crate SharedSecret::raw_secret_bytes()). No hashing of the shared secret.',
    'room = first 22 characters of b64u(SHA-256(D_pub 65 bytes)).',
    'Pairing link: the fragment is #pair=b64u(UTF-8 JSON {v,relay,room,d,c}); the JSON key order shown is what the generator used but a reader must not depend on it.',
    'Pairing key: k = HKDF-SHA256(ikm = ECDH(E, D) 32 bytes, salt = C (16 raw bytes), info = ASCII "fb-pair-v1", L = 32).',
    'Pairing ciphertext: AES-256-GCM(key k, nonce 12 random bytes, no AAD) over the UTF-8 JSON {"p":b64u(P_pub),"name":...}; ct = ciphertext || 16-byte tag (WebCrypto and aes-gcm crate layout). The nonce travels in the frame field "n".',
    'Session: dh1 = ECDH(eP, eD), dh2 = ECDH(eP, D), dh3 = ECDH(P, eD) (desktop: ECDH(eD, eP), ECDH(D, eP), ECDH(eD, P)); ikm = dh1 || dh2 || dh3 (96 bytes).',
    'th = SHA-256(ASCII "fb-kk-v1" (8 bytes, no terminator) || P_pub || D_pub || eP_pub || eD_pub), each pub 65 bytes; 268 bytes hashed.',
    'okm = HKDF-SHA256(ikm, salt = th (32 bytes), info = ASCII "fb-session-v1", L = 64); k_pd = okm[0..32] (phone to desktop), k_dp = okm[32..64] (desktop to phone).',
    'Session nonce: 12-byte big-endian counter per direction, starting at 0 (counter 0 = 12 zero bytes, counter 1 = 00..00 01). Each direction has its own counter. No AAD.',
    'Session ciphertext: AES-256-GCM(ciphertext || 16-byte tag), sent as {"t":"m","ct":b64u}. Plaintext is the UTF-8 JSON request/reply exactly as listed (compare after JSON parse, not byte-for-byte, when you produce your own).',
    'Comparison code (pair.sas): h = SHA-256(ASCII "fb-pair-sas-v1" (14 bytes) || D_pub || P_pub || E_pub (65 bytes each) || C (16 bytes)), 225 bytes hashed; code = the first 4 bytes of h read as a big-endian unsigned integer, modulo 1,000,000, written as 6 digits with leading zeros; shown as two groups of three ("042 917").',
    'Host proof (proof): ECDSA P-256 with SHA-256 over ASCII "fb-relay-proof-v1" (17 bytes) || n (the 32 raw challenge bytes), 49 bytes signed; sig = r || s, 64 bytes (the WebCrypto layout). The vector\'s sig is the RFC 6979 deterministic signature (the p256 crate\'s SigningKey::sign); any valid signature is accepted, and a signature over the bare n is refused.',
  ],
  keys: {
    D: keyEntry(D, 'fb-vector-D'),
    P: keyEntry(P, 'fb-vector-P'),
    E: keyEntry(E, 'fb-vector-E'),
    eP: keyEntry(eP, 'fb-vector-eP'),
    eD: keyEntry(eD, 'fb-vector-eD'),
  },
  room: { d_pub: b64u(D.pub), room: roomId },
  pairing_link: { json: linkJson, url: pairUrl },
  pair: {
    c: b64u(C),
    c_hex: Buffer.from(C).toString('hex'),
    ecdh: b64u(await (await import('./kk-ref.mjs')).ecdh(E.priv, D.pub)),
    k: b64u(kPhone),
    nonce: b64u(pairNonce),
    plaintext: pairPlain,
    ct: b64u(pairCt),
    frame: pairFrame,
    sas: {
      h_hex: Buffer.from(sas.h).toString('hex'),
      u32: sas.u32,
      code: sas.code,
      display: showPairCode(sas.code),
    },
  },
  session: {
    hello: { t: 'hello', p: b64u(P.pub), e: b64u(eP.pub) },
    hello_ok: { t: 'hello-ok', e: b64u(eD.pub) },
    dh1: b64u(ps.dh1),
    dh2: b64u(ps.dh2),
    dh3: b64u(ps.dh3),
    ikm: b64u(ps.ikm),
    th: b64u(ps.th),
    k_pd: b64u(ps.kPd),
    k_dp: b64u(ps.kDp),
    phone_to_desktop: pd,
    desktop_to_phone: dp,
  },
  proof: {
    context: PROOF_CONTEXT,
    n: b64u(challenge),
    n_hex: Buffer.from(challenge).toString('hex'),
    challenge_frame: { t: 'challenge', n: b64u(challenge) },
    msg_hex: Buffer.from(proofMsg).toString('hex'),
    sig: PROOF_SIG,
    frame: { t: 'proof', sig: PROOF_SIG },
  },
};

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(vectors, null, 2) + '\n');
console.log('wrote', out);
console.log('room', roomId, 'th', vectors.session.th);
