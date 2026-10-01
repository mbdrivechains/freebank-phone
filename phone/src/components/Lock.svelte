<script lang="ts">
  // The desktop asks for Face ID before it answers this session (this phone added a passkey). Safari asks only from
  // a tap, so the challenge is fetched first and the button goes straight to the prompt.
  import { onDestroy } from 'svelte';
  import type { PhoneClient } from '../lib/api';
  import { assertPasskey, passkeyError } from '../lib/passkey';

  export let client: PhoneClient;

  let ch: { challenge: string; cred?: string } | null = null;
  let at = 0;
  let busy = false;
  let error = '';

  async function fetchChallenge() {
    try {
      ch = await client.authStart('open');
      at = Date.now();
      error = '';
      // No passkey any more (the desktop removed it): nothing to unlock.
      if (!ch.cred && (await client.unlockIfOpen())) return;
    } catch (e) {
      ch = null;
      error = (e as Error).message;
    }
  }
  // A challenge belongs to one session: fetch one on each (re)connection, the first included.
  const off = client.status.subscribe((s) => {
    if (s === 'connected') fetchChallenge();
  });
  onDestroy(off);

  async function unlock() {
    if (!ch) return;
    if (!ch.cred) {
      error = 'Your desktop has no Face ID for this phone. Open FreeBank again.';
      return;
    }
    // A challenge lasts 2 minutes: an old one is replaced, and the next tap uses the new one.
    if (Date.now() - at > 100_000) {
      await fetchChallenge();
      error = 'Tap again.';
      return;
    }
    busy = true;
    error = '';
    try {
      await client.auth(await assertPasskey(ch.challenge, ch.cred));
    } catch (e) {
      error = passkeyError(e);
      await fetchChallenge(); // each challenge is good once
    } finally {
      busy = false;
    }
  }
</script>

<section class="card stack center" data-testid="locked">
  <h2>FreeBank is locked</h2>
  <p>Your desktop asks for Face ID, your fingerprint or your phone's passcode before it answers this phone.</p>
  <button class="primary full" on:click={unlock} disabled={busy || !ch}>{busy ? 'Checking…' : 'Unlock with Face ID'}</button>
  {#if error}<p class="error small">{error}</p>{/if}
  {#if !ch && !busy}<button class="full" on:click={fetchChallenge}>Try again</button>{/if}
</section>

<style>
  .center {
    text-align: center;
    padding: 28px 18px;
  }
</style>
