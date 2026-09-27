import { describe, expect, it } from 'vitest';
import { DEFAULT_BUSINESS_CONFIG } from '../config';
import { SEEDS, createPrng } from '../testing/prng';
import { type LimitInput, checkLimit, computeTransactionLimit, trustMultiplierFor } from './index';

const CFG = DEFAULT_BUSINESS_CONFIG['limits.transaction'];
const buyer: LimitInput = {
  kycLevel: 3,
  trustScore: 50,
  completedTransactions: 5,
  productRisk: 'LOW',
  countryRisk: 'LOW',
  role: 'BUYER',
  monthUsedIdr: 0,
};

describe('computeTransactionLimit', () => {
  it('uses the KYC base with trust tiers', () => {
    expect(computeTransactionLimit(buyer, CFG).perTransactionMaxIdr).toBe(15_000_000);
    expect(computeTransactionLimit({ ...buyer, trustScore: 39 }, CFG).perTransactionMaxIdr).toBe(7_500_000);
    expect(computeTransactionLimit({ ...buyer, trustScore: 85 }, CFG).perTransactionMaxIdr).toBe(30_000_000);
    expect(trustMultiplierFor(70, CFG)).toBe(1.5);
  });

  it('applies product and country risk multipliers exactly (no float drift)', () => {
    const r = computeTransactionLimit({ ...buyer, kycLevel: 2, productRisk: 'MEDIUM', countryRisk: 'MEDIUM' }, CFG);
    expect(r.perTransactionMaxIdr).toBe(1_920_000); // 3,000,000 × 0.8 × 0.8
    expect(r.reasons.map((x) => x.code)).toEqual(expect.arrayContaining(['PRODUCT_RISK', 'COUNTRY_RISK']));
  });

  it('caps new travelers', () => {
    const t = computeTransactionLimit({ ...buyer, role: 'TRAVELER', kycLevel: 4, trustScore: 90, completedTransactions: 2 }, CFG);
    expect(t.perTransactionMaxIdr).toBe(5_000_000);
    expect(t.newTravelerCapApplied).toBe(true);
    const seasoned = computeTransactionLimit({ ...buyer, role: 'TRAVELER', kycLevel: 4, trustScore: 90, completedTransactions: 3 }, CFG);
    expect(seasoned.perTransactionMaxIdr).toBe(40_000_000);
  });

  it('KYC 1 buyers and KYC 2 travelers cannot transact', () => {
    expect(computeTransactionLimit({ ...buyer, kycLevel: 1 }, CFG).perTransactionMaxIdr).toBe(0);
    expect(checkLimit(1, { ...buyer, role: 'TRAVELER', kycLevel: 2 }, CFG)).toMatchObject({ ok: false, code: 'KYC_LEVEL_TOO_LOW' });
    expect(() => computeTransactionLimit({ ...buyer, kycLevel: 6 }, CFG)).toThrow();
  });

  it('tracks the monthly remaining budget', () => {
    const r = computeTransactionLimit({ ...buyer, kycLevel: 5, trustScore: 90, monthUsedIdr: 140_000_000 }, CFG);
    expect(r.monthlyRemainingIdr).toBe(10_000_000);
    expect(r.effectiveMaxIdr).toBe(10_000_000);
    expect(r.reasons.map((x) => x.code)).toContain('MONTHLY_REMAINING');
  });
});

describe('checkLimit', () => {
  it('distinguishes per-transaction and monthly breaches', () => {
    expect(checkLimit(15_000_000, buyer, CFG).ok).toBe(true);
    expect(checkLimit(15_000_001, buyer, CFG)).toMatchObject({ ok: false, code: 'PER_TRANSACTION_LIMIT_EXCEEDED' });
    expect(checkLimit(5_000_000, { ...buyer, monthUsedIdr: 148_000_000 }, CFG)).toMatchObject({
      ok: false,
      code: 'MONTHLY_LIMIT_EXCEEDED',
    });
  });

  it('limit is monotonic in trust score and KYC level (property)', () => {
    for (const seed of SEEDS.slice(0, 100)) {
      const r = createPrng(seed);
      const inp: LimitInput = {
        ...buyer,
        role: r.pick(['BUYER', 'TRAVELER'] as const),
        kycLevel: r.int(1, 4),
        trustScore: r.int(0, 90),
        completedTransactions: r.int(0, 10),
        productRisk: r.pick(['LOW', 'MEDIUM', 'HIGH'] as const),
      };
      const a = computeTransactionLimit(inp, CFG).perTransactionMaxIdr;
      expect(computeTransactionLimit({ ...inp, trustScore: inp.trustScore + r.int(0, 10) }, CFG).perTransactionMaxIdr).toBeGreaterThanOrEqual(a);
      expect(computeTransactionLimit({ ...inp, kycLevel: inp.kycLevel + 1 }, CFG).perTransactionMaxIdr).toBeGreaterThanOrEqual(a);
      expect(a % 1000).toBe(0);
    }
  });
});
