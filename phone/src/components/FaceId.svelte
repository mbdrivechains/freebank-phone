<script lang="ts">
  // Settings: Face ID for this phone (relay/PROTOCOL.md, "Face ID: passkeys"). Turning it on makes a passkey, then
  // proves it once over the desktop's challenge (two taps: Safari asks only from a tap). The desktop then asks for
  // it on every new session, and before each send if chosen.
  import { onMount } from 'svelte';
  import type { NodeStatus, PhoneClient } from '../lib/api';
  import { assertPasskey, createPasskey, passkeyError, passkeysAvailable } from '../lib/passkey';

  export let client: PhoneClient;
  export let name: string;
  /** This phone's key (b64u), naming the pairing. */
  export let pairing: string;

  let available: boolean | null = null;
  let st: NodeStatus | null = null;
  let sends = false;
  let made: { pk: string; cred: string } | null = null;
  let addCh: { challenge: string } | null = null;
  let busy = false;
  let error = '';
  let removing = false;

  // Changing Face ID takes Face ID (the desktop asks): a "change" challenge is
  // fetched first, so the tap goes straight to the prompt.
  let changeCh: { challenge: string; cred?: string; at: number } | null = null;

  async function load() {
    try {
      st = await client.nodeStatus();
      changeCh = st.face_id ? { ...(await client.authStart('change')), at: Date.now() } : null;
    } catch (e) {
      error = (e as Error).message;
    }
  }

  /** Face ID over the fetched "change" challenge, or null (and a fresh challenge for the next tap). */
  async function changeAuth() {
    if (!changeCh?.cred || Date.now() - changeCh.at > 100_000) {
      await load();
      error = 'Tap again.';
      return null;
    }
    try {
      return await assertPasskey(changeCh.challenge, changeCh.cred);
    } catch (e) {
      error = passkeyError(e);
      await load();
      return null;
    }
  }
  onMount(async () => {
    available = await passkeysAvailable();
    await load();
  });

  // With "Approve sends on my phone" on, this phone's first Face ID would let it approve the desktop's payments, so
  // another phone with Face ID says yes first (desktop v0.2.5). Asking starts that; the answer says so.
  let askNote = '';
  async function askOther() {
    busy = true;
    error = '';
    askNote = '';
    try {
      await client.authStart('add');
    } catch (e) {
      askNote = (e as Error).message;
    }
    busy = false;
    await load();
  }

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
    // The challenge didn't come (the connection dropped): fetch it, then the next tap goes on.
    if (!addCh) {
      addCh = await client.authStart('add').catch(() => null);
      error = addCh ? 'Tap again.' : 'Your desktop is not reachable right now.';
      return;
    }
    busy = true;
    error = '';
    try {
      await client.passkeyAdd(made.pk, made.cred, sends, await assertPasskey(addCh.challenge, made.cred));
      made = null;
      addCh = null;
      await load();
    } catch (e) {
      error = passkeyError(e);
      addCh = await client.authStart('add').catch(() => null);
    } finally {
      busy = false;
    }
  }

  async function setSends(box: HTMLInputElement) {
    error = '';
    const auth = await changeAuth();
    if (auth) {
      try {
        await client.passkeySet(box.checked, auth);
      } catch (e) {
        error = (e as Error).message;
      }
    }
    await load();
    // The box shows what the desktop has, also when the change didn't go through: Svelte wouldn't reset
    // it, as the value it knows didn't change (code review N2).
    box.checked = !!st?.face_id_sends;
  }

  async function remove() {
    error = '';
    const auth = await changeAuth();
    if (!auth) return;
    try {
      await client.passkeyRemove(auth);
      removing = false;
    } catch (e) {
      error = (e as Error).message;
    }
    await load();
  }
</script>

<div class="card stack" data-testid="faceid">
  <h2>Face ID</h2>
  {#if available === false}
    <p class="small muted">This browser can't use Face ID, a fingerprint or the phone's passcode for FreeBank.</p>
  {:else if !st}
    <p class="small muted">{error || 'Asking your desktop…'}</p>
  {:else if st.face_id === undefined}
    <p class="small muted">Update FreeBank on your desktop (0.2.1 or later) to use Face ID here.</p>
  {:else if !st.face_id}
    <p class="small">
      Ask for Face ID (or your fingerprint or passcode) each time FreeBank opens here. Your desktop checks it, so someone
      holding your unlocked phone still can't use FreeBank. Safari and a Home Screen icon are paired separately: turn
      it on in each.
    </p>
    <label class="check"><input type="checkbox" bind:checked={sends} disabled={!!made} /> Also before each send</label>
    {#if st.add_asks && !made}
      <p class="small">
        "Approve sends on my phone" is on, so your other phone with Face ID approves this first: with Face ID on, this
        phone could approve your desktop's payments too.
      </p>
      <button class="primary full" on:click={askOther} disabled={busy}>Ask my other phone</button>
      {#if askNote}<p class="small" data-testid="faceid-asked">{askNote}</p>{/if}
    {:else if !made}
      <button class="primary full" on:click={make} disabled={busy}>{busy ? 'Making your passkey…' : 'Turn on Face ID'}</button>
    {:else}
      <p class="small">Passkey made. Now confirm it once.</p>
      <button class="primary full" on:click={confirm} disabled={busy}>{busy ? 'Checking…' : 'Confirm with Face ID'}</button>
    {/if}
  {:else}
    <p class="small">On: FreeBank asks for Face ID each time it opens here{st.face_id_sends ? ', and before each send' : ''}. Changing this asks for it too.</p>
    <label class="check">
      <input type="checkbox" checked={st.face_id_sends} disabled={!changeCh} on:change={(e) => setSends(e.currentTarget)} /> Also before each send
    </label>
    {#if !removing}
      <button class="full" on:click={() => (removing = true)}>Turn off Face ID</button>
    {:else}
      <p class="small">The passkey stays in your phone's passwords; delete it there if you like.</p>
      <button class="danger full" on:click={remove} disabled={!changeCh}>Turn it off with Face ID</button>
      <button class="full" on:click={() => (removing = false)}>Cancel</button>
    {/if}
  {/if}
  {#if error && st}<p class="error small">{error}</p>{/if}
</div>

<style>
  .check {
    display: flex;
    gap: 10px;
    align-items: center;
    font-weight: 400;
    font-size: 15px;
    min-height: 44px;
  }
  /* Not the page's full-width text input. */
  .check input {
    width: auto;
    min-height: 0;
    margin: 0;
    padding: 0;
    accent-color: var(--accent);
  }
</style>
