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
    Keep FreeBank on your Home Screen: tap Share, then <strong>Add to Home Screen</strong>. Safari deletes this page's
    key after 7 days without a visit; the Home Screen app keeps it.{paired
      ? ' The icon has storage of its own, so pair it from your desktop too (it becomes a second phone there).'
      : ''}
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
