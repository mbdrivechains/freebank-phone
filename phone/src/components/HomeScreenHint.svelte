<script lang="ts">
  // In the browser only, never in the Home Screen app: how to keep FreeBank on the Home Screen. An
  // iPhone can't add a page by itself (always Share, then Add to Home Screen); Chrome on Android
  // offers its install prompt, shown as a button.
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
  <p class="muted small hint" data-testid="homescreen-hint">
    {#if paired}
      Keep FreeBank on your Home Screen: tap Share (under ••• if you don't see it), then <strong>Add to Home Screen</strong>.
      Safari deletes this page's key after 7 days without a visit; the Home Screen app keeps it. The Home Screen app
      keeps its own storage, apart from Safari, so it pairs once more: on your desktop click <strong>Pair a phone</strong>,
      then in the Home Screen app tap <strong>Scan the code on your desktop</strong>. Your desktop lists it as a second
      phone.
    {:else}
      On an iPhone, pair FreeBank from your Home Screen: tap Share (under ••• if you don't see it), then
      <strong>Add to Home Screen</strong>, open FreeBank there and pair it. Safari deletes this page's key after 7 days
      without a visit; the Home Screen app keeps it.
    {/if}
  </p>
{:else if inBrowser && $installPrompt}
  <button class="full" on:click={install}>Install FreeBank on this phone</button>
{/if}

<style>
  .hint {
    margin-top: 16px;
    text-align: center;
  }
</style>
