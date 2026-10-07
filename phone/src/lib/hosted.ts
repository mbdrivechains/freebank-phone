// A wallet kept at a house for this phone (relay/PROTOCOL.md, "Hosted wallets", desktop v0.2.8): where it is in its
// setup, confirming the recovery words, and the Shop screen's "Paid" check. Pure functions, tested on their own.
import type { NoteHolding } from './api';

/** `status.step`: being made, words to show, joining the house, ready, moving home, moved home, or failed. */
export type Step = 'setup' | 'words' | 'joining' | 'ready' | 'moving' | 'moved' | 'failed';

const STEPS: ReadonlySet<string> = new Set(['setup', 'words', 'joining', 'ready', 'moving', 'moved', 'failed']);

/** The step a status names; anything unknown reads as still being set up (a newer desktop's step). */
export function stepOf(s: { step?: unknown } | null | undefined): Step {
  const v = String(s?.step ?? '');
  return STEPS.has(v) ? (v as Step) : 'setup';
}

/** How often to ask again while a step waits on the desktop or the chain, in ms; 0: nothing to wait for. */
export function pollMs(step: Step): number {
  return step === 'setup' ? 3000 : step === 'joining' || step === 'moving' ? 5000 : 0;
}

/**
 * Which words to ask back: `n` different positions (0-based, in order), drawn with `rand` (0 <= rand() < 1). Asking
 * three shows the words were written down without retyping all 24.
 */
export function pickConfirm(count: number, n = 3, rand: () => number = secureRandom): number[] {
  const picked = new Set<number>();
  while (picked.size < Math.min(n, count)) picked.add(Math.floor(rand() * count));
  return [...picked].sort((a, b) => a - b);
}

function secureRandom(): number {
  return globalThis.crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;
}

/** Whether the typed answers match the words at `positions`: case and spaces don't matter. */
export function confirmMatches(words: string[], positions: number[], answers: string[]): boolean {
  return positions.length > 0 && positions.every((p, i) => (answers[i] ?? '').trim().toLowerCase() === (words[p] ?? '').trim().toLowerCase());
}

/** What the Shop screen watches: this house's notes only, as the desktop lists them (confirmed). ECX and payments
 *  still on their way don't count, so a payment that is never confirmed, or money from someone else, can't mark a
 *  sale paid (security review of v0.2.8, L6). */
export function heldValue(notes: NoteHolding[] | null, house: number): number {
  const n = (notes ?? []).filter((x) => x.house === house).reduce((t, x) => t + x.amount, 0);
  return Math.round(n * 1e8) / 1e8;
}

/** Paid: what's held rose by at least the amount asked since the QR code went up. */
export function isPaid(before: number, now: number, amount: number): boolean {
  return now - before >= amount - 1e-9;
}

/** The day's takings, kept on this phone only: by local date, newest first. */
export interface Taking {
  at: number; // ms
  amount: number; // ECX
}

const TAKINGS = 'freebank-takings';

export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function loadTakings(now = Date.now(), storage: Pick<Storage, 'getItem'> | null = safeStorage()): Taking[] {
  try {
    const all = JSON.parse(storage?.getItem(TAKINGS) ?? '{}');
    const list = all?.[dayKey(now)];
    return Array.isArray(list) ? list.filter((t) => typeof t?.at === 'number' && typeof t?.amount === 'number') : [];
  } catch {
    return [];
  }
}

/** Add a taking to today's list; other days are dropped (only today is shown). */
export function addTaking(t: Taking, storage: Pick<Storage, 'getItem' | 'setItem'> | null = safeStorage()): Taking[] {
  const list = [t, ...loadTakings(t.at, storage)];
  try {
    storage?.setItem(TAKINGS, JSON.stringify({ [dayKey(t.at)]: list }));
  } catch {
    // private browsing: the list lasts as long as the screen
  }
  return list;
}

function safeStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
