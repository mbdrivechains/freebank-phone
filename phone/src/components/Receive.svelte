<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import type { PhoneClient, Status } from '../lib/api';
  import Back from './Back.svelte';
  import Copy from './Copy.svelte';
  import Qr from './Qr.svelte';

  export let client: PhoneClient;
  export let status: Status;
  const dispatch = createEventDispatcher();

  let address = '';
  let error = '';
  let loading = false;

  async function load() {
    loading = true;
    error = '';
    try {
      address = (await client.receive()).address;
    } catch (e) {
      error = (e as Error).message;
    } finally {
      loading = false;
    }
  }

  // Ask once the session is up (it may still be reconnecting when the screen opens).
  $: if (!address && !loading && !error && status === 'connected') load();
</script>

<Back title="Receive" on:back={() => dispatch('back')} />

<section class="stack" data-testid="receive">
  {#if address}
    <div class="card stack qrcard">
      <Qr text={address} label="QR code of your address" />
      <p class="addr mono" data-testid="address">{address}</p>
      <Copy text={address} label="Copy address" />
    </div>
    <p class="muted small">Send only ECX to this address. Payments show on Home once your desktop sees them.</p>
  {:else if error}
    <p class="error">{error}</p>
    <button class="full" on:click={load}>Try again</button>
  {:else}
    <p class="muted"><span class="spinner"></span> Getting an address from your desktop…</p>
  {/if}
</section>

<style>
  .qrcard {
    text-align: center;
  }
  .addr {
    font-size: 21px;
    line-height: 1.35;
    word-break: break-all;
    font-weight: 500;
    user-select: all;
    -webkit-user-select: all;
  }
  .qrcard :global(.copy) {
    width: 100%;
    min-height: 52px;
  }
</style>
