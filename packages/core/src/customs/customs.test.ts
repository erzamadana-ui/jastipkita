import { describe, expect, it } from 'vitest';
import { CUSTOMS_RULES } from '../testing/fixtures';
import { SEEDS, createPrng } from '../testing/prng';
import { type CustomsEstimateInput, customsRuleRef, estimateCustoms, isRuleEffective, rankCustomsRules, selectRule } from './index';

const DATE = new Date('2026-09-27T03:00:00Z');
const ctx = {
  originCountry: 'JP',
  destinationCountry: 'ID',
  treatment: 'NON_PERSONAL' as const,
  date: DATE,
};

function input(over: Partial<CustomsEstimateInput> = {}): CustomsEstimateInput {
  return {
    originCountry: 'JP',
    destinationCountry: 'ID',
    hsCode: '9503.00',
    categoryCode: 'TOYS_HOBBIES',
    itemValueMinor: 50_000,
    currency: 'JPY',
    quantity: 1,
    fx: { itemToIdr: '108.5432', usdToIdr: '16000' },
    date: DATE,
    rules: CUSTOMS_RULES,
    ...over,
  };
}

describe('selectRule', () => {
  it('prefers the longest HS prefix over category and origin', () => {
    const r = selectRule(CUSTOMS_RULES, { ...ctx, originCountry: 'US', hsCode: '6403.99', categoryCode: 'FOOTWEAR' });
    expect(r?.id).toBe('r-footwear-hs');
  });

  it('prefers category over origin, origin over generic', () => {
    expect(selectRule(CUSTOMS_RULES, { ...ctx, originCountry: 'US', categoryCode: 'COSMETICS_SKINCARE' })?.id).toBe(
      'r-cosmetics-cat',
    );
    expect(selectRule(CUSTOMS_RULES, { ...ctx, originCountry: 'US', categoryCode: 'TOYS_HOBBIES' })?.id).toBe('r-us-origin');
    expect(selectRule(CUSTOMS_RULES, { ...ctx, categoryCode: 'TOYS_HOBBIES' })?.id).toBe('r-generic');
  });

  it('ignores DRAFT rules; effective dates are INCLUSIVE calendar dates in Asia/Jakarta (§16)', () => {
    expect(selectRule(CUSTOMS_RULES, { ...ctx, hsCode: '85171200' })?.id).toBe('r-generic');
    // old rule: until 2024-12-31 (inclusive); new rule: from 2025-01-01
    const lastMomentOfOld = selectRule(CUSTOMS_RULES, { ...ctx, hsCode: '6403', date: new Date('2024-12-31T16:59:59Z') }); // 23:59:59 WIB
    expect(lastMomentOfOld?.id).toBe('r-old-footwear');
    const firstMomentOfNew = selectRule(CUSTOMS_RULES, { ...ctx, hsCode: '6403', date: new Date('2024-12-31T17:00:00Z') }); // 00:00 WIB
    expect(firstMomentOfNew?.id).toBe('r-footwear-hs');
  });

  it('isRuleEffective: inclusive both ends; accepts DB date strings and timestamps', () => {
    const rule = { effectiveFrom: '2026-01-01', effectiveUntil: '2026-01-31' };
    expect(isRuleEffective(rule, new Date('2025-12-31T17:00:00Z'))).toBe(true); // 1 Jan 00:00 WIB
    expect(isRuleEffective(rule, new Date('2025-12-31T16:59:59Z'))).toBe(false);
    expect(isRuleEffective(rule, new Date('2026-01-31T16:59:59Z'))).toBe(true); // 31 Jan 23:59:59 WIB
    expect(isRuleEffective(rule, new Date('2026-01-31T17:00:00Z'))).toBe(false);
    expect(isRuleEffective({ effectiveFrom: new Date('2026-01-01T00:00:00Z'), effectiveUntil: null }, new Date('2030-01-01'))).toBe(true);
  });

  it('breaks specificity ties by priority, then latest effectiveFrom, then id', () => {
    const a = { ...(CUSTOMS_RULES[0] as (typeof CUSTOMS_RULES)[number]), id: 'a', priority: 1 };
    const b = { ...a, id: 'b', priority: 5 };
    const c = { ...a, id: 'c', priority: 5, effectiveFrom: '2026-01-01' };
    expect(rankCustomsRules([a, b, c], { ...ctx, categoryCode: 'X' }).map((r) => r.id)).toEqual(['c', 'b', 'a']);
  });

  it('respects treatment on the rule', () => {
    const personalOnly = { ...(CUSTOMS_RULES[0] as (typeof CUSTOMS_RULES)[number]), id: 'p', treatment: 'PERSONAL' as const, priority: 99 };
    expect(selectRule([personalOnly], { ...ctx, categoryCode: 'X' })).toBeNull();
    expect(selectRule([personalOnly], { ...ctx, treatment: 'PERSONAL', categoryCode: 'X' })?.id).toBe('p');
  });
});

describe('estimateCustoms — ID_PASSENGER_V2025', () => {
  it('NON_PERSONAL (jastip default): full value, no exemption, no-NPWP income tax, CEIL_1000', () => {
    const e = estimateCustoms(input());
    expect(e.ruleId).toBe('r-generic');
    expect(e.treatment).toBe('NON_PERSONAL');
    expect(e.customsValueIdr).toBe(5_427_160);
    expect(e.exemptionAppliedIdr).toBe(0);
    expect(e.dutyIdr).toBe(543_000); // 542,716 → ceil 1000
    expect(e.vatIdr).toBe(657_000); // 5,970,160 × 0.916667 × 12% = 656,717.84 → 656,718 → 657,000
    expect(e.luxuryTaxIdr).toBe(0);
    expect(e.incomeTaxIdr).toBe(1_195_000); // 20% no-NPWP of 5,970,160 = 1,194,032 → 1,195,000
    expect(e.importTaxIdr).toBe(1_852_000);
    expect(e.totalIdr).toBe(2_395_000);
    expect(e.isEstimate).toBe(true);
    expect(e.warnings.map((w) => w.code)).toContain('EXEMPTION_NOT_APPLIED');
    expect(e.breakdownSteps.at(-1)?.amount).toBe(2_395_000);
    expect(customsRuleRef(e)).toBe('customs_rules:r-generic@v3');
  });

  it('PERSONAL with NPWP: USD 500 exemption, 10% income tax', () => {
    const e = estimateCustoms(
      input({ currency: 'USD', itemValueMinor: 60_000, fx: { itemToIdr: '16000', usdToIdr: '16000' }, treatment: 'PERSONAL', hasNpwp: true }),
    );
    expect(e.customsValueIdr).toBe(9_600_000);
    expect(e.exemptionAppliedIdr).toBe(8_000_000);
    expect(e.taxableValueIdr).toBe(1_600_000);
    expect(e.dutyIdr).toBe(160_000);
    expect(e.vatIdr).toBe(194_000); // 1,760,000 × 0.11000004 = 193,600.07 → 194,000
    expect(e.incomeTaxIdr).toBe(176_000);
    expect(e.totalIdr).toBe(530_000);
  });

  it('PERSONAL below exemption → zero duty and tax', () => {
    const e = estimateCustoms(input({ treatment: 'PERSONAL' }));
    expect(e.exemptionAppliedIdr).toBe(5_427_160);
    expect(e.totalIdr).toBe(0);
  });

  it('caps the exemption with the traveler’s remaining allowance', () => {
    const e = estimateCustoms(input({ treatment: 'PERSONAL', travelerAllowanceUsd: '100' }));
    expect(e.exemptionAppliedIdr).toBe(1_600_000);
    expect(e.taxableValueIdr).toBe(3_827_160);
    expect(e.warnings.map((w) => w.code)).toContain('ALLOWANCE_CAPPED');
  });

  it('defaults a missing HS code to the category default and warns', () => {
    const e = estimateCustoms(input({ hsCode: null, categoryCode: 'FOOTWEAR' }));
    expect(e.hsCodeUsed).toBe('6403');
    expect(e.ruleId).toBe('r-footwear-hs');
    expect(e.dutyIdr).toBe(1_357_000); // 25% of 5,427,160 = 1,356,790 → 1,357,000
    expect(e.warnings.map((w) => w.code)).toContain('HS_CODE_DEFAULTED');
  });

  it('warns when rule verification is stale', () => {
    const e = estimateCustoms(input({ date: new Date('2027-06-01T00:00:00Z') }));
    expect(e.warnings.map((w) => w.code)).toContain('RULE_VERIFICATION_STALE');
  });
});

describe('estimateCustoms — other formulas', () => {
  it('FLAT_RATES applies each rate to the full value without cascade (rounding NONE)', () => {
    const e = estimateCustoms(input({ categoryCode: 'COSMETICS_SKINCARE', hsCode: '3304', itemValueMinor: 10_000 }));
    // value = 1,085,432
    expect(e.ruleId).toBe('r-cosmetics-cat');
    expect(e.dutyIdr).toBe(162_815); // × 15% = 162,814.8
    expect(e.vatIdr).toBe(119_398); // × 0.916667 × 12% = 119,397.56
    expect(e.incomeTaxIdr).toBe(108_543);
    expect(e.totalIdr).toBe(162_815 + 119_398 + 108_543);
  });

  it('EXEMPT returns zero amounts with the rule reference', () => {
    const e = estimateCustoms(input({ categoryCode: 'BOOKS_MEDIA', hsCode: '4901' }));
    expect(e.ruleCode).toBe('ID_BOOKS_EXEMPT');
    expect(e.totalIdr).toBe(0);
    expect(e.exemptionAppliedIdr).toBe(e.customsValueIdr);
  });

  it('returns NO_RULE with zero amounts when nothing matches', () => {
    const e = estimateCustoms(input({ destinationCountry: 'MY' }));
    expect(e.ruleId).toBeNull();
    expect(e.totalIdr).toBe(0);
    expect(e.warnings.map((w) => w.code)).toContain('NO_RULE');
  });

  it('throws when a needed FX rate is missing', () => {
    expect(() => estimateCustoms(input({ fx: {} }))).toThrowError(expect.objectContaining({ code: 'FX_RATE_MISSING' }));
    expect(() => estimateCustoms(input({ treatment: 'PERSONAL', fx: { itemToIdr: '100' } }))).toThrowError(
      expect.objectContaining({ code: 'FX_RATE_MISSING' }),
    );
  });
});

describe('estimateCustoms — invariants (property)', () => {
  it('totals reconcile, amounts are non-negative, and tax is monotonic in value', () => {
    const categories = ['TOYS_HOBBIES', 'FOOTWEAR', 'COSMETICS_SKINCARE', 'MOBILE_PHONES', 'BOOKS_MEDIA'];
    for (const seed of SEEDS) {
      const r = createPrng(seed);
      const treatment = r.bool() ? 'PERSONAL' : 'NON_PERSONAL';
      const common = {
        categoryCode: r.pick(categories),
        hsCode: null,
        quantity: r.int(1, 5),
        treatment,
        hasNpwp: r.bool(),
      } as const;
      const v1 = r.int(0, 2_000_000);
      const v2 = v1 + r.int(0, 2_000_000);
      const a = estimateCustoms(input({ ...common, itemValueMinor: v1 }));
      const b = estimateCustoms(input({ ...common, itemValueMinor: v2 }));
      for (const e of [a, b]) {
        expect(e.importTaxIdr).toBe(e.vatIdr + e.luxuryTaxIdr + e.incomeTaxIdr);
        expect(e.totalIdr).toBe(e.dutyIdr + e.importTaxIdr);
        expect(Math.min(e.dutyIdr, e.vatIdr, e.luxuryTaxIdr, e.incomeTaxIdr)).toBeGreaterThanOrEqual(0);
        expect(e.taxableValueIdr).toBe(e.customsValueIdr - e.exemptionAppliedIdr);
      }
      expect(b.totalIdr).toBeGreaterThanOrEqual(a.totalIdr);
    }
  });
});
