import { describe, expect, it } from 'vitest';
import { addTaking, confirmMatches, dayKey, heldValue, isPaid, loadTakings, pickConfirm, pollMs, stepOf } from './hosted';
import type { NoteHolding } from './api';

describe('a hosted wallet\'s steps (desktop v0.2.8)', () => {
  it('reads the step, and anything unknown as still being set up', () => {
    for (const s of ['setup', 'words', 'joining', 'ready', 'moving', 'moved', 'failed']) expect(stepOf({ step: s })).toBe(s);
    expect(stepOf({ step: 'something-newer' })).toBe('setup');
    expect(stepOf(null)).toBe('setup');
  });

  it('asks again only while the desktop or the chain is working', () => {
    expect(pollMs('setup')).toBeGreaterThan(0);
    expect(pollMs('joining')).toBeGreaterThan(0);
    expect(pollMs('moving')).toBeGreaterThan(0);
    for (const s of ['words', 'ready', 'moved', 'failed'] as const) expect(pollMs(s)).toBe(0);
  });
});

describe('checking the recovery words', () => {
  const words = Array.from({ length: 24 }, (_, i) => `word${i + 1}`);

  it('asks three different positions, in order', () => {
    let k = 0;
    const seq = [0.5, 0.5, 0.1, 0.9]; // a repeat is drawn again
    const p = pickConfirm(24, 3, () => seq[k++ % seq.length]);
    expect(p).toEqual([2, 12, 21]);
    for (let i = 0; i < 50; i++) {
      const q = pickConfirm(24);
      expect(new Set(q).size).toBe(3);
      expect(q.every((x) => x >= 0 && x < 24)).toBe(true);
    }
  });

  it('matches regardless of case and spaces, and only when all match', () => {
    expect(confirmMatches(words, [0, 5, 23], [' Word1', 'WORD6 ', 'word24'])).toBe(true);
    expect(confirmMatches(words, [0, 5, 23], ['word1', 'word6', 'word23'])).toBe(false);
    expect(confirmMatches(words, [0, 5, 23], ['word1', 'word6'])).toBe(false);
    expect(confirmMatches(words, [], [])).toBe(false);
  });
});

describe('the Shop screen sees a payment', () => {
  const note = (house: number, amount: number) => ({ house, amount } as NoteHolding);

  it("counts only the house's notes: not other houses, not sECX (security review of v0.2.8, L6)", () => {
    expect(heldValue([note(5, 0.1), note(3, 9)], 5)).toBe(0.1);
    expect(heldValue([note(5, 0.1), note(5, 0.02)], 5)).toBe(0.12);
    expect(heldValue(null, 5)).toBe(0);
  });

  it('paid once the rise reaches the amount', () => {
    expect(isPaid(0.1, 0.15, 0.05)).toBe(true);
    expect(isPaid(0.1, 0.1499, 0.05)).toBe(false);
    expect(isPaid(0.1, 0.3, 0.05)).toBe(true);
  });

  it("keeps today's takings, newest first, and drops other days", () => {
    const mem: Record<string, string> = {};
    const storage = { getItem: (k: string) => mem[k] ?? null, setItem: (k: string, v: string) => void (mem[k] = v) };
    const day = new Date(2026, 9, 4, 12).getTime();
    addTaking({ at: day, amount: 0.05 }, storage);
    const list = addTaking({ at: day + 60_000, amount: 0.1 }, storage);
    expect(list.map((t) => t.amount)).toEqual([0.1, 0.05]);
    expect(loadTakings(day + 120_000, storage)).toHaveLength(2);
    expect(loadTakings(day + 86_400_000, storage)).toEqual([]);
    expect(dayKey(day)).toBe('2026-10-04');
    expect(loadTakings(day, { getItem: () => 'not json' })).toEqual([]);
  });
});
