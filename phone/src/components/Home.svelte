<script lang="ts">
  import { createEventDispatcher, onDestroy, onMount } from 'svelte';
  import { StartingError, type Balance, type NodeStatus, type PhoneClient, type Status, type Tx } from '../lib/api';
  import { fmtEcx, fmtTime, categoryLabel, shortId } from '../lib/format';
  import { noteFlow, sendFlow } from '../lib/sendflow';
  import Copy from './Copy.svelte';

  export let client: PhoneClient;
  export let status: Status;

  const dispatch = createEventDispatcher();

  // Cached across visits to this screen so returning from Send/Receive shows the last figures.
  let balance: Balance | null = cache.balance;
  let txs: Tx[] | null = cache.txs;
  let node: NodeStatus | null = cache.node;
  let loading = false;
  let error = '';
  // Daemon mode: the desktop is starting its node because this phone asked; ask again every 10 s until it answers,
  // for 5 minutes at most (the retries count as use, which keeps an unlocked phone unlocked), and only on this screen.
  let starting = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let retries = 0;
  let destroyed = false;
  const MAX_RETRIES = 30;
  let open: string | null = null;

  async function refresh() {
    if (loading) return;
    loading = true;
    error = '';
    try {
      const [b, h, s] = await Promise.all([client.balance(), client.history(10), client.nodeStatus()]);
      balance = cache.balance = b;
      txs = cache.txs = Array.isArray(h) ? h.slice(0, 10) : [];
      node = cache.node = s;
      starting = false;
      retries = 0;
    } catch (e) {
      clearTimeout(retry);
      if (e instanceof StartingError && retries < MAX_RETRIES) {
        starting = true;
        retries++;
        if (!destroyed) retry = setTimeout(refresh, 10_000);
      } else {
        starting = false;
        retries = 0;
        error = e instanceof StartingError ? 'Your desktop is still starting FreeBank. Tap ↻ to check again.' : (e as Error).message;
      }
    } finally {
      loading = false;
    }
  }
  onDestroy(() => {
    destroyed = true;
    clearTimeout(retry);
  });

  // Refresh whenever a session comes up (first connect, reconnect, page shown again).
  let last: Status | null = null;
  $: if (status !== last) {
    if (status === 'connected' && last !== null) refresh();
    last = status;
  }
  onMount(() => {
    if (status === 'connected') refresh();
  });

  function onVisible() {
    if (document.visibilityState === 'visible' && status === 'connected') refresh();
  }

  // Pull to refresh: drag down from the top of the page.
  let startY: number | null = null;
  let pull = 0;
  const THRESHOLD = 70;
  function touchStart(e: TouchEvent) {
    startY = window.scrollY <= 0 ? e.touches[0].clientY : null;
    pull = 0;
  }
  function touchMove(e: TouchEvent) {
    if (startY !== null) pull = Math.max(0, e.touches[0].clientY - startY);
  }
  function touchEnd() {
    if (startY !== null && pull > THRESHOLD) refresh();
    startY = null;
    pull = 0;
  }
  onDestroy(() => (startY = null));
</script>

<script context="module" lang="ts">
  const cache: { balance: Balance | null; txs: Tx[] | null; node: NodeStatus | null } = {
    balance: null,
    txs: null,
    node: null,
  };
</script>

<svelte:document on:visibilitychange={onVisible} />
<svelte:window on:touchstart|passive={touchStart} on:touchmove|passive={touchMove} on:touchend={touchEnd} />

<div class="pull" class:show={pull > 20} aria-hidden="true">{pull > THRESHOLD ? 'Release to refresh' : 'Pull to refresh'}</div>

<section class="stack" data-testid="home">
  {#if $sendFlow.k === 'held' || $sendFlow.k === 'sending'}
    <button class="banner full" on:click={() => dispatch('send')}>
      <span class="spinner"></span> A payment of {fmtEcx($sendFlow.amount)} ECX is waiting for your desktop{$sendFlow.k === 'held' && $sendFlow.why === 'locked' ? ' (its wallet is locked)' : ''}
    </button>
  {/if}
  {#if $noteFlow.k === 'held' || $noteFlow.k === 'sending'}
    <button class="banner full" on:click={() => dispatch('notes')}>
      <span class="spinner"></span> {fmtEcx($noteFlow.amount)} ECX of notes are waiting for your desktop
    </button>
  {/if}

  <div class="card balance">
    <div class="label">Balance</div>
    <div class="amount" data-testid="balance">
      {#if balance}
        {fmtEcx(balance.confirmed)} <span class="unit">ECX</span>
      {:else}
        <span class="muted">—</span>
      {/if}
    </div>
    {#if balance && balance.pending !== 0}
      <div class="pending" data-testid="pending">{balance.pending > 0 ? '+' : ''}{fmtEcx(balance.pending)} ECX pending</div>
    {/if}
    {#if node}
      <div class="muted small meta">Block {node.blocks.toLocaleString()}{node.synced ? '' : ' · desktop still syncing'}</div>
    {/if}
  </div>

  <div class="actions">
    <button class="primary" on:click={() => dispatch('receive')}>Receive</button>
    <button class="primary" on:click={() => dispatch('send')}>Send</button>
  </div>
  {#if node?.credit}
    <button class="full" data-testid="open-notes" on:click={() => dispatch('notes')}>Notes and houses</button>
  {/if}

  <div class="head">
    <h3>Recent activity</h3>
    <button class="plain refresh" on:click={refresh} disabled={loading || status !== 'connected'} aria-label="Refresh">
      {#if loading}<span class="spinner"></span>{:else}↻{/if}
    </button>
  </div>

  {#if starting}
    <div class="card stack center" data-testid="starting">
      <span class="spinner"></span>
      <p><strong>Your desktop is starting FreeBank.</strong></p>
      <p class="muted small">It started when this phone asked, and answers in a minute or two. This page keeps trying.</p>
    </div>
  {/if}
  {#if error}
    <p class="error small">{error}</p>
  {/if}

  {#if txs && txs.length === 0}
    <p class="muted">No payments yet.</p>
  {:else if txs}
    <ul class="txs" data-testid="txs">
      {#each txs as tx (tx.txid + tx.category + tx.amount)}
        {@const key = tx.txid + tx.category + tx.amount}
        <li>
          <button class="tx" class:open={open === key} on:click={() => (open = open === key ? null : key)} aria-expanded={open === key}>
            <span class="what">
              <span>{categoryLabel(tx.category, tx.amount)}</span>
              <span class="muted small">{fmtTime(tx.time)}{tx.confirmations === 0 ? ' · unconfirmed' : ''}</span>
            </span>
            <span class="amt" class:neg={tx.amount < 0}>{tx.amount > 0 ? '+' : ''}{fmtEcx(tx.amount)}</span>
          </button>
          {#if open === key}
            <div class="detail small">
              <div><span class="muted">Confirmations</span> {tx.confirmations.toLocaleString()}</div>
              {#if tx.address}<div class="row"><span class="muted">Address</span> <span class="mono wrap">{tx.address}</span></div>{/if}
              <div class="row">
                <span class="muted">Transaction</span>
                <span class="mono wrap" data-testid="txid">{tx.txid}</span>
              </div>
              <Copy text={tx.txid} label="Copy ID" />
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {:else if status !== 'connected'}
    <p class="muted">Waiting for your desktop…</p>
  {:else if !starting}
    <p class="muted"><span class="spinner"></span></p>
  {/if}
</section>

<style>
  .pull {
    text-align: center;
    color: var(--muted);
    font-size: 14px;
    height: 0;
    overflow: hidden;
  }
  .pull.show {
    height: 28px;
  }
  .balance .label {
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
  .pending {
    color: var(--warn);
    font-weight: 600;
    margin-top: 2px;
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
    min-height: 60px;
    font-size: 18px;
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding-top: 6px;
  }
  .refresh {
    font-size: 24px;
    min-width: 48px;
    color: var(--accent);
  }
  .txs {
    list-style: none;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
  }
  .txs li + li {
    border-top: 1px solid var(--border);
  }
  .tx {
    width: 100%;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    border: none;
    border-radius: 0;
    background: transparent;
    min-height: 64px;
    text-align: left;
    font-weight: 500;
  }
  .tx.open {
    background: var(--accent-tint);
  }
  .what {
    display: flex;
    flex-direction: column;
    line-height: 1.3;
  }
  .amt {
    font-variant-numeric: tabular-nums;
    font-weight: 650;
    color: var(--success);
    white-space: nowrap;
  }
  .amt.neg {
    color: var(--text);
  }
  .detail {
    padding: 4px 18px 16px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    background: var(--accent-tint);
  }
  .row {
    display: flex;
    flex-direction: column;
  }
  .wrap {
    word-break: break-all;
  }
  .detail :global(.copy) {
    align-self: flex-start;
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
  }
</style>
