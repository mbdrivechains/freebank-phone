<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import type { PhoneClient } from '../lib/api';
  import { isHosted, type Pairing } from '../lib/store';
  import Back from './Back.svelte';
  import FaceId from './FaceId.svelte';

  export let pairing: Pairing;
  export let client: PhoneClient | null = null;
  export let locked = false;
  const dispatch = createEventDispatcher();
  let confirming = false;
  // A wallet kept at a house (desktop v0.2.8): Face ID can't be turned off there, and forgetting the house leaves only
  // the wallet's recovery words as the way back to the money.
  $: hosted = isHosted(pairing);
  $: houseName = pairing.house?.name ?? 'the house';

  // Over Nostr (desktop v0.6.0) the link goes through public relays; through the relay, one host and its room.
  $: relayHost = (() => {
    const hostOf = (u: string) => {
      try {
        return new URL(u).host;
      } catch {
        return u;
      }
    };
    return pairing.v === 2 ? (pairing.relays ?? []).map(hostOf).join(', ') : hostOf(pairing.relay ?? '');
  })();
</script>

<Back title="Settings" on:back={() => dispatch('back')} />

<section class="stack" data-testid="settings">
  <dl class="card">
    <dt>This phone</dt>
    <dd>{pairing.name}</dd>
    <dt>Paired</dt>
    <dd>{new Date(pairing.pairedAt).toLocaleString()}</dd>
    {#if hosted}
      <dt>Wallet kept at</dt>
      <dd>{houseName}</dd>
      <dt>Invited by</dt>
      <dd>{pairing.house?.by ?? ''}</dd>
    {/if}
    {#if pairing.v === 2}
      <dt>Desktop</dt>
      <dd class="mono">{(pairing.n ?? '').slice(0, 16)}</dd>
      <dt>Link</dt>
      <dd>Over Nostr</dd>
      <dt>Relays</dt>
      <dd class="mono" data-testid="relays">{relayHost}</dd>
    {:else}
      <dt>Desktop</dt>
      <dd class="mono">{pairing.room}</dd>
      <dt>Relay</dt>
      <dd class="mono">{relayHost}</dd>
    {/if}
  </dl>

  {#if hosted}
    <p class="card small">Face ID guards this wallet, and every payment asks for it. It stays on while {houseName} keeps your wallet.</p>
  {:else if client && !locked}<FaceId {client} name={pairing.name} pairing={pairing.pPub} />{/if}

  <div class="card stack">
    {#if hosted}
      <h2>Forget {houseName}</h2>
      <p class="small">Deletes this phone's key from this browser. Your wallet stays at {houseName}; without this phone, only your 24 recovery words get your money back. To move your money to a computer of your own, use <strong>Move to my own computer</strong> on Home instead.</p>
    {:else}
      <h2>Forget this desktop</h2>
      <p class="small">Deletes this phone's key and the desktop's details from this browser. To also remove the phone from your desktop, use FreeBank on the desktop (Settings, Phone, Revoke).</p>
    {/if}
    {#if !confirming}
      <button class="danger full" on:click={() => (confirming = true)}>{hosted ? `Forget ${houseName}` : 'Forget this desktop'}</button>
    {:else}
      <p class="small warn">This can't be undone. You will need to pair again.</p>
      <button class="danger full" on:click={() => dispatch('forget')} data-testid="forget-confirm">Yes, forget it</button>
      <button class="full" on:click={() => (confirming = false)}>Cancel</button>
    {/if}
  </div>
</section>

<style>
  dl {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 8px 16px;
  }
  dt {
    color: var(--muted);
  }
  dd {
    word-break: break-all;
    text-align: right;
  }
  .warn {
    color: var(--warn);
  }
</style>
