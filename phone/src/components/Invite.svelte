<script lang="ts">
  // "Invite to my house" (desktop v0.2.8, "Hosted wallets"): someone with only a phone scans this QR code and gets a
  // wallet of their own, kept on your desktop until they move it to a computer of theirs, and joins your house. Making
  // the invite takes this phone's Face ID; letting them in takes it again (the Allow card).
  import { createEventDispatcher, onDestroy } from 'svelte';
  import type { MyHouse, PhoneClient, Status } from '../lib/api';
  import { assertPasskey, passkeyError } from '../lib/passkey';
  import Back from './Back.svelte';
  import Copy from './Copy.svelte';
  import Qr from './Qr.svelte';

  export let client: PhoneClient;
  export let status: Status;
  const dispatch = createEventDispatcher<{ back: void }>();

  let houses: MyHouse[] | null = null;
  let chosen: MyHouse | null = null;
  let loadError = '';
  let error = '';
  let busy = false;
  let ch: { challenge: string; cred?: string; at: number } | null = null;
  let invite: { url: string; until: number } | null = null;
  let now = Date.now();
  const tick = setInterval(() => (now = Date.now()), 1000);
  onDestroy(() => clearInterval(tick));
  $: left = invite ? Math.max(0, Math.round((invite.until - now) / 1000)) : 0;

  let asked = false;
  $: if (!asked && status === 'connected') load();

  async function load() {
    asked = true;
    loadError = '';
    try {
      houses = await client.housesMine();
      if (houses.length === 1) chosen = houses[0];
    } catch (e) {
      const m = (e as Error).message;
      loadError = /unknown method/.test(m) ? 'Your desktop app needs updating (v0.2.8 or later) to invite people.' : m;
    }
  }

  /** The Face ID challenge is fetched before the tap, so the tap goes straight to the prompt (Safari needs a tap). */
  async function fetchChallenge() {
    ch = null;
    try {
      const c = await client.authStart('invite');
      if (!c.cred) {
        error = 'Turn on Face ID for this phone first (Settings).';
        return;
      }
      ch = { ...c, at: Date.now() };
    } catch (e) {
      error = (e as Error).message;
    }
  }
  $: if (chosen && !ch && !invite && !error && status === 'connected') fetchChallenge();

  async function make() {
    if (!chosen) return;
    error = '';
    if (!ch?.cred || Date.now() - ch.at > 100_000) {
      await fetchChallenge();
      if (!error) error = 'Tap Show the invite again.';
      return;
    }
    busy = true;
    let auth;
    try {
      auth = await assertPasskey(ch.challenge, ch.cred);
    } catch (e) {
      error = passkeyError(e);
      busy = false;
      ch = null;
      return;
    }
    ch = null;
    try {
      const r = await client.invite(chosen.house, auth);
      invite = { url: r.url, until: Date.now() + (r.secs ?? 600) * 1000 };
    } catch (e) {
      error = (e as Error).message;
    }
    busy = false;
  }

  function another() {
    invite = null;
    error = '';
  }

  const label = (h: MyHouse) => h.name ?? `House #${h.house}`;
</script>

<Back title="Invite to my house" on:back={() => dispatch('back')} />

<section class="stack" data-testid="invite">
  {#if invite && left > 0}
    <div class="card stack qrcard">
      <p><strong>Scan this with the other phone's Camera</strong></p>
      <Qr text={invite.url} label="Invite QR code" />
      <p class="small">
        They get a wallet of their own at <strong>{chosen ? label(chosen) : 'your house'}</strong>, kept on your desktop
        until they move it to their own computer. You'll be asked to let them in: check the code on their phone first.
      </p>
      <p class="muted small" data-testid="invite-left">Works once, for {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')} more.</p>
      <Copy text={invite.url} label="Copy the invite link" />
    </div>
    <button class="full" on:click={another}>Another invite</button>
  {:else if invite}
    <div class="card stack">
      <p>That invite ran out.</p>
      <button class="primary full" on:click={another}>Make a new one</button>
    </div>
  {:else if loadError}
    <p class="error">{loadError}</p>
    <button class="full" on:click={load}>Try again</button>
  {:else if houses === null}
    <p class="muted"><span class="spinner"></span> Asking your desktop for your houses…</p>
  {:else if houses.length === 0}
    <div class="card stack">
      <p>Your desktop's wallet doesn't run a members-only house.</p>
      <p class="muted small">
        Invites join people to a house you run whose notes go only to its members. Charter one on your desktop
        (Credit › House tools), then invite people to it here.
      </p>
    </div>
  {:else}
    <div class="card stack">
      <p>
        Someone without FreeBank, a shopkeeper say, scans the invite with their phone. They get a wallet of their own,
        with their own recovery words, kept on your desktop until they move it home. Then you can pay them in your
        house's notes.
      </p>
      {#if houses.length > 1}
        <fieldset class="stack">
          <legend class="small muted">Which house?</legend>
          {#each houses as h}
            <label class="choice">
              <input type="radio" name="house" value={h.house} checked={chosen?.house === h.house} on:change={() => { chosen = h; error = ''; }} />
              {label(h)} <span class="muted small">#{h.house}{h.type === 'redeem' ? ' · redeem only' : ''}</span>
            </label>
          {/each}
        </fieldset>
      {:else if chosen}
        <p class="small">House: <strong>{label(chosen)}</strong> <span class="muted">#{chosen.house}</span></p>
      {/if}
      <button class="primary full" on:click={make} disabled={!chosen || busy}>Show the invite with Face ID</button>
      <p class="muted small">"Let my phone send" must be on in your desktop's Settings: joining the house is signed there.</p>
    </div>
  {/if}
  {#if error}<p class="error small" data-testid="invite-error">{error}</p>{/if}
</section>

<style>
  .qrcard {
    text-align: center;
  }
  .qrcard :global(.copy) {
    width: 100%;
  }
  fieldset {
    border: 0;
    padding: 0;
    margin: 0;
  }
  .choice {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 44px;
  }
</style>
