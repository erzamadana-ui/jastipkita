export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

/** Rounds a display score to `decimals` places using half-up on the decimal representation. */
export function roundScore(value: number, decimals = 2): number {
  const f = 10 ** decimals;
  return Math.sign(value) * Math.round(Math.abs(value) * f + Number.EPSILON) / f;
}

/** Saturating log curve: 0 at x=0, 1 at x=saturation, capped at 1. */
export function logSaturate(x: number, saturation: number): number {
  if (!(x > 0) || !(saturation > 0)) return 0;
  return clamp01(Math.log1p(x) / Math.log1p(saturation));
}

/** Stable sort helper returning a new array. */
export function sortBy<T>(items: readonly T[], compare: (a: T, b: T) => number): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => compare(a.item, b.item) || a.index - b.index)
    .map((x) => x.item);
}

export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
