import { describe, expect, it } from 'vitest';
import { DEFAULT_BUSINESS_CONFIG } from '../config';
import { SEEDS, createPrng } from '../testing/prng';
import { evaluatePriceChange, isWindowExpired, resolveExpired, windowExpiresAt } from './index';

const PC = DEFAULT_BUSINESS_CONFIG.price_confirmation; // 200 bps, max Rp50.000
const base = { securedItemIdr: 1_000_000, toleranceBps: PC.toleranceBps, toleranceMaxIdr: PC.toleranceMaxIdr };

describe('evaluatePriceChange', () => {
  it('auto-approves increases within tolerance (2%, capped at Rp50.000)', () => {
    const r = evaluatePriceChange({ ...base, actualItemIdr: 1_020_000 });
    expect(r.outcome).toBe('WITHIN_TOLERANCE');
    expect(r.toleranceIdr).toBe(20_000);
    expect(r.absorbedWithinToleranceIdr).toBe(20_000);
    expect(r.nextTransactionStatus).toBe('PURCHASE_APPROVED');
  });

  it('needs confirmation beyond tolerance and reports the top-up', () => {
    const r = evaluatePriceChange({ ...base, actualItemIdr: 1_020_001 });
    expect(r.outcome).toBe('NEEDS_CONFIRMATION');
    expect(r.supplementalRequiredIdr).toBe(20_001);
    expect(r.nextTransactionStatus).toBe('PRICE_CHANGE_PENDING');
  });

  it('caps tolerance at toleranceMaxIdr for large items', () => {
    const r = evaluatePriceChange({ ...base, securedItemIdr: 10_000_000, actualItemIdr: 10_050_001 });
    expect(r.toleranceIdr).toBe(50_000);
    expect(r.outcome).toBe('NEEDS_CONFIRMATION');
  });

  it('decreases are auto-approved with a refund due', () => {
    const r = evaluatePriceChange({ ...base, actualItemIdr: 800_000 });
    expect(r.outcome).toBe('WITHIN_TOLERANCE');
    expect(r.direction).toBe('DECREASE');
    expect(r.refundDueIdr).toBe(200_000);
  });

  it('flags max-budget breaches and never auto-approves them', () => {
    const r = evaluatePriceChange({ ...base, maxBudgetIdr: 1_010_000, actualItemIdr: 1_015_000 });
    expect(r.exceedsMaxBudget).toBe(true);
    expect(r.outcome).toBe('NEEDS_CONFIRMATION');
  });

  it('outcome is monotonic in the actual price (property)', () => {
    for (const seed of SEEDS.slice(0, 100)) {
      const r = createPrng(seed);
      const secured = r.int(100_000, 50_000_000);
      const a = r.int(0, secured * 2);
      const b = a + r.int(0, secured);
      const ea = evaluatePriceChange({ ...base, securedItemIdr: secured, actualItemIdr: a });
      const eb = evaluatePriceChange({ ...base, securedItemIdr: secured, actualItemIdr: b });
      if (ea.outcome === 'NEEDS_CONFIRMATION') expect(eb.outcome).toBe('NEEDS_CONFIRMATION');
      expect(ea.supplementalRequiredIdr + ea.absorbedWithinToleranceIdr - ea.refundDueIdr).toBe(ea.differenceIdr);
    }
  });
});

describe('window & expiry', () => {
  it('computes the window from now', () => {
    const now = new Date('2026-09-27T03:00:00Z');
    const exp = windowExpiresAt(now, PC.windowSeconds);
    expect(exp.toISOString()).toBe('2026-09-27T03:15:00.000Z');
    expect(isWindowExpired(exp, new Date('2026-09-27T03:14:59Z'))).toBe(false);
    expect(isWindowExpired(exp, exp)).toBe(true);
    expect(() => windowExpiresAt(now, 0)).toThrow();
  });

  it('default expiredAction REJECT → REFUND_PENDING', () => {
    expect(resolveExpired(PC)).toMatchObject({ action: 'REJECT', transactionTo: 'REFUND_PENDING' });
  });

  it('APPROVE_WITHIN_BUDGET approves only unfunded-free, in-budget changes', () => {
    const cfg = { expiredAction: 'APPROVE_WITHIN_BUDGET' } as const;
    expect(resolveExpired(cfg, { supplementalRequiredIdr: 0, exceedsMaxBudget: false }).transactionTo).toBe('PURCHASE_APPROVED');
    expect(resolveExpired(cfg, { supplementalRequiredIdr: 1, exceedsMaxBudget: false }).transactionTo).toBe('REFUND_PENDING');
  });
});
