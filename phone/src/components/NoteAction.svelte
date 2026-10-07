<script lang="ts">
  // Send, redeem or demand a house's notes (desktop v0.2.5). The same guard as a send: Face ID when this phone chose
  // it, the daily limit, and the desktop's approval above it.
  import { createEventDispatcher } from 'svelte';
  import type { NoteHolding, PaymentKind, PhoneClient, Status } from '../lib/api';
  import { fmtEcx, parseAmount } from '../lib/format';
  import { assertPasskey, passkeyError } from '../lib/passkey';
  import { noteFlow } from '../lib/sendflow';
  import Back from './Back.svelte';
  import Copy from './Copy.svelte';

  export let client: PhoneClient;
  export let status: Status;
  export let holding: NoteHolding;
  export let kind: PaymentKind;
  /** Scan to pay (desktop v0.2.8): a shop's payment code fills the address, and the amount unless it left it open. */
  export let presetAddress = '';
  export let presetAmount: number | null = null;
  export let shop = '';
  const dispatch = createEventDispatcher<{ back: void }>();

  const name = holding.name ?? `House #${holding.house}`;
  const free = Math.max(0, Math.round((holding.amount - holding.demanded) * 1e8) / 1e8);
  const verb = kind === 'note-redeem' ? 'Redeem' : kind === 'note-demand' ? 'Demand' : 'Send';
  const done = kind === 'note-redeem' ? 'Redeemed' : kind === 'note-demand' ? 'Demanded' : 'Sent';
  // What the node takes: redeem what can be redeemed now; demand or send the notes not already under demand.
  const most = kind === 'note-redeem' ? holding.redeemable : free;
  // What a note action costs besides the notes, and counts against the daily limit (desktop v0.2.5): the fee, and up
  // to two carrier outputs of 1000 sats.
  const EXTRA = 0.00102;

  let address = presetAddress;
  // Fixed decimals: String(1e-7) would be "1e-7", which the amount field doesn't take.
  const fixed = (v: number) => v.toFixed(8).replace(/\.?0+$/, '');
  let amountText = presetAddress ? (presetAmount !== null ? fixed(presetAmount) : '') : fixed(most);
  let limitLeft: number | null = null;
  let reviewing = false;
  let formError = '';
  let asked = false;
  let faceIdSends = false;
  let sendCh: { challenge: string; cred?: string; at: number } | null = null;
  let authError = '';
  let checkingFaceId = false;

  $: if (!asked && status === 'connected') {
    asked = true;
    client.nodeStatus().then(
      (s) => {
        // A hosted phone (desktop v0.2.8) has no daily limit, and every payment takes Face ID.
        limitLeft = s.limit_left ?? null;
        faceIdSends = !!s.face_id_sends || !!s.hosted;
      },
      () => setTimeout(() => (asked = false), 5000),
    );
  }

  async function fetchSendChallenge() {
    sendCh = null;
    checkingFaceId = true;
    try {
      const s = await client.nodeStatus();
      faceIdSends = !!s.face_id_sends || !!s.hosted;
      if (faceIdSends) {
        const c = await client.authStart('send');
        if (c.cred) sendCh = { ...c, at: Date.now() };
        else faceIdSends = false;
      }
    } catch (e) {
      authError = (e as Error).message;
    } finally {
      checkingFaceId = false;
    }
  }

  $: amount = parseAmount(amountText);
  $: overLimit = amount !== null && limitLeft !== null && amount + EXTRA > limitLeft + 1e-12;

  function review() {
    formError = '';
    const a = address.trim();
    if (kind === 'note-send' && !/^[A-Za-z0-9]{20,100}$/.test(a)) formError = 'Enter the address you are sending the notes to (it starts with X).';
    else if (amount === null) formError = 'Enter an amount in ECX, like 0.05 (up to 8 decimals).';
    else if (amount > most + 1e-12) formError = `You can ${verb.toLowerCase()} at most ${fmtEcx(most)} ECX of these notes.`;
    if (formError) return;
    address = a;
    reviewing = true;
    authError = '';
    fetchSendChallenge();
  }

  async function go() {
    const p = { kind, house: holding.house, address: kind === 'note-send' ? address : '', amount: amount! };
    if (!faceIdSends) {
      reviewing = false;
      noteFlow.pay(client, p);
      return;
    }
    authError = '';
    if (!sendCh?.cred || Date.now() - sendCh.at > 100_000) {
      await fetchSendChallenge();
      authError = `Tap ${verb} again.`;
      return;
    }
    let auth;
    try {
      auth = await assertPasskey(sendCh.challenge, sendCh.cred);
    } catch (e) {
      authError = passkeyError(e);
      return;
    }
    reviewing = false;
    sendCh = null;
    noteFlow.pay(client, p, auth);
  }

  function edit() {
    const s = $noteFlow;
    if (s.k === 'error') {
      address = s.address;
      amountText = String(s.amount);
    }
    noteFlow.reset();
  }

  function finish() {
    noteFlow.reset();
    dispatch('back');
  }
</script>

<Back title="{verb} notes" on:back={() => dispatch('back')} />

<section class="stack" data-testid="note-action">
  {#if $noteFlow.k === 'form'}
    <div class="card stack">
      <div class="muted small">{name} · house #{holding.house} · {holding.state_name}</div>
      <div>You hold <strong>{fmtEcx(holding.amount)} ECX</strong> of its notes{holding.demanded > 0 ? `, ${fmtEcx(holding.demanded)} ECX under demand` : ''}.</div>
    </div>
  {/if}

  {#if $noteFlow.k === 'form' && !reviewing}
    <form class="stack" on:submit|preventDefault={review}>
      {#if kind === 'note-send' && presetAddress}
        <div data-testid="pay-to">
          <div class="muted small">Paying</div>
          <div><strong>{shop || 'This address'}</strong></div>
          <div class="mono wrap small">{address}</div>
        </div>
      {:else if kind === 'note-send'}
        <div>
          <label for="to">Send the notes to</label>
          <input id="to" class="mono" bind:value={address} placeholder="X…" autocomplete="off" autocapitalize="off"
            autocorrect="off" spellcheck="false" enterkeyhint="next" />
        </div>
      {/if}
      <div>
        <label for="amt">Amount of notes</label>
        <div class="amtwrap">
          <input id="amt" bind:value={amountText} inputmode="decimal" placeholder="0.00" autocomplete="off" enterkeyhint="done" />
          <span class="unit">ECX</span>
        </div>
      </div>
      <p class="small" data-testid="note-explain">
        {#if kind === 'note-send' && holding.type === 'members'}
          Members only: this house's notes can go only to its members. The house owes them to whoever holds them.
        {:else if kind === 'note-send'}
          The notes go to that address; the house owes them to whoever holds them.
        {:else if kind === 'note-redeem'}
          {#if holding.state === 'd'}
            While the house is suspended, only notes under demand can be redeemed, with their interest.
          {:else}
            The house pays you ECX for them, one for one, from its reserves.
          {/if}
        {:else if holding.state === 'd'}
          Your notes join the house's payout queue and earn {holding.rate_bps ? `${holding.rate_bps / 100}%` : 'interest'} a year from today. They can't be sent while they wait.
        {:else if holding.state === 'o' || holding.state === 's'}
          A formal demand: the house must pay it within its demand window. The notes can't be sent while they wait.
        {:else}
          The house has failed, so holders are paid from what it has left.
        {/if}
      </p>
      <p class="muted small">
        Fee 0.001 ECX.
        {#if limitLeft !== null}This phone can move up to {fmtEcx(limitLeft)} ECX more today, fees included; more waits for your desktop.{/if}
      </p>
      {#if formError}<p class="error small">{formError}</p>{/if}
      <button class="primary full" type="submit" disabled={status !== 'connected'}>Review</button>
    </form>
  {:else if $noteFlow.k === 'form' && reviewing}
    <div class="card stack">
      <div class="big">{fmtEcx(amount ?? 0)} <span class="unit">ECX</span></div>
      <div class="muted small">{verb} {name}'s notes</div>
      {#if kind === 'note-send'}<div><div class="muted small">To</div>{#if shop}<div><strong>{shop}</strong></div>{/if}<div class="mono wrap">{address}</div></div>{/if}
      {#if overLimit}<p class="small warnbox">This is more than today's limit, so it waits for you to confirm it on your desktop.</p>{/if}
    </div>
    <button class="primary full" on:click={go} disabled={status !== 'connected' || checkingFaceId || (faceIdSends && !sendCh)}
      >{faceIdSends ? `${verb} with Face ID` : `${verb} ${fmtEcx(amount ?? 0)} ECX`}</button
    >
    {#if authError}<p class="error small">{authError}</p>{/if}
    <button class="full" on:click={() => (reviewing = false)}>Change</button>
  {:else if $noteFlow.k === 'sending'}
    <div class="card center"><span class="spinner"></span><p>Working…</p></div>
  {:else if $noteFlow.k === 'held'}
    <div class="card stack center" data-testid="note-held">
      <span class="spinner"></span>
      <h2>Waiting for your desktop…</h2>
      {#if $noteFlow.why === 'locked'}<p class="lockedbox">Your desktop wallet is locked: confirm on your desktop.</p>{/if}
      <p>Open FreeBank on your desktop and confirm it there.</p>
      <p class="muted small">You can leave this screen; the answer shows up here.</p>
    </div>
  {:else if $noteFlow.k === 'done'}
    <div class="card stack" data-testid="note-receipt">
      <div class="ok">✓ {done}</div>
      <div class="big">{fmtEcx($noteFlow.amount)} <span class="unit">ECX</span></div>
      {#if $noteFlow.address}<div><div class="muted small">To</div><div class="mono wrap">{$noteFlow.address}</div></div>{/if}
      <div>
        <div class="muted small">Transaction ID</div>
        <div class="mono wrap">{$noteFlow.txid}</div>
      </div>
      <Copy text={$noteFlow.txid} label="Copy ID" />
      {#if $noteFlow.wasHeld}<p class="muted small">Confirmed on your desktop.</p>{/if}
    </div>
    <button class="primary full" on:click={finish}>Done</button>
  {:else if $noteFlow.k === 'error'}
    <div class="card stack" data-testid="note-error">
      <h2>{$noteFlow.unsure ? 'Not confirmed' : 'Not done'}</h2>
      <p class="error">{$noteFlow.msg}</p>
    </div>
    <button class="full" on:click={edit}>Back to the form</button>
  {/if}
</section>

<style>
  .amtwrap {
    position: relative;
  }
  .amtwrap input {
    padding-right: 64px;
    font-variant-numeric: tabular-nums;
  }
  .amtwrap .unit {
    position: absolute;
    right: 14px;
    top: 50%;
    transform: translateY(-50%);
    color: var(--accent);
    font-weight: 650;
  }
  .big {
    font-size: 32px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }
  .big .unit {
    font-size: 18px;
    color: var(--accent);
  }
  .wrap {
    word-break: break-all;
  }
  .center {
    text-align: center;
    padding: 28px 18px;
  }
  .warnbox,
  .lockedbox {
    color: var(--warn);
    border: 1px solid var(--warn);
    border-radius: 10px;
    padding: 10px 12px;
  }
  .lockedbox {
    font-weight: 600;
  }
  .ok {
    color: var(--success);
    font-weight: 700;
    font-size: 18px;
  }
</style>
