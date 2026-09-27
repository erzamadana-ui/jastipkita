/**
 * Seeded PRNG for property-style tests (not exported from the package entry).
 * mulberry32 — tiny, fast, good enough for test-case generation.
 */
export interface Prng {
  next(): number;
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  bool(p?: number): boolean;
  bytes(n: number): Uint8Array;
}

export function createPrng(seed: number): Prng {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number): number => min + Math.floor(next() * (max - min + 1));
  return {
    next,
    int,
    pick<T>(items: readonly T[]): T {
      const v = items[int(0, items.length - 1)];
      if (v === undefined) throw new Error('pick from empty list');
      return v;
    },
    bool(p = 0.5): boolean {
      return next() < p;
    },
    bytes(n: number): Uint8Array {
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) out[i] = int(0, 255);
      return out;
    },
  };
}

export const SEEDS: readonly number[] = Array.from({ length: 200 }, (_, i) => 0x9e3779b1 ^ (i * 2654435761));
