<script lang="ts">
  // In the browser only, never in the Home Screen app: how to keep FreeBank on the Home Screen. An
  // iPhone can't add a page by itself (always Share, then Add to Home Screen), so it gets the taps one by one, each
  // with the icon Safari shows (app v0.2.6).
  // Chrome on Android offers its install prompt, shown as a button.
  import { installPrompt, ios, standalone } from '../lib/homescreen';

  export let paired = false;

  const inBrowser = !standalone();
  const iphone = ios();

  async function install() {
    const p = $installPrompt;
    installPrompt.set(null);
    await p?.prompt();
  }
</script>

{#if inBrowser && iphone}
  <div class="hint" data-testid="homescreen-hint">
    <p class="small">
      {paired ? 'Keep FreeBank on your Home Screen:' : 'On an iPhone, pair FreeBank from your Home Screen:'}
    </p>
    <ol class="taps small">
      <li>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M8 7l4-4 4 4M6 11v9h12v-9" /></svg>
        <span>Tap <strong>Share</strong> in Safari's bar. Don't see it? Tap <strong>•••</strong> at the bottom right first.</span>
      </li>
      <li>
        <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="4" /><path d="M12 8v8M8 12h8" /></svg>
        <span>Scroll down and tap <strong>Add to Home Screen</strong>.</span>
      </li>
      <li>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l5 5 9-10" /></svg>
        <span>Tap <strong>Add</strong>, then open FreeBank from your Home Screen{paired ? '' : ' and pair it there'}.</span>
      </li>
    </ol>
    <p class="muted small">
      Safari deletes this page's key after 7 days without a visit; the Home Screen app keeps it.
      {#if paired}
        The Home Screen app has its own storage, so it pairs once more: on your desktop click <strong>Pair a phone</strong>,
        then in the Home Screen app tap <strong>Scan the code on your desktop</strong>. Your desktop lists it as a second
        phone.
      {/if}
    </p>
  </div>
{:else if inBrowser && $installPrompt}
  <button class="full" on:click={install}>Install FreeBank on this phone</button>
{/if}

<style>
  .hint {
    margin-top: 16px;
  }
  .taps {
    list-style: none;
    padding: 0;
    margin: 8px 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .taps li {
    display: flex;
    gap: 10px;
    align-items: flex-start;
  }
  .taps svg {
    flex: none;
    width: 26px;
    height: 26px;
    padding: 3px;
    border-radius: 8px;
    border: 1px solid var(--muted);
    fill: none;
    stroke: var(--accent);
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
</style>
