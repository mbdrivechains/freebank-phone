// The state of a payment in progress. Lives outside the screens so leaving one (back button) does not lose a payment
// that is waiting for the desktop. `sendFlow` is ECX from the Send screen; `noteFlow` is a house's notes (v0.2.5).
import { writable } from 'svelte/store';
import { LostError, type AssertionParts, type HeldWhy, type Payment, type PaymentKind, type PhoneClient } from './api';

interface What {
  kind: PaymentKind;
  house?: number;
  address: string;
  amount: number;
}

export type SendState =
  | { k: 'form' }
  | ({ k: 'sending' } & What)
  | ({ k: 'held'; confirmId: string; why: HeldWhy } & What)
  | ({ k: 'done'; txid: string; wasHeld: boolean } & What)
  // `unsure`: no answer came, so the payment may or may not have gone out (check History before trying again).
  | ({ k: 'error'; msg: string; unsure: boolean } & What);

export function createPaymentFlow() {
  const { subscribe, set } = writable<SendState>({ k: 'form' });
  let busy = false;
  async function pay(client: PhoneClient, p: Payment, auth?: AssertionParts) {
    if (busy) return;
    busy = true;
    let wasHeld = false;
    const what: What = { kind: p.kind, house: p.house, address: p.address, amount: p.amount };
    set({ k: 'sending', ...what });
    try {
      const r = await client.pay(
        p,
        (confirmId, why) => {
          wasHeld = true;
          set({ k: 'held', confirmId, why, ...what });
        },
        auth,
      );
      set({ k: 'done', txid: r.txid, wasHeld, ...what });
    } catch (e) {
      set({ k: 'error', msg: (e as Error).message, unsure: e instanceof LostError, ...what });
    } finally {
      busy = false;
    }
  }
  return {
    subscribe,
    reset() {
      if (!busy) set({ k: 'form' });
    },
    pay,
    /** `auth`: Face ID over a send challenge, when this phone chose it before each send. */
    start(client: PhoneClient, address: string, amount: number, auth?: AssertionParts) {
      return pay(client, { kind: 'send', address, amount }, auth);
    },
  };
}

export const sendFlow = createPaymentFlow();
export const noteFlow = createPaymentFlow();
