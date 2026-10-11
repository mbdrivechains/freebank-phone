<script lang="ts">
  // Home for a wallet kept at a house (desktop v0.2.8, "Hosted wallets"). It follows the wallet's setup (Face ID first,
  // then the words, then joining the house), then shows the balance, the house's notes, and the shop's actions.
  import { createEventDispatcher, onDestroy, onMount } from 'svelte';
  import { StartingError, type Balance, type NodeStatus, type NoteHolding, type PhoneClient, type Status, type Tx } from '../lib/api';
  import { pollMs, stepOf, type Step } from '../lib/hosted';
  import { fmtEcx, fmtTime, categoryLabel } from '../lib/format';
  import type { Pairing } from '../lib/store';
  import FaceIdFirst from './FaceIdFirst.svelte';
  import Words from './Words.svelte';

  export let client: PhoneClient;
  export let status: Status;
  export let pairing: Pairing;
  /** A move home was started and its new pairing waits: finish it. */
  export let moving = false;

  const dispatch = createEventDispatcher<{ shop: void; receive: void; pay: void; send: void; notes: void; move: void; forget: void }>();

  let st: NodeStatus | null = null;
  let step: Step = 'setup';
  let balance: Balance | null = null;
  let notes: NoteHolding[] | null = null;
  let txs: Tx[] | null = null;
  let error = '';
  let loading = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let destroyed = false;

  $: houseId = st?.house ?? pairing.house?.house ?? 0;
  $: houseName = st?.house_name ?? pairing.house?.name ?? `House #${houseId}`;
  $: houseNotes = (notes ?? []).filter((n) => n.house === houseId).reduce((t, n) => t + n.amount, 0);
  $: otherNotes = (notes ?? []).filter((n) => n.house !== houseId);

  async function refresh() {
    if (loading || destroyed) return;
    loading = true;
    error = '';
    clearTimeout(timer);
    try {
      st = await client.nodeStatus();
      step = stepOf(st);
      if (st.face_id && step === 'ready') {
        const [b, n, h] = await Promise.all([client.balance(), client.notes(), client.history(10)]);
        balance = b;
        notes = Array.isArray(n) ? n : [];
        txs = Array.isArray(h) ? h.slice(0, 10) : [];
      }
    } catch (e) {
      error = e instanceof StartingError ? 'The house is starting FreeBank. One moment…' : (e as Error).message;
      if (e instanceof StartingError && !destroyed) timer = setTimeout(refresh, 10_000);
    } finally {
      loading = false;
    }
    const wait = st?.face_id ? pollMs(step) : 0;
    if (wait && !destroyed) timer = setTimeout(refresh, wait);
  }

  let last: Status | null = null;
  $: if (status !== last) {
    if (status === 'connected' && last !== null) refresh();
    last = status;
  }
  onMount(() => {
    if (status === 'connected') refresh();
  });
  onDestroy(() => {
    destroyed = true;
    clearTimeout(timer);
  });
  function onVisible() {
    if (document.visibilityState === 'visible' && status === 'connected') refresh();
  }
</script>

<svelte:document on:visibilitychange={onVisible} />

<section class="stack" data-testid="hosted-home">
  {#if st && !st.face_id}
    <div class="card stack">
      <h2>Welcome to {houseName}</h2>
      <p class="small">{pairing.house?.by ?? 'The house'} invited you. Your wallet is being set up on their desktop.</p>
    </div>
    <FaceIdFirst {client} name={pairing.name} pairing={pairing.pPub} on:done={refresh} />
  {:else if st && step === 'setup'}
    <div class="card stack center" data-testid="step-setup">
      <span class="spinner"></span>
      <h2>Setting up your wallet…</h2>
      <p>About a minute. {houseName}'s desktop is making your wallet, with recovery words of your own.</p>
    </div>
  {:else if st && step === 'words'}
    <Words {client} {status} {houseName} on:done={refresh} />
  {:else if st && step === 'joining'}
    <div class="card stack center" data-testid="step-joining">
      <span class="spinner"></span>
      <h2>Joining {houseName}…</h2>
      <p>About a minute: the house adds you to its members in the next block. Then you can be paid in its notes.</p>
    </div>
  {:else if st && step === 'failed'}
    <div class="card stack" data-testid="step-failed">
      <h2>Your wallet couldn't be set up</h2>
      <p class="error">{st.why ?? 'The house\'s desktop gave no reason.'}</p>
      <p class="small">Ask {pairing.house?.by ?? 'the house'} for a new invite, then forget this one here.</p>
      <button class="danger full" on:click={() => dispatch('forget')}>Forget this house</button>
    </div>
  {:else if st && step === 'moving'}
    <div class="card stack center" data-testid="step-moving">
      <span class="spinner"></span>
      <h2>Moving your money…</h2>
      <p>{houseName} is sending your notes and coins to your computer. It takes a block or two.</p>
      {#if st.why}<p class="muted small">{st.why}</p>{/if}
      {#if moving}<button class="full" data-testid="finish-move" on:click={() => dispatch('move')}>See how it goes</button>{/if}
    </div>
  {:else if st && step === 'moved'}
    <div class="card stack" data-testid="step-moved">
      <h2>Your money has moved</h2>
      <p>Your notes and coins are on your own computer now. Pair this phone with FreeBank there (Settings › Phone › Pair a phone).</p>
      {#if moving}<button class="primary full" data-testid="finish-move" on:click={() => dispatch('move')}>Finish moving to your computer</button>{/if}
      <button class="full" on:click={() => dispatch('forget')}>Forget {houseName}</button>
    </div>
  {:else if st}
    {#if moving}
      <button class="banner full" data-testid="finish-move" on:click={() => dispatch('move')}>Finish moving to your computer</button>
    {/if}
    <div class="card balance">
      <div class="label">At {houseName}</div>
      <div class="amount" data-testid="hosted-balance">{fmtEcx(houseNotes)} <span class="unit">sECX</span></div>
      <div class="muted small">in {houseName}'s notes{balance && balance.confirmed + balance.pending > 0 ? `, and ${fmtEcx(balance.confirmed + balance.pending)} sECX` : ''}</div>
      {#if st.blocks}<div class="muted small meta">Block {st.blocks.toLocaleString()}</div>{/if}
    </div>
    <button class="primary full shop" data-testid="open-shop" on:click={() => dispatch('shop')}>Shop: take a payment</button>
    <div class="actions">
      <button on:click={() => dispatch('receive')}>Receive</button>
      <button on:click={() => dispatch('pay')}>Pay</button>
    </div>
    {#if otherNotes.length || (balance && balance.confirmed > 0)}
      <div class="actions">
        {#if otherNotes.length}<button on:click={() => dispatch('notes')}>Other notes</button>{/if}
        {#if balance && balance.confirmed > 0}<button on:click={() => dispatch('send')}>Send sECX</button>{/if}
      </div>
    {/if}
    {#if txs && txs.length}
      <div class="card">
        <div class="label">Recent</div>
        <ul class="txs">
          {#each txs as t}
            <li><span>{categoryLabel(t.category, t.amount)}</span><span class="muted small">{fmtTime(t.time)}</span><span class="amt">{t.amount > 0 ? '+' : ''}{fmtEcx(t.amount)}</span></li>
          {/each}
        </ul>
      </div>
    {/if}
    <div class="card stack">
      <p class="small">
        <strong>{houseName} keeps your wallet</strong> until you move your money to a computer of your own: they could
        spend it until then. Set FreeBank up there as new, with its own recovery words, then move your money across.
      </p>
      <button class="full" data-testid="open-move" on:click={() => dispatch('move')}>Move to my own computer</button>
    </div>
  {:else if !error}
    <p class="muted center"><span class="spinner"></span></p>
  {/if}
  {#if error}<p class="error small">{error}</p>{/if}
</section>

<style>
  .label {
    color: var(--muted);
    font-size: 15px;
  }
  .amount {
    font-size: 38px;
    font-weight: 700;
    letter-spacing: -0.02em;
    font-variant-numeric: tabular-nums;
    line-height: 1.2;
    word-break: break-word;
  }
  .unit {
    font-size: 20px;
    color: var(--accent);
    font-weight: 650;
  }
  .meta {
    margin-top: 8px;
  }
  .actions {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }
  .actions button {
    min-height: 56px;
    font-size: 17px;
  }
  .banner {
    display: flex;
    align-items: center;
    gap: 10px;
    text-align: left;
    background: var(--accent-tint);
    border-color: var(--accent);
    font-weight: 500;
    padding: 12px 16px;
  }
  .center {
    text-align: center;
    padding: 28px 18px;
  }
  .shop {
    min-height: 60px;
    font-size: 18px;
  }
  .txs {
    list-style: none;
    padding: 0;
    margin: 8px 0 0;
    display: grid;
    gap: 6px;
  }
  .txs li {
    display: grid;
    grid-template-columns: 1fr auto auto;
    gap: 10px;
    align-items: baseline;
  }
  .amt {
    font-variant-numeric: tabular-nums;
  }
</style>
