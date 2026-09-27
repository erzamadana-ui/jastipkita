/**
 * FX: provider snapshots → fx_rates (append-only), spot/cross rates via @jastipkita/core, and
 * FX locks (fx_locks) with markup & window from business config.
 *
 * Exported for the money group:
 *   getSpotRate(db, deps, base, quote)                → SpotRate (no markup; customs & display)
 *   createFxLock(db, deps, { base, quote, userId })   → FxLockDto (ACTIVE fx_locks row)
 *   refreshFxRates(db, deps)                           → stores a provider snapshot
 */
import {
  CoreError,
  convert,
  createFxLockFromConfig,
  crossRate,
  crossRateChecked,
  getCurrency,
  isRateStale,
  markupBpsFor,
  normalizeRate,
  quoteRate,
  rateAgeMinutes,
} from '@jastipkita/core';
import type { AppDeps } from '../../context';
import type { Db } from '../../db/sql';
import { AppError, Errors } from '../../lib/errors';
import { fxPivot } from '../../providers/fx';
import type { FxProvider } from '../../providers/types';
import { core, coreToAppError } from '../catalog/shared';
import * as repo from './repository';

export type FxDeps = Pick<AppDeps, 'config' | 'clock' | 'providers' | 'logger'>;

export interface SpotRate {
  base: string;
  quote: string;
  /** quote per 1 base, decimal string (≤ 10 dp) */
  spotRate: string;
  asOf: Date;
  source: string;
  pivot: string;
  /** fx_rates row of the oldest leg used (null for identity / pivot-only pairs without rows) */
  sourceRateId: string | null;
}

export interface FxLockDto {
  id: string;
  base: string;
  quote: string;
  spotRate: string;
  markupBps: number;
  lockedRate: string;
  lockedAt: string;
  expiresAt: string;
  status: 'ACTIVE' | 'CONSUMED' | 'EXPIRED';
  rateAsOf: string;
  source: string;
  sourceRateId: string | null;
}

/** Avoid hammering a failing/stale provider from request paths: ≥ 60 s between on-demand refreshes. */
const REFRESH_BACKOFF_MS = 60_000;
const lastOnDemandRefresh = new WeakMap<FxProvider, number>();

interface Leg {
  id: string;
  rate: string;
  asOf: Date;
}

async function loadLegs(db: Db, provider: FxProvider): Promise<Map<string, Leg>> {
  const rows = await repo.latestLegs(db, provider.source, fxPivot(provider));
  return new Map(rows.map((r) => [r.quote, { id: r.id, rate: r.rate, asOf: r.as_of }]));
}

/**
 * Fetches the provider snapshot for every active currency and stores it (idempotent per as_of).
 * Throws on provider failure (the scheduled job records the failure; request paths fall back to stored data).
 */
export async function refreshFxRates(db: Db, deps: FxDeps): Promise<{ source: string; pivot: string; asOf: string; stored: number; currencies: number }> {
  const provider = deps.providers.fx;
  const pivot = fxPivot(provider);
  const all = await repo.activeCurrencyCodes(db);
  const ecbOnly = provider.source.startsWith('frankfurter');
  const symbols = all.filter((c) => c.code !== pivot && (!ecbOnly || c.ecb_reference)).map((c) => c.code);
  const snap = await provider.latest(pivot, symbols);
  const now = deps.clock.now();
  const rows: { base: string; quote: string; rate: string; source: string; asOf: Date; fetchedAt: Date }[] = [];
  for (const [quote, value] of Object.entries(snap.rates)) {
    if (quote === snap.base || !symbols.includes(quote)) continue;
    let rate: string;
    try {
      rate = normalizeRate(value);
    } catch {
      deps.logger.warn('fx.refresh.invalid_rate', { quote, source: snap.source });
      continue;
    }
    rows.push({ base: snap.base, quote, rate, source: snap.source, asOf: snap.asOf, fetchedAt: now });
  }
  const stored = await repo.insertRates(db, rows);
  return { source: snap.source, pivot: snap.base, asOf: snap.asOf.toISOString(), stored, currencies: rows.length };
}

async function maxRateAgeMinutes(deps: FxDeps): Promise<number> {
  return (await deps.config.get('fx.lock')).maxRateAgeMinutes;
}

function legsUsable(legs: Map<string, Leg>, needed: string[], now: Date, maxAge: number): boolean {
  return needed.every((c) => {
    const l = legs.get(c);
    return l !== undefined && !isRateStale(l.asOf, now, maxAge);
  });
}

async function tryOnDemandRefresh(db: Db, deps: FxDeps): Promise<boolean> {
  const provider = deps.providers.fx;
  const now = deps.clock.now().getTime();
  const last = lastOnDemandRefresh.get(provider);
  if (last !== undefined && now - last >= 0 && now - last < REFRESH_BACKOFF_MS) return false;
  lastOnDemandRefresh.set(provider, now);
  try {
    await refreshFxRates(db, deps);
    return true;
  } catch (err) {
    deps.logger.warn('fx.on_demand_refresh_failed', { error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

/**
 * Spot (mid) rate base→quote, derived through the provider pivot with core `crossRateChecked`.
 * Stale or missing data triggers one on-demand refresh (backed off); still stale → FX_RATE_STALE,
 * missing → FX_RATE_UNAVAILABLE.
 */
export async function getSpotRate(db: Db, deps: FxDeps, base: string, quote: string): Promise<SpotRate> {
  await core(() => {
    getCurrency(base);
    getCurrency(quote);
  });
  const provider = deps.providers.fx;
  const pivot = fxPivot(provider);
  const now = deps.clock.now();
  if (base === quote) return { base, quote, spotRate: '1', asOf: now, source: 'identity', pivot, sourceRateId: null };

  const maxAge = await maxRateAgeMinutes(deps);
  const needed = [base, quote].filter((c) => c !== pivot);
  let legs = await loadLegs(db, provider);
  if (!legsUsable(legs, needed, now, maxAge)) {
    if (await tryOnDemandRefresh(db, deps)) legs = await loadLegs(db, provider);
  }
  const used = needed.map((c) => legs.get(c)).filter((l): l is Leg => l !== undefined);
  const oldest = used.reduce<Leg | null>((acc, l) => (acc === null || l.asOf.getTime() < acc.asOf.getTime() ? l : acc), null);
  const table = {
    base: pivot,
    asOf: oldest?.asOf ?? now,
    rates: Object.fromEntries(needed.flatMap((c) => (legs.get(c) ? [[c, legs.get(c)!.rate]] : []))),
  };
  // Missing data (FX_RATE_UNAVAILABLE) is reported before staleness (FX_RATE_STALE).
  await core(() => crossRate(table, base, quote));
  const spotRate = await core(() => crossRateChecked(table, base, quote, now, maxAge));
  return { base, quote, spotRate, asOf: table.asOf, source: provider.source, pivot, sourceRateId: oldest?.id ?? null };
}

export interface FxRateDto {
  base: string;
  quote: string;
  spotRate: string;
  markupBps: number;
  rate: string;
  asOf: string;
  ageMinutes: number;
  maxRateAgeMinutes: number;
  source: string;
  pivot: string;
}

export async function quoteFxRate(db: Db, deps: FxDeps, base: string, quote: string): Promise<FxRateDto> {
  const spot = await getSpotRate(db, deps, base, quote);
  const markupBps = base === quote ? 0 : markupBpsFor(base, await deps.config.get('pricing.fx_markup'));
  const now = deps.clock.now();
  return {
    base,
    quote,
    spotRate: spot.spotRate,
    markupBps,
    rate: base === quote ? '1' : quoteRate(spot.spotRate, markupBps),
    asOf: spot.asOf.toISOString(),
    ageMinutes: Math.max(0, Math.round(rateAgeMinutes(spot.asOf, now))),
    maxRateAgeMinutes: await maxRateAgeMinutes(deps),
    source: spot.source,
    pivot: spot.pivot,
  };
}

/** All active currencies → quote (default IDR). Unavailable pairs are listed separately, not failed. */
export async function listFxRates(db: Db, deps: FxDeps, quote: string): Promise<{ data: FxRateDto[]; unavailable: { currency: string; code: string }[] }> {
  const all = await repo.activeCurrencyCodes(db);
  const data: FxRateDto[] = [];
  const unavailable: { currency: string; code: string }[] = [];
  for (const c of all) {
    if (c.code === quote) continue;
    try {
      data.push(await quoteFxRate(db, deps, c.code, quote));
    } catch (err) {
      if (err instanceof AppError && (err.code === 'FX_RATE_UNAVAILABLE' || err.code === 'FX_RATE_STALE')) {
        unavailable.push({ currency: c.code, code: err.code });
        continue;
      }
      throw err;
    }
  }
  if (data.length === 0 && unavailable.some((u) => u.code === 'FX_RATE_STALE')) {
    throw new AppError(503, 'FX_RATE_STALE', 'Kurs terbaru belum tersedia (data kurs terlalu lama). Coba lagi nanti.');
  }
  return { data, unavailable };
}

/**
 * Creates an ACTIVE fx_locks row for base→quote with markup (`pricing.fx_markup`), window and
 * staleness limit (`fx.lock`) from config via core `createFxLockFromConfig`. `userId` is recorded in
 * logs only (fx_locks has no owner column; the quote that consumes the lock carries the transaction).
 */
export async function createFxLock(db: Db, deps: FxDeps, input: { base: string; quote?: string; userId?: string | null }): Promise<FxLockDto> {
  const quote = input.quote ?? 'IDR';
  if (input.base === quote) throw Errors.badRequest('INVALID_FX_PAIR', 'Mata uang asal dan tujuan harus berbeda');
  const spot = await getSpotRate(db, deps, input.base, quote);
  const now = deps.clock.now();
  const lockCfg = await deps.config.get('fx.lock');
  const markupCfg = await deps.config.get('pricing.fx_markup');
  // Coverage check follows the ACTUAL provider (config names the production provider; the MOCK
  // table may cover other currencies). ECB coverage is enforced when the provider is ECB-based.
  const providerName = deps.providers.fx.source.startsWith('frankfurter') ? 'frankfurter' : 'static';
  let lock;
  try {
    lock = createFxLockFromConfig(
      { base: input.base, quote, spotRate: spot.spotRate, rateAsOf: spot.asOf, now, source: spot.source },
      { 'fx.lock': { ...lockCfg, provider: providerName }, 'pricing.fx_markup': markupCfg },
    );
  } catch (err) {
    if (err instanceof CoreError) throw coreToAppError(err);
    throw err;
  }
  const row = await repo.insertLock(db, {
    base: lock.base,
    quote: lock.quote,
    spotRate: lock.spotRate,
    markupBps: lock.markupBps,
    lockedRate: lock.lockedRate,
    lockedAt: lock.lockedAt,
    expiresAt: lock.expiresAt,
    sourceRateId: spot.sourceRateId,
  });
  deps.logger.info('fx.lock_created', { lockId: row.id, base: row.base, quote: row.quote, userId: input.userId ?? null });
  return {
    id: row.id,
    base: row.base,
    quote: row.quote,
    spotRate: normalizeRate(row.spot_rate),
    markupBps: row.markup_bps,
    lockedRate: normalizeRate(row.locked_rate),
    lockedAt: row.locked_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    status: row.status,
    rateAsOf: spot.asOf.toISOString(),
    source: spot.source,
    sourceRateId: row.source_rate_id,
  };
}

/** Converts a foreign-currency amount (minor units) to IDR at the current spot (no markup). */
export async function toIdrAtSpot(db: Db, deps: FxDeps, amountMinor: number, currency: string): Promise<{ idr: number; rate: SpotRate }> {
  const rate = await getSpotRate(db, deps, currency, 'IDR');
  return { idr: await core(() => convert(amountMinor, currency, 'IDR', rate.spotRate)), rate };
}
