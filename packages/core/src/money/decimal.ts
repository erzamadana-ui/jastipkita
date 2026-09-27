import { CoreError } from '../errors';

/**
 * Minimal exact decimal: value = coef / 10^scale. Backed by BigInt so FX rates
 * (numeric(20,10)) and tax factors multiply without floating-point drift.
 */
export interface Decimal {
  readonly coef: bigint;
  readonly scale: number;
}

export type DecimalInput = string | number | bigint | Decimal;

/**
 * Rounding modes:
 * - HALF_UP: half away from zero (commercial rounding; CONVENTIONS.md "half-up")
 * - CEIL: toward +∞; FLOOR: toward −∞; TRUNC: toward zero
 */
export type RoundingMode = 'HALF_UP' | 'CEIL' | 'FLOOR' | 'TRUNC';

const DECIMAL_RE = /^([+-])?(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;
const POW10_CACHE: bigint[] = [1n];

export function pow10(n: number): bigint {
  if (!Number.isInteger(n) || n < 0) {
    throw new CoreError('INVALID_SCALE', `pow10 expects a non-negative integer, got ${n}`);
  }
  for (let i = POW10_CACHE.length; i <= n; i++) {
    POW10_CACHE[i] = (POW10_CACHE[i - 1] as bigint) * 10n;
  }
  return POW10_CACHE[n] as bigint;
}

function isDecimal(x: unknown): x is Decimal {
  return typeof x === 'object' && x !== null && 'coef' in x && 'scale' in x;
}

/**
 * Parses a decimal from a string ("108.5432", "-1.5e-3"), a finite number
 * (via its shortest round-trip representation — `String(0.1)` is "0.1"), or a bigint.
 */
export function parseDecimal(input: DecimalInput): Decimal {
  if (typeof input === 'bigint') return { coef: input, scale: 0 };
  if (isDecimal(input)) return input;
  let text: string;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) {
      throw new CoreError('INVALID_DECIMAL', `Cannot parse non-finite number ${input}`);
    }
    text = String(input);
  } else {
    text = input.trim();
  }
  const m = DECIMAL_RE.exec(text);
  const intPart = m?.[2] ?? '';
  const fracPart = m?.[3] ?? '';
  if (!m || (intPart === '' && fracPart === '')) {
    throw new CoreError('INVALID_DECIMAL', `Cannot parse decimal "${text}"`);
  }
  const negative = m[1] === '-';
  const exp = m[4] !== undefined ? Number.parseInt(m[4], 10) : 0;
  let coef = BigInt(`${intPart}${fracPart}` || '0');
  if (negative) coef = -coef;
  let scale = fracPart.length - exp;
  if (scale < 0) {
    coef *= pow10(-scale);
    scale = 0;
  }
  return normalizeDecimal({ coef, scale });
}

/** Strips trailing zeros from the coefficient (canonical form). */
export function normalizeDecimal(d: Decimal): Decimal {
  let { coef, scale } = d;
  if (coef === 0n) return { coef: 0n, scale: 0 };
  while (scale > 0 && coef % 10n === 0n) {
    coef /= 10n;
    scale -= 1;
  }
  return { coef, scale };
}

/** Integer division n/d with explicit rounding. */
export function divRound(n: bigint, d: bigint, mode: RoundingMode): bigint {
  if (d === 0n) throw new CoreError('DIVISION_BY_ZERO', 'Division by zero');
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const q = n / d; // truncates toward zero
  const r = n % d;
  if (r === 0n) return q;
  switch (mode) {
    case 'TRUNC':
      return q;
    case 'FLOOR':
      return n < 0n ? q - 1n : q;
    case 'CEIL':
      return n > 0n ? q + 1n : q;
    case 'HALF_UP': {
      const absR = r < 0n ? -r : r;
      if (absR * 2n >= d) return n < 0n ? q - 1n : q + 1n;
      return q;
    }
  }
}

/** Re-expresses `d` at exactly `scale` fractional digits, rounding if needed. */
export function rescaleDecimal(d: Decimal, scale: number, mode: RoundingMode = 'HALF_UP'): Decimal {
  if (scale === d.scale) return d;
  if (scale > d.scale) return { coef: d.coef * pow10(scale - d.scale), scale };
  return { coef: divRound(d.coef, pow10(d.scale - scale), mode), scale };
}

export function mulDecimal(a: DecimalInput, b: DecimalInput): Decimal {
  const x = parseDecimal(a);
  const y = parseDecimal(b);
  return { coef: x.coef * y.coef, scale: x.scale + y.scale };
}

export function addDecimal(a: DecimalInput, b: DecimalInput): Decimal {
  const x = parseDecimal(a);
  const y = parseDecimal(b);
  const scale = Math.max(x.scale, y.scale);
  return {
    coef: rescaleDecimal(x, scale).coef + rescaleDecimal(y, scale).coef,
    scale,
  };
}

/** a / b rounded to `scale` fractional digits. */
export function divDecimal(
  a: DecimalInput,
  b: DecimalInput,
  scale: number,
  mode: RoundingMode = 'HALF_UP',
): Decimal {
  const x = parseDecimal(a);
  const y = parseDecimal(b);
  if (y.coef === 0n) throw new CoreError('DIVISION_BY_ZERO', 'Division by zero');
  const num = x.coef * pow10(y.scale + scale);
  const den = y.coef * pow10(x.scale);
  return { coef: divRound(num, den, mode), scale };
}

/** Rounds a decimal to an integer (bigint). */
export function decimalToBigInt(d: DecimalInput, mode: RoundingMode = 'HALF_UP'): bigint {
  const x = parseDecimal(d);
  return divRound(x.coef, pow10(x.scale), mode);
}

export function compareDecimal(a: DecimalInput, b: DecimalInput): -1 | 0 | 1 {
  const x = parseDecimal(a);
  const y = parseDecimal(b);
  const scale = Math.max(x.scale, y.scale);
  const cx = rescaleDecimal(x, scale).coef;
  const cy = rescaleDecimal(y, scale).coef;
  return cx < cy ? -1 : cx > cy ? 1 : 0;
}

/** Plain decimal string (no exponent), trailing zeros trimmed down to `minFractionDigits`. */
export function decimalToString(d: DecimalInput, minFractionDigits = 0): string {
  const x = parseDecimal(d);
  const target = Math.max(x.scale, minFractionDigits);
  const scaled = rescaleDecimal(x, target);
  const negative = scaled.coef < 0n;
  const digits = (negative ? -scaled.coef : scaled.coef).toString().padStart(target + 1, '0');
  let intPart = digits.slice(0, digits.length - target);
  let fracPart = target > 0 ? digits.slice(digits.length - target) : '';
  while (fracPart.length > minFractionDigits && fracPart.endsWith('0')) {
    fracPart = fracPart.slice(0, -1);
  }
  if (intPart === '') intPart = '0';
  const body = fracPart.length > 0 ? `${intPart}.${fracPart}` : intPart;
  return negative && scaled.coef !== 0n ? `-${body}` : body;
}

export function decimalToNumber(d: DecimalInput): number {
  return Number(decimalToString(d));
}

export function isPositiveDecimal(d: DecimalInput): boolean {
  return parseDecimal(d).coef > 0n;
}
