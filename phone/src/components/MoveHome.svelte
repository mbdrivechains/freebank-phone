<script lang="ts">
  // "Move to my own computer" (desktop v0.2.8, "Hosted wallets", moving home to fresh
  // words). The shopkeeper sets FreeBank up on his computer as new, with recovery words of its own; this phone pairs
  // with it as any phone does, asks it for an address, and with Face ID asks the house to move the money there
  // (`move-home`). The house adds that address to its members, sends the notes and the coins across, and says
  // "moved"; only then does this phone forget the house. Until then the new pairing waits apart ("moving"), so a
  // reload, or a house that can't be reached, loses nothing: the next look picks up where the move stands.
  import { createEventDispatcher, onDestroy, onMount } from 'svelte';
  import { PhoneClient, type Status } from '../lib/api';
  import { parsePairLink, showPairCode, type PairLink } from '../lib/crypto';
  import { pairPhone, PairRefusedError, relayMatchesPage } from '../lib/pair';
  import { OfflineError, RelayLink } from '../lib/relay';
  import { pairValueFrom } from '../lib/homescreen';
  import { stepOf } from '../lib/hosted';
  import { finishMove, saveMoving, type Pairing } from '../lib/store';
  import { assertPasskey, passkeyError } from '../lib/passkey';
  import { note } from '../lib/activity';
  import Back from './Back.svelte';
  import Scanner from './Scanner.svelte';

  /** The house's client (this phone's current pairing). */
  export let client: PhoneClient;
  export let status: Status;
  export let pairing: Pairing;
  /** A new pairing left from a move that wasn't finished. */
  export let resume: Pairing | null = null;
  const dispatch = createEventDispatcher<{ back: void; moved: Pairing }>();

  type State = 'explain' | 'scanning' | 'waiting' | 'checking' | 'tell' | 'moving' | 'done' | 'error';
  let state: State = resume ? 'checking' : 'explain';
  let error = '';
  let code = '';
  let pasted = '';
  let fresh: Pairing | null = resume;
  let freshClient: PhoneClient | null = null;
  /** The new computer's address, where the money goes. */
  let target = '';
  /** What the house says it waits for while it moves the money. */
  let why = '';
  let ch: { challenge: string; cred?: string; at: number } | null = null;
  let busy = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let destroyed = false;
  const houseName = pairing.house?.name ?? 'the house';

  onMount(() => {
    if (resume) check(resume);
  });
  onDestroy(() => {
    destroyed = true;
    clearTimeout(timer);
    freshClient?.stop();
  });

  async function useLink(value: string) {
    error = '';
    let link: PairLink;
    try {
      link = await parsePairLink(value);
      if (link.h) throw new Error("That's an invite to a house. Scan the pairing code FreeBank on your computer shows (Settings › Phone › Pair a phone).");
      if (!relayMatchesPage(link.relay, location)) throw new Error('This pairing link is for another server, not this page.');
    } catch (e) {
      error = (e as Error).message;
      state = 'error';
      return;
    }
    state = 'waiting';
    code = '';
    try {
      const p = await pairPhone(link, pairing.name, (c) => (code = showPairCode(c)), saveMoving);
      note('move: paired with the new computer');
      fresh = p;
      await check(p);
    } catch (e) {
      error = e instanceof PairRefusedError
        ? 'Your computer said no, or its QR code expired. Click Pair a phone there for a new one.'
        : e instanceof OfflineError
          ? 'FreeBank on your computer is not connected. Open it, then scan its pairing code again.'
          : (e as Error).message;
      state = 'error';
    }
  }

  /** The new computer answers; then where the move stands at the house: not asked yet (give it an address), moving,
   *  or moved. */
  async function check(p: Pairing) {
    state = 'checking';
    error = '';
    freshClient?.stop();
    freshClient = new PhoneClient({ pPriv: p.pPriv, pPub: p.pPub, d: p.d }, () => RelayLink.open(p.relay, p.room));
    freshClient.start();
    try {
      const st = await client.nodeStatus();
      const step = stepOf(st);
      if (step === 'moved') return finish();
      if (step === 'moving') {
        why = st.why ?? '';
        state = 'moving';
        return follow();
      }
    } catch {
      // the house may be out of reach for now: the new computer's address is still worth getting
    }
    try {
      target = (await freshClient.receive()).address;
    } catch (e) {
      error = `Paired, but your computer didn't give an address yet (${(e as Error).message}). Keep FreeBank open there and try again.`;
      state = 'error';
      return;
    }
    // The computer shows the address too, and says whether it is its own wallet's (the re-review of v0.2.8, N3): a QR
    // code from someone else's computer would otherwise take the money.
    try {
      const n = await freshClient.moveNotice(target, houseName);
      if (!n.mine) {
        error = "That computer says the address isn't its own wallet's. Pair with the computer you set up yourself.";
        state = 'error';
        return;
      }
    } catch (e) {
      error = `Your computer didn't confirm the address (${(e as Error).message}). Update FreeBank there, then try again.`;
      state = 'error';
      return;
    }
    state = 'tell';
    fetchChallenge();
  }

  async function fetchChallenge() {
    ch = null;
    try {
      const c = await client.authStart('change');
      if (c.cred) ch = { ...c, at: Date.now() };
    } catch (e) {
      error = (e as Error).message;
    }
  }

  async function tell() {
    if (!fresh || !target) return;
    error = '';
    if (!ch?.cred || Date.now() - ch.at > 100_000) {
      await fetchChallenge();
      if (!error) error = 'Tap again.';
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
      await client.moveHome(target, auth);
    } catch (e) {
      error = `${houseName} didn't take it: ${(e as Error).message}`;
      busy = false;
      fetchChallenge();
      return;
    }
    note('move: the house is moving the money');
    busy = false;
    why = '';
    state = 'moving';
    follow();
  }

  /** Ask the house how the move goes, every few seconds, until it says "moved". */
  async function follow() {
    clearTimeout(timer);
    if (destroyed || state !== 'moving') return;
    try {
      const st = await client.nodeStatus();
      const step = stepOf(st);
      if (step === 'moved') return finish();
      if (step === 'failed') {
        error = st.why ?? `${houseName}'s desktop couldn't move the money.`;
        state = 'error';
        return;
      }
      why = st.why ?? '';
    } catch {
      // out of reach for a moment: look again
    }
    if (!destroyed && state === 'moving') timer = setTimeout(follow, 5000);
  }

  async function finish() {
    if (!fresh) return;
    await finishMove(fresh);
    note('move: done');
    freshClient?.stop();
    freshClient = null;
    state = 'done';
  }

  function done() {
    if (fresh) dispatch('moved', { ...fresh, kind: 'owner', house: undefined });
  }

  /** Stop a move that can't finish (the re-review of v0.2.8, N1): back to the wallet at the house. */
  async function stop() {
    error = '';
    busy = true;
    try {
      const c = await client.authStart('change');
      if (!c.cred) throw new Error('Set up Face ID on this phone first.');
      const auth = await assertPasskey(c.challenge, c.cred);
      await client.moveStop(auth);
      note('move: stopped');
      clearTimeout(timer);
      dispatch('back');
    } catch (e) {
      error = passkeyError(e) || (e as Error).message;
    }
    busy = false;
  }

  function scanned(e: CustomEvent<string>) {
    useLink(e.detail);
  }

  function pastePair() {
    try {
      const v = pairValueFrom(pasted, location.origin);
      if (!v) {
        error = 'That is not a pairing link. Copy it again from FreeBank on your computer.';
        return;
      }
      useLink(v);
    } catch (e) {
      error = (e as Error).message;
    }
  }
</script>

<Back title="Move to my own computer" on:back={() => dispatch('back')} />

<section class="stack" data-testid="move-home">
  {#if state === 'explain'}
    <div class="card stack">
      <ol class="steps">
        <li>On your computer, install FreeBank from <strong>github.com/mbdrivechains/freebank-app</strong>.</li>
        <li>Set it up <strong>as new, with its own recovery words</strong> (not the words from {houseName}), and keep those new words safe.</li>
        <li>When it's ready, open <strong>Settings › Phone › Pair a phone</strong>. A QR code appears.</li>
        <li>Scan it here. {houseName} then moves your notes and coins to your computer, and its copy of your wallet ends up empty.</li>
      </ol>
      <button class="primary full" on:click={() => (state = 'scanning')} disabled={status !== 'connected'}>Scan the code on my computer</button>
      <form class="stack" on:submit|preventDefault={pastePair}>
        <label for="movelink">Or paste its pairing link</label>
        <input id="movelink" bind:value={pasted} placeholder="https://…/#pair=…" autocomplete="off" autocapitalize="off" spellcheck="false" />
        <button type="submit" disabled={!pasted.trim()}>Pair with this link</button>
      </form>
    </div>
  {:else if state === 'scanning'}
    <div class="card stack">
      <Scanner hint="Point the camera at the QR code FreeBank on your computer shows." on:value={scanned}
        on:cancel={() => (state = 'explain')} on:failed={(e) => { error = e.detail.text; state = 'explain'; }} />
    </div>
  {:else if state === 'waiting'}
    <div class="card stack center" data-testid="move-waiting">
      <span class="spinner"></span>
      {#if code}
        <p class="codeline" data-testid="pair-code">Check that your computer shows <strong class="code">{code}</strong></p>
        <p>Click Allow there if it shows the same code.</p>
      {:else}
        <p>Reaching your computer…</p>
      {/if}
    </div>
  {:else if state === 'checking'}
    <div class="card center"><span class="spinner"></span><p>Checking that your computer answers…</p></div>
  {:else if state === 'tell'}
    <div class="card stack" data-testid="move-tell">
      <h2>Paired with your computer</h2>
      <p>Move your money to your computer:</p>
      <p class="addr mono" data-testid="move-target">{target}</p>
      <p class="small">
        Your computer now shows this address too: check they match. {houseName} adds it to its members, then sends your
        notes and coins there. Notes of another house that your computer can't hold are redeemed for sECX first, and
        the sECX follows.
      </p>
      <button class="primary full" on:click={tell} disabled={busy || status !== 'connected'}>Move my money with Face ID</button>
      {#if status !== 'connected'}<p class="muted small">Waiting to reach {houseName}…</p>{/if}
    </div>
  {:else if state === 'moving'}
    <div class="card stack center" data-testid="move-moving">
      <span class="spinner"></span>
      <h2>Moving your money…</h2>
      <p>{houseName} is sending your notes and coins to your computer. It takes a block or two.</p>
      {#if why}<p class="muted small" data-testid="move-why">{why}</p>{/if}
      {#if status !== 'connected'}<p class="muted small">Waiting to reach {houseName}…</p>{/if}
      <button class="link-btn" on:click={stop} disabled={busy}>Stop moving</button>
    </div>
  {:else if state === 'done'}
    <div class="card stack" data-testid="move-done">
      <h2>Your money is on your computer</h2>
      <p>
        <strong>Replace the shop's QR codes and NFC sticker:</strong> they show your old address, which {houseName} no
        longer takes notes at. Make new ones from Shop on this phone.
      </p>
      <p class="small">
        Keep the words {houseName} gave you too: money sent to the old address later is sent on while {houseName} keeps
        the old copy, and those words reach it after.
      </p>
      <button class="primary full" on:click={done}>Done</button>
    </div>
  {:else}
    <div class="card stack">
      <h2>Not moved yet</h2>
      <p class="error">{error}</p>
      {#if fresh}
        <button class="full" on:click={() => fresh && check(fresh)}>Try again</button>
        <button class="link-btn" on:click={stop} disabled={busy}>Stop moving</button>
      {:else}
        <button class="full" on:click={() => { error = ''; state = 'explain'; }}>Back</button>
      {/if}
    </div>
  {/if}
  {#if error && state !== 'error'}<p class="error small">{error}</p>{/if}
</section>

<style>
  .steps {
    padding-left: 20px;
    display: grid;
    gap: 8px;
  }
  .center {
    text-align: center;
    padding: 28px 18px;
  }
  .addr {
    font-size: 19px;
    line-height: 1.35;
    word-break: break-all;
    font-weight: 500;
  }
  .code {
    display: block;
    margin-top: 6px;
    font-size: 36px;
    font-weight: 700;
    letter-spacing: 0.06em;
    font-variant-numeric: tabular-nums;
    color: var(--accent);
  }
</style>
