// Phone-side crypto for relay protocol v1 (relay/PROTOCOL.md). WebCrypto only:
// ECDH P-256, HKDF-SHA256, AES-256-GCM, SHA-256. No libraries.

const subtle = globalThis.crypto.subtle;
const te = new TextEncoder();
const td = new TextDecoder();

export type Bytes = Uint8Array<ArrayBuffer>;

// ---------- encoding ----------

export function b64u(data: Bytes | ArrayBuffer): string {
  const b = data instanceof Uint8Array ? data : new Uint8Array(data);
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64u(s: string): Bytes {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('bad base64url');
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function concat(...parts: Bytes[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export const utf8 = (s: string): Bytes => te.encode(s);

export function randomBytes(n: number): Bytes {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

// ---------- primitives ----------

const EC: EcKeyImportParams = { name: 'ECDH', namedCurve: 'P-256' };

export async function sha256(data: Bytes): Promise<Bytes> {
  return new Uint8Array(await subtle.digest('SHA-256', data));
}

/** room = first 22 chars of b64u(SHA-256(D_pub)). */
export async function roomOf(dPub: Bytes): Promise<string> {
  return b64u(await sha256(dPub)).slice(0, 22);
}

/** A P-256 ECDH key pair. The private half is non-extractable unless asked. */
export async function genKeyPair(extractable = false): Promise<CryptoKeyPair> {
  return (await subtle.generateKey(EC, extractable, ['deriveBits'])) as CryptoKeyPair;
}

/** Uncompressed SEC1 public key, 65 bytes. Public keys are always exportable. */
export async function exportPub(key: CryptoKey): Promise<Bytes> {
  return new Uint8Array(await subtle.exportKey('raw', key));
}

export async function importPub(raw: Bytes): Promise<CryptoKey> {
  if (raw.length !== 65 || raw[0] !== 4) throw new Error('bad public key');
  return subtle.importKey('raw', raw, EC, true, []);
}

/** 32-byte X coordinate of the shared point. */
export async function ecdh(priv: CryptoKey, pub: Bytes | CryptoKey): Promise<Bytes> {
  const p = pub instanceof Uint8Array ? await importPub(pub) : pub;
  return new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: p }, priv, 256));
}

export async function hkdf(ikm: Bytes, salt: Bytes, info: string, len: number): Promise<Bytes> {
  const k = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(
    await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: utf8(info) }, k, len * 8),
  );
}

export async function aesKey(raw: Bytes): Promise<CryptoKey> {
  if (raw.length !== 32) throw new Error('AES-256 key must be 32 bytes');
  return subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function aesSeal(key: CryptoKey, nonce: Bytes, pt: Bytes): Promise<Bytes> {
  return new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, pt));
}

export async function aesOpen(key: CryptoKey, nonce: Bytes, ct: Bytes): Promise<Bytes> {
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ct));
}

/** 12-byte big-endian counter nonce. */
export function counterNonce(n: number): Bytes {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('bad counter');
  const b = new Uint8Array(12);
  let v = n;
  for (let i = 11; i >= 4 && v > 0; i--) {
    b[i] = v % 256;
    v = Math.floor(v / 256);
  }
  return b;
}

// ---------- pairing ----------

export interface PairLink {
  v: 1;
  relay: string;
  room: string;
  d: string; // b64u D_pub
  c: string; // b64u pairing code
}

/** Parse the `#pair=` fragment value. Throws with a user-facing message on anything odd. */
export async function parsePairLink(fragmentValue: string): Promise<PairLink> {
  let obj: any;
  try {
    obj = JSON.parse(td.decode(fromB64u(fragmentValue)));
  } catch {
    throw new Error('This pairing link is damaged. Show the QR code again on your desktop.');
  }
  if (obj?.v !== 1) throw new Error('This pairing link is from a newer or older version.');
  if (typeof obj.relay !== 'string' || !/^wss?:\/\//.test(obj.relay)) throw new Error('The pairing link has no relay address.');
  const d = fromB64u(String(obj.d ?? ''));
  if (d.length !== 65 || d[0] !== 4) throw new Error('The pairing link has a bad desktop key.');
  if (fromB64u(String(obj.c ?? '')).length !== 16) throw new Error('The pairing link has a bad code.');
  if ((await roomOf(d)) !== obj.room) throw new Error('The pairing link does not match its desktop key.');
  return { v: 1, relay: obj.relay, room: obj.room, d: obj.d, c: obj.c };
}

/** k = HKDF(ECDH(E, D_pub), salt = C, info = "fb-pair-v1", 32 bytes). */
export async function pairKeyBytes(ePriv: CryptoKey, dPub: Bytes, c: Bytes): Promise<Bytes> {
  return hkdf(await ecdh(ePriv, dPub), c, 'fb-pair-v1', 32);
}

/** The 6-digit comparison code from a SHA-256 digest: its first 4 bytes, big-endian, modulo 1,000,000. */
export function codeFromDigest(h: Bytes): string {
  if (h.length < 4) throw new Error('digest too short');
  const u32 = ((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0;
  return String(u32 % 1_000_000).padStart(6, '0');
}

/**
 * The comparison code both screens show at pairing (PROTOCOL.md, "The comparison code"; security review P1):
 * h = SHA-256("fb-pair-sas-v1" || D_pub || P_pub || E_pub || C), keys as raw 65-byte points, C its 16 bytes.
 * Someone else's phone pairing with the same QR code has another P and E, so its code differs.
 */
export async function pairCode(dPub: Bytes, pPub: Bytes, ePub: Bytes, c: Bytes): Promise<string> {
  if (dPub.length !== 65 || pPub.length !== 65 || ePub.length !== 65 || c.length !== 16) {
    throw new Error('bad input for the comparison code');
  }
  return codeFromDigest(await sha256(concat(utf8('fb-pair-sas-v1'), dPub, pPub, ePub, c)));
}

/** "042917" as both screens show it: "042 917". */
export function showPairCode(code: string): string {
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}

export interface PairFrame {
  t: 'pair';
  e: string;
  ct: string;
  n: string;
}

/** Build the encrypted pair request. `e` is the pairing ephemeral key pair; `nonce` is for tests. */
export async function buildPairFrame(opts: {
  e: CryptoKeyPair;
  dPub: Bytes;
  c: Bytes;
  pPub: Bytes;
  name: string;
  nonce?: Bytes;
}): Promise<PairFrame> {
  const k = await aesKey(await pairKeyBytes(opts.e.privateKey, opts.dPub, opts.c));
  const nonce = opts.nonce ?? randomBytes(12);
  const pt = utf8(JSON.stringify({ p: b64u(opts.pPub), name: opts.name }));
  const ct = await aesSeal(k, nonce, pt);
  return { t: 'pair', e: b64u(await exportPub(opts.e.publicKey)), ct: b64u(ct), n: b64u(nonce) };
}

// ---------- session (Noise-KK-like) ----------

export interface SessionSecret {
  th: Bytes;
  kPd: Bytes; // phone -> desktop
  kDp: Bytes; // desktop -> phone
}

/**
 * ikm = ECDH(eP,eD) || ECDH(eP,D) || ECDH(P,eD)
 * th  = SHA-256("fb-kk-v1" || P_pub || D_pub || eP_pub || eD_pub)
 * k_pd || k_dp = HKDF(ikm, salt = th, info = "fb-session-v1", 64)
 */
export async function phoneSessionSecret(o: {
  pPriv: CryptoKey;
  pPub: Bytes;
  ePriv: CryptoKey;
  ePub: Bytes;
  dPub: Bytes;
  eDPub: Bytes;
}): Promise<SessionSecret> {
  const eD = await importPub(o.eDPub);
  const ikm = concat(await ecdh(o.ePriv, eD), await ecdh(o.ePriv, o.dPub), await ecdh(o.pPriv, eD));
  const th = await sha256(concat(utf8('fb-kk-v1'), o.pPub, o.dPub, o.ePub, o.eDPub));
  const okm = await hkdf(ikm, th, 'fb-session-v1', 64);
  return { th, kPd: okm.slice(0, 32), kDp: okm.slice(32, 64) };
}

/**
 * An established session. Seal/open are serialised so counters are used strictly in call order;
 * callers must send sealed frames in the order the promises were created (they resolve in order).
 * Any decrypt failure poisons the session: the caller must close the connection.
 */
export class Session {
  private sendN = 0;
  private recvN = 0;
  private sendQ: Promise<unknown> = Promise.resolve();
  private recvQ: Promise<unknown> = Promise.resolve();
  broken = false;

  private constructor(
    private readonly kSend: CryptoKey,
    private readonly kRecv: CryptoKey,
  ) {}

  static async phone(secret: SessionSecret): Promise<Session> {
    return new Session(await aesKey(secret.kPd), await aesKey(secret.kDp));
  }

  /** For tests and mocks only: the desktop's view of the same session. */
  static async desktop(secret: SessionSecret): Promise<Session> {
    return new Session(await aesKey(secret.kDp), await aesKey(secret.kPd));
  }

  seal(obj: unknown): Promise<string> {
    const n = this.sendN++;
    const p = this.sendQ.then(async () => b64u(await aesSeal(this.kSend, counterNonce(n), utf8(JSON.stringify(obj)))));
    this.sendQ = p.catch(() => {});
    return p;
  }

  open(ct: string): Promise<any> {
    const n = this.recvN++;
    const p = this.recvQ.then(async () => {
      if (this.broken) throw new Error('session closed');
      try {
        return JSON.parse(td.decode(await aesOpen(this.kRecv, counterNonce(n), fromB64u(ct))));
      } catch (e) {
        this.broken = true;
        throw new Error('decrypt failed');
      }
    });
    this.recvQ = p.catch(() => {});
    return p;
  }
}
