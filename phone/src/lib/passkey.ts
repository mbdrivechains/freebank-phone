// Face ID, Touch ID or a fingerprint: a WebAuthn passkey on this phone (relay/PROTOCOL.md, "Face ID: passkeys").
// The desktop checks each assertion, so this page only makes the credential and asks the phone for assertions.
// Safari lets a page ask only from a tap, so callers fetch the desktop's challenge first and call these from the
// button's handler.
import { b64u, fromB64u, type Bytes } from './crypto';

export interface Assertion {
  ad: string;
  cdj: string;
  sig: string;
}

/** A platform authenticator that verifies the user (Face ID, Touch ID, a fingerprint or the passcode). */
export async function passkeysAvailable(): Promise<boolean> {
  try {
    return !!window.PublicKeyCredential && (await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable());
  } catch {
    return false;
  }
}

/** A minimal CBOR reader for the attestation object: ints, byte and text strings, arrays and maps. */
function cbor(b: Bytes, i = 0): [unknown, number] {
  const major = b[i] >> 5;
  const info = b[i] & 31;
  i++;
  let n: number;
  if (info < 24) n = info;
  else if (info === 24) n = b[i++];
  else if (info === 25) (n = (b[i] << 8) | b[i + 1]), (i += 2);
  else if (info === 26) (n = ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3]), (i += 4);
  else throw new Error('Unexpected CBOR in the passkey.');
  switch (major) {
    case 0:
      return [n, i];
    case 1:
      return [-1 - n, i];
    case 2:
      return [b.slice(i, i + n), i + n];
    case 3:
      return [new TextDecoder().decode(b.slice(i, i + n)), i + n];
    case 4: {
      const out: unknown[] = [];
      for (let k = 0; k < n; k++) {
        const [v, j] = cbor(b, i);
        out.push(v);
        i = j;
      }
      return [out, i];
    }
    case 5: {
      const out = new Map<unknown, unknown>();
      for (let k = 0; k < n; k++) {
        const [key, j] = cbor(b, i);
        const [v, j2] = cbor(b, j);
        out.set(key, v);
        i = j2;
      }
      return [out, i];
    }
    default:
      throw new Error('Unexpected CBOR in the passkey.');
  }
}

/** The new credential's public key (65-byte point) and id, from `navigator.credentials.create`'s attestation object. */
export function readAttestation(obj: Bytes): { pk: Bytes; cred: Bytes } {
  const [att] = cbor(obj);
  const ad = (att as Map<string, unknown>).get('authData') as Bytes | undefined;
  if (!(ad instanceof Uint8Array) || ad.length < 55 || !(ad[32] & 0x40)) throw new Error('The passkey came without its key.');
  const n = (ad[53] << 8) | ad[54];
  const cred = ad.slice(55, 55 + n);
  const [key] = cbor(ad, 55 + n);
  const k = key as Map<number, unknown>;
  const x = k.get(-2), y = k.get(-3);
  if (k.get(1) !== 2 || k.get(3) !== -7 || k.get(-1) !== 1 || !(x instanceof Uint8Array) || !(y instanceof Uint8Array) || x.length !== 32 || y.length !== 32)
    throw new Error('This phone made a kind of passkey FreeBank does not use (it needs ES256 on P-256).');
  const pk = new Uint8Array(65);
  pk[0] = 4;
  pk.set(x, 1);
  pk.set(y, 33);
  return { pk, cred };
}

/**
 * Make this phone's passkey for FreeBank. Needs a tap. `pairing` names the pairing (this phone's key): the passkey's
 * user id comes from it, so making one again replaces the last instead of piling up passkeys.
 */
export async function createPasskey(name: string, pairing: string): Promise<{ pk: string; cred: string }> {
  const user = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('fb-passkey-user-v1:' + pairing))).slice(0, 16);
  const c = (await navigator.credentials.create({
    publicKey: {
      rp: { id: location.hostname, name: 'FreeBank' },
      user: { id: user, name: name || 'FreeBank phone', displayName: name || 'FreeBank phone' },
      // Not checked by anyone: the desktop checks the assertion that follows, over its own challenge.
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' },
      attestation: 'none',
      timeout: 60_000,
    },
  })) as PublicKeyCredential | null;
  if (!c) throw new Error('No passkey was made.');
  const r = c.response as AuthenticatorAttestationResponse;
  const { pk, cred } = readAttestation(new Uint8Array(r.attestationObject));
  return { pk: b64u(pk), cred: b64u(cred) };
}

/** Ask for Face ID over the desktop's challenge. Needs a tap. */
export async function assertPasskey(challenge: string, cred: string): Promise<Assertion> {
  const c = (await navigator.credentials.get({
    publicKey: {
      challenge: fromB64u(challenge),
      rpId: location.hostname,
      allowCredentials: [{ type: 'public-key', id: fromB64u(cred) }],
      userVerification: 'required',
      timeout: 60_000,
    },
  })) as PublicKeyCredential | null;
  if (!c) throw new Error('Face ID was cancelled.');
  const r = c.response as AuthenticatorAssertionResponse;
  return {
    ad: b64u(new Uint8Array(r.authenticatorData)),
    cdj: b64u(new Uint8Array(r.clientDataJSON)),
    sig: b64u(new Uint8Array(r.signature)),
  };
}

/** What to say when the phone's prompt fails. */
export function passkeyError(e: unknown): string {
  const name = (e as { name?: string })?.name;
  if (name === 'NotAllowedError') return 'Face ID was cancelled, or took too long. Tap to try again.';
  if (name === 'InvalidStateError') return 'This phone already has a FreeBank passkey.';
  return (e as Error)?.message || String(e);
}
