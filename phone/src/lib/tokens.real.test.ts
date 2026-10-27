// The token wallet against a live fb-mint on a real chain (easynet's, since 2026-10-26): notes in, a link sent and
// taken in, notes out. Skipped unless FB_REAL_MINT is set. FB_PAY is a shell command that pays house notes to an address
// ({address} and {units} in it are filled in), e.g. a house's wallet's `mintnote`; FB_REDEEM_TO is a FreeBank address
// the tokens go back to as notes. Real blocks: notes in waits for the mint's confirmations, so it takes a while.
import { execSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { TokenWallet, newWords, tokenLink, type Keep } from './tokens';

const MINT = process.env.FB_REAL_MINT ?? '';
const PAY = process.env.FB_PAY ?? '';
const REDEEM_TO = process.env.FB_REDEEM_TO ?? '';
// The mint pays out at least 0.01 ECX (its --min-melt), so the amounts are above that.
const IN = 3_000_000;
const SEND = 1_500_000;
const OUT = 1_000_000;

function memoryKeep(): Keep {
  const data = new Map<string, unknown>();
  return {
    get: async <T>(k: string) => structuredClone(data.get(k)) as T | undefined,
    put: async (e) => {
      for (const [k, v] of Object.entries(e)) data.set(k, structuredClone(v));
    },
  };
}

const say = (s: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${s}`);

describe.skipIf(!MINT || !PAY || !REDEEM_TO)('the token wallet against a live mint', () => {
  it('notes in, a link sent and taken in, notes out', async () => {
    const a = await TokenWallet.create(MINT, memoryKeep(), newWords());
    const q = await a.getQuote(IN);
    expect(q.request.startsWith('freebank:')).toBe(true);
    say(`quote ${q.id}: ${q.request}`);
    const paid = execSync(PAY.replace('{address}', q.address).replace('{units}', String(IN)), { encoding: 'utf8' }).trim();
    say(`notes paid: ${paid}`);
    let got = 0;
    for (let i = 0; i < 240 && got === 0; i++) {
      await new Promise((r) => setTimeout(r, 30_000));
      // As the page does: an error while waiting (the mint's node busy with a new block) is tried again.
      got = await a.collect(q.id).catch((e) => (say(`not yet: ${e}`), 0));
    }
    say(`tokens minted: ${got}`);
    expect(got).toBe(IN);

    const b = await TokenWallet.create(MINT, memoryKeep(), newWords());
    const link = tokenLink(await a.send(SEND), 'https://app.ecxfreebank.com/');
    expect(await b.receive(link)).toEqual({ amount: SEND, back: false });
    expect(await a.balance()).toBe(IN - SEND);
    say(`a link of ${SEND} taken in by a second wallet`);

    expect(await b.redeem(REDEEM_TO, OUT)).toBe('paid');
    expect(await b.balance()).toBe(SEND - OUT);
    say(`${OUT} back to notes at ${REDEEM_TO}`);
  }, 2 * 3600_000);
});
