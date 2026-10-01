<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { PhoneClient, type Status } from './lib/api';
  import { RelayLink } from './lib/relay';
  import { loadPairing, forgetPairing, type Pairing } from './lib/store';
  import { sendFlow } from './lib/sendflow';
  import { takePairFragment } from './lib/fragment';
  import Pair from './components/Pair.svelte';
  import Home from './components/Home.svelte';
  import Receive from './components/Receive.svelte';
  import Send from './components/Send.svelte';
  import Settings from './components/Settings.svelte';
  import HomeScreenHint from './components/HomeScreenHint.svelte';
  import Report from './components/Report.svelte';
  import Lock from './components/Lock.svelte';

  export let pairValue: string | null = null;

  type Screen = 'loading' | 'pair' | 'home' | 'receive' | 'send' | 'settings';
  let screen: Screen = 'loading';
  let pairing: Pairing | null = null;
  let client: PhoneClient | null = null;
  let status: Status = 'idle';
  let unsub: (() => void) | null = null;
  // Face ID: the desktop asked for it on this session. Each unlock remounts the screen, so it asks again.
  let locked = false;
  let unlocks = 0;
  let unsubLocked: (() => void) | null = null;
  let loadError = '';
  // "Report a problem or suggest something", from the footer on any screen.
  let reporting = false;

  function startClient(p: Pairing) {
    stopClient();
    pairing = p;
    client = new PhoneClient({ pPriv: p.pPriv, pPub: p.pPub, d: p.d }, () => RelayLink.open(p.relay, p.room));
    unsub = client.status.subscribe((s) => (status = s));
    unsubLocked = client.locked.subscribe((l) => {
      if (locked && !l) unlocks++;
      locked = l;
    });
    client.start();
  }

  function stopClient() {
    unsub?.();
    unsub = null;
    unsubLocked?.();
    unsubLocked = null;
    locked = false;
    client?.stop();
    client = null;
    status = 'idle';
  }

  onMount(async () => {
    try {
      pairing = await loadPairing();
    } catch (e) {
      loadError = 'This browser will not let the page store its key (private browsing?). ' + (e as Error).message;
    }
    if (pairValue) screen = 'pair';
    else if (pairing) {
      startClient(pairing);
      screen = 'home';
    } else screen = 'pair';
  });

  // Phone back button / swipe: sub-screens are history entries on top of home.
  function go(s: Screen) {
    if (s === screen) return;
    if (s === 'home') {
      if (history.state?.screen) history.back();
      else screen = 'home';
      return;
    }
    if (history.state?.screen) history.replaceState({ screen: s }, '');
    else history.pushState({ screen: s }, '');
    screen = s;
  }
  function onPop(e: PopStateEvent) {
    if (!pairing) return;
    screen = (e.state?.screen as Screen) ?? 'home';
  }

  // A pairing link opened while the page is already open (same document, only the hash changes).
  function onHash() {
    const v = takePairFragment();
    if (!v) return;
    pairValue = v;
    screen = 'pair';
  }

  function onVisible() {
    if (document.visibilityState === 'visible') client?.kick();
  }

  function onPaired(e: CustomEvent<Pairing>) {
    pairValue = null;
    startClient(e.detail);
    screen = 'home';
  }

  // `denied` comes in clear, so it isn't proof: trying again keeps the key and asks the desktop once more.
  function retry() {
    if (pairing) startClient(pairing);
  }

  async function forget() {
    stopClient();
    await forgetPairing();
    sendFlow.reset();
    pairing = null;
    history.replaceState(null, '');
    screen = 'pair';
  }

  onDestroy(stopClient);

  const statusText: Record<Status, string> = {
    idle: '',
    connecting: 'Connecting…',
    connected: 'Connected',
    reconnecting: 'Reconnecting…',
    offline: 'Desktop offline',
    denied: 'Removed on the desktop',
  };
</script>

<svelte:window on:popstate={onPop} on:hashchange={onHash} on:online={() => client?.kick()} />
<svelte:document on:visibilitychange={onVisible} />

<header>
  <h1><span class="mark" aria-hidden="true">☉</span>FreeBank</h1>
  {#if pairing && screen !== 'pair'}
    <div class="right">
      <span class="status {status}" data-testid="status" role="status">
        <span class="dot" aria-hidden="true"></span>{statusText[status]}
      </span>
      {#if screen !== 'settings'}
        <button class="plain gear" aria-label="Settings" on:click={() => go('settings')}>⚙</button>
      {/if}
    </div>
  {/if}
</header>

{#if loadError}
  <p class="card error small">{loadError}</p>
{/if}

{#if reporting}
  <Report on:back={() => (reporting = false)} />
{:else if screen === 'loading'}
  <p class="muted center"><span class="spinner"></span></p>
{:else if screen === 'pair'}
  {#key pairValue}
    <Pair {pairValue} alreadyPaired={!!pairing} on:paired={onPaired} />
  {/key}
  {#if !pairValue}<HomeScreenHint />{/if}
{:else if status === 'denied' && screen !== 'settings'}
  <section class="card stack">
    <h2>This phone was removed</h2>
    <p>Your desktop no longer accepts this phone. Forget it here, then pair again from your desktop app (Settings → Pair a phone).</p>
    <p class="muted small">If you didn't remove it on your desktop, try again first: this phone keeps its key until you forget it.</p>
    <button class="full" on:click={retry}>Try again</button>
    <button class="danger full" on:click={forget}>Forget this desktop</button>
  </section>
{:else if client && pairing && locked && screen !== 'settings'}
  <Lock {client} />
{:else if client && pairing}
  {#key unlocks}
  {#if screen === 'home'}
    <Home {client} {status} on:receive={() => go('receive')} on:send={() => go('send')} />
    <HomeScreenHint paired />
  {:else if screen === 'receive'}
    <Receive {client} {status} on:back={() => go('home')} />
  {:else if screen === 'send'}
    <Send {client} {status} on:back={() => go('home')} />
  {:else if screen === 'settings'}
    <Settings {pairing} {client} {locked} on:back={() => go('home')} on:forget={forget} />
  {/if}
  {/key}
{/if}

{#if !reporting && screen !== 'loading'}
  <footer>
    <button class="plain small muted" on:click={() => (reporting = true)}>Report a problem or suggest something</button>
  </footer>
{/if}

<style>
  footer {
    margin-top: 24px;
    text-align: center;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    min-height: 52px;
    margin-bottom: 12px;
  }
  h1 {
    font-size: 21px;
    font-weight: 700;
    letter-spacing: -0.01em;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .mark {
    color: var(--accent);
    font-size: 26px;
    line-height: 1;
  }
  .right {
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .status {
    font-size: 14px;
    color: var(--muted);
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--muted);
  }
  .status.connected .dot { background: var(--success); }
  .status.offline .dot, .status.denied .dot { background: var(--error); }
  .status.reconnecting .dot, .status.connecting .dot { background: var(--warn); }
  .gear {
    font-size: 24px;
    min-width: 48px;
    color: var(--muted);
  }
  .center { text-align: center; padding: 40px 0; }
</style>
