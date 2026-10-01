<script lang="ts">
  import { createEventDispatcher, onMount } from 'svelte';
  import { parsePairLink, showPairCode, type PairLink } from '../lib/crypto';
  import { pairPhone, PairRefusedError, relayMatchesPage } from '../lib/pair';
  import { OfflineError } from '../lib/relay';
  import { defaultDeviceName } from '../lib/format';
  import { ios, pairLinkFor, pairValueFrom, standalone } from '../lib/homescreen';
  import type { Pairing } from '../lib/store';
  import Copy from './Copy.svelte';

  export let pairValue: string | null;
  export let alreadyPaired = false;

  const dispatch = createEventDispatcher<{ paired: Pairing }>();

  type State = 'none' | 'reading' | 'form' | 'connecting' | 'waiting' | 'refused' | 'error';
  let state: State = pairValue ? 'reading' : 'none';
  let link: PairLink | null = null;
  let name = defaultDeviceName();
  let message = '';
  let code = ''; // the comparison code, "042 917", shown from the moment the request is out
  let pasted = '';
  let pasteError = '';
  // Opened from the QR code in an iPhone's browser: offer to pair the Home Screen icon instead.
  const homeOffer = ios() && !standalone();
  const inApp = standalone();

  async function readLink(value: string) {
    try {
      const l = await parsePairLink(value);
      if (!relayMatchesPage(l.relay, location)) {
        const where = l.relay.length > 60 ? l.relay.slice(0, 60) + '…' : l.relay;
        throw new Error(`This pairing link is for another server (${where}), not this page. Use the link your FreeBank desktop shows.`);
      }
      link = l;
      pairValue = value;
      state = 'form';
    } catch (e) {
      message = (e as Error).message;
      state = 'error';
    }
  }

  onMount(() => {
    if (pairValue) readLink(pairValue);
  });

  // "Paste pairing link": the Home Screen icon's way in (its storage isn't the browser's).
  async function pastePair() {
    pasteError = '';
    try {
      const v = pairValueFrom(pasted, location.origin);
      if (!v) {
        pasteError = 'That is not a pairing link. Copy it again on your desktop, or from the page the QR code opened.';
        return;
      }
      pasted = '';
      await readLink(v);
    } catch (e) {
      pasteError = (e as Error).message;
    }
  }

  async function pasteFromClipboard() {
    pasteError = '';
    try {
      pasted = await navigator.clipboard.readText();
    } catch {
      pasteError = 'This browser did not hand over the clipboard: press and hold the box, then Paste.';
      return;
    }
    await pastePair();
  }

  async function pair() {
    if (!link) return;
    const n = name.trim().slice(0, 40) || defaultDeviceName();
    state = 'connecting';
    code = '';
    try {
      const p = await pairPhone(link, n, (c) => {
        code = showPairCode(c);
        state = 'waiting';
      });
      dispatch('paired', p);
    } catch (e) {
      if (e instanceof PairRefusedError) {
        state = 'refused';
      } else if (e instanceof OfflineError) {
        message = 'Your desktop app is not connected to the relay. Open FreeBank on your desktop, then scan the pairing code again.';
        state = 'error';
      } else {
        message = (e as Error).message;
        state = 'error';
      }
    }
  }
</script>

<section class="stack" data-testid="pair">
  {#if state === 'none' || state === 'reading'}
    <div class="card stack">
      <h2>Pair this phone</h2>
      {#if inApp}
        <p>Paste the pairing link from your FreeBank desktop app (<strong>Settings → Pair a phone</strong>).</p>
        <p class="muted small">Scan the desktop's QR code with your camera and tap <strong>Copy link for your Home Screen app</strong> on the page it opens. Or copy the link on the desktop: a Mac's Universal Clipboard passes it to your iPhone.</p>
      {:else}
        <p>Open the pairing link from your FreeBank desktop app (<strong>Settings → Pair a phone</strong>).</p>
        <p class="muted small">Point your phone's camera at the QR code the desktop shows and open the link. This page then pairs itself; you approve the phone on the desktop.</p>
      {/if}
      <form class="stack paste" on:submit|preventDefault={pastePair}>
        <label for="pairlink">{inApp ? 'Pairing link' : 'Or paste the pairing link'}</label>
        <input id="pairlink" bind:value={pasted} placeholder="https://…/#pair=…" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="go" />
        {#if pasteError}<p class="error small">{pasteError}</p>{/if}
        <div class="row">
          <button type="button" on:click={pasteFromClipboard}>Paste pairing link</button>
          <button class="primary" type="submit" disabled={!pasted.trim()}>Pair with this link</button>
        </div>
      </form>
      <p class="muted small">Your phone never learns your node's password. It gets its own key, which you can remove on the desktop at any time.</p>
    </div>
  {:else if state === 'form'}
    <form class="card stack" on:submit|preventDefault={pair}>
      <h2>Pair this phone</h2>
      {#if alreadyPaired}
        <p class="small warn">This phone is already paired with a desktop. Pairing again replaces it.</p>
      {/if}
      <div>
        <label for="devname">Name for this phone</label>
        <input id="devname" bind:value={name} maxlength="40" autocomplete="off" autocapitalize="words" enterkeyhint="go" />
        <p class="muted small hint">Your desktop shows this name when it asks you to allow the phone.</p>
      </div>
      <button class="primary full" type="submit">Pair</button>
    </form>
    {#if homeOffer && pairValue}
      <div class="card stack" data-testid="homescreen-offer">
        <h2>Or pair FreeBank on your Home Screen</h2>
        <p class="small">The better home on an iPhone: Safari deletes this page's key after 7 days without a visit, and the Home Screen icon keeps it. The icon has storage of its own, so it pairs itself:</p>
        <ol class="small steps">
          <li><Copy text={pairLinkFor(pairValue, location)} label="Copy link for your Home Screen app" /></li>
          <li>Tap Share, then <strong>Add to Home Screen</strong>.</li>
          <li>Open FreeBank from your Home Screen and tap <strong>Paste pairing link</strong>, within 5 minutes.</li>
        </ol>
      </div>
    {/if}
  {:else if state === 'connecting' || state === 'waiting'}
    <div class="card stack center" data-testid="pair-waiting">
      <span class="spinner"></span>
      {#if state === 'connecting'}
        <p>Reaching your desktop…</p>
      {:else}
        <h2>Check your desktop</h2>
        <p class="codeline" data-testid="pair-code">Check that your desktop shows <strong class="code">{code}</strong></p>
        <p>FreeBank on your desktop is asking <strong>“Allow this phone?”</strong> for <strong>{name}</strong>. Tap Allow only if it shows the same code.</p>
        <p class="muted small">A different code means another phone is trying to pair with your QR code: tap Deny for that one.</p>
        <p class="muted small">Keep this page open.</p>
      {/if}
    </div>
  {:else if state === 'refused'}
    <div class="card stack">
      <h2>Not paired</h2>
      <p>The desktop said no, or the QR code expired (it lasts 5 minutes). Make a new pairing QR code on the desktop and scan it again.</p>
    </div>
  {:else if state === 'error'}
    <div class="card stack">
      <h2>Could not pair</h2>
      <p class="error">{message}</p>
      {#if link}
        <button class="full" on:click={pair}>Try again</button>
      {:else}
        <p class="muted small">Make a new pairing QR code on your desktop (Settings → Pair a phone) and scan it again.</p>
        <button class="full" on:click={() => { state = 'none'; message = ''; }}>Back</button>
      {/if}
    </div>
  {/if}
</section>

<style>
  .center {
    text-align: center;
    padding: 32px 18px;
  }
  .hint {
    margin-top: 6px;
  }
  .codeline {
    font-size: 17px;
  }
  .code {
    display: block;
    margin-top: 6px;
    font-size: 36px;
    font-weight: 700;
    letter-spacing: 0.06em;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    color: var(--accent);
  }
  .warn {
    color: var(--warn);
  }
  .paste .row {
    display: flex;
    gap: 8px;
  }
  .paste .row button {
    flex: 1;
  }
  .steps {
    padding-left: 20px;
    display: grid;
    gap: 8px;
  }
</style>
