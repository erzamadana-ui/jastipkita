import { crossRate, estimateCustoms } from '@jastipkita/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../../../test/helpers';
import { MOCK_USD_RATES } from '../../providers/mock';
import { rulesInForce } from './repository';
import { estimateCustomsForItem } from './service';

const NOW = new Date('2026-10-05T03:00:00Z');
let t: TestContext;
beforeAll(async () => {
  t = await createTestContext({ now: NOW });
});
afterAll(async () => {
  await t.close();
});

const usdTable = { base: 'USD', asOf: NOW, rates: Object.fromEntries(Object.entries(MOCK_USD_RATES).map(([k, v]) => [k, String(v)])) };

describe('POST /v1/customs/estimate', () => {
  it('JP ¥60.000 item: NON_PERSONAL by default, matches core math, shows source & verification date', async () => {
    const res = await t.request('POST', '/v1/customs/estimate', {
      body: { originCountry: 'JP', categoryCode: 'TOYS_HOBBIES', unitPriceMinor: 60000, currency: 'JPY', quantity: 1 },
    });
    expect(res.status).toBe(200);
    expect(res.body.isEstimate).toBe(true);
    expect(res.body.treatment).toBe('NON_PERSONAL');
    expect(res.body.treatmentExplanation).toMatch(/BUKAN pribadi/);
    expect(res.body.disclaimer).toMatch(/Bea Cukai/);

    const itemToIdr = crossRate(usdTable, 'JPY', 'IDR');
    const usdToIdr = crossRate(usdTable, 'USD', 'IDR');
    const rules = await rulesInForce(t.sql, '2026-10-05', 'ID');
    const expected = estimateCustoms({
      originCountry: 'JP',
      destinationCountry: 'ID',
      categoryCode: 'TOYS_HOBBIES',
      itemValueMinor: 60000,
      currency: 'JPY',
      quantity: 1,
      fx: { itemToIdr, usdToIdr },
      date: NOW,
      rules,
    });
    const e = res.body.estimate;
    expect(e).toMatchObject({
      ruleCode: 'ID_PAX_NON_PERSONAL',
      ruleVersion: 1,
      treatment: 'NON_PERSONAL',
      customsValueIdr: expected.customsValueIdr,
      dutyIdr: expected.dutyIdr,
      vatIdr: expected.vatIdr,
      incomeTaxIdr: expected.incomeTaxIdr,
      totalIdr: expected.totalIdr,
      isEstimate: true,
      lastVerifiedAt: '2026-09-27',
    });
    // research doc §6 worked example (seed rule, CEIL_1000 on every component): ≈ Rp1.885.000
    expect(e.totalIdr).toBe(1_885_000);
    expect(e.sourceReference).toMatch(/PMK 34 Tahun 2025/);
    expect(e.sourceUrl).toMatch(/^https:\/\/jdih\.kemenkeu\.go\.id/);
    expect(e.ruleRef).toBe(`customs_rules:${e.ruleId}@v1`);
    expect(e.warnings.map((w: { code: string }) => w.code)).toContain('HS_CODE_DEFAULTED');
    expect(res.body.fx).toMatchObject({ itemToIdr, usdToIdr, source: 'static-mock' });

    // PERSONAL comparison for education: USD 500 exemption covers a ≈USD 381 item → 0
    expect(res.body.personalComparison).toMatchObject({ treatment: 'PERSONAL', totalIdr: 0 });
    expect(res.body.personalComparison.exemptionAppliedIdr).toBe(expected.customsValueIdr);
    expect(res.body.personalComparison.note).toMatch(/edukasi/);
  });

  it('validates input (unknown category, unsupported origin, bad currency)', async () => {
    const cat = await t.request('POST', '/v1/customs/estimate', {
      body: { originCountry: 'JP', categoryCode: 'NOPE', unitPriceMinor: 1, currency: 'JPY' },
    });
    expect(cat.status).toBe(422);
    expect(cat.body.error.code).toBe('CATEGORY_UNKNOWN');
    const origin = await t.request('POST', '/v1/customs/estimate', {
      body: { originCountry: 'CN', categoryCode: 'TOYS_HOBBIES', unitPriceMinor: 1, currency: 'CNY' },
    });
    expect(origin.body.error.code).toBe('COUNTRY_NOT_SUPPORTED');
    const neg = await t.request('POST', '/v1/customs/estimate', {
      body: { originCountry: 'JP', categoryCode: 'TOYS_HOBBIES', unitPriceMinor: -5, currency: 'JPY' },
    });
    expect(neg.status).toBe(400);
  });

  it('estimateCustomsForItem accepts caller FX (money group) and defaults to NON_PERSONAL', async () => {
    const est = await estimateCustomsForItem(t.sql, t.deps, {
      originCountry: 'JP',
      categoryCode: 'TOYS_HOBBIES',
      hsCode: '9503.00',
      unitPriceMinor: 50_000,
      currency: 'JPY',
      quantity: 1,
      fx: { itemToIdr: '109.6734442391', usdToIdr: '16481.4814814815' },
    });
    expect(est.treatment).toBe('NON_PERSONAL');
    expect(est.customsValueIdr).toBe(5_483_672);
    expect(est.dutyIdr).toBe(549_000);
    expect(est.warnings.map((w) => w.code)).not.toContain('HS_CODE_DEFAULTED');
  });
});
