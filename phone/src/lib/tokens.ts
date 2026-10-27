// The token wallet: Cashu tokens backed by a FreeBank house's notes, kept on this phone only
// (gateway/docs/distribution/MINT_DESIGN.md §5). cashu-ts does the Cashu side; this file keeps the wallet's state and
// holds its rules:
// - Twelve words make the seed (NUT-13). Every token's secret derives from it, so the words restore the tokens. They
//   are shown once, at set-up; only the seed is kept.
// - Tokens received are swapped at once, so the sender (who knows their secrets) can no longer spend or claim them.
// - Every token must carry the mint's DLEQ proof, with its r: that is what a claim on a failed house needs. A mint that
//   doesn't offer DLEQ proofs (NUT-12) isn't used, and every new token is checked.
// - The wallet never asks the mint about tokens it still holds (NUT-07), so a dishonest mint can't single them out.
//   Only a restore from the words, or "Find missing tokens", asks.
// - One mint, set when the page is built. A token from another mint is refused.
// - One operation at a time, across tabs too. Before each request to the mint, the operation is kept: its inputs and
//   the counters its outputs use. If the answer is lost (a dropped connection, a closed tab), the wallet asks the mint
//   for those outputs alone (NUT-09) and settles the operation from what it signed, before anything else.
import {
  Wallet,
  getEncodedToken,
  getDecodedToken,
  serializeProofs,
  deserializeProofs,
  createRandomSecretKey,
  getPubKeyFromPrivKey,
  hasValidDleq,
  HttpResponseError,
  MintOperationError,
  type CounterRange,
  type CounterSource,
  type MeltQuoteBaseResponse,
  type MintQuoteBaseResponse,
  type Proof,
} from '@cashu/cashu-ts';
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';

export const METHOD = 'freebank';
const UNIT = 'sat';
/** A restore asks this many outputs a request: the mint takes at most 64 a request. */
const BATCH = 64;
/** A restore stops after this many unused counters in a row (ten empty batches). */
const GAP = 640;

/** Where the wallet keeps its state: IndexedDB on the phone, memory in tests. */
export interface Keep {
  get<T>(key: string): Promise<T | undefined>;
  /** Several keys at once: all are written, or none. */
  put(entries: Record<string, unknown>): Promise<void>;
}

/** A token this phone sent, as a link: the receiver swaps it; until then the sender can take it back. */
export interface SentToken {
  token: string;
  amount: number;
  at: number;
  state: 'out' | 'back' | 'claimed';
}

/** Notes in: a mint quote waiting for the notes paid to its address. `key` signs the mint request (NUT-20). */
export interface GetQuote {
  id: string;
  amount: number;
  address: string;
  request: string;
  key: string;
  at: number;
}

/** Tokens out to notes, sent to the mint and not yet known paid. */
interface Melting {
  quote: string;
  amount: number;
  address: string;
  proofs: string[];
  /** The quote's expiry (seconds): an unpaid quote can't be paid after it, so its tokens can come back. */
  expiry: number;
  at: number;
}

/** A request to the mint in progress: what it spends, and the counters of the outputs it asks for. */
interface Op {
  kind: 'swap' | 'mint';
  inputs: string[];
  ranges: { keysetId: string; start: number; count: number }[];
  at: number;
}

type MintQuote = MintQuoteBaseResponse & { amount?: unknown; address?: string };
type MeltQuote = MeltQuoteBaseResponse & { fee_reserve?: unknown };

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const trimUrl = (u: string) => u.trim().replace(/\/+$/, '');
/** An amount as cashu-ts hands it back (its Amount, or a plain number from a custom method's fields). */
const num = (x: unknown): number =>
  x == null ? 0 : typeof x === 'object' && 'toNumber' in x ? (x as { toNumber(): number }).toNumber() : Number(x);
const sum = (ps: Proof[]) => ps.reduce((a, p) => a + num(p.amount), 0);
const secrets = (ps: Proof[]) => new Set(ps.map((p) => p.secret));

/** The mint answered and refused: nothing was spent or signed. (A lost answer, or one cashu-ts rejects, isn't.) */
function refused(e: unknown): boolean {
  return e instanceof MintOperationError || (e instanceof HttpResponseError && e.status >= 400 && e.status < 500);
}

export function normalizeWords(words: string): string {
  return words.trim().toLowerCase().split(/\s+/).join(' ');
}

export function newWords(): string {
  return generateMnemonic(wordlist, 128);
}

export function wordsOk(words: string): boolean {
  return validateMnemonic(normalizeWords(words), wordlist);
}

/** The token in a pasted or scanned text: a link `…#token=cashuB…`, `cashu:cashuB…`, or the bare token. */
export function tokenFrom(text: string): string | null {
  const t = text.trim();
  const m = /(?:#token=|cashu:)?(cashu[AB][A-Za-z0-9_\-+/=]+)$/.exec(t);
  return m ? m[1] : null;
}

/** What a token carries, read without asking the mint (before there is a wallet, too); null when it isn't one. The
 *  mint's keyset ids are v1 (full length), so no keyset list is needed to read it. */
export function peekToken(text: string): { amount: number; mint: string } | null {
  const token = tokenFrom(text);
  if (!token) return null;
  try {
    const t = getDecodedToken(token, []);
    return { amount: sum(t.proofs), mint: t.mint };
  } catch {
    return null;
  }
}

/** The link that opens this page on a token. */
export function tokenLink(token: string, origin = location.origin + location.pathname): string {
  return `${origin}#token=${token}`;
}

/** A FreeBank address, as the desktop shows it: a plain (P2PKH) one, X…, the only kind notes go to. A wallet's
 *  default address on easynet (s…) isn't one. */
export function addressOk(a: string): boolean {
  return /^X[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(a.trim());
}

/** What the mint said, in words for the screen. */
export function why(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (/already spent/i.test(m)) return 'Those tokens were already spent.';
  if (/isn't issuing|not issuing/i.test(m)) return "The house isn't issuing tokens just now. Try again later.";
  if (/Failed to fetch|NetworkError|Load failed|network/i.test(m)) return "Couldn't reach the mint. Check your connection.";
  if (/not enough|insufficient|Not enough funds/i.test(m)) return "There aren't enough tokens on this phone.";
  // The mint's own words, marked as such: never take instructions from them (this page never asks for the words).
  if (e instanceof HttpResponseError) return `The mint said: ${m}`;
  return m;
}

class KeptCounters implements CounterSource {
  /** The operation whose outputs the next reservations are for: kept with the counters, in one write. */
  op: Op | null = null;
  constructor(private keep: Keep) {}
  private async all() {
    return (await this.keep.get<Record<string, number>>('counters')) ?? {};
  }
  async reserve(keysetId: string, n: number): Promise<CounterRange> {
    const c = await this.all();
    const start = c[keysetId] ?? 0;
    c[keysetId] = start + n;
    if (this.op) {
      this.op.ranges.push({ keysetId, start, count: n });
      await this.keep.put({ counters: c, op: this.op });
    } else await this.keep.put({ counters: c });
    return { start, count: n };
  }
  async advanceToAtLeast(keysetId: string, minNext: number): Promise<void> {
    const c = await this.all();
    if ((c[keysetId] ?? 0) < minNext) {
      c[keysetId] = minNext;
      await this.keep.put({ counters: c });
    }
  }
  async setNext(keysetId: string, next: number): Promise<void> {
    const c = await this.all();
    c[keysetId] = next;
    await this.keep.put({ counters: c });
  }
  async snapshot(): Promise<Record<string, number>> {
    return this.all();
  }
}

let chain: Promise<unknown> = Promise.resolve();
/** One operation at a time: across tabs with Web Locks where the browser has them, in this page otherwise. */
function serial<T>(f: () => Promise<T>): Promise<T> {
  const locks = (globalThis.navigator as Navigator | undefined)?.locks;
  if (locks) return locks.request('freebank-tokens', f) as Promise<T>;
  const run = chain.then(f, f);
  chain = run.catch(() => undefined);
  return run;
}

/** Every token the seed made, unspent, across the mint's keysets in our unit: asks the mint (NUT-09, NUT-07). */
async function findAll(w: Wallet): Promise<{ unspent: Proof[]; next: Record<string, number> }> {
  const found: Proof[] = [];
  const next: Record<string, number> = {};
  for (const ks of w.keyChain.getKeysets()) {
    if (ks.unit !== UNIT) continue;
    const r = await w.batchRestore(GAP, BATCH, 0, ks.id);
    found.push(...r.proofs);
    if (r.lastCounterWithSignature !== undefined) next[ks.id] = r.lastCounterWithSignature + 1;
  }
  const states = found.length ? await w.groupProofsByState(found) : { unspent: [] as Proof[] };
  return { unspent: states.unspent, next };
}

export class TokenWallet {
  private constructor(
    readonly mintUrl: string,
    private keep: Keep,
    private wallet: Wallet,
    private counters: KeptCounters,
  ) {}

  private static async load(mintUrl: string, keep: Keep, seed: Uint8Array): Promise<TokenWallet> {
    const counters = new KeptCounters(keep);
    const wallet = new Wallet(trimUrl(mintUrl), {
      unit: UNIT,
      bip39seed: seed,
      counterSource: counters,
      requireSigDleq: true,
    });
    await wallet.loadMint();
    // cashu-ts requires a DLEQ on the mint's signatures only when the mint says it gives them.
    if (!wallet.getMintInfo().isSupported(12).supported) throw new Error("This mint doesn't prove its signatures (NUT-12).");
    return new TokenWallet(trimUrl(mintUrl), keep, wallet, counters);
  }

  /** The wallet on this phone, or null before set-up. An operation left unsettled is settled first, if the mint can
   *  be reached. */
  static async open(mintUrl: string, keep: Keep): Promise<TokenWallet | null> {
    const seed = await keep.get<Uint8Array>('seed');
    if (!seed) return null;
    const w = await TokenWallet.load(mintUrl, keep, seed);
    await serial(() => w.recover()).catch(() => undefined);
    return w;
  }

  /** A new wallet from words just written down. */
  static async create(mintUrl: string, keep: Keep, words: string): Promise<TokenWallet> {
    if (!wordsOk(words)) throw new Error('Those words are not a valid set of twelve.');
    if (await keep.get('seed')) throw new Error('This phone already has a token wallet.');
    const seed = mnemonicToSeedSync(normalizeWords(words));
    const w = await TokenWallet.load(mintUrl, keep, seed);
    await keep.put({ seed, counters: {}, proofs: [], sent: [], quotes: [], melting: [], op: null });
    return w;
  }

  /** The wallet back from its words: every token the mint signed for them that isn't spent. Asks the mint (NUT-09,
   *  NUT-07) about all of them, once. */
  static async restore(mintUrl: string, keep: Keep, words: string): Promise<TokenWallet> {
    if (!wordsOk(words)) throw new Error('Those words are not a valid set of twelve.');
    if (await keep.get('seed')) throw new Error('This phone already has a token wallet.');
    const seed = mnemonicToSeedSync(normalizeWords(words));
    const probe = new Wallet(trimUrl(mintUrl), { unit: UNIT, bip39seed: seed });
    await probe.loadMint();
    const { unspent, next } = await findAll(probe);
    const w = await TokenWallet.load(mintUrl, keep, seed);
    await keep.put({ seed, counters: next, proofs: serializeProofs(unspent), sent: [], quotes: [], melting: [], op: null });
    w.checkDleq(unspent);
    return w;
  }

  /** "Find missing tokens": every unspent token the words made, asked of the mint (NUT-09, NUT-07) as a restore does,
   *  in place of the tokens held. Tokens set aside for a payment out stay set aside. Returns the balance after. */
  repair(): Promise<number> {
    return serial(async () => {
      await this.recover();
      const { unspent, next } = await findAll(this.wallet);
      const aside = new Set(((await this.keep.get<Melting[]>('melting')) ?? []).flatMap((m) => deserializeProofs(m.proofs).map((p) => p.secret)));
      const kept = unspent.filter((p) => !aside.has(p.secret));
      const counters = { ...(await this.counters.snapshot()) };
      for (const [k, n] of Object.entries(next)) counters[k] = Math.max(counters[k] ?? 0, n);
      await this.keep.put({ proofs: serializeProofs(kept), counters });
      this.checkDleq(kept);
      return sum(kept);
    });
  }

  /** Throws when a token lacks the mint's DLEQ proof with its r (it is kept: it is still money, but a claim on a failed
   *  house can't use it). */
  private checkDleq(ps: Proof[]) {
    const bad = ps.filter((p) => {
      try {
        return !p.dleq?.r || !hasValidDleq(p, this.wallet.keyChain.getKeyset(p.id), { require: true });
      } catch {
        return true;
      }
    });
    if (bad.length) {
      throw new Error(`The mint didn't prove its signature on ${bad.length} token(s). They're kept, but couldn't be claimed if the house failed.`);
    }
  }

  /** Runs one request to the mint as an operation that can be settled later if its answer is lost. `inputs` are held
   *  tokens it spends; `save` returns what to write once it succeeds (new tokens are checked for their DLEQ). */
  private async guarded<T>(kind: Op['kind'], inputs: Proof[], run: () => Promise<T>, save: (r: T) => Promise<{ entries: Record<string, unknown>; fresh: Proof[] }>): Promise<T> {
    if (await this.keep.get<Op>('op')) {
      await this.recover();
      if (await this.keep.get<Op>('op')) throw new Error("A step before this one isn't settled yet. Check your connection and try again.");
    }
    const op: Op = { kind, inputs: serializeProofs(inputs), ranges: [], at: Date.now() };
    await this.keep.put({ op });
    this.counters.op = op;
    let r: T;
    try {
      r = await run();
    } catch (e) {
      this.counters.op = null;
      if (refused(e)) {
        // Nothing was signed: the counters can be used again.
        const c = await this.counters.snapshot();
        for (const g of op.ranges) if (c[g.keysetId] === g.start + g.count) c[g.keysetId] = g.start;
        await this.keep.put({ op: null, counters: c });
      } else await this.recover().catch(() => undefined);
      throw e;
    }
    this.counters.op = null;
    const { entries, fresh } = await save(r);
    await this.keep.put({ ...entries, op: null });
    this.checkDleq(fresh);
    return r;
  }

  /** Settles an operation whose answer was lost: asks the mint (NUT-09) for the outputs at its counters alone. Signed:
   *  it happened, so its inputs go and its outputs come in. Nothing signed, a minute on: it didn't, and its inputs stay. */
  private async recover(): Promise<void> {
    const op = await this.keep.get<Op>('op');
    if (!op) return;
    const found: Proof[] = [];
    for (const g of op.ranges) found.push(...(await this.wallet.restore(g.start, g.count, { keysetId: g.keysetId })).proofs);
    if (!found.length) {
      if (Date.now() - op.at > 60_000 || !op.ranges.length) await this.keep.put({ op: null });
      return;
    }
    const gone = secrets(deserializeProofs(op.inputs));
    const held = (await this.proofs()).filter((p) => !gone.has(p.secret));
    const have = secrets(held);
    const all = [...held, ...found.filter((p) => !have.has(p.secret))];
    await this.keep.put({ proofs: serializeProofs(all), op: null });
    this.checkDleq(found);
  }

  private async proofs(): Promise<Proof[]> {
    return deserializeProofs((await this.keep.get<string[]>('proofs')) ?? []);
  }

  async balance(): Promise<number> {
    return sum(await this.proofs());
  }

  async sent(): Promise<SentToken[]> {
    return (await this.keep.get<SentToken[]>('sent')) ?? [];
  }

  async quotes(): Promise<GetQuote[]> {
    return (await this.keep.get<GetQuote[]>('quotes')) ?? [];
  }

  /** The mint's smallest payment out as notes (each costs the house an sECX fee), in units. */
  minRedeem(): number {
    const m = this.wallet.getMintInfo().isSupported(5).params.find((p) => p.method === METHOD && p.unit === UNIT);
    return num(m?.min_amount) || 1;
  }

  /** Units on their way out as notes, not yet known paid. */
  async melting(): Promise<number> {
    return ((await this.keep.get<Melting[]>('melting')) ?? []).reduce((a, m) => a + m.amount, 0);
  }

  /** Takes in a token (swapped at once). A token this phone sent comes back as taken back (`back`). */
  receive(text: string): Promise<{ amount: number; back: boolean }> {
    return serial(async () => {
      const token = tokenFrom(text);
      if (!token) throw new Error("That isn't a token.");
      const t = this.wallet.decodeToken(token);
      if (trimUrl(t.mint) !== this.mintUrl) throw new Error(`That token is from another mint (${t.mint}).`);
      if ((t.unit ?? UNIT) !== UNIT) throw new Error('That token is in another unit.');
      const mine = (await this.sent()).some((s) => s.token === token && s.state === 'out');
      try {
        const got = await this.guarded('swap', [], () => this.wallet.receive(t, { requireDleq: true }), async (got) => {
          const sent = (await this.sent()).map((s) => (s.token === token && s.state === 'out' ? { ...s, state: 'back' as const } : s));
          return { entries: { proofs: serializeProofs([...(await this.proofs()), ...got]), sent }, fresh: got };
        });
        return { amount: sum(got), back: mine };
      } catch (e) {
        if (refused(e) && /already spent/i.test(String(e))) await this.markSent(token, 'claimed');
        throw e;
      }
    });
  }

  private async markSent(token: string, state: SentToken['state']) {
    const sent = (await this.sent()).map((s) => (s.token === token && s.state === 'out' ? { ...s, state } : s));
    await this.keep.put({ sent });
  }

  /** Swaps held tokens to exactly `amount`, saving the rest with what `also` returns for the tokens to spend, in one
   *  write. The chosen inputs are kept with the operation, so a lost answer settles. */
  private async exact(amount: number, also: (send: Proof[]) => Promise<Record<string, unknown>>): Promise<Proof[]> {
    const proofs = await this.proofs();
    if (amount <= 0 || amount > sum(proofs)) throw new Error("There aren't enough tokens on this phone.");
    const pick = this.wallet.selectProofsToSend(proofs, amount, true);
    const r = await this.guarded('swap', pick.send, () => this.wallet.send(amount, pick.send, { includeFees: true }), async (x) => ({
      entries: { proofs: serializeProofs([...pick.keep, ...x.keep]), ...(await also(x.send)) },
      fresh: [...x.keep, ...x.send],
    }));
    return r.send;
  }

  /** A token for `amount`, to send as a link or QR. The tokens in it leave this wallet now. */
  send(amount: number): Promise<string> {
    return serial(async () => {
      let token = '';
      await this.exact(amount, async (send) => {
        token = getEncodedToken({ mint: this.mintUrl, proofs: send, unit: UNIT });
        return { sent: [{ token, amount: sum(send), at: Date.now(), state: 'out' as const }, ...(await this.sent())] };
      });
      return token;
    });
  }

  /** Notes in: a quote whose address takes `amount` notes; tokens follow once they are confirmed. The quote lives
   *  only on this phone until then. */
  getQuote(amount: number): Promise<GetQuote> {
    return serial(async () => {
      const key = createRandomSecretKey();
      const q = await this.wallet.createMintQuote<MintQuote>(METHOD, {
        amount,
        unit: UNIT,
        pubkey: hex(getPubKeyFromPrivKey(key)),
      });
      const address = q.address ?? q.request.replace(/^freebank:/, '').split('?')[0];
      const g: GetQuote = { id: q.quote, amount, address, request: q.request, key: hex(key), at: Date.now() };
      await this.keep.put({ quotes: [g, ...(await this.quotes())] });
      return g;
    });
  }

  /** Mints the quote's tokens if its notes have arrived. Returns the amount minted (0: not yet). The quote is kept
   *  until all its amount is minted. */
  collect(id: string): Promise<number> {
    return serial(async () => {
      const g = (await this.quotes()).find((q) => q.id === id);
      if (!g) return 0;
      const q = await this.wallet.checkMintQuote<MintQuote>(METHOD, g.id);
      const ready = num(q.amount_paid) - num(q.amount_issued);
      if (ready <= 0) {
        // All minted already (its answer was lost, and the operation settled since): the quote is done.
        if (num(q.amount_issued) >= g.amount) await this.keep.put({ quotes: (await this.quotes()).filter((x) => x.id !== id) });
        return 0;
      }
      const got = await this.guarded('mint', [], () => this.wallet.mintProofs(METHOD, ready, q, { privkey: g.key }), async (got) => {
        const quotes = (await this.quotes()).filter((x) => x.id !== id || num(q.amount_issued) + ready < g.amount);
        return { entries: { proofs: serializeProofs([...(await this.proofs()), ...got]), quotes }, fresh: got };
      });
      return sum(got);
    });
  }

  async dropQuote(id: string): Promise<void> {
    await serial(async () => this.keep.put({ quotes: (await this.quotes()).filter((q) => q.id !== id) }));
  }

  /** Tokens back to notes: `units` paid as notes to the FreeBank `address`. Returns 'paid', or 'pending' when the
   *  outcome isn't known yet (the tokens stay set aside until it is). */
  redeem(address: string, units: number): Promise<'paid' | 'pending'> {
    return serial(async () => {
      if (!addressOk(address)) throw new Error("That isn't a FreeBank address for notes: one starts with X (the desktop app's Receive gives one).");
      if (units < this.minRedeem()) throw new Error(`The house pays out at least ${(this.minRedeem() / 1e8).toFixed(8).replace(/\.?0+$/, '')} sECX at a time.`);
      const request = `freebank:${address.trim()}?units=${units}`;
      const q = await this.wallet.createMeltQuote<MeltQuote>(METHOD, { method: METHOD, request, unit: UNIT });
      // The quote must be for what was asked, with no fee: this wallet sends exact tokens and takes no change.
      if (num(q.amount) !== units || num(q.fee_reserve) !== 0 || (q as { request?: string }).request !== request) {
        throw new Error("The mint's quote doesn't match the payment asked for.");
      }
      let m!: Melting;
      const send = await this.exact(units, async (send) => {
        m = { quote: q.quote, amount: units, address, proofs: serializeProofs(send), expiry: q.expiry, at: Date.now() };
        return { melting: [...((await this.keep.get<Melting[]>('melting')) ?? []), m] };
      });
      try {
        const r = await this.wallet.meltProofs(METHOD, q, send);
        if (r.quote.state === 'PAID') {
          await this.settle(m.quote, 'paid');
          return 'paid';
        }
      } catch (e) {
        if (refused(e)) {
          await this.settle(m.quote, 'back');
          throw e;
        }
        // A lost answer: what the mint says about the quote decides.
      }
      const s = await this.checkMelt(m);
      if (s === 'back') throw new Error('The mint refused the payment out; your tokens are back.');
      return s;
    });
  }

  /** Payments out still pending: asks the mint about each quote (not about the tokens). */
  settleMelts(): Promise<void> {
    return serial(async () => {
      for (const m of (await this.keep.get<Melting[]>('melting')) ?? []) await this.checkMelt(m);
    });
  }

  /** Paid: the tokens are gone. Unpaid after the quote expired: they come back. Otherwise it's still pending (an
   *  unpaid quote may yet be paid by a request still on its way). */
  private async checkMelt(m: Melting): Promise<'paid' | 'pending' | 'back'> {
    let state: string;
    try {
      state = (await this.wallet.checkMeltQuote<MeltQuote>(METHOD, m.quote)).state;
    } catch {
      return 'pending';
    }
    if (state === 'PAID') {
      await this.settle(m.quote, 'paid');
      return 'paid';
    }
    if (state === 'UNPAID' && Date.now() / 1000 > m.expiry) {
      await this.settle(m.quote, 'back');
      return 'back';
    }
    return 'pending';
  }

  private async settle(quote: string, how: 'paid' | 'back') {
    const all = (await this.keep.get<Melting[]>('melting')) ?? [];
    const m = all.find((x) => x.quote === quote);
    if (!m) return;
    const back = how === 'back' ? deserializeProofs(m.proofs) : [];
    await this.keep.put({ proofs: serializeProofs([...(await this.proofs()), ...back]), melting: all.filter((x) => x.quote !== quote) });
  }
}
