import currenciesJson from '../config/currencies.json' with { type: 'json' };
import { CoreError } from '../errors';
import {
  type Decimal,
  type DecimalInput,
  type RoundingMode,
  decimalToBigInt,
  decimalToString,
  divRound,
  mulDecimal,
  parseDecimal,
  pow10,
  rescaleDecimal,
} from './decimal';

export * from './decimal';

/**
 * Money convention: amounts are integer minor units (`number`), e.g. IDR 1.250.000 → 1250000,
 * USD 12.50 → 1250. IDR values up to 10^15 are exactly representable (2^53 ≈ 9.007×10^15), and every
 * function asserts `Number.isSafeInteger` on inputs and outputs. Intermediate products are BigInt.
 */

export interface CurrencyInfo {
  readonly code: string;
  readonly minorUnits: number;
  readonly name: string;
  readonly symbol: string;
  /** Published in the ECB euro reference rates (Frankfurter). */
  readonly ecbReference: boolean;
}

export const CURRENCIES: readonly CurrencyInfo[] = Object.freeze(
  (currenciesJson as CurrencyInfo[]).map((c) => Object.freeze({ ...c })),
);

const CURRENCY_BY_CODE: ReadonlyMap<string, CurrencyInfo> = new Map(CURRENCIES.map((c) => [c.code, c]));

export function isSupportedCurrency(code: string): boolean {
  return CURRENCY_BY_CODE.has(code);
}

export function getCurrency(code: string): CurrencyInfo {
  const c = CURRENCY_BY_CODE.get(code);
  if (!c) throw new CoreError('UNKNOWN_CURRENCY', `Unsupported currency ${code}`, { code });
  return c;
}

/** Currencies covered by ECB reference rates (usable with the frankfurter/ECB provider). */
export const ECB_REFERENCE_CURRENCIES: readonly string[] = Object.freeze(
  CURRENCIES.filter((c) => c.ecbReference).map((c) => c.code),
);

export function isEcbReferenceCurrency(code: string): boolean {
  return getCurrency(code).ecbReference;
}

export function minorUnitsOf(code: string): number {
  return getCurrency(code).minorUnits;
}

// ---------------------------------------------------------------------------
// Safe-integer guards
// ---------------------------------------------------------------------------

export function assertSafeInteger(value: number, label = 'amount'): void {
  if (!Number.isSafeInteger(value)) {
    throw new CoreError('UNSAFE_INTEGER', `${label} must be a safe integer (minor units), got ${value}`, {
      label,
      value,
    });
  }
}

export function assertNonNegativeInteger(value: number, label = 'amount'): void {
  assertSafeInteger(value, label);
  if (value < 0) {
    throw new CoreError('NEGATIVE_AMOUNT', `${label} must be >= 0, got ${value}`, { label, value });
  }
}

export function bigintToSafeNumber(value: bigint, label = 'amount'): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new CoreError('UNSAFE_INTEGER', `${label} overflows the safe integer range`, {
      label,
      value: value.toString(),
    });
  }
  return Number(value);
}

export function sumMinor(values: readonly number[], label = 'sum'): number {
  let total = 0n;
  for (const v of values) {
    assertSafeInteger(v, label);
    total += BigInt(v);
  }
  return bigintToSafeNumber(total, label);
}

// ---------------------------------------------------------------------------
// Major <-> minor
// ---------------------------------------------------------------------------

/** "12.345" USD → 1235 (half-up at the currency's minor unit). */
export function toMinor(amount: DecimalInput, currency: string, mode: RoundingMode = 'HALF_UP'): number {
  const units = minorUnitsOf(currency);
  const scaled = rescaleDecimal(parseDecimal(amount), units, mode);
  return bigintToSafeNumber(scaled.coef, 'toMinor');
}

/** 1250 USD → "12.50"; 1250000 IDR → "1250000". Exact string, never a float. */
export function fromMinor(minor: number, currency: string): string {
  assertSafeInteger(minor, 'fromMinor');
  const units = minorUnitsOf(currency);
  return decimalToString({ coef: BigInt(minor), scale: units }, units);
}

// ---------------------------------------------------------------------------
// Rounding helpers
// ---------------------------------------------------------------------------

/**
 * Half-up (away from zero) rounding of a decimal value to `decimals` places.
 * Parses the shortest decimal representation first, so `roundHalfUp(1.005, 2) === 1.01`
 * (whereas `Math.round(1.005 * 100) / 100 === 1`).
 */
export function roundHalfUp(value: DecimalInput, decimals = 0): number {
  const d = rescaleDecimal(parseDecimal(value), decimals, 'HALF_UP');
  return Number(decimalToString(d));
}

/** Rounds an integer amount to a multiple of `step` (e.g. 1000) with the given mode. */
export function roundToStep(amount: number, step: number, mode: RoundingMode): number {
  assertSafeInteger(amount, 'amount');
  if (!Number.isSafeInteger(step) || step <= 0) {
    throw new CoreError('INVALID_STEP', `step must be a positive integer, got ${step}`);
  }
  const q = divRound(BigInt(amount), BigInt(step), mode);
  return bigintToSafeNumber(q * BigInt(step));
}

/** ceilTo(12_345, 1000) → 13_000 */
export function ceilTo(amount: number, step: number): number {
  return roundToStep(amount, step, 'CEIL');
}

/** floorTo(12_999, 1000) → 12_000 */
export function floorTo(amount: number, step: number): number {
  return roundToStep(amount, step, 'FLOOR');
}

/** roundTo(12_500, 1000) → 13_000 (half-up) */
export function roundTo(amount: number, step: number): number {
  return roundToStep(amount, step, 'HALF_UP');
}

export type AmountRoundingRule = 'NONE' | 'CEIL_1000' | 'ROUND_1000' | 'CEIL_100';

export function applyRoundingRule(amount: number, rule: AmountRoundingRule): number {
  switch (rule) {
    case 'NONE':
      assertSafeInteger(amount);
      return amount;
    case 'CEIL_1000':
      return ceilTo(amount, 1000);
    case 'ROUND_1000':
      return roundTo(amount, 1000);
    case 'CEIL_100':
      return ceilTo(amount, 100);
  }
}

export function clampAmount(amount: number, min: number, max: number): number {
  assertSafeInteger(amount);
  if (min > max) throw new CoreError('INVALID_BOUNDS', `min ${min} > max ${max}`);
  return Math.min(max, Math.max(min, amount));
}

// ---------------------------------------------------------------------------
// Rates, basis points, percentages
// ---------------------------------------------------------------------------

export const BPS_DENOMINATOR = 10_000;

export function assertBps(bps: number, label = 'bps', max = BPS_DENOMINATOR): void {
  if (!Number.isSafeInteger(bps) || bps < 0 || bps > max) {
    throw new CoreError('INVALID_BPS', `${label} must be an integer in [0, ${max}], got ${bps}`);
  }
}

/** amount × bps / 10 000 with explicit rounding (exact BigInt arithmetic). */
export function applyBps(amount: number, bps: number, mode: RoundingMode = 'HALF_UP'): number {
  assertSafeInteger(amount);
  if (!Number.isSafeInteger(bps)) throw new CoreError('INVALID_BPS', `bps must be an integer, got ${bps}`);
  return bigintToSafeNumber(divRound(BigInt(amount) * BigInt(bps), BigInt(BPS_DENOMINATOR), mode));
}

/** amount × rate (decimal string/number) rounded to an integer. */
export function mulByRate(amount: number, rate: DecimalInput, mode: RoundingMode = 'HALF_UP'): number {
  return mulByRates(amount, [rate], mode);
}

/** amount × r1 × r2 × … rounded once at the end (no intermediate rounding). */
export function mulByRates(amount: number, rates: readonly DecimalInput[], mode: RoundingMode = 'HALF_UP'): number {
  assertSafeInteger(amount);
  let product: Decimal = { coef: BigInt(amount), scale: 0 };
  for (const r of rates) product = mulDecimal(product, r);
  return bigintToSafeNumber(decimalToBigInt(product, mode));
}

/** 150 → "0.015" */
export function bpsToRate(bps: number): string {
  assertSafeInteger(bps, 'bps');
  return decimalToString({ coef: BigInt(bps), scale: 4 });
}

/** "0.015" → 150. Rounds half-up to a whole bps. */
export function rateToBps(rate: DecimalInput): number {
  const d = mulDecimal(rate, BPS_DENOMINATOR);
  return bigintToSafeNumber(decimalToBigInt(d, 'HALF_UP'), 'bps');
}

/** 1.5 (%) → 150 bps */
export function percentToBps(percent: DecimalInput): number {
  return bigintToSafeNumber(decimalToBigInt(mulDecimal(percent, 100), 'HALF_UP'), 'bps');
}

/** 150 bps → 1.5 (%) */
export function bpsToPercent(bps: number): number {
  return Number(decimalToString({ coef: BigInt(bps), scale: 2 }));
}

/**
 * Splits `total` across `weights` proportionally using the largest-remainder method;
 * the parts always sum exactly to `total` and ties go to the earliest index (deterministic).
 */
export function allocateProportionally(total: number, weights: readonly number[]): number[] {
  assertSafeInteger(total, 'total');
  weights.forEach((w) => assertNonNegativeInteger(w, 'weight'));
  const weightSum = weights.reduce((a, b) => a + BigInt(b), 0n);
  if (weights.length === 0) return [];
  if (weightSum === 0n) return weights.map((_, i) => (i === 0 ? total : 0));
  const T = BigInt(total);
  const sign = T < 0n ? -1n : 1n;
  const absT = T * sign;
  const base = weights.map((w) => (absT * BigInt(w)) / weightSum);
  const remainders = weights.map((w, i) => ({ i, r: (absT * BigInt(w)) % weightSum }));
  let leftover = absT - base.reduce((a, b) => a + b, 0n);
  remainders.sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
  for (const { i } of remainders) {
    if (leftover === 0n) break;
    base[i] = (base[i] as bigint) + 1n;
    leftover -= 1n;
  }
  return base.map((b) => bigintToSafeNumber(b * sign));
}

// ---------------------------------------------------------------------------
// Formatting (deterministic; no Intl dependency so output is identical on Node/Workers)
// ---------------------------------------------------------------------------

function groupThousands(intDigits: string, separator: string): string {
  let out = '';
  for (let i = 0; i < intDigits.length; i++) {
    const fromEnd = intDigits.length - i;
    out += intDigits[i];
    if (fromEnd > 1 && fromEnd % 3 === 1) out += separator;
  }
  return out;
}

/** Locales using "." for thousands and "," for decimals (id-ID, de-DE, …). */
const DOT_GROUPING_LANGS = new Set(['id', 'de', 'es', 'it', 'nl', 'pt', 'tr', 'vi', 'da', 'el', 'ro']);

function separatorsFor(locale: string): { group: string; decimal: string } {
  const lang = locale.toLowerCase().split(/[-_]/)[0] ?? 'en';
  return DOT_GROUPING_LANGS.has(lang) ? { group: '.', decimal: ',' } : { group: ',', decimal: '.' };
}

/**
 * formatMoney(1250000, 'IDR', 'id-ID') → "Rp1.250.000"
 * formatMoney(1250, 'USD', 'en-US') → "$12.50"
 * formatMoney(-250000, 'IDR') → "-Rp250.000"
 */
export function formatMoney(amountMinor: number, currency: string, locale = 'id-ID'): string {
  assertSafeInteger(amountMinor, 'amountMinor');
  const info = getCurrency(currency);
  const { group, decimal } = separatorsFor(locale);
  const negative = amountMinor < 0;
  const abs = decimalToString({ coef: BigInt(Math.abs(amountMinor)), scale: info.minorUnits }, info.minorUnits);
  const [intPart = '0', fracPart] = abs.split('.');
  const body = groupThousands(intPart, group) + (fracPart !== undefined ? decimal + fracPart : '');
  return `${negative ? '-' : ''}${info.symbol}${body}`;
}

/** formatIdr(1250000) → "Rp1.250.000" */
export function formatIdr(amount: number): string {
  return formatMoney(amount, 'IDR', 'id-ID');
}

/** Decimal rate formatting for breakdown text, e.g. "108,5432" in id-ID. */
export function formatDecimal(value: DecimalInput, locale = 'id-ID', maxFractionDigits = 10): string {
  const d = rescaleDecimal(parseDecimal(value), maxFractionDigits, 'HALF_UP');
  const text = decimalToString(d);
  const { group, decimal } = separatorsFor(locale);
  const negative = text.startsWith('-');
  const [intPart = '0', fracPart] = (negative ? text.slice(1) : text).split('.');
  return `${negative ? '-' : ''}${groupThousands(intPart, group)}${fracPart ? decimal + fracPart : ''}`;
}

/** Internal convenience: 10^units as bigint for currency scaling. */
export function minorScale(currency: string): bigint {
  return pow10(minorUnitsOf(currency));
}
