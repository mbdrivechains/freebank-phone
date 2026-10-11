<script lang="ts">
  // Ask FreeBank (phone page v0.4.6): the header's ?, on any screen, paired or not. One question, one answer, nothing
  // kept. Its code (and the recovery-word list it checks against) loads only when it opens.
  import { onMount } from 'svelte';
  import Back from './Back.svelte';
  import { askHelper, MAX_QUESTION } from '../lib/ask';

  let input: HTMLInputElement;
  let q = '';
  let asked = '';
  let answer = '';
  let error = '';
  let busy = false;
  onMount(() => input?.focus());

  async function ask() {
    const question = q.trim();
    if (!question || busy) return;
    busy = true;
    asked = question;
    answer = '';
    error = '';
    try {
      answer = await askHelper(question);
      q = '';
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

<section class="stack" data-testid="ask">
  <Back title="Ask FreeBank" on:back />
  <form class="card stack" on:submit|preventDefault={ask}>
    <div class="row">
      <input bind:this={input} bind:value={q} maxlength={MAX_QUESTION} placeholder="How do I borrow?" aria-label="Your question"
        autocomplete="off" spellcheck="true" enterkeyhint="send" />
      <button class="primary" type="submit" disabled={busy || !q.trim()}>{busy ? '…' : 'Ask'}</button>
    </div>
    {#if asked && (answer || error || busy)}
      <p class="q">{asked}</p>
    {/if}
    {#if busy}
      <p class="muted small"><span class="spinner"></span> Asking FreeBank's helper…</p>
    {:else if answer}
      <p class="a" data-testid="ask-answer">{answer}</p>
    {:else if error}
      <p class="error small" data-testid="ask-error">{error}</p>
    {/if}
    <p class="muted small">
      FreeBank's helper is an AI that answers from FreeBank's notes. It can't see your wallet or do anything for you.
      Questions go to FreeBank's server and to Anthropic, which runs it: never type recovery words or anything private.
    </p>
  </form>
</section>

<style>
  .row {
    display: flex;
    gap: 8px;
  }
  .row input {
    flex: 1;
    min-width: 0;
  }
  .row button {
    flex: none;
    padding: 0 18px;
  }
  .q {
    font-weight: 600;
    margin: 4px 0 0;
  }
  .a {
    white-space: pre-wrap;
    line-height: 1.5;
    margin: 0;
  }
</style>
