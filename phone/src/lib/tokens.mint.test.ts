// The token wallet against a real fb-mint (its dev build over a fake node): run with FB_DEV_MINT=http://127.0.0.1:47339
// and FB_DEV_CONTROL=http://127.0.0.1:47340 (mint/examples/dev-mint.rs). Skipped otherwise.
import { describe, expect, it } from 'vitest';
import { TokenWallet, newWords, tokenLink, tokenFrom, type Keep } from './tokens';

const MINT = process.env.FB_DEV_MINT ?? '';
const CONTROL = process.env.FB_DEV_CONTROL ?? '';

function memoryKeep(): Keep & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: async <T>(k: string) => structuredClone(data.get(k)) as T | undefined,
    put: async (e) => {
      for (const [k, v] of Object.entries(e)) data.set(k, structuredClone(v));
    },
  };
}

async function pay(address: string, units: number) {
  const r = await fetch(`${CONTROL}/pay?address=${address}&units=${units}`, { method: 'POST' });
  expect(r.ok).toBe(true);
}

describe.skipIf(!MINT)('the token wallet against fb-mint', () => {
  it('notes in, send, receive, take back, notes out, restore', async () => {
    const wordsA = newWords();
    const a = await TokenWallet.create(MINT, memoryKeep(), wordsA);

    // Notes in: nothing until they arrive, then the tokens.
    const q = await a.getQuote(1000);
    expect(q.request.startsWith('freebank:')).toBe(true);
    expect(await a.collect(q.id)).toBe(0);
    await pay(q.address, 1000);
    // The mint asks its node about one quote again only after 10 seconds.
    await new Promise((r) => setTimeout(r, 11_000));
    expect(await a.collect(q.id)).toBe(1000);
    expect(await a.balance()).toBe(1000);
    expect(await a.quotes()).toEqual([]);

    // Send 300 as a link; the receiver swaps it at once; the sender can't take it back.
    const token = await a.send(300);
    expect(await a.balance()).toBe(700);
    const link = tokenLink(token, 'https://example.test/');
    expect(tokenFrom(link)).toBe(token);
    const wordsB = newWords();
    const bKeep = memoryKeep();
    const b = await TokenWallet.create(MINT, bKeep, wordsB);
    expect(await b.receive(link)).toEqual({ amount: 300, back: false });
    await expect(a.receive(token)).rejects.toThrow(/spent/i);
    expect((await a.sent())[0].state).toBe('claimed');
    // Every token came with its DLEQ proof.
    const kept = bKeep.data.get('proofs') as string[];
    expect(kept.every((p) => JSON.parse(p).dleq)).toBe(true);

    // A token not claimed comes back.
    const t2 = await a.send(100);
    expect(await a.receive(t2)).toEqual({ amount: 100, back: true });
    expect((await a.sent())[0].state).toBe('back');
    expect(await a.balance()).toBe(700);

    // Tokens to notes: 250 to a FreeBank address.
    const to = 'X' + 'a'.repeat(33);
    expect(await b.redeem(to, 250)).toBe('paid');
    expect(await b.balance()).toBe(50);
    const payouts = await (await fetch(`${CONTROL}/payouts`)).json();
    expect(payouts).toContainEqual([to, 250]);

    // The words bring the tokens back on a new phone, spent ones left out.
    expect(await (await TokenWallet.restore(MINT, memoryKeep(), wordsA)).balance()).toBe(700);
    expect(await (await TokenWallet.restore(MINT, memoryKeep(), wordsB)).balance()).toBe(50);
  }, 60_000);

  it('a lost answer settles from what the mint signed; a refusal reuses the counters; repair', async () => {
    const keep = memoryKeep();
    const a = await TokenWallet.create(MINT, keep, newWords());
    const q = await a.getQuote(1000);
    await pay(q.address, 1000);

    // The mint gets the request and answers, but the answer never arrives.
    const real = globalThis.fetch;
    const lose = (path: string) => {
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const r = await real(input, init);
        if (String(input).includes(path)) throw new TypeError('Failed to fetch');
        return r;
      }) as typeof fetch;
    };
    lose('/v1/mint/freebank');
    await expect(a.collect(q.id)).rejects.toThrow();
    globalThis.fetch = real;
    expect(await a.balance()).toBe(1000);
    expect(keep.data.get('op')).toBeNull();
    expect(await a.collect(q.id)).toBe(0);
    expect(await a.quotes()).toEqual([]);

    lose('/v1/swap');
    await expect(a.send(300)).rejects.toThrow();
    globalThis.fetch = real;
    expect(await a.balance()).toBe(1000);
    expect(await a.sent()).toEqual([]);
    // The tokens held are the mint's outputs now: a send works.
    const token = await a.send(300);
    expect(await a.balance()).toBe(700);

    // A refusal (a spent token) signs nothing, so its counters are used again.
    const b = await TokenWallet.create(MINT, memoryKeep(), newWords());
    await b.receive(token);
    const before = structuredClone(keep.data.get('counters'));
    await expect(a.receive(token)).rejects.toThrow(/spent/i);
    expect(keep.data.get('counters')).toEqual(before);

    // Find missing tokens: the held list lost, the mint's records bring it back.
    keep.data.set('proofs', []);
    expect(await a.balance()).toBe(0);
    expect(await a.repair()).toBe(700);
    expect(await a.balance()).toBe(700);
  }, 60_000);
});

