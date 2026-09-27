/**
 * Money helpers for the web (no Intl dependency for IDR so output is identical in every browser).
 * Brand rule: "Rp 1.234.567" (space after Rp, dot thousands, no decimals) — id; "IDR 1,234,567" — en.
 * Pure module (no imports) so it runs in the browser, at build time and under `node --test`.
 */

export type Locale = 'id' | 'en';

function group(n: bigint | number, sep: string): string {
  const s = (typeof n === 'bigint' ? n : BigInt(Math.trunc(n))).toString();
  const neg = s.startsWith('-');
  const digits = neg ? s.slice(1) : s;
  const out = digits.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
  return neg ? `−${out}` : out;
}

export function formatIdr(amount: number, locale: Locale = 'id'): string {
  const neg = amount < 0;
  const body = group(Math.abs(Math.round(amount)), locale === 'id' ? '.' : ',');
  const txt = locale === 'id' ? `Rp ${body}` : `IDR ${body}`;
  return neg ? `−${txt}` : txt;
}

/** Plain grouped integer, e.g. 60000 → "60.000". */
export function formatNumber(n: number, locale: Locale = 'id'): string {
  return group(Math.round(n), locale === 'id' ? '.' : ',');
}

/** Decimal string with locale separators: "113.7125" → "113,7125" (id). */
export function formatDecimalString(dec: string, locale: Locale = 'id'): string {
  const [i = '0', f] = dec.split('.');
  const intPart = group(BigInt(i), locale === 'id' ? '.' : ',');
  return f ? `${intPart}${locale === 'id' ? ',' : '.'}${f}` : intPart;
}

// ---------------------------------------------------------------------------
// Exact decimal arithmetic (BigInt) — mirrors packages/core: multiply, then round HALF_UP once.
// ---------------------------------------------------------------------------

interface Dec {
  n: bigint;
  scale: number;
}

export function parseDec(input: string | number): Dec {
  const s = String(input).trim().replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`Invalid non-negative decimal: ${input}`);
  const [i = '0', f = ''] = s.split('.');
  return { n: BigInt(i + f), scale: f.length };
}

/** round_half_up(a × b × c …) to an integer. All factors must be non-negative. */
export function mulHalfUp(...factors: Array<string | number>): number {
  let num = 1n;
  let scale = 0;
  for (const f of factors) {
    const d = parseDec(f);
    num *= d.n;
    scale += d.scale;
  }
  const den = 10n ** BigInt(scale);
  const q = (num * 2n + den) / (2n * den);
  const out = Number(q);
  if (!Number.isSafeInteger(out)) throw new Error('Amount exceeds safe integer range');
  return out;
}

export function ceilTo(amount: number, step: number): number {
  return Math.ceil(amount / step) * step;
}
