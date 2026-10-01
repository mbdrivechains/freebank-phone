import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { b64u, fromB64u } from './crypto';
import { readAttestation } from './passkey';

const V = JSON.parse(readFileSync(resolve(__dirname, '../../../relay/testvectors/webauthn-v1.json'), 'utf8'));

describe('passkey attestation', () => {
  it('gives the key and credential id the vectors name', () => {
    const { pk, cred } = readAttestation(fromB64u(V.attestation.object));
    expect(b64u(pk)).toBe(V.attestation.pk);
    expect(b64u(cred)).toBe(V.attestation.cred);
    expect(b64u(pk)).toBe(V.pk);
  });

  it('refuses an attestation without a key', () => {
    const obj = fromB64u(V.attestation.object);
    // authData follows its key and a one-byte-length byte string header (0x58, n); its flags byte is at 32.
    const key = new TextEncoder().encode('authData');
    const at = obj.findIndex((_, i) => key.every((b, j) => obj[i + j] === b));
    expect(obj[at + key.length]).toBe(0x58);
    const flags = at + key.length + 2 + 32;
    expect(obj[flags]).toBe(0x45);
    const cut = obj.slice();
    cut[flags] = 0x05; // "attested credential data" (0x40) cleared
    expect(() => readAttestation(cut)).toThrow(/without its key/);
  });
});
