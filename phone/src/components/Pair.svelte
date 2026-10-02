<script lang="ts">
  import { createEventDispatcher, onMount } from 'svelte';
  import { parsePairLink, showPairCode, type PairLink } from '../lib/crypto';
  import { pairPhone, PairRefusedError, relayMatchesPage } from '../lib/pair';
  import { OfflineError } from '../lib/relay';
  import { defaultDeviceName } from '../lib/format';
  import { ios, pairLinkFor, pairValueFrom, standalone } from '../lib/homescreen';
  import type { Pairing } from '../lib/store';
  import Copy from './Copy.svelte';
  import HomeScreenHint from './HomeScreenHint.svelte';
  import Scanner from './Scanner.svelte';
  import { note } from '../lib/activity';

  export let pairValue: string | null;
  export let alreadyPaired = false;

  const dispatch = createEventDispatcher<{ paired: Pairing }>();

  type State = 'none' | 'reading' | 'scanning' | 'form' | 'connecting' | 'waiting' | 'refused' | 'error';
  let state: State = pairValue ? 'reading' : 'none';
  let link: PairLink | null = null;
  const inApp = standalone();
  const iphone = ios();
  // The desktop lists each pairing by name, and on an iPhone the Home Screen app pairs apart from Safari.
  let name = inApp && iphone ? `${defaultDeviceName()} Home Screen` : defaultDeviceName();
  let message = '';
  let code = ''; // the comparison code, "042 917", shown from the moment the request is out
  let pasted = '';
  let pasteError = '';
  let pasteOpen = false;
  let scanError = '';
  let scanReload = false; // the reader's file didn't load: reloading the page may help
  // Opened from the QR code in an iPhone's browser: Home Screen first (the icon scans this same code), Safari second.
  const homeFirst = iphone && !inApp;
  let pairHere = false;

  async function readLink(value: string) {
    try {
      const l = await parsePairLink(value);
      if (!relayMatchesPage(l.relay, location)) {
        const shown = l.relay.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, '');
        const where = shown.length > 60 ? shown.slice(0, 60) + '…' : shown;
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

  function scan() {
    scanError = '';
    scanReload = false;
    state = 'scanning';
  }

  function scanned(e: CustomEvent<string>) {
    state = 'reading';
    readLink(e.detail);
  }

  function scanFailed(e: CustomEvent<{ text: string; reload: boolean }>) {
    note(`scan: ${e.detail.text}`);
    scanError = e.detail.text;
    scanReload = e.detail.reload;
    pasteOpen = !scanReload;
    state = 'none';
  }

  // Back to the start, for a new QR code.
  function again() {
    link = null;
    pairValue = null;
    message = '';
    state = 'none';
  }

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
      {#if inApp && iphone}
        <h2>Pair this Home Screen app</h2>
        <p>
          The Home Screen app keeps its own storage, apart from Safari, so it needs its own pairing with your desktop,
          even if you already paired FreeBank in Safari.
        </p>
      {:else}
        <h2>Pair this phone</h2>
      {/if}
      <ol class="steps">
        <li><strong>On your desktop:</strong> open FreeBank's <strong>Settings</strong> and click <strong>Pair a phone</strong> (under Phone). A QR code appears.</li>
        <li>
          <strong>On this phone:</strong> tap <strong>Scan the code on your desktop</strong>{inApp ? '' : ', or scan it with your Camera app'}, and
          point the camera at the QR code.
        </li>
        <li><strong>On your desktop:</strong> click <strong>Allow</strong> if it shows the same 6-digit code as this phone.</li>
      </ol>
      {#if scanError}<p class="error small" data-testid="scan-error">{scanError}</p>{/if}
      {#if scanReload}
        <button class="primary full" on:click={() => location.reload()}>Reload</button>
      {:else}
        <button class="primary full" on:click={scan}>Scan the code on your desktop</button>
      {/if}
      <details bind:open={pasteOpen}>
        <summary>Can't scan? Paste the pairing link</summary>
        <form class="stack paste" on:submit|preventDefault={pastePair}>
          <p class="muted small">
            On your desktop, click <strong>Copy</strong> next to the QR code's link: a Mac's Universal Clipboard passes it
            to an iPhone.{inApp && iphone ? ' Or open the QR code with your Camera app and, on the page it opens in Safari, tap Copy link for your Home Screen app.' : ''}
          </p>
          <label for="pairlink">Pairing link</label>
          <input id="pairlink" bind:value={pasted} placeholder="https://…/#pair=…" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="go" />
          {#if pasteError}<p class="error small">{pasteError}</p>{/if}
          <div class="row">
            <button type="button" on:click={pasteFromClipboard}>Paste pairing link</button>
            <button class="primary" type="submit" disabled={!pasted.trim()}>Pair with this link</button>
          </div>
        </form>
      </details>
      <p class="muted small">Your phone never learns your node's password. It gets its own key, which you can remove on the desktop at any time.</p>
    </div>
    <HomeScreenHint />
  {:else if state === 'scanning'}
    <div class="card stack">
      <h2>Scan the code on your desktop</h2>
      <Scanner on:value={scanned} on:cancel={again} on:failed={scanFailed} />
    </div>
  {:else if state === 'form'}
    {#if homeFirst && !pairHere}
      <div class="card stack" data-testid="homescreen-first">
        <h2>Add FreeBank to your Home Screen first</h2>
        <p>
          On an iPhone, FreeBank belongs on your Home Screen: Safari deletes this page's key after 7 days without a
          visit, and the Home Screen app keeps it. The Home Screen app keeps its own storage, so pair it there:
        </p>
        <ol class="steps">
          <li>
            Tap <strong>Share</strong> (under <strong>•••</strong> if you don't see it), then <strong>Add to Home Screen</strong>.
            Keep <strong>Open as Web App</strong> on if your iPhone shows it.
          </li>
          <li>Open <strong>FreeBank</strong> from your Home Screen.</li>
          <li>
            Tap <strong>Scan the code on your desktop</strong> and scan this same QR code again. It works for 5 minutes
            from when you clicked Pair a phone; after that, click <strong>Pair a phone</strong> again for a new one.
          </li>
        </ol>
        {#if pairValue}
          <p class="muted small">
            If the Home Screen app can't use the camera, copy the link here and tap <strong>Paste pairing link</strong> there:
          </p>
          <Copy text={pairLinkFor(pairValue, location)} label="Copy link for your Home Screen app" />
        {/if}
      </div>
      <button class="full" on:click={() => (pairHere = true)}>Pair in this browser instead</button>
    {:else}
      <form class="card stack" on:submit|preventDefault={pair}>
        <h2>Pair this phone</h2>
        {#if alreadyPaired}
          <p class="small warn">This phone is already paired with a desktop. Pairing again replaces it.</p>
        {/if}
        {#if homeFirst}
          <p class="muted small">This browser and the Home Screen app pair separately: each is its own phone on your desktop.</p>
        {/if}
        <div>
          <label for="devname">Name for this phone</label>
          <input id="devname" bind:value={name} maxlength="40" autocomplete="off" autocapitalize="words" enterkeyhint="go" />
          <p class="muted small hint">Your desktop shows this name when it asks you to allow the phone.</p>
        </div>
        <button class="primary full" type="submit">Pair</button>
        <button class="full" type="button" on:click={again}>Back</button>
      </form>
    {/if}
  {:else if state === 'connecting' || state === 'waiting'}
    <div class="card stack center" data-testid="pair-waiting">
      <span class="spinner"></span>
      {#if state === 'connecting'}
        <p>Reaching your desktop…</p>
      {:else}
        <h2>Check your desktop</h2>
        <p class="codeline" data-testid="pair-code">Check that your desktop shows <strong class="code">{code}</strong></p>
        <p>FreeBank on your desktop is asking <strong>“Allow this phone?”</strong> for <strong>{name}</strong>. Click Allow only if it shows the same code.</p>
        <p class="muted small">A different code means another phone is trying to pair with your QR code: click Deny for that one.</p>
        <p class="muted small">Keep this page open.</p>
      {/if}
    </div>
  {:else if state === 'refused'}
    <div class="card stack">
      <h2>Not paired</h2>
      <p>The desktop said no, or the QR code expired (it lasts 5 minutes). On your desktop, click <strong>Pair a phone</strong> for a new QR code and scan it.</p>
      <button class="full" on:click={again}>Back</button>
    </div>
  {:else if state === 'error'}
    <div class="card stack">
      <h2>Could not pair</h2>
      <p class="error">{message}</p>
      {#if link}
        <button class="full" on:click={pair}>Try again</button>
        <button class="full" on:click={again}>Back</button>
      {:else}
        <p class="muted small">On your desktop, click <strong>Pair a phone</strong> (Settings) for a new QR code and scan it.</p>
        <button class="full" on:click={again}>Back</button>
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
  details summary {
    cursor: pointer;
    color: var(--accent);
    font-size: 15px;
  }
  details[open] summary {
    margin-bottom: 10px;
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
