import { describe, expect, it } from 'vitest';
import { CANCELLATION_STAGES } from '../domain';
import { isSupportedCurrency } from '../money';
import {
  BUSINESS_CONFIG_KEYS,
  BUSINESS_CONFIG_META,
  COUNTRIES,
  DEFAULT_BUSINESS_CONFIG,
  PRODUCT_CATEGORIES,
  getCategory,
  getCountry,
  validateBusinessConfig,
  validateBusinessConfigSet,
} from './index';

type DeepMutable<T> = T extends object ? { -readonly [K in keyof T]: DeepMutable<T[K]> } : T;

function clone<T>(v: T): DeepMutable<T> {
  return JSON.parse(JSON.stringify(v)) as DeepMutable<T>;
}

describe('DEFAULT_BUSINESS_CONFIG', () => {
  it('contains every key and validates cleanly', () => {
    for (const key of BUSINESS_CONFIG_KEYS) {
      const r = validateBusinessConfig(key, DEFAULT_BUSINESS_CONFIG[key]);
      expect(r.ok, `${key}: ${JSON.stringify(r.ok ? [] : r.errors)}`).toBe(true);
    }
    expect(validateBusinessConfigSet(clone(DEFAULT_BUSINESS_CONFIG)).ok).toBe(true);
  });

  it('is deep-frozen', () => {
    expect(Object.isFrozen(DEFAULT_BUSINESS_CONFIG)).toBe(true);
    expect(Object.isFrozen(DEFAULT_BUSINESS_CONFIG['pricing.payment_fees'].channels.VA)).toBe(true);
    expect(() => {
      (DEFAULT_BUSINESS_CONFIG['pricing.platform_fee'] as { rateBps: number }).rateBps = 1;
    }).toThrow();
  });

  it('exposes _meta assumptions separately', () => {
    expect(BUSINESS_CONFIG_META.currency).toBe('IDR');
    expect(BUSINESS_CONFIG_META.assumptions.length).toBeGreaterThan(0);
  });

  it('matches binding doc values (risk thresholds 40/70/90, PIN 6 digits / 5 attempts)', () => {
    expect(DEFAULT_BUSINESS_CONFIG['risk.thresholds']).toEqual({ review: 40, hold: 70, block: 90 });
    expect(DEFAULT_BUSINESS_CONFIG.delivery.pinLength).toBe(6);
    expect(DEFAULT_BUSINESS_CONFIG.delivery.maxPinAttempts).toBe(5);
    expect(DEFAULT_BUSINESS_CONFIG.price_confirmation.windowSeconds).toBe(900);
    expect(DEFAULT_BUSINESS_CONFIG.trips.allowUnverifiedActive).toBe(false);
  });
});

describe('validateBusinessConfig', () => {
  it('rejects negative fees and min > max', () => {
    const r = validateBusinessConfig('pricing.platform_fee', { rateBps: 500, minIdr: -1, maxIdr: 100 });
    expect(r.ok).toBe(false);
    const r2 = validateBusinessConfig('pricing.platform_fee', { rateBps: 500, minIdr: 1000, maxIdr: 100 });
    expect(r2.ok ? [] : r2.errors.map((e) => e.path)).toContain('pricing.platform_fee.minIdr');
  });

  it('rejects bps above 10 000 and non-integer bps', () => {
    expect(validateBusinessConfig('pricing.protection_fee', { rateBps: 10_001, minIdr: 0, maxIdr: 1 }).ok).toBe(false);
    expect(validateBusinessConfig('pricing.protection_fee', { rateBps: 1.5, minIdr: 0, maxIdr: 1 }).ok).toBe(false);
  });

  it('rejects unknown fields (typo protection) and missing fields', () => {
    const r = validateBusinessConfig('pricing.platform_fee', { rateBPS: 500, minIdr: 0, maxIdr: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.map((e) => e.path)).toEqual(
        expect.arrayContaining(['pricing.platform_fee.rateBPS', 'pricing.platform_fee.rateBps']),
      );
    }
  });

  it('requires payment channel rate < 100% and a valid default channel', () => {
    const cfg = clone(DEFAULT_BUSINESS_CONFIG['pricing.payment_fees']);
    const qris = cfg.channels.QRIS;
    if (qris) qris.rateBps = 10_000;
    cfg.defaultChannel = 'CASH';
    const r = validateBusinessConfig('pricing.payment_fees', cfg);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.map((e) => e.path)).toEqual(
        expect.arrayContaining(['pricing.payment_fees.channels.QRIS.rateBps', 'pricing.payment_fees.defaultChannel']),
      );
    }
  });

  it('detects missing and duplicate cancellation matrix rows', () => {
    const matrix = clone(DEFAULT_BUSINESS_CONFIG['cancellation.matrix']).filter(
      (r) => !(r.stage === 'AFTER_PAYMENT' && r.actor === 'BUYER'),
    );
    const r = validateBusinessConfig('cancellation.matrix', matrix);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.message.includes('AFTER_PAYMENT'))).toBe(true);

    const dup = [...clone(DEFAULT_BUSINESS_CONFIG['cancellation.matrix']), clone(DEFAULT_BUSINESS_CONFIG['cancellation.matrix'][0])];
    const r2 = validateBusinessConfig('cancellation.matrix', dup);
    expect(r2.ok ? '' : r2.errors.map((e) => e.message).join()).toContain('duplicate');
  });

  it('requires full refund coverage on allowed post-payment rows', () => {
    const matrix = clone(DEFAULT_BUSINESS_CONFIG['cancellation.matrix']);
    const idx = matrix.findIndex((r) => r.stage === 'BEFORE_PURCHASE' && r.actor === 'BUYER');
    const row = matrix[idx];
    if (row) delete row.refund.PAYMENT_FEE;
    const r = validateBusinessConfig('cancellation.matrix', matrix);
    expect(r.ok ? [] : r.errors.map((e) => e.path)).toContain(`cancellation.matrix[${idx}].refund.PAYMENT_FEE`);
  });

  it('accepts cause rows (distinct from the plain row) but rejects bad causes and duplicate causes', () => {
    const matrix = DEFAULT_BUSINESS_CONFIG['cancellation.matrix'];
    expect(matrix.some((r) => r.cause === 'PRICE_CHANGE_REJECTED')).toBe(true);
    const bad = clone(matrix);
    const causeRow = bad.find((r) => r.cause !== undefined);
    if (causeRow) causeRow.cause = 'price change';
    expect(validateBusinessConfig('cancellation.matrix', bad).ok).toBe(false);
    const dup = [...clone(matrix), clone(matrix.find((r) => r.cause !== undefined))];
    const r = validateBusinessConfig('cancellation.matrix', dup);
    expect(r.ok ? '' : r.errors.map((e) => e.message).join()).toContain('AFTER_PAYMENT/BUYER/PRICE_CHANGE_REJECTED');
  });

  it('fx.lock: 72h staleness default, optional fallbackProvider/note, unknown fields rejected', () => {
    expect(DEFAULT_BUSINESS_CONFIG['fx.lock'].maxRateAgeMinutes).toBe(4320);
    expect(validateBusinessConfig('fx.lock', { lockMinutes: 30, maxRateAgeMinutes: 4320, provider: 'frankfurter' }).ok).toBe(true);
    expect(validateBusinessConfig('fx.lock', { lockMinutes: 30, maxRateAgeMinutes: 4320, provider: 'x', fallback: 'y' }).ok).toBe(false);
  });

  it('enforces ordered risk thresholds and trust tiers', () => {
    expect(validateBusinessConfig('risk.thresholds', { review: 70, hold: 40, block: 90 }).ok).toBe(false);
    const limits = clone(DEFAULT_BUSINESS_CONFIG['limits.transaction']);
    const tier = limits.trustMultipliers[2];
    if (tier) tier.minScore = 10;
    expect(validateBusinessConfig('limits.transaction', limits).ok).toBe(false);
  });

  it('rejects unknown keys and incomplete sets', () => {
    const bad = { ...clone(DEFAULT_BUSINESS_CONFIG), 'pricing.unknown': {} } as Record<string, unknown>;
    delete bad.trips;
    const r = validateBusinessConfigSet(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.path)).toEqual(expect.arrayContaining(['pricing.unknown', 'trips']));
  });
});

describe('reference data', () => {
  it('categories are unique with valid risk levels and weights', () => {
    const codes = PRODUCT_CATEGORIES.map((c) => c.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const c of PRODUCT_CATEGORIES) {
      expect(['LOW', 'MEDIUM', 'HIGH']).toContain(c.risk);
      expect(c.defaultWeightKg).toBeGreaterThan(0);
      if (c.defaultHs !== null) expect(c.defaultHs).toMatch(/^\d{4}$/);
    }
    expect(getCategory('MOBILE_PHONES').requiresSerial).toBe(true);
  });

  it('countries reference supported currencies; Indonesia is the only destination', () => {
    for (const c of COUNTRIES) expect(isSupportedCurrency(c.currency)).toBe(true);
    expect(COUNTRIES.filter((c) => c.destination).map((c) => c.code)).toEqual(['ID']);
    expect(getCountry('JP').currency).toBe('JPY');
    expect(() => getCountry('ZZ')).toThrow();
  });

  it('cancellation stages in the default matrix cover the domain list', () => {
    const stages = new Set(DEFAULT_BUSINESS_CONFIG['cancellation.matrix'].map((r) => r.stage));
    expect([...stages].sort()).toEqual([...CANCELLATION_STAGES].sort());
  });
});

describe('config keys added in wave A integration', () => {
  it('accepts defaults for money.policy, marketplace.lifetimes, support.sla', async () => {
    const { validateBusinessConfig, DEFAULT_BUSINESS_CONFIG } = await import('./index');
    for (const k of ['money.policy', 'marketplace.lifetimes', 'support.sla'] as const) {
      expect(validateBusinessConfig(k, DEFAULT_BUSINESS_CONFIG[k]).ok).toBe(true);
    }
  });
  it('rejects invalid values', async () => {
    const { validateBusinessConfig } = await import('./index');
    expect(validateBusinessConfig('money.policy', { refundAutoApproveMaxIdr: -1, refundMaxSystemRetries: 3, payoutMaxSystemRetries: 3, payoutDelayHours: 0, pendingPaymentPollMinutes: 15, payoutFeeIdr: 0, payoutMinIdr: 0 }).ok).toBe(false);
    expect(validateBusinessConfig('money.policy', { refundAutoApproveMaxIdr: 1, refundMaxSystemRetries: 3, payoutMaxSystemRetries: 3, payoutDelayHours: 0, pendingPaymentPollMinutes: 15, payoutFeeIdr: 0, payoutMinIdr: 0 }).ok).toBe(true);
    expect(validateBusinessConfig('marketplace.lifetimes', { requestExpiryDays: 0, offerExpiryHours: 48, unpublishedTripGraceDays: 0 }).ok).toBe(false);
    expect(validateBusinessConfig('marketplace.lifetimes', { requestExpiryDays: 30, offerExpiryHours: 9999, unpublishedTripGraceDays: 0 }).ok).toBe(false);
    expect(validateBusinessConfig('support.sla', { hoursByPriority: { URGENT: 24, HIGH: 12, NORMAL: 24, LOW: 72 } }).ok).toBe(false);
    expect(validateBusinessConfig('support.sla', { hoursByPriority: { URGENT: 4, HIGH: 12, NORMAL: 24 } }).ok).toBe(false);
    expect(validateBusinessConfig('referral.traveler', { enabled: true, referrerCreditIdr: 50000, requiredCompletedTransactions: 2, monthlyCapIdr: 250000, creditExpiryDays: 90, withdrawable: false, pendingExpiryDays: 0 }).ok).toBe(false);
  });
});
