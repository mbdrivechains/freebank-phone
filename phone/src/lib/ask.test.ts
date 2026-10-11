import { describe, expect, it } from 'vitest';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { ASK_URL, askHelper, check } from './ask';

describe('Ask FreeBank on the phone', () => {
  it('never sends recovery words, however they are wrapped', () => {
    const words = generateMnemonic(wordlist, 256);
    const twelve = generateMnemonic(wordlist, 128);
    const chatter =
      'I wrote these down on a card yesterday and I am not sure they are right so could you please tell me ' +
      'whether this looks like a proper backup for my wallet when I get home tonight';
    for (const q of [words, twelve, `are these right? ${words}`, `${chatter} ${words}`, words.toUpperCase(),
      words.split(' ').map((w) => w.slice(0, 4)).join(' ')]) {
      expect(() => check(q)).toThrow(/recovery words/);
    }
    expect(check(chatter)).toBe(chatter);
    expect(check('  How do I borrow from a house, and when do I repay?  ')).toBe('How do I borrow from a house, and when do I repay?');
    expect(() => check('')).toThrow();
    expect(() => check('x'.repeat(501))).toThrow();
    expect(check('é'.repeat(500))).toHaveLength(500);
  });

  it("asks only FreeBank's helper, as plain text, and shows its answer or its error", async () => {
    const calls: [string, RequestInit][] = [];
    const reply = (body: string) => (async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return new Response(body);
    }) as unknown as typeof fetch;
    expect(await askHelper(' How do I borrow? ', reply('{"answer":"Tap Borrow."}'))).toBe('Tap Borrow.');
    expect(calls[0][0]).toBe(ASK_URL);
    expect(ASK_URL).toBe('https://ask.ecxfreebank.com/ask');
    expect(calls[0][1].body).toBe('{"q":"How do I borrow?"}');
    expect(calls[0][1].headers).toBeUndefined(); // text/plain: no preflight, so the helper's site needs no OPTIONS
    expect(calls[0][1].credentials).toBe('omit');
    await expect(askHelper('q', reply('{"error":"Too many questions this hour."}'))).rejects.toThrow('Too many questions this hour.');
    await expect(askHelper('q', reply('<html>'))).rejects.toThrow(/couldn't read/);
    const down = (async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch;
    await expect(askHelper('q', down)).rejects.toThrow(/isn't answering/);
    const n = calls.length;
    await expect(askHelper(generateMnemonic(wordlist, 128), reply('{}'))).rejects.toThrow(/recovery words/);
    expect(calls.length).toBe(n); // nothing sent
  });
});
