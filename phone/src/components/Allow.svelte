<script lang="ts">
  // A phone asks to join at a house from this phone's invite (desktop v0.2.8, "Hosted wallets"). Its comparison code
  // must match the one the other phone shows, as in pairing: anyone who saw the invite QR could ask first. Face ID
  // signs the challenge this card carries, for this one phone.
  import { onDestroy, onMount } from 'svelte';
  import type { AllowAsk, PhoneClient } from '../lib/api';
  import { assertPasskey, passkeyError } from '../lib/passkey';

  export let client: PhoneClient;
  export let ask: AllowAsk;
  /** The house's name, if this phone knows it. */
  export let houseName: string | null = null;

  let busy = false;
  let error = '';
  // The desktop names the house; an older one sends only its number, and the name comes from this wallet's houses.
  onMount(() => {
    if (!houseName && ask.house_name) houseName = ask.house_name;
    if (houseName) return;
    client.housesMine().then(
      (l) => (houseName = l.find((h) => h.house === ask.house)?.name ?? null),
      () => {},
    );
  });
  let now = Date.now();
  const tick = setInterval(() => (now = Date.now()), 1000);
  onDestroy(() => clearInterval(tick));
  $: left = Math.max(0, Math.round((ask.deadline - now) / 1000));
  let gone: ReturnType<typeof setTimeout> | undefined;
  $: if (left === 0 && !gone) gone = setTimeout(() => client.dismissAllow(ask.id), 4000);
  onDestroy(() => clearTimeout(gone));

  async function allow() {
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
      await client.allow(ask.id, auth);
    } catch (e) {
      error = (e as Error).message;
    }
    busy = false;
  }

  async function decline() {
    busy = true;
    error = '';
    try {
      await client.declineAllow(ask.id);
    } catch (e) {
      error = (e as Error).message;
    }
    busy = false;
  }
</script>

<div class="back">
  <section class="card stack" data-testid="allow-ask" role="dialog" aria-modal="true" aria-labelledby="allow-title">
    <h2 id="allow-title">Let {ask.name} join?</h2>
    <p class="muted small">At {houseName ?? `house #${ask.house}`}, from your invite. Allow only if their phone shows:</p>
    <div class="code" data-testid="allow-code">{ask.code}</div>
    {#if (ask.others ?? 0) > 0}
      <p class="error small" data-testid="allow-others">
        Another phone opened this invite too: allow only if the code matches the phone in front of you.
      </p>
    {/if}
    <p class="small">
      Your desktop then keeps a wallet for them, with their own recovery words, and adds them to the house. A different
      code means someone else is using your invite: decline it.
    </p>
    <button class="primary full" on:click={allow} disabled={busy || left === 0}>Allow with Face ID</button>
    <button class="full" on:click={decline} disabled={busy || left === 0}>Decline</button>
    {#if left === 0}
      <p class="muted small">The invite ran out.</p>
    {:else}
      <p class="muted small">The invite lasts {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')} more.</p>
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
  .code {
    font-size: 36px;
    font-weight: 700;
    letter-spacing: 0.06em;
    font-variant-numeric: tabular-nums;
    text-align: center;
    color: var(--accent);
  }
</style>
