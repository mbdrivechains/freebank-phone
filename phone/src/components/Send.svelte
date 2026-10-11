<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import type { PhoneClient, Status } from '../lib/api';
  import { fmtEcx, parseAmount } from '../lib/format';
  import { assertPasskey, passkeyError } from '../lib/passkey';
  import { sendFlow } from '../lib/sendflow';
  import Back from './Back.svelte';
  import Copy from './Copy.svelte';

  export let client: PhoneClient;
  export let status: Status;
  const dispatch = createEventDispatcher();

  let address = '';
  let amountText = '';
  let limitLeft: number | null = null;
  let reviewing = false;
  let formError = '';
  let asked = false;
  // Face ID before each send, if this phone chose it: the challenge is fetched when the payment is reviewed, so
  // the Send tap goes straight to the prompt (Safari asks only from a tap).
  let faceIdSends = false;
  let sendCh: { challenge: string; cred?: string; at: number } | null = null;
  let authError = '';

  $: if (!asked && status === 'connected') {
    asked = true;
    client.nodeStatus().then(
      (s) => {
        limitLeft = s.limit_left ?? null;
        faceIdSends = !!s.face_id_sends || !!s.hosted;
      },
      // Ask again in a while, not at once: a desktop that refuses would get a request per refusal (review note).
      () => setTimeout(() => (asked = false), 5000),
    );
  }

  // Whether this send needs Face ID is settled when the payment is reviewed, from the desktop's answer then:
  // a challenge without a passkey id means the phone has none now.
  let checkingFaceId = false;
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
  $: overLimit = amount !== null && limitLeft !== null && amount > limitLeft + 1e-12;

  function review() {
    const a = address.trim();
    formError = '';
    if (!/^[A-Za-z0-9]{20,100}$/.test(a)) formError = 'Enter the address you are paying (it starts with X).';
    else if (amount === null) formError = 'Enter an amount in sECX, like 0.05 (up to 8 decimals).';
    if (formError) return;
    address = a;
    reviewing = true;
    authError = '';
    fetchSendChallenge();
  }

  async function send() {
    if (!faceIdSends) {
      reviewing = false;
      sendFlow.start(client, address, amount!);
      return;
    }
    authError = '';
    if (!sendCh?.cred || Date.now() - sendCh.at > 100_000) {
      await fetchSendChallenge();
      authError = 'Tap Send again.';
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
    sendFlow.start(client, address, amount!, auth);
  }

  function newPayment() {
    sendFlow.reset();
    address = '';
    amountText = '';
    asked = false; // the limit changed
  }

  function edit() {
    const s = $sendFlow;
    if (s.k === 'error') {
      address = s.address;
      amountText = String(s.amount);
    }
    sendFlow.reset();
  }
</script>

<Back title="Send" on:back={() => dispatch('back')} />

<section class="stack" data-testid="send">
  {#if $sendFlow.k === 'form' && !reviewing}
    <form class="stack" on:submit|preventDefault={review}>
      <div>
        <label for="to">Pay to address</label>
        <input id="to" class="mono" bind:value={address} placeholder="X…" autocomplete="off" autocapitalize="off"
          autocorrect="off" spellcheck="false" enterkeyhint="next" />
      </div>
      <div>
        <label for="amt">Amount</label>
        <div class="amtwrap">
          <input id="amt" bind:value={amountText} inputmode="decimal" placeholder="0.00" autocomplete="off" enterkeyhint="done" />
          <span class="unit">sECX</span>
        </div>
      </div>
      <p class="muted small" data-testid="limit">
        {#if limitLeft !== null}
          You can send up to <strong>{fmtEcx(limitLeft)} sECX</strong> more today from this phone. Larger payments wait for you to approve them on your desktop.
        {:else}
          Payments over this phone's daily limit wait for you to approve them on your desktop.
        {/if}
      </p>
      {#if formError}<p class="error small">{formError}</p>{/if}
      <button class="primary full" type="submit" disabled={status !== 'connected'}>Review</button>
    </form>
  {:else if $sendFlow.k === 'form' && reviewing}
    <div class="card stack">
      <div class="big">{fmtEcx(amount ?? 0)} <span class="unit">sECX</span></div>
      <div><div class="muted small">To</div><div class="mono wrap">{address}</div></div>
      {#if overLimit}
        <p class="small warnbox">This is more than today's limit, so it waits for you to confirm it on your desktop.</p>
      {/if}
    </div>
    <button class="primary full" on:click={send} disabled={status !== 'connected' || checkingFaceId || (faceIdSends && !sendCh)}
      >{faceIdSends ? 'Send with Face ID' : `Send ${fmtEcx(amount ?? 0)} sECX`}</button
    >
    {#if authError}<p class="error small">{authError}</p>{/if}
    <button class="full" on:click={() => (reviewing = false)}>Change</button>
  {:else if $sendFlow.k === 'sending'}
    <div class="card center"><span class="spinner"></span><p>Sending…</p></div>
  {:else if $sendFlow.k === 'held'}
    <div class="card stack center" data-testid="held">
      <span class="spinner"></span>
      <h2>Waiting for your desktop…</h2>
      {#if $sendFlow.why === 'locked'}
        <p class="lockedbox" data-testid="held-locked">Your desktop wallet is locked: confirm on your desktop.</p>
      {/if}
      <p>Open FreeBank on your desktop and approve sending <strong>{fmtEcx($sendFlow.amount)} sECX</strong>.</p>
      <p class="muted small">You can leave this screen; the answer shows up here.</p>
    </div>
  {:else if $sendFlow.k === 'done'}
    <div class="card stack" data-testid="receipt">
      <div class="ok">✓ Sent</div>
      <div class="big">{fmtEcx($sendFlow.amount)} <span class="unit">sECX</span></div>
      <div><div class="muted small">To</div><div class="mono wrap">{$sendFlow.address}</div></div>
      <div>
        <div class="muted small">Transaction ID</div>
        <div class="mono wrap" data-testid="receipt-txid">{$sendFlow.txid}</div>
      </div>
      <Copy text={$sendFlow.txid} label="Copy ID" />
      {#if $sendFlow.wasHeld}<p class="muted small">Confirmed on your desktop.</p>{/if}
    </div>
    <button class="primary full" on:click={() => { newPayment(); dispatch('back'); }}>Done</button>
  {:else if $sendFlow.k === 'error'}
    <div class="card stack" data-testid="send-error">
      <h2>{$sendFlow.unsure ? 'Not confirmed' : 'Not sent'}</h2>
      <p class="error">{$sendFlow.msg}</p>
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
