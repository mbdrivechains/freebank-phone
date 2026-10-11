<script lang="ts">
  // The Shop screen (desktop v0.2.8): type the amount, show the payment QR code, and see "Paid ✓" when the house's
  // notes (or sECX) arrive. The payer scans it with FreeBank's Scan to pay. The day's takings stay on this phone only.
  import { createEventDispatcher, onDestroy } from 'svelte';
  import type { PhoneClient, Status } from '../lib/api';
  import { addTaking, heldValue, isPaid, loadTakings, type Taking } from '../lib/hosted';
  import { payLinkFor } from '../lib/paylink';
  import { fmtEcx, fmtTime, parseAmount } from '../lib/format';
  import { note } from '../lib/activity';
  import Back from './Back.svelte';
  import Copy from './Copy.svelte';
  import Qr from './Qr.svelte';

  export let client: PhoneClient;
  export let status: Status;
  export let house: number;
  export let houseName: string;
  /** The shop's name on the payment code: the name this phone joined with. */
  export let shopName: string;
  const dispatch = createEventDispatcher<{ back: void }>();

  type State = 'amount' | 'qr' | 'paid' | 'counter';
  let state: State = 'amount';
  let text = '';
  let address = '';
  let error = '';
  let before = 0;
  let asked = 0;
  let takings: Taking[] = loadTakings();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let destroyed = false;
  onDestroy(() => {
    destroyed = true;
    clearTimeout(timer);
  });

  $: amount = parseAmount(text);
  $: link = address ? payLinkFor(location.origin, location.pathname, { address, house, amount: state === 'counter' ? null : asked, name: shopName }) : '';
  $: today = Math.round(takings.reduce((t, x) => t + x.amount, 0) * 1e8) / 1e8;

  const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', '⌫'];
  function key(k: string) {
    error = '';
    if (k === '⌫') text = text.slice(0, -1);
    else if (k === '.') {
      if (!text.includes('.')) text = (text || '0') + '.';
    } else if (!(text.includes('.') && text.split('.')[1].length >= 8) && text.length < 16) {
      text = text === '0' ? k : text + k;
    }
  }

  async function value(): Promise<number> {
    const n = await client.notes();
    return heldValue(Array.isArray(n) ? n : [], house);
  }

  async function ensureAddress() {
    if (!address) address = (await client.receive()).address;
  }

  async function show() {
    if (amount === null || amount <= 0) {
      error = 'Type the amount first.';
      return;
    }
    error = '';
    try {
      await ensureAddress();
      before = await value();
    } catch (e) {
      error = (e as Error).message;
      return;
    }
    asked = amount;
    state = 'qr';
    note('shop: showing a payment code');
    watch();
  }

  async function watch() {
    clearTimeout(timer);
    if (destroyed || state !== 'qr') return;
    try {
      const now = await value();
      if (state === 'qr' && isPaid(before, now, asked)) return paid();
    } catch {
      // the next look may get through
    }
    if (!destroyed && state === 'qr') timer = setTimeout(watch, 4000);
  }

  function paid() {
    state = 'paid';
    takings = addTaking({ at: Date.now(), amount: asked });
    note('shop: paid');
    chime();
  }

  /** A short two-note chime, made here (no sound file). */
  function chime() {
    try {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      [880, 1320].forEach((f, i) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, ctx.currentTime + i * 0.15);
        g.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + i * 0.15 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.15 + 0.3);
        o.connect(g).connect(ctx.destination);
        o.start(ctx.currentTime + i * 0.15);
        o.stop(ctx.currentTime + i * 0.15 + 0.32);
      });
      setTimeout(() => ctx.close(), 1000);
    } catch {
      // no sound: the screen says it
    }
  }

  function next() {
    clearTimeout(timer);
    text = '';
    asked = 0;
    state = 'amount';
  }

  async function counter() {
    error = '';
    try {
      await ensureAddress();
    } catch (e) {
      error = (e as Error).message;
      return;
    }
    clearTimeout(timer);
    state = 'counter';
  }
</script>

<Back title="Shop" on:back={() => dispatch('back')} />

<section class="stack" data-testid="shop">
  {#if state === 'amount'}
    <div class="card stack">
      <div class="muted small">Take a payment in {houseName}'s notes</div>
      <div class="entry" data-testid="shop-amount">{text || '0'} <span class="unit">sECX</span></div>
      <div class="keys">
        {#each KEYS as k}<button type="button" on:click={() => key(k)} aria-label={k === '⌫' ? 'Delete' : k}>{k}</button>{/each}
      </div>
      <button class="primary full" on:click={show} disabled={status !== 'connected' || amount === null || amount <= 0}>Show the QR code</button>
    </div>
    <button class="full" on:click={counter}>Counter QR code (the payer types the amount)</button>
  {:else if state === 'qr'}
    <div class="card stack qrcard">
      <div class="big" data-testid="shop-asked">{fmtEcx(asked)} <span class="unit">sECX</span></div>
      <Qr text={link} label="Payment QR code" />
      <p class="small">The payer scans this with <strong>Scan to pay</strong> in FreeBank.</p>
      <p class="muted small"><span class="spinner"></span> Waiting for the payment… it shows here once the house's desktop sees it.</p>
      <Copy text={link} label="Copy the payment link" />
    </div>
    <button class="full" on:click={next}>Cancel</button>
  {:else if state === 'paid'}
    <div class="card stack paidcard" data-testid="shop-paid">
      <div class="tick">✓</div>
      <div class="big">Paid {fmtEcx(asked)} <span class="unit">sECX</span></div>
      <div class="muted small">in {houseName}'s notes</div>
    </div>
    <button class="primary full" on:click={next}>Next customer</button>
  {:else}
    <div class="card stack qrcard" data-testid="shop-counter">
      <p><strong>{shopName}</strong></p>
      <Qr text={link} label="Counter QR code" />
      <p class="small">Print this for your counter: the payer scans it with Scan to pay and types the amount.</p>
      <p class="muted small">Any NFC app can also write this link to an NFC sticker, so a tap opens it.</p>
      <Copy text={link} label="Copy the link" />
    </div>
    <button class="full" on:click={next}>Back</button>
  {/if}
  {#if error}<p class="error small">{error}</p>{/if}

  {#if takings.length}
    <div class="card">
      <div class="muted small">Today: {fmtEcx(today)} sECX, {takings.length} payment{takings.length === 1 ? '' : 's'}</div>
      <ul class="takings" data-testid="takings">
        {#each takings as t}<li><span class="muted small">{fmtTime(Math.floor(t.at / 1000))}</span><span>{fmtEcx(t.amount)} sECX</span></li>{/each}
      </ul>
    </div>
  {/if}
</section>

<style>
  .entry {
    font-size: 40px;
    font-weight: 700;
    text-align: center;
    font-variant-numeric: tabular-nums;
    word-break: break-all;
  }
  .unit {
    font-size: 20px;
    color: var(--accent);
    font-weight: 650;
  }
  .keys {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
  }
  .keys button {
    min-height: 56px;
    font-size: 22px;
    font-variant-numeric: tabular-nums;
  }
  .qrcard,
  .paidcard {
    text-align: center;
  }
  .qrcard :global(.copy) {
    width: 100%;
  }
  .big {
    font-size: 32px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }
  .tick {
    font-size: 64px;
    line-height: 1;
    color: var(--success);
  }
  .takings {
    list-style: none;
    padding: 0;
    margin: 8px 0 0;
    display: grid;
    gap: 4px;
  }
  .takings li {
    display: flex;
    justify-content: space-between;
    font-variant-numeric: tabular-nums;
  }
</style>
