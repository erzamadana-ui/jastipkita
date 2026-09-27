import { CoreError } from '../errors';
import { addMinutes, MINUTE_MS } from '../internal/time';
import {
  type DecimalInput,
  type RoundingMode,
  assertSafeInteger,
  assertBps,
  bigintToSafeNumber,
  compareDecimal,
  decimalToString,
  divDecimal,
  divRound,
  getCurrency,
  isEcbReferenceCurrency,
  mulDecimal,
  parseDecimal,
  pow10,
  rescaleDecimal,
} from '../money';

/**
 * FX conventions
 * - A rate is "quote per 1 base": JPY→IDR rate 108.5 means ¥1 = Rp108.5.
 * - Rates are canonical decimal strings with at most {@link RATE_SCALE} fractional digits
 *   (DB `numeric(20,10)`), rounded half-up.
 * - Conversions round half-up at the *target* currency's minor unit.
 */
export const RATE_SCALE = 10;

export type RateInput = DecimalInput;

export function normalizeRate(rate: RateInput, label = 'rate'): string {
  const d = rescaleDecimal(parseDecimal(rate), RATE_SCALE, 'HALF_UP');
  if (d.coef <= 0n) {
    throw new CoreError('INVALID_RATE', `${label} must be > 0`, { rate: String(rate) });
  }
  return decimalToString(d);
}

/**
 * Converts `amountMinor` (in `from` minor units) to `to` minor units:
 *   out = amountMinor / 10^m(from) × rate × 10^m(to), rounded once (half-up by default).
 */
export function convert(
  amountMinor: number,
  from: string,
  to: string,
  rate: RateInput,
  mode: RoundingMode = 'HALF_UP',
): number {
  assertSafeInteger(amountMinor, 'amountMinor');
  const fromUnits = getCurrency(from).minorUnits;
  const toUnits = getCurrency(to).minorUnits;
  if (from === to) {
    if (compareDecimal(rate, 1) !== 0) {
      throw new CoreError('INVALID_RATE', `Same-currency conversion ${from}→${to} requires rate 1`);
    }
    return amountMinor;
  }
  const r = parseDecimal(normalizeRate(rate));
  const num = BigInt(amountMinor) * r.coef * pow10(toUnits);
  const den = pow10(fromUnits + r.scale);
  return bigintToSafeNumber(divRound(num, den, mode), 'converted amount');
}

/** Applies a markup that makes the rate less favourable to the buyer: spot × (1 + bps/10 000). */
export function quoteRate(spot: RateInput, markupBps: number): string {
  assertBps(markupBps, 'markupBps');
  const spotD = parseDecimal(normalizeRate(spot, 'spot'));
  const factor = { coef: BigInt(10_000 + markupBps), scale: 4 };
  return decimalToString(rescaleDecimal(mulDecimal(spotD, factor), RATE_SCALE, 'HALF_UP'));
}

/** Markup for a currency from `pricing.fx_markup` (per-currency override, else default). */
export function markupBpsFor(
  currency: string,
  cfg: { readonly defaultBps: number; readonly perCurrency: Readonly<Record<string, number>> },
): number {
  return cfg.perCurrency[currency] ?? cfg.defaultBps;
}

export function invertRate(rate: RateInput): string {
  return decimalToString(divDecimal(1, normalizeRate(rate), RATE_SCALE, 'HALF_UP'));
}

// ---------------------------------------------------------------------------
// Staleness
// ---------------------------------------------------------------------------

export function rateAgeMinutes(rateAsOf: Date, now: Date): number {
  return (now.getTime() - rateAsOf.getTime()) / MINUTE_MS;
}

/** A rate is stale when older than `maxRateAgeMinutes` (config `fx.lock.maxRateAgeMinutes`). */
export function isRateStale(rateAsOf: Date, now: Date, maxRateAgeMinutes: number): boolean {
  return rateAgeMinutes(rateAsOf, now) > maxRateAgeMinutes;
}

// ---------------------------------------------------------------------------
// Locks
// ---------------------------------------------------------------------------

export interface FxLock {
  readonly base: string;
  readonly quote: string;
  readonly spotRate: string;
  readonly markupBps: number;
  readonly lockedRate: string;
  readonly lockedAt: Date;
  readonly expiresAt: Date;
  readonly rateAsOf: Date | null;
  readonly source: string | null;
}

export interface CreateFxLockInput {
  readonly base: string;
  readonly quote: string;
  readonly spotRate: RateInput;
  readonly markupBps: number;
  readonly now: Date;
  readonly lockMinutes: number;
  /** Timestamp of the provider rate; required to enforce staleness. */
  readonly rateAsOf?: Date | null;
  readonly maxRateAgeMinutes?: number;
  readonly source?: string | null;
}

export function createFxLock(input: CreateFxLockInput): FxLock {
  getCurrency(input.base);
  getCurrency(input.quote);
  if (input.base === input.quote) {
    throw new CoreError('INVALID_FX_PAIR', `FX lock needs two different currencies (${input.base})`);
  }
  if (!(input.lockMinutes > 0)) {
    throw new CoreError('INVALID_LOCK_MINUTES', `lockMinutes must be > 0, got ${input.lockMinutes}`);
  }
  const rateAsOf = input.rateAsOf ?? null;
  if (rateAsOf && input.maxRateAgeMinutes !== undefined && isRateStale(rateAsOf, input.now, input.maxRateAgeMinutes)) {
    throw new CoreError('FX_RATE_STALE', `Rate as of ${rateAsOf.toISOString()} exceeds ${input.maxRateAgeMinutes} minutes`, {
      rateAsOf: rateAsOf.toISOString(),
      ageMinutes: rateAgeMinutes(rateAsOf, input.now),
    });
  }
  if (rateAsOf && rateAsOf.getTime() > input.now.getTime()) {
    throw new CoreError('FX_RATE_FROM_FUTURE', 'rateAsOf is after now');
  }
  const spotRate = normalizeRate(input.spotRate, 'spotRate');
  return {
    base: input.base,
    quote: input.quote,
    spotRate,
    markupBps: input.markupBps,
    lockedRate: quoteRate(spotRate, input.markupBps),
    lockedAt: new Date(input.now.getTime()),
    expiresAt: addMinutes(input.now, input.lockMinutes),
    rateAsOf: rateAsOf ? new Date(rateAsOf.getTime()) : null,
    source: input.source ?? null,
  };
}

/** Valid on [lockedAt, expiresAt). */
export function isLockValid(lock: Pick<FxLock, 'lockedAt' | 'expiresAt'>, now: Date): boolean {
  const t = now.getTime();
  return t >= lock.lockedAt.getTime() && t < lock.expiresAt.getTime();
}

/** Converts a base-currency amount with the lock's rate. */
export function convertWithLock(lock: FxLock, amountMinor: number): number {
  return convert(amountMinor, lock.base, lock.quote, lock.lockedRate);
}

export interface FxAdjustment {
  readonly base: string;
  readonly quote: string;
  readonly oldRate: string;
  readonly newRate: string;
  readonly oldQuoteMinor: number;
  readonly newQuoteMinor: number;
  /** new − old, in quote minor units. Positive = buyer owes more. */
  readonly differenceMinor: number;
  readonly direction: 'BUYER_PAYS_MORE' | 'BUYER_PAYS_LESS' | 'NO_CHANGE';
}

/**
 * Re-quote delta for `amountMinor` (base currency) when an expired lock is replaced by `newRate`
 * (already marked-up, i.e. a new lock's `lockedRate`).
 */
export function fxAdjustment(oldLock: FxLock, newRate: RateInput, amountMinor: number): FxAdjustment {
  const normalized = normalizeRate(newRate, 'newRate');
  const oldQuoteMinor = convert(amountMinor, oldLock.base, oldLock.quote, oldLock.lockedRate);
  const newQuoteMinor = convert(amountMinor, oldLock.base, oldLock.quote, normalized);
  const differenceMinor = newQuoteMinor - oldQuoteMinor;
  return {
    base: oldLock.base,
    quote: oldLock.quote,
    oldRate: oldLock.lockedRate,
    newRate: normalized,
    oldQuoteMinor,
    newQuoteMinor,
    differenceMinor,
    direction: differenceMinor > 0 ? 'BUYER_PAYS_MORE' : differenceMinor < 0 ? 'BUYER_PAYS_LESS' : 'NO_CHANGE',
  };
}

// ---------------------------------------------------------------------------
// Cross rates
// ---------------------------------------------------------------------------

/** Rates relative to one base (e.g. ECB/Frankfurter: base EUR, rates {JPY: 162.3, IDR: 17800}). */
export interface RateTable {
  readonly base: string;
  readonly asOf: Date;
  readonly rates: Readonly<Record<string, RateInput>>;
}

function rateFromTable(table: RateTable, currency: string): string {
  if (currency === table.base) return '1';
  const r = table.rates[currency];
  if (r === undefined || r === null) {
    const ecb = isEcbReferenceCurrency(currency);
    throw new CoreError(
      'FX_RATE_UNAVAILABLE',
      ecb
        ? `No ${table.base}→${currency} rate in the rate table`
        : `${currency} is not an ECB reference currency; no rate available from ECB/Frankfurter`,
      { base: table.base, currency, reason: ecb ? 'MISSING_FROM_TABLE' : 'NOT_ECB_REFERENCE' },
    );
  }
  const normalized = normalizeRate(r, `${table.base}${currency}`);
  return normalized;
}

/**
 * Derives from→to via the table's base: rate = rates[to] / rates[from].
 * E.g. EUR-based {JPY: 162.3, IDR: 17800} → JPY→IDR = 17800 / 162.3 = 109.6734442391.
 */
export function crossRate(table: RateTable, from: string, to: string): string {
  getCurrency(from);
  getCurrency(to);
  if (from === to) return '1';
  const rFrom = rateFromTable(table, from);
  const rTo = rateFromTable(table, to);
  return decimalToString(divDecimal(rTo, rFrom, RATE_SCALE, 'HALF_UP'));
}

/** Cross rate plus staleness guard (throws FX_RATE_STALE). */
export function crossRateChecked(
  table: RateTable,
  from: string,
  to: string,
  now: Date,
  maxRateAgeMinutes: number,
): string {
  if (isRateStale(table.asOf, now, maxRateAgeMinutes)) {
    throw new CoreError('FX_RATE_STALE', `Rate table as of ${table.asOf.toISOString()} is stale`, {
      ageMinutes: rateAgeMinutes(table.asOf, now),
      maxRateAgeMinutes,
    });
  }
  return crossRate(table, from, to);
}

// ---------------------------------------------------------------------------
// Provider coverage & config-driven locks
// ---------------------------------------------------------------------------

/** Providers whose rates are the ECB euro reference set. */
export const ECB_BASED_PROVIDERS: readonly string[] = ['frankfurter', 'ecb'];

/** Whether `provider` can quote `currency` (ECB-based providers only cover `ecbReference` currencies). */
export function providerSupportsCurrency(provider: string, currency: string): boolean {
  getCurrency(currency);
  return ECB_BASED_PROVIDERS.includes(provider.toLowerCase()) ? isEcbReferenceCurrency(currency) : true;
}

/** Throws FX_RATE_UNAVAILABLE when the configured provider cannot quote the pair. */
export function assertRateAvailable(provider: string, from: string, to: string): void {
  for (const ccy of [from, to]) {
    if (!providerSupportsCurrency(provider, ccy)) {
      throw new CoreError('FX_RATE_UNAVAILABLE', `${ccy} is not available from provider ${provider}`, {
        provider,
        currency: ccy,
        reason: 'NOT_ECB_REFERENCE',
      });
    }
  }
}

export interface FxLockConfigInput {
  readonly 'fx.lock': { readonly lockMinutes: number; readonly maxRateAgeMinutes: number; readonly provider: string };
  readonly 'pricing.fx_markup': { readonly defaultBps: number; readonly perCurrency: Readonly<Record<string, number>> };
}

/**
 * createFxLock with every knob from business config: lock window, staleness limit
 * (`fx.lock.maxRateAgeMinutes`, default 4320 = 72 h so ECB weekend gaps don't block checkout),
 * per-currency markup, and provider coverage (FX_RATE_UNAVAILABLE for non-ECB currencies).
 */
export function createFxLockFromConfig(
  input: {
    readonly base: string;
    readonly quote: string;
    readonly spotRate: RateInput;
    readonly rateAsOf: Date;
    readonly now: Date;
    readonly source?: string | null;
  },
  config: FxLockConfigInput,
): FxLock {
  const lockCfg = config['fx.lock'];
  assertRateAvailable(lockCfg.provider, input.base, input.quote);
  return createFxLock({
    base: input.base,
    quote: input.quote,
    spotRate: input.spotRate,
    markupBps: markupBpsFor(input.base, config['pricing.fx_markup']),
    now: input.now,
    lockMinutes: lockCfg.lockMinutes,
    rateAsOf: input.rateAsOf,
    maxRateAgeMinutes: lockCfg.maxRateAgeMinutes,
    source: input.source ?? lockCfg.provider,
  });
}
