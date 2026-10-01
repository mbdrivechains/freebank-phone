// Test vectors for the phone relay's passkeys (relay/PROTOCOL.md, "Face ID: passkeys"): a P-256 key, a challenge,
// WebAuthn assertions (one that passes, and one for each way the desktop must refuse), and an attestation object
// the phone reads the new credential's key from. Node WebCrypto; ECDSA signatures are randomised, so each run makes
// new (equally valid) signatures over the same data.
//
//   node scripts/make-webauthn-vectors.mjs > ../relay/testvectors/webauthn-v1.json
import { webcrypto } from 'node:crypto';

const { subtle } = webcrypto;
const b64u = (b) => Buffer.from(b).toString('base64url');
const cat = (...xs) => Buffer.concat(xs.map((x) => Buffer.from(x)));
const sha256 = async (b) => Buffer.from(await subtle.digest('SHA-256', b));
const u32 = (n) => Buffer.from([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);

// A fixed key, so the public key is the same on every run.
const D = Buffer.from('c9afa9d845ba75166b5c215767b1d6934e50c3db36e89b127b8a622b120f6721', 'hex');
const jwk = await (async () => {
  // The public point for D: import as PKCS#8 is awkward in WebCrypto, so derive it with an ECDH import.
  const { createECDH } = await import('node:crypto');
  const e = createECDH('prime256v1');
  e.setPrivateKey(D);
  const pub = e.getPublicKey();
  return { kty: 'EC', crv: 'P-256', d: b64u(D), x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) };
})();
const priv = await subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
const pk = cat([4], Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url'));

// WebCrypto signs as r || s; WebAuthn carries DER.
function der(rs) {
  const int = (b) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    b = b.subarray(i);
    return b[0] & 0x80 ? cat([0x02, b.length + 1, 0], b) : cat([0x02, b.length], b);
  };
  const body = cat(int(Buffer.from(rs.subarray(0, 32))), int(Buffer.from(rs.subarray(32))));
  return cat([0x30, body.length], body);
}
const sign = async (msg, key = priv) => der(Buffer.from(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, msg)));
// Another key, for a signature that isn't the phone's.
const other = (await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])).privateKey;

const RP = 'app.ecxfreebank.com';
const ORIGIN = 'https://app.ecxfreebank.com';
const CHALLENGE = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
const OTHER = Buffer.from(Array.from({ length: 32 }, (_, i) => 255 - i));

async function assertion({ rp = RP, flags = 0x05, count = 0, cdj = {}, cdjRaw = null, tamper = false, adLen = null }) {
  let ad = cat(await sha256(Buffer.from(rp)), [flags], u32(count));
  if (adLen !== null) ad = ad.subarray(0, adLen);
  const client = cdjRaw ?? JSON.stringify({ type: 'webauthn.get', challenge: b64u(CHALLENGE), origin: ORIGIN, crossOrigin: false, ...cdj });
  const cdjBytes = Buffer.from(client);
  const sig = await sign(cat(ad, await sha256(cdjBytes)));
  if (tamper) ad = cat(ad.subarray(0, 32), [ad[32] | 0x40], ad.subarray(33));
  return { ad: b64u(ad), cdj: b64u(cdjBytes), sig: b64u(sig) };
}

// A minimal CBOR encoder: unsigned and negative ints, byte and text strings, maps.
function cbor(v) {
  const head = (major, n) =>
    n < 24 ? Buffer.from([(major << 5) | n]) : n < 256 ? Buffer.from([(major << 5) | 24, n]) : Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') return cat(head(3, Buffer.byteLength(v)), Buffer.from(v));
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return cat(head(2, v.length), v);
  if (v instanceof Map) return cat(head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)]));
  throw new Error('cbor: ' + typeof v);
}

const credId = Buffer.from(Array.from({ length: 16 }, (_, i) => 0xa0 + i));
const cose = cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]));
const attAuthData = cat(await sha256(Buffer.from(RP)), [0x45], u32(0), Buffer.alloc(16), [0, credId.length], credId, cose);
const attObj = cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', attAuthData]]));

const good = await assertion({});
const out = {
  name: 'FreeBank phone relay passkey (WebAuthn) vectors',
  spec: 'distribution/relay/PROTOCOL.md, "Face ID: passkeys (app v0.2.1)"',
  generator: 'distribution/phone/scripts/make-webauthn-vectors.mjs (Node WebCrypto; signatures differ run to run)',
  notes: [
    'b64u = base64url without padding. pk is the uncompressed P-256 point. ad = authenticatorData, cdj = clientDataJSON, sig = DER ECDSA over ad || SHA-256(cdj).',
    'Each case is checked with rp_id, origin and challenge below and the stored signature counter stored_count; ok says whether the desktop accepts it, and new_count what it keeps then.',
  ],
  rp_id: RP,
  origin: ORIGIN,
  challenge: b64u(CHALLENGE),
  pk: b64u(pk),
  cases: [
    { name: 'good', ...good, stored_count: 0, ok: true, new_count: 0 },
    { name: 'good, no crossOrigin field (Safari)', ...(await assertion({ cdjRaw: JSON.stringify({ type: 'webauthn.get', challenge: b64u(CHALLENGE), origin: ORIGIN }) })), stored_count: 0, ok: true, new_count: 0 },
    { name: 'good, extra client data fields', ...(await assertion({ cdj: { other_keys_can_be_added_here: 'x' } })), stored_count: 0, ok: true, new_count: 0 },
    { name: 'good, counter goes up', ...(await assertion({ count: 8 })), stored_count: 7, ok: true, new_count: 8 },
    { name: 'counter does not go up', ...(await assertion({ count: 7 })), stored_count: 7, ok: false },
    { name: 'counter goes back to 0', ...(await assertion({ count: 0 })), stored_count: 7, ok: false },
    { name: 'wrong origin', ...(await assertion({ cdj: { origin: 'https://evil.example' } })), stored_count: 0, ok: false },
    { name: 'origin with a trailing slash', ...(await assertion({ cdj: { origin: ORIGIN + '/' } })), stored_count: 0, ok: false },
    { name: 'wrong challenge', ...(await assertion({ cdj: { challenge: b64u(OTHER) } })), stored_count: 0, ok: false },
    { name: 'challenge with padding', ...(await assertion({ cdj: { challenge: Buffer.from(CHALLENGE).toString('base64') } })), stored_count: 0, ok: false },
    { name: 'type webauthn.create', ...(await assertion({ cdj: { type: 'webauthn.create' } })), stored_count: 0, ok: false },
    { name: 'crossOrigin true', ...(await assertion({ cdj: { crossOrigin: true } })), stored_count: 0, ok: false },
    { name: 'no user verification (UV)', ...(await assertion({ flags: 0x01 })), stored_count: 0, ok: false },
    { name: 'no user presence (UP)', ...(await assertion({ flags: 0x04 })), stored_count: 0, ok: false },
    { name: 'another relying party', ...(await assertion({ rp: 'evil.example' })), stored_count: 0, ok: false },
    { name: 'authenticator data changed after signing', ...(await assertion({ tamper: true })), stored_count: 0, ok: false },
    { name: 'authenticator data too short', ...(await assertion({ adLen: 36 })), stored_count: 0, ok: false },
    { name: 'client data not JSON', ...(await assertion({ cdjRaw: 'type=webauthn.get' })), stored_count: 0, ok: false },
    {
      name: 'signature by another key',
      ad: good.ad,
      cdj: good.cdj,
      sig: b64u(await sign(cat(Buffer.from(good.ad, 'base64url'), await sha256(Buffer.from(good.cdj, 'base64url'))), other)),
      stored_count: 0,
      ok: false,
    },
  ],
  attestation: {
    note: 'A "none" attestation object as navigator.credentials.create returns it; the phone reads pk and cred from it.',
    object: b64u(attObj),
    pk: b64u(pk),
    cred: b64u(credId),
  },
};
console.log(JSON.stringify(out, null, 2));
