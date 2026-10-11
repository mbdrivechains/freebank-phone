<script lang="ts">
  // The token wallet (lib/tokens.ts): tokens backed by a house's notes, kept on this phone, no desktop needed.
  import { createEventDispatcher, onDestroy, onMount } from 'svelte';
  import Back from './Back.svelte';
  import Copy from './Copy.svelte';
  import Qr from './Qr.svelte';
  import Scanner from './Scanner.svelte';
  import { TokenWallet, addressOk, newWords, normalizeWords, peekToken, tokenFrom, tokenLink, why, type GetQuote, type SentToken } from '../lib/tokens';
  import { tokenKeep } from '../lib/tokenstore';
  import { fmtEcx, parseAmount } from '../lib/format';
  import { encodeQr } from '../lib/qr';
  import type { Scanned } from '../lib/scan';

  /** The mint this page uses, set when it is built. */
  export let mintUrl: string;
  /** A token link the page was opened with. */
  export let incoming: string | null = null;
  const dispatch = createEventDispatcher();

  type View = 'loading' | 'off' | 'unreachable' | 'start' | 'words' | 'confirm' | 'restore' | 'home' | 'receive'
    | 'send' | 'sent' | 'get' | 'redeem';
  let view: View = 'loading';
  let w: TokenWallet | null = null;
  let balance = 0;
  let outgoing = 0;
  let sent: SentToken[] = [];
  let quotes: GetQuote[] = [];
  let busy = false;
  let error = '';
  let notice = '';
  let words = '';
  let ask: [number, number] = [0, 0];
  let answers = ['', ''];
  let restoreWords = '';
  let amountText = '';
  let pasted = '';
  let token = '';
  let address = '';
  let scanning: 'token' | 'address' | null = null;
  let quote: GetQuote | null = null;
  let poll: ReturnType<typeof setInterval> | null = null;

  const ecx = (units: number) => fmtEcx(units / 1e8);
  const toUnits = (text: string) => {
    const n = parseAmount(text);
    return n === null ? null : Math.round(n * 1e8);
  };
  $: link = token ? tokenLink(token) : '';
  $: fitsQr = (() => {
    try {
      return !!link && !!encodeQr(link);
    } catch {
      return false;
    }
  })();
  // What the link says it carries: unchecked until the mint swaps it.
  $: incomingAmount = incoming ? peekToken(incoming) : null;
  $: otherMint = !!incomingAmount && incomingAmount.mint.replace(/\/+$/, '') !== mintUrl.replace(/\/+$/, '');
  let forgetting = '';

  async function refresh() {
    if (!w) return;
    [balance, outgoing, sent, quotes] = await Promise.all([w.balance(), w.melting(), w.sent(), w.quotes()]);
  }

  async function load() {
    view = 'loading';
    error = '';
    if (!mintUrl) {
      view = 'off';
      return;
    }
    try {
      w = await TokenWallet.open(mintUrl, tokenKeep);
    } catch (e) {
      error = why(e);
      view = 'unreachable';
      return;
    }
    if (!w) {
      view = 'start';
      return;
    }
    await refresh();
    view = 'home';
    w.settleMelts().then(refresh, () => undefined);
    for (const q of quotes) {
      w.collect(q.id).then((n) => {
        if (n) done(`${ecx(n)} sECX in tokens arrived.`);
      }, () => undefined);
    }
  }

  // Each step that talks to the mint: one at a time, its error shown on the screen.
  async function act(f: () => Promise<void>) {
    busy = true;
    error = '';
    try {
      await f();
    } catch (e) {
      error = why(e);
    } finally {
      busy = false;
    }
  }

  // The balance first, so the notice never shows beside the old one.
  async function done(msg: string) {
    await refresh();
    notice = msg;
    quote = null;
    view = 'home';
  }

  function begin() {
    words = newWords();
    view = 'words';
  }

  function pickTwo() {
    const r = crypto.getRandomValues(new Uint32Array(2));
    const a = r[0] % 12;
    let b = r[1] % 11;
    if (b >= a) b++;
    ask = a < b ? [a, b] : [b, a];
    answers = ['', ''];
    view = 'confirm';
  }

  const confirm = () =>
    act(async () => {
      const list = words.split(' ');
      if (answers.some((x, i) => normalizeWords(x) !== list[ask[i]])) throw new Error("Those words don't match. Check what you wrote down.");
      w = await TokenWallet.create(mintUrl, tokenKeep, words);
      words = '';
      await afterSetup();
    });

  const restore = () =>
    act(async () => {
      try {
        w = await TokenWallet.restore(mintUrl, tokenKeep, restoreWords);
      } catch (e) {
        // Restored, with a warning (a token without its DLEQ proof): the wallet is there; show it and the warning.
        w = await TokenWallet.open(mintUrl, tokenKeep).catch(() => null);
        if (w) await afterSetup();
        throw e;
      }
      restoreWords = '';
      await afterSetup();
    });

  async function afterSetup() {
    await refresh();
    view = 'home';
    if (incoming) await takeIn(incoming);
  }

  async function takeIn(text: string) {
    if (!w) return;
    const wallet = w;
    await act(async () => {
      const r = await wallet.receive(text);
      incoming = null;
      dispatch('taken');
      pasted = '';
      await done(
        r.back
          ? `Taken back: ${ecx(r.amount)} sECX is on this phone again, and the link no longer works.`
          : `${ecx(r.amount)} sECX in tokens received. They're yours now: the sender can no longer spend them.`,
      );
    });
  }

  const makeToken = () =>
    act(async () => {
      const u = toUnits(amountText);
      if (!w || !u) throw new Error('Enter an amount.');
      token = await w.send(u);
      amountText = '';
      await refresh();
      view = 'sent';
    });

  const takeBack = (s: SentToken) => takeIn(s.token);

  async function share() {
    try {
      await navigator.share({ title: 'FreeBank tokens', url: link });
    } catch {
      // Cancelled, or no share sheet: Copy is beside it.
    }
  }

  const startGet = () =>
    act(async () => {
      const u = toUnits(amountText);
      if (!w || !u) throw new Error('Enter an amount.');
      quote = await w.getQuote(u);
      amountText = '';
      await refresh();
      openGet(quote);
    });

  function openGet(q: GetQuote) {
    quote = q;
    view = 'get';
    stopPoll();
    // The mint asks its node about a quote at most every ten seconds.
    poll = setInterval(() => check(false), 15_000);
  }

  function stopPoll() {
    if (poll) clearInterval(poll);
    poll = null;
  }

  async function check(shown = true) {
    if (!w || !quote || busy) return;
    const wallet = w;
    const q = quote;
    await act(async () => {
      const n = await wallet.collect(q.id);
      if (n > 0) {
        stopPoll();
        await done(`${ecx(n)} sECX in tokens arrived.`);
      } else if (shown) notice = 'Not yet: the notes have to be confirmed first.';
    });
  }

  async function forgetQuote(q: GetQuote) {
    forgetting = '';
    await w?.dropQuote(q.id);
    await refresh();
  }

  const repair = () =>
    act(async () => {
      if (!w) return;
      const n = await w.repair();
      await done(`Every unspent token your words made is here: ${ecx(n)} sECX.`);
    });

  const redeem = () =>
    act(async () => {
      const u = toUnits(amountText);
      if (!w || !u) throw new Error('Enter an amount.');
      const r = await w.redeem(address, u);
      amountText = '';
      address = '';
      await done(
        r === 'paid'
          ? `${ecx(u)} sECX paid out as notes. Your desktop shows them once the payment is confirmed.`
          : `${ecx(u)} sECX is on its way out as notes. If it doesn't arrive, the tokens come back here.`,
      );
    });

  function acceptToken(text: string): Scanned {
    return tokenFrom(text) ? { value: text } : { wrong: "That QR code isn't a token." };
  }
  function acceptAddress(text: string): Scanned {
    const a = text.trim().replace(/^freebank:/, '').split('?')[0];
    return addressOk(a) ? { value: a } : { wrong: "That QR code isn't a FreeBank address." };
  }
  function scanned(e: CustomEvent<string>) {
    if (scanning === 'token') takeIn(e.detail);
    else address = e.detail;
    scanning = null;
  }

  function go(v: View) {
    error = '';
    notice = v === 'home' ? notice : '';
    if (v !== 'get') stopPoll();
    view = v;
  }

  function back() {
    if (view === 'home' || view === 'start' || view === 'off' || view === 'unreachable') dispatch('back');
    else if (view === 'confirm') go('words');
    else if (view === 'words' || view === 'restore') {
      words = '';
      go('start');
    } else go(w ? 'home' : 'start');
  }

  onMount(load);
  onDestroy(stopPoll);
</script>

<Back title="Tokens" on:back={back} />

{#if scanning}
  <Scanner accept={scanning === 'token' ? acceptToken : acceptAddress}
    hint={scanning === 'token' ? 'Point the camera at the token QR code.' : 'Point the camera at the address QR code.'}
    on:value={scanned} on:cancel={() => (scanning = null)} on:failed={(e) => { error = String(e.detail); scanning = null; }} />
{:else}
<section class="stack" data-testid="tokens">
  {#if notice && view === 'home'}<p class="card small" data-testid="tokens-notice">{notice}</p>{/if}

  {#if view === 'loading'}
    <p class="muted"><span class="spinner"></span></p>
  {:else if view === 'off'}
    <p class="card">Tokens aren't open on this page yet.</p>
  {:else if view === 'unreachable'}
    <p class="error">{error}</p>
    <button class="full" on:click={load}>Try again</button>
  {:else if view === 'start'}
    {#if incoming}
      <div class="card stack">
        <h2>You've been sent tokens</h2>
        {#if incomingAmount}<p data-testid="tokens-link-says">This link says it carries {ecx(incomingAmount.amount)} sECX.</p>{/if}
        {#if otherMint}
          <p class="error">It's from another mint ({incomingAmount?.mint}): this wallet can't take it in.</p>
        {:else}
          <p>To keep them, set up a token wallet on this phone first. It takes a minute.</p>
        {/if}
      </div>
    {/if}
    <div class="card stack">
      <p>Tokens are digital cash backed by a FreeBank house's notes, one for one. They stay on this phone: send them as a
        link, and turn them back into notes at any FreeBank address.</p>
      <p class="muted small">Issued by the mint at <span class="mono">{mintUrl}</span>.</p>
    </div>
    <button class="primary full" on:click={begin} data-testid="tokens-new">Set up a token wallet</button>
    <button class="full" on:click={() => go('restore')}>I have my twelve words</button>
  {:else if view === 'words'}
    <div class="card stack">
      <h2>Write down these twelve words</h2>
      <ol class="words" data-testid="tokens-words">
        {#each words.split(' ') as word, i}<li><span class="n">{i + 1}</span> <span class="mono">{word}</span></li>{/each}
      </ol>
      <p class="small">On paper, in order. They are the only way to get your tokens back if this phone is lost or its
        browser data is cleared. Anyone who has them can take your tokens. They won't be shown again.</p>
    </div>
    <button class="primary full" on:click={pickTwo}>I wrote them down</button>
  {:else if view === 'confirm'}
    <form class="card stack" on:submit|preventDefault={confirm}>
      <h2>Check two words</h2>
      {#each ask as n, i}
        <label>Word {n + 1}
          <input bind:value={answers[i]} autocomplete="off" autocapitalize="none" spellcheck="false" data-testid="tokens-word-{i}" />
        </label>
      {/each}
      {#if error}<p class="error">{error}</p>{/if}
      <button class="primary full" type="submit" disabled={busy || answers.some((a) => !a.trim())}>
        {#if busy}<span class="spinner"></span>{/if} Set up the wallet</button>
    </form>
  {:else if view === 'restore'}
    <form class="card stack" on:submit|preventDefault={restore}>
      <h2>Your twelve words</h2>
      <textarea bind:value={restoreWords} rows="4" autocomplete="off" autocapitalize="none" spellcheck="false"
        placeholder="word word word …" data-testid="tokens-restore-words"></textarea>
      <p class="muted small">This phone asks the mint for every token made from these words, then which are still unspent.</p>
      {#if error}<p class="error">{error}</p>{/if}
      <button class="primary full" type="submit" disabled={busy || !restoreWords.trim()}>
        {#if busy}<span class="spinner"></span>{/if} Restore my tokens</button>
    </form>
  {:else if view === 'home'}
    <div class="card center">
      <div class="label">Tokens on this phone</div>
      <div class="big" data-testid="tokens-balance">{ecx(balance)} <span class="unit">sECX</span></div>
      {#if outgoing}<div class="muted small">{ecx(outgoing)} sECX on its way out as notes</div>{/if}
    </div>
    {#if incoming}
      <div class="card stack">
        <p>Take in the tokens from this link{incomingAmount ? ` (it says ${ecx(incomingAmount.amount)} sECX)` : ''}?</p>
        <button class="primary full" disabled={busy} on:click={() => incoming && takeIn(incoming)}>Take them in</button>
      </div>
    {/if}
    {#if error}<p class="error">{error}</p>{/if}
    <div class="actions">
      <button class="primary" on:click={() => go('receive')}>Receive</button>
      <button class="primary" on:click={() => go('send')} disabled={!balance}>Send</button>
    </div>
    <button class="full" on:click={() => { quote = null; go('get'); }} data-testid="tokens-get">Get tokens for notes</button>
    <button class="full" on:click={() => go('redeem')} disabled={!balance} data-testid="tokens-redeem">Turn tokens into notes</button>
    {#each quotes as q (q.id)}
      <div class="card stack small">
        <div>Waiting for {ecx(q.amount)} sECX in notes at <span class="mono">{q.address}</span>.</div>
        {#if forgetting === q.id}
          <p class="small">Notes already paid to this address could then only be recovered by the house. Forget it?</p>
          <div class="row"><button class="danger" on:click={() => forgetQuote(q)}>Forget it</button><button on:click={() => (forgetting = '')}>Keep it</button></div>
        {:else}
          <div class="row"><button on:click={() => openGet(q)}>Show</button><button class="plain" on:click={() => (forgetting = q.id)}>Forget</button></div>
        {/if}
      </div>
    {/each}
    {#each sent.filter((s) => s.state === 'out') as s (s.token)}
      <div class="card stack small">
        <div>Sent {ecx(s.amount)} sECX as a link. Not taken in yet?</div>
        <button disabled={busy} on:click={() => takeBack(s)}>Take it back</button>
      </div>
    {/each}
    <button class="plain small muted" disabled={busy} on:click={repair} data-testid="tokens-repair">Find missing tokens</button>
    <p class="muted small">If a step was cut off, this asks the mint for every token your words made and keeps the unspent
      ones. The mint then sees all your tokens at once.</p>
  {:else if view === 'receive'}
    <form class="card stack" on:submit|preventDefault={() => takeIn(pasted)}>
      <h2>Receive tokens</h2>
      <textarea bind:value={pasted} rows="3" placeholder="Paste a token or a token link" autocomplete="off"
        autocapitalize="none" spellcheck="false" data-testid="tokens-paste"></textarea>
      {#if error}<p class="error">{error}</p>{/if}
      <button class="primary full" type="submit" disabled={busy || !tokenFrom(pasted)}>
        {#if busy}<span class="spinner"></span>{/if} Take them in</button>
      <button class="full" type="button" on:click={() => (scanning = 'token')}>Scan a token QR code</button>
    </form>
  {:else if view === 'send'}
    <form class="card stack" on:submit|preventDefault={makeToken}>
      <h2>Send tokens</h2>
      <label>Amount (sECX)
        <input bind:value={amountText} inputmode="decimal" autocomplete="off" data-testid="tokens-amount" />
      </label>
      <p class="muted small">You have {ecx(balance)} sECX. This makes a link that carries the tokens.</p>
      {#if error}<p class="error">{error}</p>{/if}
      <button class="primary full" type="submit" disabled={busy || !toUnits(amountText)}>
        {#if busy}<span class="spinner"></span>{/if} Make the link</button>
    </form>
  {:else if view === 'sent'}
    <div class="card stack center">
      <h2>Your tokens, as a link</h2>
      {#if fitsQr}<Qr text={link} label="Token QR code" />{/if}
      <p class="small">Whoever opens this link first can take the tokens. Send it only to the person you're paying.</p>
      {#if 'share' in navigator}<button class="primary full" on:click={share}>Share the link</button>{/if}
      <Copy text={link} label="Copy the link" />
      <p class="muted small">Until they take them in, you can take them back on the Tokens screen.</p>
      <textarea readonly rows="3" class="mono small" data-testid="tokens-link">{link}</textarea>
    </div>
    <button class="full" on:click={() => { token = ''; go('home'); }}>Done</button>
  {:else if view === 'get'}
    {#if quote}
      <div class="card stack center">
        <h2>Pay {ecx(quote.amount)} sECX in notes</h2>
        <Qr text={quote.address} label="QR code of the mint's address" />
        <p class="addr mono" data-testid="tokens-get-address">{quote.address}</p>
        <Copy text={quote.address} label="Copy the address" />
        <p class="small">From your desktop, send exactly {ecx(quote.amount)} sECX of the house's notes to this address. It's
          for this payment only. Your tokens arrive here once the payment is confirmed.</p>
        <p class="muted small">This request lives only on this phone until the tokens arrive: keep this page's data until
          then. Your twelve words can't bring it back.</p>
        {#if notice}<p class="muted small">{notice}</p>{/if}
        {#if error}<p class="error">{error}</p>{/if}
        <button class="full" disabled={busy} on:click={() => check(true)}>{#if busy}<span class="spinner"></span>{/if} Check now</button>
      </div>
    {:else}
      <form class="card stack" on:submit|preventDefault={startGet}>
        <h2>Get tokens for notes</h2>
        <label>Amount (sECX)
          <input bind:value={amountText} inputmode="decimal" autocomplete="off" data-testid="tokens-amount" />
        </label>
        <p class="muted small">You'll get an address to pay the notes to from your desktop.</p>
        {#if error}<p class="error">{error}</p>{/if}
        <button class="primary full" type="submit" disabled={busy || !toUnits(amountText)}>
          {#if busy}<span class="spinner"></span>{/if} Get the address</button>
      </form>
    {/if}
  {:else if view === 'redeem'}
    <form class="card stack" on:submit|preventDefault={redeem}>
      <h2>Turn tokens into notes</h2>
      <label>To a FreeBank address
        <input bind:value={address} autocomplete="off" autocapitalize="none" spellcheck="false" class="mono" data-testid="tokens-address" />
      </label>
      <button class="full" type="button" on:click={() => (scanning = 'address')}>Scan an address</button>
      <label>Amount (sECX)
        <input bind:value={amountText} inputmode="decimal" autocomplete="off" data-testid="tokens-amount" />
      </label>
      <p class="muted small">You have {ecx(balance)} sECX. The house pays the notes, at least {w ? ecx(w.minRedeem()) : '…'} sECX at
        a time; there is no fee.</p>
      {#if error}<p class="error">{error}</p>{/if}
      <button class="primary full" type="submit" disabled={busy || !addressOk(address) || !toUnits(amountText)}>
        {#if busy}<span class="spinner"></span>{/if} Pay out as notes</button>
    </form>
  {/if}
</section>
{/if}

<style>
  .center { text-align: center; }
  .label { color: var(--muted); font-size: 15px; }
  .big { font-size: 34px; font-weight: 700; }
  .unit { font-size: 18px; color: var(--muted); font-weight: 500; }
  .actions { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .row { display: flex; gap: 8px; }
  .words { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 16px; padding: 0; list-style: none; font-size: 18px; }
  .words .n { color: var(--muted); display: inline-block; min-width: 1.6em; text-align: right; }
  .addr { font-size: 19px; word-break: break-all; user-select: all; -webkit-user-select: all; }
  textarea { width: 100%; box-sizing: border-box; }
  label { display: flex; flex-direction: column; gap: 6px; }
</style>
