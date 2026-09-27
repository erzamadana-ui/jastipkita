import { describe, expect, it } from 'vitest';
import { DEFAULT_BUSINESS_CONFIG } from '../config';
import { CoreError } from '../errors';
import { CURRENCIES, ECB_REFERENCE_CURRENCIES, isEcbReferenceCurrency } from '../money';
import { SEEDS, createPrng } from '../testing/prng';
import {
  assertRateAvailable,
  convert,
  createFxLock,
  createFxLockFromConfig,
  crossRate,
  crossRateChecked,
  fxAdjustment,
  invertRate,
  isLockValid,
  isRateStale,
  markupBpsFor,
  normalizeRate,
  providerSupportsCurrency,
  quoteRate,
} from './index';

const NOW = new Date('2026-09-27T03:00:00Z');

describe('convert', () => {
  it('converts JPY (0 decimals) to IDR with half-up at target minor unit', () => {
    // ¥50,000 × 108.5432 = 5,427,160
    expect(convert(50_000, 'JPY', 'IDR', '108.5432')).toBe(5_427_160);
    // ¥1 × 108.5 = 108.5 → 109
    expect(convert(1, 'JPY', 'IDR', '108.5')).toBe(109);
  });

  it('respects minor units on both sides (USD cents → IDR, IDR → USD cents)', () => {
    // $12.34 × 16,250.5 = 200,531.17 → 200,531
    expect(convert(1234, 'USD', 'IDR', '16250.5')).toBe(200_531);
    // Rp1,000,000 × 0.0000615 = $61.50
    expect(convert(1_000_000, 'IDR', 'USD', '0.0000615')).toBe(6150);
  });

  it('never drifts like floats would (property: equals exact rational rounding)', () => {
    for (const seed of SEEDS.slice(0, 100)) {
      const r = createPrng(seed);
      const amount = r.int(0, 50_000_000);
      const rateInt = r.int(1, 2_000_000_000);
      const rate = `${Math.floor(rateInt / 10_000)}.${String(rateInt % 10_000).padStart(4, '0')}`;
      const out = convert(amount, 'JPY', 'IDR', rate);
      const exactTimes10k = BigInt(amount) * BigInt(rateInt);
      const expected = (exactTimes10k + 5_000n) / 10_000n;
      expect(BigInt(out)).toBe(expected);
    }
  });

  it('rejects zero/negative rates and unknown currencies', () => {
    expect(() => convert(100, 'JPY', 'IDR', 0)).toThrowError(CoreError);
    expect(() => convert(100, 'JPY', 'IDR', '-1')).toThrowError(CoreError);
    expect(() => convert(100, 'XYZ', 'IDR', 1)).toThrowError(/Unsupported currency/);
  });
});

describe('quoteRate & markup', () => {
  it('applies markup bps and keeps 10 decimal places', () => {
    expect(quoteRate('100', 150)).toBe('101.5');
    expect(quoteRate('108.5432', 150)).toBe('110.171348');
    expect(quoteRate('0.0000615', 200)).toBe('0.00006273');
    // rounding at the 10th decimal: 0.0000000001 × 1.015 = 0.0000000001015 → 0.0000000001
    expect(quoteRate('0.0000000001', 150)).toBe('0.0000000001');
  });

  it('picks per-currency markup with default fallback', () => {
    const cfg = { defaultBps: 150, perCurrency: { KRW: 200, JPY: 150 } };
    expect(markupBpsFor('KRW', cfg)).toBe(200);
    expect(markupBpsFor('SGD', cfg)).toBe(150);
  });

  it('normalizes and inverts rates', () => {
    expect(normalizeRate(0.1)).toBe('0.1');
    expect(normalizeRate('1.123456789049')).toBe('1.123456789');
    expect(invertRate('16000')).toBe('0.0000625');
  });
});

describe('FX lock', () => {
  const lock = createFxLock({
    base: 'JPY',
    quote: 'IDR',
    spotRate: '108.5432',
    markupBps: 150,
    now: NOW,
    lockMinutes: 30,
    rateAsOf: new Date('2026-09-26T14:00:00Z'),
    maxRateAgeMinutes: DEFAULT_BUSINESS_CONFIG['fx.lock'].maxRateAgeMinutes,
    source: 'frankfurter',
  });

  it('computes lockedRate, lockedAt and expiresAt', () => {
    expect(lock.lockedRate).toBe('110.171348');
    expect(lock.lockedAt.toISOString()).toBe('2026-09-27T03:00:00.000Z');
    expect(lock.expiresAt.toISOString()).toBe('2026-09-27T03:30:00.000Z');
  });

  it('is valid on [lockedAt, expiresAt)', () => {
    expect(isLockValid(lock, NOW)).toBe(true);
    expect(isLockValid(lock, new Date('2026-09-27T03:29:59.999Z'))).toBe(true);
    expect(isLockValid(lock, new Date('2026-09-27T03:30:00Z'))).toBe(false);
    expect(isLockValid(lock, new Date('2026-09-27T02:59:59Z'))).toBe(false);
  });

  it('refuses stale provider rates', () => {
    expect(() =>
      createFxLock({
        base: 'JPY',
        quote: 'IDR',
        spotRate: '108',
        markupBps: 150,
        now: NOW,
        lockMinutes: 30,
        rateAsOf: new Date('2026-09-24T02:59:00Z'),
        maxRateAgeMinutes: DEFAULT_BUSINESS_CONFIG['fx.lock'].maxRateAgeMinutes,
      }),
    ).toThrowError(expect.objectContaining({ code: 'FX_RATE_STALE' }));
    const maxAge = DEFAULT_BUSINESS_CONFIG['fx.lock'].maxRateAgeMinutes;
    expect(isRateStale(new Date('2026-09-24T02:59:00Z'), NOW, maxAge)).toBe(true);
    expect(isRateStale(new Date('2026-09-24T03:00:00Z'), NOW, maxAge)).toBe(false);
  });

  it('fxAdjustment reports the re-quote difference', () => {
    const adj = fxAdjustment(lock, '111.5', 50_000);
    expect(adj.oldQuoteMinor).toBe(5_508_567);
    expect(adj.newQuoteMinor).toBe(5_575_000);
    expect(adj.differenceMinor).toBe(66_433);
    expect(adj.direction).toBe('BUYER_PAYS_MORE');
    expect(fxAdjustment(lock, lock.lockedRate, 50_000).direction).toBe('NO_CHANGE');
    expect(fxAdjustment(lock, '100', 50_000).direction).toBe('BUYER_PAYS_LESS');
  });
});

describe('cross rates', () => {
  const table = {
    base: 'EUR',
    asOf: new Date('2026-09-26T14:00:00Z'),
    rates: { JPY: '162.3', IDR: '17800', USD: '1.08' },
  };

  it('derives JPY→IDR from EUR-based rates', () => {
    expect(crossRate(table, 'JPY', 'IDR')).toBe('109.6734442391');
    expect(crossRate(table, 'EUR', 'IDR')).toBe('17800');
    expect(crossRate(table, 'IDR', 'EUR')).toBe('0.0000561798');
    expect(crossRate(table, 'USD', 'USD')).toBe('1');
  });

  it('missing or non-ECB currencies → FX_RATE_UNAVAILABLE (never a silent 0)', () => {
    expect(() => crossRate(table, 'KRW', 'IDR')).toThrowError(
      expect.objectContaining({ code: 'FX_RATE_UNAVAILABLE', details: expect.objectContaining({ reason: 'MISSING_FROM_TABLE' }) }),
    );
    expect(() => crossRate(table, 'TWD', 'IDR')).toThrowError(
      expect.objectContaining({ code: 'FX_RATE_UNAVAILABLE', details: expect.objectContaining({ reason: 'NOT_ECB_REFERENCE' }) }),
    );
  });

  it('staleness uses config fx.lock.maxRateAgeMinutes (4320 = 72h): Friday ECB rate survives the weekend', () => {
    const maxAge = DEFAULT_BUSINESS_CONFIG['fx.lock'].maxRateAgeMinutes;
    const friday = { ...table, asOf: new Date('2026-09-25T14:00:00Z') }; // Fri 16:00 CET
    expect(crossRateChecked(friday, 'JPY', 'IDR', new Date('2026-09-28T03:00:00Z'), maxAge)).toBe('109.6734442391'); // Mon 10:00 WIB
    expect(() => crossRateChecked(friday, 'JPY', 'IDR', new Date('2026-09-28T14:00:01Z'), maxAge)).toThrowError(
      expect.objectContaining({ code: 'FX_RATE_STALE' }),
    );
  });
});

describe('ECB coverage & config-driven locks', () => {
  it('exposes ecbReference from currencies.json', () => {
    expect(CURRENCIES.find((c) => c.code === 'TWD')?.ecbReference).toBe(false);
    expect(isEcbReferenceCurrency('JPY')).toBe(true);
    expect([...ECB_REFERENCE_CURRENCIES].sort()).not.toContain('VND');
    expect(ECB_REFERENCE_CURRENCIES).toHaveLength(16);
  });

  it('ECB-based providers cannot quote TWD/VND/AED/SAR; other providers are not restricted', () => {
    for (const c of ['TWD', 'VND', 'AED', 'SAR']) expect(providerSupportsCurrency('frankfurter', c)).toBe(false);
    expect(providerSupportsCurrency('some-bank-feed', 'TWD')).toBe(true);
    expect(() => assertRateAvailable('frankfurter', 'VND', 'IDR')).toThrowError(expect.objectContaining({ code: 'FX_RATE_UNAVAILABLE' }));
  });

  it('createFxLockFromConfig applies lock window, per-currency markup, 72h staleness and coverage', () => {
    const lock = createFxLockFromConfig(
      { base: 'KRW', quote: 'IDR', spotRate: '11.7', rateAsOf: new Date('2026-09-25T14:00:00Z'), now: new Date('2026-09-28T03:00:00Z') },
      DEFAULT_BUSINESS_CONFIG,
    );
    expect(lock).toMatchObject({ markupBps: 200, lockedRate: '11.934', source: 'frankfurter' });
    expect(lock.expiresAt.toISOString()).toBe('2026-09-28T03:30:00.000Z');
    expect(() =>
      createFxLockFromConfig(
        { base: 'TWD', quote: 'IDR', spotRate: '500', rateAsOf: new Date('2026-09-27T00:00:00Z'), now: NOW },
        DEFAULT_BUSINESS_CONFIG,
      ),
    ).toThrowError(expect.objectContaining({ code: 'FX_RATE_UNAVAILABLE' }));
    expect(() =>
      createFxLockFromConfig(
        { base: 'JPY', quote: 'IDR', spotRate: '108', rateAsOf: new Date('2026-09-20T00:00:00Z'), now: NOW },
        DEFAULT_BUSINESS_CONFIG,
      ),
    ).toThrowError(expect.objectContaining({ code: 'FX_RATE_STALE' }));
  });
});
