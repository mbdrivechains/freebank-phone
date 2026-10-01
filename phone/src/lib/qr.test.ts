import { describe, expect, it } from 'vitest';
import jsQR from 'jsqr';
import { encodeQr, qrGhost } from './qr';

/** Grey levels of the code at `scale` pixels a module, with the quiet zone, ghosted or not. */
function draw(m: boolean[][], ghost: boolean, scale = 4): { g: Float64Array; w: number } {
  const quiet = 4;
  const w = (m.length + quiet * 2) * scale;
  const g = new Float64Array(w * w).fill(255);
  const fill = (x: number, y: number, v: number) => {
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) g[(y * scale + dy) * w + x * scale + dx] = v;
  };
  if (ghost)
    for (const { d, fill: hex } of qrGhost(m)) {
      const [r, gr, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
      for (const [, x, y] of d.matchAll(/M(\d+) (\d+)/g)) fill(+x, +y, 0.299 * r + 0.587 * gr + 0.114 * b);
    }
  for (let y = 0; y < m.length; y++) for (let x = 0; x < m.length; x++) if (m[y][x]) fill(x + quiet, y + quiet, 0);
  return { g, w };
}

function read({ g, w }: { g: Float64Array; w: number }): string | null {
  const px = new Uint8ClampedArray(w * w * 4);
  g.forEach((v, i) => px.set([v, v, v, 255], i * 4));
  return jsQR(px, w, w, { inversionAttempts: 'dontInvert' })?.data ?? null;
}

const decode = (m: boolean[][]) => read(draw(m, false));

describe('qr encoder', () => {
  it('encodes a FreeBank address that a real decoder reads back', () => {
    const addr = 'XmZ9qH8vY3kLq2aB7cD4eF6gH1jK5mN8pR';
    const m = encodeQr(addr);
    expect(m.length).toBe(29); // version 3
    expect(decode(m)).toBe(addr);
  });

  it('covers versions 1 to 10', () => {
    const sizes = new Set<number>();
    for (const n of [1, 10, 14, 20, 26, 40, 62, 84, 106, 122, 152, 180, 213]) {
      const text = Array.from({ length: n }, (_, i) => 'abcdefghijklmnopqrstuvwxyz0123456789:/?=&'[(i * 7 + n) % 41]).join('');
      const m = encodeQr(text);
      sizes.add(m.length);
      expect(decode(m), `length ${n} (size ${m.length})`).toBe(text);
    }
    expect(Math.max(...sizes)).toBe(57); // version 10 reached
    expect(Math.min(...sizes)).toBe(21);
  });

  it('reads with the gold ghost as a plain code does', () => {
    const addr = 'XmZ9qH8vY3kLq2aB7cD4eF6gH1jK5mN8pR';
    const m = encodeQr(addr);
    const ghost = qrGhost(m);
    expect(ghost.length).toBeGreaterThan(0);
    // Never a dark module, never the finder corners.
    const tinted = ghost.flatMap((p) => [...p.d.matchAll(/M(\d+) (\d+)/g)].map(([, x, y]) => [+x - 4, +y - 4]));
    for (const [x, y] of tinted) {
      expect(m[y][x]).toBe(false);
      expect((x < 8 && y < 8) || (x >= m.length - 8 && y < 8) || (x < 8 && y >= m.length - 8)).toBe(false);
    }
    for (const scale of [8, 3, 2]) expect(read(draw(m, true, scale)), `${scale}px`).toBe(addr);
    // Washed out and noisy (seeded): the ghost reads within a tenth of plain.
    const copies = (ghost: boolean) => {
      let ok = 0;
      for (let seed = 1; seed <= 100; seed++) {
        let s = seed * 7919;
        const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
        const { g, w } = draw(m, ghost, 3);
        ok += Number(read({ g: g.map((v) => 90 + v * 0.62 + (rnd() + rnd() + rnd() - 1.5) * 70), w }) === addr);
      }
      return ok;
    };
    expect(copies(true)).toBeGreaterThanOrEqual(copies(false) - 10);
  });

  it('refuses text that does not fit', () => {
    expect(() => encodeQr('x'.repeat(214))).toThrow();
  });
});
