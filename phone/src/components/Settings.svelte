<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import type { PhoneClient } from '../lib/api';
  import type { Pairing } from '../lib/store';
  import Back from './Back.svelte';
  import FaceId from './FaceId.svelte';

  export let pairing: Pairing;
  export let client: PhoneClient | null = null;
  export let locked = false;
  const dispatch = createEventDispatcher();
  let confirming = false;

  $: relayHost = (() => {
    try {
      return new URL(pairing.relay).host;
    } catch {
      return pairing.relay;
    }
  })();
</script>

<Back title="Settings" on:back={() => dispatch('back')} />

<section class="stack" data-testid="settings">
  <dl class="card">
    <dt>This phone</dt>
    <dd>{pairing.name}</dd>
    <dt>Paired</dt>
    <dd>{new Date(pairing.pairedAt).toLocaleString()}</dd>
    <dt>Desktop</dt>
    <dd class="mono">{pairing.room}</dd>
    <dt>Relay</dt>
    <dd class="mono">{relayHost}</dd>
  </dl>

  {#if client && !locked}<FaceId {client} name={pairing.name} pairing={pairing.pPub} />{/if}

  <div class="card stack">
    <h2>Forget this desktop</h2>
    <p class="small">Deletes this phone's key and the desktop's details from this browser. To also remove the phone from your desktop, use FreeBank on the desktop (Settings → Phones).</p>
    {#if !confirming}
      <button class="danger full" on:click={() => (confirming = true)}>Forget this desktop</button>
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
