// The link over Nostr (desktop v0.6.0): pairing links v2, and padding.
import { describe, expect, it } from 'vitest';
import { b64u, exportPub, genKeyPair, padJson, parsePairLink } from './crypto';
import { usableRelays, followRelays } from './carrier';
import type { Pairing } from './store';

const te = new TextEncoder();

async function v2(over: Record<string, unknown> = {}): Promise<string> {
  const d = await exportPub((await genKeyPair(false)).publicKey);
  const link = {
    v: 2,
    r: ['wss://relay.damus.io', 'wss://nos.lol'],
    n: 'ab'.repeat(32),
    d: b64u(d),
    c: b64u(new Uint8Array(16).fill(7)),
    x: Math.floor(Date.now() / 1000) + 300,
    ...over,
  };
  return b64u(te.encode(JSON.stringify(link)));
}

describe('pairing link v2', () => {
  it('reads relays, the desktop Nostr key and the expiry', async () => {
    const l = await parsePairLink(await v2());
    expect(l.v).toBe(2);
    expect(l.r).toEqual(['wss://relay.damus.io', 'wss://nos.lol']);
    expect(l.n).toBe('ab'.repeat(32));
    expect(l.relay).toBeUndefined();
  });

  it('refuses bad relays, keys and times', async () => {
    const now = Math.floor(Date.now() / 1000);
    await expect(parsePairLink(await v2({ r: [] }))).rejects.toThrow(/no usable relays/);
    await expect(parsePairLink(await v2({ r: ['ws://relay.damus.io'] }))).rejects.toThrow(/no usable relays/);
    await expect(parsePairLink(await v2({ r: ['https://x'] }))).rejects.toThrow(/no usable relays/);
    await expect(parsePairLink(await v2({ r: Array(6).fill('wss://a.b') }))).rejects.toThrow(/no usable relays/);
    await expect(parsePairLink(await v2({ n: 'AB'.repeat(32) }))).rejects.toThrow(/desktop key/);
    await expect(parsePairLink(await v2({ x: now - 600 }))).rejects.toThrow(/run out/);
    await expect(parsePairLink(await v2({ x: now + 3600 }))).rejects.toThrow(/damaged/);
  });

  it('allows two minutes of clock difference either way (review L4)', async () => {
    const now = Math.floor(Date.now() / 1000);
    await expect(parsePairLink(await v2({ x: now - 60 }))).resolves.toBeTruthy();
    await expect(parsePairLink(await v2({ x: now + 600 + 60 }))).resolves.toBeTruthy();
  });

  it('takes ws:// only on this computer, for tests', async () => {
    expect(usableRelays(['ws://127.0.0.1:7447'])).toEqual(['ws://127.0.0.1:7447']);
    expect(usableRelays(['ws://example.com'])).toBeNull();
  });
});

describe('following the desktop relays', () => {
  it('a v2 pairing takes a new list from status, a v1 pairing never', () => {
    const p = { v: 2, relays: ['wss://a.example'], n: 'ab'.repeat(32), nsec: new Uint8Array(32) } as unknown as Pairing;
    expect(followRelays(p, ['wss://a.example'])).toBeNull();
    expect(followRelays(p, ['wss://b.example'])?.relays).toEqual(['wss://b.example']);
    expect(followRelays(p, ['https://c.example'])).toBeNull();
    const old = { v: 1, relay: 'wss://app.ecxfreebank.com/ws', room: 'r' } as unknown as Pairing;
    expect(followRelays(old, ['wss://b.example'])).toBeNull();
  });
});

describe('padding', () => {
  it('pads to 1, 4 or 16 KiB, and nothing longer (review L3)', () => {
    const len = (s: string) => te.encode(s).length;
    expect(len(padJson('{}'))).toBe(1024);
    expect(len(padJson('"' + 'a'.repeat(2000) + '"'))).toBe(4096);
    expect(len(padJson('"' + 'a'.repeat(9000) + '"'))).toBe(16_384);
    expect(len(padJson('"' + 'a'.repeat(20_000) + '"'))).toBe(20_002);
    expect(JSON.parse(padJson('{"a":1}'))).toEqual({ a: 1 });
  });
});
