<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import type { MemberAddress, PhoneClient, Status } from '../lib/api';
  import Back from './Back.svelte';
  import Copy from './Copy.svelte';
  import Qr from './Qr.svelte';
  import { payLinkFor } from '../lib/paylink';

  export let client: PhoneClient;
  export let status: Status;
  /** A hosted wallet (desktop v0.2.8): its one member address, shown as a payment link in the house's notes. */
  export let pay: { house: number; houseName: string; shop: string } | null = null;
  const dispatch = createEventDispatcher();

  let address = '';
  // An owner's desktop (v0.2.8): this wallet's member addresses at members-only houses, whose notes can be paid only
  // to them (relay/PROTOCOL.md, "Member addresses").
  let members: MemberAddress[] = [];
  let error = '';
  let loading = false;

  async function load() {
    loading = true;
    error = '';
    try {
      const r = await client.receive();
      address = r.address;
      members = !pay && Array.isArray(r.members) ? r.members.filter((m) => m && typeof m.address === 'string') : [];
    } catch (e) {
      error = (e as Error).message;
    } finally {
      loading = false;
    }
  }

  $: link = pay && address ? payLinkFor(location.origin, location.pathname, { address, house: pay.house, amount: null, name: pay.shop }) : '';

  // Ask once the session is up (it may still be reconnecting when the screen opens).
  $: if (!address && !loading && !error && status === 'connected') load();
</script>

<Back title="Receive" on:back={() => dispatch('back')} />

<section class="stack" data-testid="receive">
  {#if address && pay}
    <div class="card stack qrcard">
      <Qr text={link} label="Payment QR code" />
      <p class="small">Payers scan this with <strong>Scan to pay</strong> in FreeBank, and pay in {pay.houseName}'s notes.</p>
      <p class="addr mono" data-testid="address">{address}</p>
      <Copy text={address} label="Copy address" />
      <Copy text={link} label="Copy payment link" />
    </div>
    <p class="muted small">Your member address at {pay.houseName}: its notes can come only to members' addresses.</p>
  {:else if address}
    <div class="card stack qrcard">
      <Qr text={address} label="QR code of your address" />
      <p class="addr mono" data-testid="address">{address}</p>
      <Copy text={address} label="Copy address" />
    </div>
    <p class="muted small">Send only sECX to this address. Payments show on Home once your desktop sees them.</p>
    {#each members as m (m.house)}
      <div class="card stack qrcard" data-testid="member-address">
        <div class="label">Your address at {m.name ?? `house #${m.house}`}</div>
        <Qr text={m.address} label={`QR code of your address at ${m.name ?? `house #${m.house}`}`} />
        <p class="addr mono">{m.address}</p>
        <Copy text={m.address} label="Copy address" />
        <p class="muted small">{m.name ?? `House #${m.house}`}'s notes can be paid only to this address: it's on the house's member list.</p>
      </div>
    {/each}
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
  .label {
    color: var(--muted);
    font-size: 15px;
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
