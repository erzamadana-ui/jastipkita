/**
 * Frankfurter FX adapter (ECB euro reference rates) — docs/research/03-fx-providers.md.
 *
 *   GET {FX_FRANKFURTER_BASE_URL}/latest?base=EUR&symbols=IDR,JPY,...
 *   → { "amount": 1.0, "base": "EUR", "date": "2026-09-25", "rates": { "IDR": 20413.1, ... } }
 *
 * - v1 endpoint (default base URL https://api.frankfurter.dev/v1), ECB data only → deterministic & auditable.
 * - No API key, no quota (rate-limited to prevent abuse): the API fetches at most hourly (job) and
 *   serves everything else from fx_rates.
 * - Weekend / TARGET-holiday staleness: ECB publishes ~16:00 CET on business days only; `date` is the
 *   ECB reference day, so on Saturday–Monday afternoon we still get Friday's rate. We report
 *   `asOf = <date>T14:00:00Z` (≈16:00 CEST, the earliest publication instant — conservative) and never
 *   the fetch time, so staleness guards (`fx.lock.maxRateAgeMinutes`, default 72 h) see the true age.
 * - Symbols not in the ECB reference set (TWD, VND, AED, SAR…) are never requested: Frankfurter
 *   answers 404 for the whole request otherwise.
 */
import { isEcbReferenceCurrency, isSupportedCurrency } from '@jastipkita/core';
import type { FxProvider, FxSnapshot } from '../types';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface FrankfurterOptions {
  baseUrl: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  now?: () => Date;
}

export class FxProviderError extends Error {
  constructor(
    readonly code: 'FX_PROVIDER_TIMEOUT' | 'FX_PROVIDER_HTTP' | 'FX_PROVIDER_BAD_RESPONSE' | 'FX_PROVIDER_UNSUPPORTED',
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'FxProviderError';
  }
}

/** ECB publication instant used as `asOf` for an ECB reference date. */
export function ecbAsOf(date: string): Date {
  return new Date(`${date}T14:00:00Z`);
}

export class FrankfurterFxProvider implements FxProvider {
  readonly mode = 'LIVE' as const;
  readonly source = 'frankfurter-ecb';
  private readonly fetchFn: FetchLike;
  private readonly timeoutMs: number;
  private readonly now: () => Date;
  private readonly baseUrl: string;

  constructor(opts: FrankfurterOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.fetchFn = opts.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = opts.timeoutMs ?? 5000;
    this.now = opts.now ?? (() => new Date());
  }

  async latest(base: string, symbols: string[]): Promise<FxSnapshot> {
    if (!isSupportedCurrency(base) || !isEcbReferenceCurrency(base)) {
      throw new FxProviderError('FX_PROVIDER_UNSUPPORTED', `${base} is not an ECB reference currency`, { base });
    }
    const wanted = [...new Set(symbols)].filter((s) => s !== base && isSupportedCurrency(s) && isEcbReferenceCurrency(s)).sort();
    const url = `${this.baseUrl}/latest?base=${encodeURIComponent(base)}${wanted.length ? `&symbols=${wanted.map(encodeURIComponent).join(',')}` : ''}`;

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    let body: unknown;
    try {
      const res = await this.fetchFn(url, { method: 'GET', headers: { accept: 'application/json' }, signal: ac.signal, redirect: 'follow' });
      if (!res.ok) throw new FxProviderError('FX_PROVIDER_HTTP', `Frankfurter HTTP ${res.status}`, { status: res.status });
      body = await res.json();
    } catch (err) {
      if (err instanceof FxProviderError) throw err;
      if (ac.signal.aborted) throw new FxProviderError('FX_PROVIDER_TIMEOUT', `Frankfurter timed out after ${this.timeoutMs} ms`);
      throw new FxProviderError('FX_PROVIDER_BAD_RESPONSE', `Frankfurter request failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timer);
    }
    return this.parse(body, base);
  }

  /** Validates the v1 payload shape; rejects zero/negative/non-finite rates. */
  parse(body: unknown, base: string): FxSnapshot {
    if (!body || typeof body !== 'object') throw new FxProviderError('FX_PROVIDER_BAD_RESPONSE', 'Frankfurter: body is not an object');
    const b = body as { base?: unknown; date?: unknown; rates?: unknown };
    if (b.base !== base) throw new FxProviderError('FX_PROVIDER_BAD_RESPONSE', `Frankfurter: base ${String(b.base)} ≠ ${base}`);
    if (typeof b.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(b.date)) {
      throw new FxProviderError('FX_PROVIDER_BAD_RESPONSE', 'Frankfurter: missing/invalid date');
    }
    if (!b.rates || typeof b.rates !== 'object') throw new FxProviderError('FX_PROVIDER_BAD_RESPONSE', 'Frankfurter: missing rates');
    const rates: Record<string, number> = {};
    for (const [ccy, v] of Object.entries(b.rates as Record<string, unknown>)) {
      if (!/^[A-Z]{3}$/.test(ccy) || !isSupportedCurrency(ccy)) continue;
      if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
        throw new FxProviderError('FX_PROVIDER_BAD_RESPONSE', `Frankfurter: invalid rate for ${ccy}`, { currency: ccy });
      }
      rates[ccy] = v;
    }
    // Never report a time in the future (fetch shortly after publication / clock skew).
    const published = ecbAsOf(b.date);
    const now = this.now();
    const asOf = published.getTime() > now.getTime() ? now : published;
    return { source: this.source, base, asOf, rates };
  }
}
