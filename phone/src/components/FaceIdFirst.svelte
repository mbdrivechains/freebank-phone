<script lang="ts">
  // A hosted phone's first step (desktop v0.2.8): a passkey before anything else. The house's desktop answers nothing
  // but this until the phone has one, and asks for it on every session and before every payment after.
  import { createEventDispatcher, onMount } from 'svelte';
  import type { PhoneClient } from '../lib/api';
  import { assertPasskey, createPasskey, passkeyError, passkeysAvailable } from '../lib/passkey';

  export let client: PhoneClient;
  export let name: string;
  /** This phone's key (b64u), naming the pairing. */
  export let pairing: string;
  const dispatch = createEventDispatcher<{ done: void }>();

  let available: boolean | null = null;
  let made: { pk: string; cred: string } | null = null;
  let addCh: { challenge: string } | null = null;
  let busy = false;
  let error = '';

  onMount(async () => {
    available = await passkeysAvailable();
  });

  async function make() {
    busy = true;
    error = '';
    try {
      made = await createPasskey(name, pairing);
      addCh = await client.authStart('add');
    } catch (e) {
      error = passkeyError(e);
    } finally {
      busy = false;
    }
  }

  async function confirm() {
    if (!made) return;
    if (!addCh) {
      addCh = await client.authStart('add').catch(() => null);
      error = addCh ? 'Tap again.' : 'The house is not reachable right now.';
      return;
    }
    busy = true;
    error = '';
    try {
      // Each payment asks for Face ID on a hosted phone, whatever `sends` says.
      await client.passkeyAdd(made.pk, made.cred, true, await assertPasskey(addCh.challenge, made.cred));
      made = null;
      addCh = null;
      dispatch('done');
    } catch (e) {
      error = passkeyError(e);
      addCh = await client.authStart('add').catch(() => null);
    } finally {
      busy = false;
    }
  }
</script>

<section class="card stack" data-testid="faceid-first">
  <h2>First, Face ID</h2>
  <p>Your wallet is guarded by this phone's Face ID (or fingerprint, or passcode). Every payment asks for it.</p>
  {#if available === false}
    <p class="error small">This browser can't make a passkey. Open the page in Safari or Chrome, up to date, and try again.</p>
  {:else if !made}
    <button class="primary full" on:click={make} disabled={busy || available === null}>Set up Face ID</button>
  {:else}
    <button class="primary full" on:click={confirm} disabled={busy}>Confirm Face ID</button>
  {/if}
  {#if error}<p class="error small">{error}</p>{/if}
</section>
