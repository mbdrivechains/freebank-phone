<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { PhoneClient, type AllowAsk, type ApprovalAsk, type NoteHolding, type PaymentKind, type Status } from './lib/api';
  import { RelayLink } from './lib/relay';
  import { loadMoving, loadPairing, forgetPairing, isHosted, type Pairing } from './lib/store';
  import { noteFlow, sendFlow } from './lib/sendflow';
  import { takePairFragment, takePayFragment, takeTokenFragment } from './lib/fragment';
  import Pair from './components/Pair.svelte';
  import Home from './components/Home.svelte';
  import Receive from './components/Receive.svelte';
  import Send from './components/Send.svelte';
  import Settings from './components/Settings.svelte';
  import Notes from './components/Notes.svelte';
  import Houses from './components/Houses.svelte';
  import NoteAction from './components/NoteAction.svelte';
  import Approve from './components/Approve.svelte';
  import HomeScreenHint from './components/HomeScreenHint.svelte';
  import Report from './components/Report.svelte';
  import Lock from './components/Lock.svelte';
  import Allow from './components/Allow.svelte';
  import Invite from './components/Invite.svelte';
  import ScanPay from './components/ScanPay.svelte';
  import HostedHome from './components/HostedHome.svelte';
  import Shop from './components/Shop.svelte';
  import MoveHome from './components/MoveHome.svelte';

  export let pairValue: string | null = null;
  /** A payment link the page was opened with (`#pay=`, desktop v0.2.8), already taken from the address bar. */
  export let payValue: string | null = null;
  /** A token link the page was opened with (`#token=`), already taken from the address bar. */
  export let tokenValue: string | null = null;
  // The token wallet's mint, set when the page is built; its code loads only when Tokens opens.
  const mintUrl: string = import.meta.env.VITE_FB_MINT ?? '';
  const loadTokens = () => import('./components/Tokens.svelte');
  // Ask FreeBank (phone page v0.4.6), the header's ?: its code and the recovery-word list load only when it opens.
  const loadAsk = () => import('./components/Ask.svelte');

  type Screen =
    | 'loading' | 'pair' | 'home' | 'receive' | 'send' | 'settings' | 'notes' | 'houses' | 'note'
    | 'invite' | 'scanpay' | 'shop' | 'move' | 'tokens';
  let screen: Screen = 'loading';
  let pairing: Pairing | null = null;
  let client: PhoneClient | null = null;
  let status: Status = 'idle';
  let unsub: (() => void) | null = null;
  // Face ID: the desktop asked for it on this session. Each unlock remounts the screen, so it asks again.
  let locked = false;
  let unlocks = 0;
  let unsubLocked: (() => void) | null = null;
  // Approvals the desktop asks for (desktop v0.2.5): shown over any screen, Face ID screen included.
  let approvals: ApprovalAsk[] = [];
  let unsubApprovals: (() => void) | null = null;
  let loadError = '';
  // The note action on screen (desktop v0.2.5): which house's notes, and send, redeem or demand.
  let noteAct: { holding: NoteHolding; kind: PaymentKind } | null = null;
  // "Report a problem or suggest something", from the footer on any screen.
  let reporting = false;
  // "Ask FreeBank", from the header's ? on any screen.
  let asking = false;
  // Desktop v0.2.8: phones asking to join at a house from this phone's invite (an owner's phone).
  let allows: AllowAsk[] = [];
  let unsubAllows: (() => void) | null = null;
  // A hosted wallet moving home: the new computer's pairing, waiting until the house is told.
  let moving: Pairing | null = null;
  let payNote = '';
  $: hosted = isHosted(pairing);

  function startClient(p: Pairing) {
    stopClient();
    pairing = p;
    client = new PhoneClient({ pPriv: p.pPriv, pPub: p.pPub, d: p.d }, () => RelayLink.open(p.relay, p.room));
    unsub = client.status.subscribe((s) => (status = s));
    unsubLocked = client.locked.subscribe((l) => {
      if (locked && !l) unlocks++;
      locked = l;
    });
    unsubApprovals = client.approvals.subscribe((l) => (approvals = l));
    unsubAllows = client.allows.subscribe((l) => (allows = l));
    client.start();
  }

  function stopClient() {
    unsub?.();
    unsub = null;
    unsubLocked?.();
    unsubLocked = null;
    unsubApprovals?.();
    unsubApprovals = null;
    approvals = [];
    unsubAllows?.();
    unsubAllows = null;
    allows = [];
    locked = false;
    client?.stop();
    client = null;
    status = 'idle';
  }

  onMount(async () => {
    try {
      pairing = await loadPairing();
      moving = isHosted(pairing) ? await loadMoving() : null;
    } catch (e) {
      loadError = 'This browser will not let the page store its key (private browsing?). ' + (e as Error).message;
    }
    if (pairValue) screen = 'pair';
    else if (tokenValue) {
      if (pairing) startClient(pairing);
      screen = 'tokens';
    } else if (pairing) {
      startClient(pairing);
      screen = 'home';
      if (payValue) openPay(payValue);
    } else {
      if (payValue) payNote = 'That was a payment link. Pair this phone with your desktop first, then use Scan to pay.';
      screen = 'pair';
    }
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
    if (!pairing) {
      screen = e.state?.screen === 'tokens' ? 'tokens' : 'pair';
      return;
    }
    screen = (e.state?.screen as Screen) ?? 'home';
    // A note action's screen needs its house; without it (a reload), back to Notes.
    if (screen === 'note' && !noteAct) screen = 'notes';
    // Screens for the other kind of pairing (an owner's invite, a hosted phone's shop): back home.
    if ((screen === 'invite' && hosted) || ((screen === 'shop' || screen === 'move') && !hosted)) screen = 'home';
  }

  // A pairing link opened while the page is already open (same document, only the hash changes).
  function onHash() {
    const token = takeTokenFragment();
    if (token) {
      tokenValue = token;
      openTokens();
      return;
    }
    const pay = takePayFragment();
    if (pay) {
      if (pairing) openPay(pay);
      else payNote = 'That was a payment link. Pair this phone with your desktop first, then use Scan to pay.';
      return;
    }
    const v = takePairFragment();
    if (!v) return;
    pairValue = v;
    screen = 'pair';
  }

  function openTokens() {
    if (screen === 'tokens') return;
    if (history.state?.screen) history.replaceState({ screen: 'tokens' }, '');
    else history.pushState({ screen: 'tokens' }, '');
    screen = 'tokens';
  }

  function closeTokens() {
    tokenValue = null;
    if (history.state?.screen === 'tokens') history.back();
    else screen = pairing ? 'home' : 'pair';
  }

  // A payment link (desktop v0.2.8): straight to Scan to pay, which reads it.
  function openPay(v: string) {
    payValue = v;
    go('scanpay');
  }

  function onVisible() {
    if (document.visibilityState === 'visible') client?.kick();
  }

  function onPaired(e: CustomEvent<Pairing>) {
    pairValue = null;
    moving = null;
    startClient(e.detail);
    screen = 'home';
  }

  // The hosted wallet moved home: this phone now belongs to the new computer.
  function onMoved(e: CustomEvent<Pairing>) {
    moving = null;
    startClient(e.detail);
    history.replaceState(null, '');
    screen = 'home';
  }

  async function startMove() {
    moving = await loadMoving().catch(() => null);
    go('move');
  }

  // `denied` comes in clear, so it isn't proof: trying again keeps the key and asks the desktop once more.
  function retry() {
    if (pairing) startClient(pairing);
  }

  async function forget() {
    stopClient();
    await forgetPairing();
    moving = null;
    sendFlow.reset();
    noteFlow.reset();
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
  {#if screen !== 'loading'}
    <div class="right">
      {#if pairing && screen !== 'pair'}
        <span class="status {status}" data-testid="status" role="status">
          <span class="dot" aria-hidden="true"></span>{statusText[status]}
        </span>
      {/if}
      {#if !asking}
        <button class="plain gear ask" aria-label="Ask FreeBank" data-testid="ask-btn" on:click={() => { reporting = false; asking = true; }}>?</button>
      {/if}
      {#if pairing && screen !== 'pair' && screen !== 'settings'}
        <button class="plain gear" aria-label="Settings" on:click={() => { asking = false; reporting = false; go('settings'); }}>⚙</button>
      {/if}
    </div>
  {/if}
</header>

{#if loadError}
  <p class="card error small">{loadError}</p>
{/if}

{#if reporting}
  <Report on:back={() => (reporting = false)} />
{:else if asking}
  {#await loadAsk()}
    <p class="muted center"><span class="spinner"></span></p>
  {:then m}
    <svelte:component this={m.default} on:back={() => (asking = false)} />
  {:catch e}
    <p class="card error small">Ask FreeBank didn't load: {e.message}</p>
  {/await}
{:else if screen === 'loading'}
  <p class="muted center"><span class="spinner"></span></p>
{:else if screen === 'pair'}
  {#if payNote}<p class="card small" data-testid="pay-note">{payNote}</p>{/if}
  {#key pairValue}
    <Pair {pairValue} alreadyPaired={!!pairing} on:paired={onPaired} />
  {/key}
  {#if mintUrl && !pairValue}
    <button class="full tokens-entry" data-testid="open-tokens" on:click={openTokens}>Tokens on this phone, no desktop needed</button>
  {/if}
{:else if screen === 'tokens'}
  {#await loadTokens()}
    <p class="muted center"><span class="spinner"></span></p>
  {:then m}
    <svelte:component this={m.default} {mintUrl} incoming={tokenValue} on:back={closeTokens} on:taken={() => (tokenValue = null)} />
  {:catch e}
    <p class="card error small">The token wallet didn't load: {e.message}</p>
  {/await}
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
  {#if screen === 'home' && hosted}
    <HostedHome {client} {status} {pairing} moving={!!moving} on:shop={() => go('shop')} on:receive={() => go('receive')}
      on:pay={() => { payValue = null; go('scanpay'); }} on:send={() => go('send')} on:notes={() => go('notes')}
      on:move={startMove} on:forget={forget} />
    <HomeScreenHint paired />
  {:else if screen === 'home'}
    <Home {client} {status} on:receive={() => go('receive')} on:send={() => go('send')} on:notes={() => go('notes')}
      on:scanpay={() => { payValue = null; go('scanpay'); }} on:invite={() => go('invite')} />
    {#if mintUrl}<button class="full tokens-entry" data-testid="open-tokens" on:click={openTokens}>Tokens</button>{/if}
    <HomeScreenHint paired />
  {:else if screen === 'receive'}
    <Receive {client} {status} on:back={() => go('home')}
      pay={hosted && pairing.house ? { house: pairing.house.house, houseName: pairing.house.name, shop: pairing.name } : null} />
  {:else if screen === 'send'}
    <Send {client} {status} on:back={() => go('home')} />
  {:else if screen === 'settings'}
    <Settings {pairing} {client} {locked} on:back={() => go('home')} on:forget={forget} />
  {:else if screen === 'notes'}
    <Notes {client} {status} on:back={() => go('home')} on:houses={() => go('houses')}
      on:act={(e) => { noteAct = e.detail; go('note'); }} />
  {:else if screen === 'houses'}
    <Houses {client} {status} on:back={() => go('notes')} />
  {:else if screen === 'note' && noteAct}
    <NoteAction {client} {status} holding={noteAct.holding} kind={noteAct.kind} on:back={() => go('notes')} />
  {:else if screen === 'invite' && !hosted}
    <Invite {client} {status} on:back={() => go('home')} />
  {:else if screen === 'scanpay'}
    <ScanPay {client} {status} initial={payValue} on:back={() => { payValue = null; go('home'); }} />
  {:else if screen === 'shop' && hosted && pairing.house}
    <Shop {client} {status} house={pairing.house.house} houseName={pairing.house.name} shopName={pairing.name} on:back={() => go('home')} />
  {:else if screen === 'move' && hosted}
    <MoveHome {client} {status} {pairing} resume={moving} on:back={() => go('home')} on:moved={onMoved} />
  {/if}
  {/key}
{/if}

{#if client && pairing && approvals.length && screen !== 'pair' && status !== 'denied'}
  {#key approvals[0].id}
    <Approve {client} ask={approvals[0]} />
  {/key}
{:else if client && pairing && !hosted && allows.length && screen !== 'pair' && status !== 'denied'}
  {#key allows[0].id}
    <Allow {client} ask={allows[0]} />
  {/key}
{/if}

{#if !reporting && !asking && screen !== 'loading'}
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
  .ask {
    font-weight: 700;
  }
  .center { text-align: center; padding: 40px 0; }
  .tokens-entry { margin-top: 12px; }
</style>
