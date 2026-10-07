<script lang="ts">
  // Your notes, house by house (desktop v0.2.5, `notes`), with what can be done with each: send, redeem, demand.
  import { createEventDispatcher, onMount } from 'svelte';
  import { typeLabel, type NoteHolding, type PaymentKind, type PhoneClient, type Status } from '../lib/api';
  import { fmtEcx } from '../lib/format';
  import Back from './Back.svelte';

  export let client: PhoneClient;
  export let status: Status;
  const dispatch = createEventDispatcher<{
    back: void;
    houses: void;
    act: { holding: NoteHolding; kind: PaymentKind };
  }>();

  let notes: NoteHolding[] | null = cache;
  let loading = false;
  let error = '';

  async function load() {
    if (loading) return;
    loading = true;
    error = '';
    try {
      notes = cache = await client.notes();
    } catch (e) {
      error = (e as Error).message;
    } finally {
      loading = false;
    }
  }
  onMount(() => {
    if (status === 'connected') load();
  });
  let last: Status | null = null;
  $: if (status !== last) {
    if (status === 'connected' && last !== null) load();
    last = status;
  }

  /** Notes not under demand: they can be sent or demanded. */
  const free = (n: NoteHolding) => Math.max(0, Math.round((n.amount - n.demanded) * 1e8) / 1e8);
</script>

<script context="module" lang="ts">
  let cache: NoteHolding[] | null = null;
</script>

<Back title="Notes" on:back={() => dispatch('back')} />

<section class="stack" data-testid="notes">
  <div class="head">
    <p class="muted small">Notes are claims on a house, paid in ECX, one for one.</p>
    <button class="plain refresh" on:click={load} disabled={loading || status !== 'connected'} aria-label="Refresh">
      {#if loading}<span class="spinner"></span>{:else}↻{/if}
    </button>
  </div>

  {#if error}<p class="error small" data-testid="notes-error">{error}</p>{/if}

  {#if notes && notes.length === 0}
    <p class="muted">You hold no notes yet.</p>
  {:else if notes}
    {#each notes as n (n.house)}
      <div class="card stack note" data-testid="note">
        <div class="top">
          <div>
            <div class="name">{n.name ?? `House #${n.house}`}</div>
            <div class="muted small">House #{n.house}</div>
          </div>
          <div class="badges">
            <span class="badge s-{n.state}">{n.state_name}</span>
            {#if typeLabel(n.type)}<span class="badge members" data-testid="note-type">{typeLabel(n.type)}</span>{/if}
          </div>
        </div>
        <div class="big">{fmtEcx(n.amount)} <span class="unit">ECX</span></div>
        {#if n.demanded > 0}
          <p class="small muted">
            {fmtEcx(n.demanded)} ECX under demand{n.state === 'd' ? `, in the payout queue${n.rate_bps ? ` at ${n.rate_bps / 100}% a year` : ''}` : ''}.
          </p>
        {/if}
        <div class="acts">
          <!-- A redeem-only house's notes go only back to the house (or onto the holder's own key, done on the desktop). -->
          {#if n.type !== 'redeem'}
            <button disabled={free(n) <= 0 || status !== 'connected'} on:click={() => dispatch('act', { holding: n, kind: 'note-send' })}>Send</button>
          {/if}
          <button disabled={!n.can_redeem || n.redeemable <= 0 || status !== 'connected'} on:click={() => dispatch('act', { holding: n, kind: 'note-redeem' })}>Redeem</button>
          <button disabled={!n.can_demand || free(n) <= 0 || status !== 'connected'} on:click={() => dispatch('act', { holding: n, kind: 'note-demand' })}>Demand</button>
        </div>
      </div>
    {/each}
  {:else if status !== 'connected'}
    <p class="muted">Waiting for your desktop…</p>
  {:else if !error}
    <p class="muted"><span class="spinner"></span></p>
  {/if}

  <button class="full" on:click={() => dispatch('houses')}>All houses</button>
</section>

<style>
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .refresh {
    font-size: 22px;
    min-width: 48px;
  }
  .top {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 8px;
  }
  .name {
    font-weight: 650;
    font-size: 17px;
  }
  .big {
    font-size: 28px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }
  .big .unit {
    font-size: 16px;
    color: var(--accent);
  }
  .acts {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
  }
</style>
