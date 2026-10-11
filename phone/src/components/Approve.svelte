<script lang="ts">
  // The desktop asks this phone to approve something (desktop v0.2.5, "Approve sends on my phone"): a payment over the
  // day's amount, something that would weaken the setting, or a change the recovery words made that waits a day. Face
  // ID signs the desktop's challenge for this one approval; it approves nothing else.
  import { onDestroy } from 'svelte';
  import type { ApprovalAsk, PhoneClient } from '../lib/api';
  import { fmtEcx } from '../lib/format';
  import { assertPasskey, passkeyError } from '../lib/passkey';

  export let client: PhoneClient;
  export let ask: ApprovalAsk;

  let busy = false;
  let error = '';
  let now = Date.now();
  const tick = setInterval(() => (now = Date.now()), 1000);
  onDestroy(() => clearInterval(tick));
  $: left = Math.max(0, Math.round((ask.deadline - now) / 1000));
  // Over: shown a moment, then put away, so a card the desktop gave up on never covers the page.
  let gone: ReturnType<typeof setTimeout> | undefined;
  $: if (left === 0 && !gone) gone = setTimeout(() => client.dismiss(ask.id), 4000);
  onDestroy(() => clearTimeout(gone));
  $: scheduled = ask.what === 'scheduled';

  function waits(s: number): string {
    if (s >= 3600) return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  async function approve() {
    busy = true;
    error = '';
    let auth;
    try {
      auth = await assertPasskey(ask.challenge, ask.cred);
    } catch (e) {
      error = passkeyError(e);
      busy = false;
      return;
    }
    try {
      await client.approve(ask.id, auth);
    } catch (e) {
      error = (e as Error).message;
    }
    busy = false;
  }

  async function decline() {
    busy = true;
    error = '';
    try {
      await client.decline(ask.id);
    } catch (e) {
      error = (e as Error).message;
    }
    busy = false;
  }
</script>

<div class="back">
  <section class="card stack" data-testid="approve-ask" role="dialog" aria-modal="true" aria-labelledby="approve-title">
    {#if scheduled}
      <h2 id="approve-title">Your recovery words were used</h2>
      <p class="muted small">On your desktop, instead of this phone:</p>
      <p><strong>{ask.amount === null ? 'Turn "Approve sends on my phone" off' : `Ask your phones only over ${fmtEcx(ask.amount)} sECX a day`}</strong></p>
      <p class="small">
        It happens in {waits(left)} unless you cancel it. If it wasn't you, cancel it and check your desktop. If someone
        may have your recovery words, move your coins to new words.
      </p>
      <button class="primary full" on:click={decline} disabled={busy || left === 0}>Cancel it</button>
      <button class="full" on:click={approve} disabled={busy || left === 0}>It was me: do it now with Face ID</button>
    {:else}
      <h2 id="approve-title">Approve on this phone?</h2>
      {#if ask.what === 'send'}
        <p class="muted small">Your desktop wants to send</p>
        <div class="big">{fmtEcx(ask.amount ?? 0)} <span class="unit">sECX</span></div>
        <div><div class="muted small">To</div><div class="mono wrap">{ask.address}</div></div>
      {:else if ask.what === 'action'}
        <p class="muted small">Your desktop wants to</p>
        <p><strong class="wrap">{ask.text}</strong></p>
        {#if ask.amount !== null}<p class="small">It costs this wallet {fmtEcx(ask.amount)} sECX, fees included.</p>{/if}
      {:else}
        <p class="muted small">Your desktop asks:</p>
        <p><strong class="wrap">{ask.text}</strong></p>
      {/if}
      <button class="primary full" on:click={approve} disabled={busy || left === 0}>Approve with Face ID</button>
      <button class="full" on:click={decline} disabled={busy || left === 0}>Decline</button>
    {/if}
    <button class="plain full" on:click={() => client.dismiss(ask.id)} disabled={busy}>Not now</button>
    {#if left === 0}
      <p class="muted small">Your desktop stopped waiting.</p>
    {:else if !scheduled}
      <p class="muted small">Your desktop waits {waits(left)} more.</p>
    {/if}
    {#if error}<p class="error small">{error}</p>{/if}
  </section>
</div>

<style>
  .back {
    position: fixed;
    inset: 0;
    z-index: 50;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    background: rgba(0, 0, 0, 0.6);
  }
  .back section {
    width: 100%;
    max-width: 420px;
  }
  .big {
    font-size: 32px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }
  .big .unit {
    font-size: 18px;
    color: var(--accent);
  }
  .wrap {
    word-break: break-word;
  }
  .mono.wrap {
    word-break: break-all;
  }
</style>
