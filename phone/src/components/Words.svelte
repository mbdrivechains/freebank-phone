<script lang="ts">
  // A hosted wallet's recovery words, shown once (desktop v0.2.8, "Hosted wallets"). They are the wallet's backup while
  // the house keeps it: if this phone is lost, they get the money back. (Moving home doesn't use them: the money moves
  // to new words of his own computer.) Three are asked back, then Face ID confirms (`words-ok`), and the desktop joins
  // him to the house.
  import { createEventDispatcher, onMount } from 'svelte';
  import type { PhoneClient, Status } from '../lib/api';
  import { confirmMatches, pickConfirm } from '../lib/hosted';
  import { assertPasskey, passkeyError } from '../lib/passkey';

  export let client: PhoneClient;
  export let status: Status;
  export let houseName: string;
  const dispatch = createEventDispatcher<{ done: void }>();

  let words: string[] = [];
  let error = '';
  let stage: 'show' | 'check' = 'show';
  let positions: number[] = [];
  let answers: string[] = ['', '', ''];
  let ch: { challenge: string; cred?: string; at: number } | null = null;
  let busy = false;

  async function load() {
    error = '';
    try {
      const r = await client.words();
      words = Array.isArray(r?.words) ? r.words.map(String) : [];
      if (words.length !== 24) error = 'Your words did not come through whole. Try again.';
    } catch (e) {
      error = (e as Error).message;
    }
  }
  onMount(() => {
    if (status === 'connected') load();
  });
  $: if (status === 'connected' && !words.length && !error) load();

  async function fetchChallenge() {
    ch = null;
    try {
      const c = await client.authStart('change');
      if (c.cred) ch = { ...c, at: Date.now() };
    } catch (e) {
      error = (e as Error).message;
    }
  }

  function toCheck() {
    positions = pickConfirm(words.length);
    answers = positions.map(() => '');
    error = '';
    stage = 'check';
    fetchChallenge();
  }

  async function confirm() {
    error = '';
    if (!confirmMatches(words, positions, answers)) {
      error = "Those don't match. Look at your words again: if you lose this phone, they're the only way back to your money.";
      stage = 'show';
      return;
    }
    if (!ch?.cred || Date.now() - ch.at > 100_000) {
      await fetchChallenge();
      error = 'Tap Confirm again.';
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
      fetchChallenge();
      return;
    }
    ch = null;
    try {
      await client.wordsOk(auth);
      words = [];
      dispatch('done');
    } catch (e) {
      error = (e as Error).message;
      fetchChallenge();
    }
    busy = false;
  }
</script>

<section class="stack" data-testid="words">
  {#if stage === 'show'}
    <div class="card stack">
      <h2>Your 24 recovery words</h2>
      <p>
        <strong>Write these down, in order, on paper.</strong> They're your wallet's backup while {houseName} keeps it: if
        you lose this phone, these words get your money back. Anyone who has them can spend it.
      </p>
      {#if words.length === 24}
        <ol class="words" data-testid="word-list">
          {#each words as w, i}<li><span class="n">{i + 1}</span> <span class="w">{w}</span></li>{/each}
        </ol>
        <p class="muted small">Don't screenshot them or keep them in notes or email. {houseName} keeps your wallet until you move your money to a computer of your own.</p>
        <button class="primary full" on:click={toCheck}>I've written them down</button>
      {:else if !error}
        <p class="muted"><span class="spinner"></span> Getting your words…</p>
      {/if}
    </div>
  {:else}
    <form class="card stack" on:submit|preventDefault={confirm}>
      <h2>Check three of them</h2>
      {#each positions as p, i}
        <div>
          <label for="w{i}">Word {p + 1}</label>
          <input id="w{i}" bind:value={answers[i]} autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" />
        </div>
      {/each}
      <button class="primary full" type="submit" disabled={busy || answers.some((a) => !a.trim())}>Confirm with Face ID</button>
      <button class="full" type="button" on:click={() => (stage = 'show')}>Show the words again</button>
    </form>
  {/if}
  {#if error}<p class="error small" data-testid="words-error">{error}</p>{/if}
</section>

<style>
  .words {
    list-style: none;
    padding: 0;
    margin: 0;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px 14px;
    font-size: 17px;
  }
  .words li {
    display: flex;
    gap: 8px;
    align-items: baseline;
  }
  .n {
    color: var(--muted);
    font-size: 13px;
    min-width: 20px;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .w {
    font-weight: 600;
  }
</style>
