// The state of the one payment in progress. Lives outside the Send screen so leaving the
// screen (back button) does not lose a send that is waiting for the desktop.
import { writable } from 'svelte/store';
import { LostError, type AssertionParts, type HeldWhy, type PhoneClient } from './api';

export type SendState =
  | { k: 'form' }
  | { k: 'sending'; address: string; amount: number }
  | { k: 'held'; address: string; amount: number; confirmId: string; why: HeldWhy }
  | { k: 'done'; address: string; amount: number; txid: string; wasHeld: boolean }
  // `unsure`: no answer came, so the payment may or may not have gone out (check History before trying again).
  | { k: 'error'; address: string; amount: number; msg: string; unsure: boolean };

export function createSendFlow() {
  const { subscribe, set } = writable<SendState>({ k: 'form' });
  let busy = false;
  return {
    subscribe,
    reset() {
      if (!busy) set({ k: 'form' });
    },
    /** `auth`: Face ID over a send challenge, when this phone chose it before each send. */
    async start(client: PhoneClient, address: string, amount: number, auth?: AssertionParts) {
      if (busy) return;
      busy = true;
      let wasHeld = false;
      set({ k: 'sending', address, amount });
      try {
        const r = await client.send(
          address,
          amount,
          (confirmId, why) => {
            wasHeld = true;
            set({ k: 'held', address, amount, confirmId, why });
          },
          auth,
        );
        set({ k: 'done', address, amount, txid: r.txid, wasHeld });
      } catch (e) {
        set({ k: 'error', address, amount, msg: (e as Error).message, unsure: e instanceof LostError });
      } finally {
        busy = false;
      }
    },
  };
}

export const sendFlow = createSendFlow();
