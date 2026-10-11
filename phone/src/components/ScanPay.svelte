<script lang="ts">
  // "Scan to pay" (desktop v0.2.8): read a shop's payment QR code (or paste its link or address), then pay in the
  // house's notes it names, through the usual note payment: Face ID, limits and the desktop's approval as for any.
  // On iPhone the Camera app opens payment links in Safari, not in the Home Screen app, so payers scan from here.
  import { createEventDispatcher, onMount } from 'svelte';
  import type { NoteHolding, PhoneClient, Status } from '../lib/api';
  import { parsePayText, scannedPay, type PayRequest } from '../lib/paylink';
  import { noteFlow } from '../lib/sendflow';
  import { fmtEcx } from '../lib/format';
  import { note } from '../lib/activity';
  import Back from './Back.svelte';
  import NoteAction from './NoteAction.svelte';
  import Scanner from './Scanner.svelte';

  export let client: PhoneClient;
  export let status: Status;
  /** A payment link the page was opened with (`#pay=`), already taken from the address bar. */
  export let initial: string | null = null;
  const dispatch = createEventDispatcher<{ back: void }>();

  type State = 'start' | 'scanning' | 'choose' | 'pay';
  let state: State = 'start';
  let req: PayRequest | null = null;
  let holdings: NoteHolding[] = [];
  let holding: NoteHolding | null = null;
  let error = '';
  let pasted = '';
  let busy = false;

  onMount(() => {
    noteFlow.reset();
    if (initial) take(initial);
  });

  async function take(text: string) {
    error = '';
    try {
      req = parsePayText(text, location.origin);
    } catch (e) {
      error = (e as Error).message;
      state = 'start';
      return;
    }
    busy = true;
    try {
      const all = await client.notes();
      // Notes that can be paid on: not a redeem-only house's (those go only back to the house), and some left.
      holdings = (Array.isArray(all) ? all : []).filter((h) => h.type !== 'redeem' && h.amount - h.demanded > 0);
    } catch (e) {
      error = (e as Error).message;
      state = 'start';
      busy = false;
      return;
    }
    busy = false;
    if (req.house !== null) {
      holding = holdings.find((h) => h.house === req!.house) ?? null;
      if (!holding) {
        error = `You hold no notes of house #${req.house} to pay with${req.name ? ` at ${req.name}` : ''}.`;
        state = 'start';
        return;
      }
      state = 'pay';
    } else if (holdings.length === 1) {
      holding = holdings[0];
      state = 'pay';
    } else if (holdings.length === 0) {
      error = 'You hold no notes to pay with.';
      state = 'start';
    } else {
      state = 'choose';
    }
    note(`scan to pay: ${state}`);
  }

  function scanned(e: CustomEvent<string>) {
    take(e.detail);
  }

  async function paste() {
    try {
      pasted = await navigator.clipboard.readText();
    } catch {
      error = 'This browser did not hand over the clipboard: press and hold the box, then Paste.';
      return;
    }
    if (pasted.trim()) take(pasted);
  }

  const houseLabel = (h: NoteHolding) => h.name ?? `House #${h.house}`;
</script>

{#if state === 'pay' && holding && req}
  <NoteAction {client} {status} {holding} kind="note-send" presetAddress={req.address} presetAmount={req.amount} shop={req.name}
    on:back={() => dispatch('back')} />
{:else}
  <Back title="Scan to pay" on:back={() => dispatch('back')} />
  <section class="stack" data-testid="scan-pay">
    {#if state === 'scanning'}
      <div class="card stack">
        <Scanner accept={scannedPay} hint="Point the camera at the shop's payment QR code." on:value={scanned}
          on:cancel={() => (state = 'start')}
          on:failed={(e) => { error = e.detail.text; state = 'start'; }} />
      </div>
    {:else if state === 'choose' && req}
      <div class="card stack">
        <p>Pay <strong>{req.name || 'this address'}</strong> in which house's notes?</p>
        <p class="mono small wrap">{req.address}</p>
        {#each holdings as h}
          <button class="full" on:click={() => { holding = h; state = 'pay'; }}>{houseLabel(h)} · {fmtEcx(h.amount - h.demanded)} sECX</button>
        {/each}
      </div>
    {:else}
      <div class="card stack">
        <p>Scan the shop's payment QR code, and pay in your house notes.</p>
        <button class="primary full" on:click={() => { error = ''; state = 'scanning'; }} disabled={busy || status !== 'connected'}>Scan the QR code</button>
        <form class="stack" on:submit|preventDefault={() => take(pasted)}>
          <label for="paylink">Or paste a payment link or address</label>
          <input id="paylink" bind:value={pasted} placeholder="https://…/#pay=… or X…" autocomplete="off" autocapitalize="off" spellcheck="false" />
          <div class="row">
            <button type="button" on:click={paste}>Paste</button>
            <button class="primary" type="submit" disabled={!pasted.trim() || busy}>Pay this</button>
          </div>
        </form>
      </div>
    {/if}
    {#if busy}<p class="muted"><span class="spinner"></span> Looking at your notes…</p>{/if}
    {#if error}<p class="error small" data-testid="scan-pay-error">{error}</p>{/if}
  </section>
{/if}

<style>
  .row {
    display: flex;
    gap: 8px;
  }
  .row button {
    flex: 1;
  }
  .wrap {
    word-break: break-all;
  }
</style>
