// Unit tests for the offline customs fallback (node --test; Node >= 22.18 strips TS types natively).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateNonPersonal, estimatePersonal, effectiveRatePct } from '../../src/lib/customs.ts';
import { formatIdr, mulHalfUp } from '../../src/lib/money.ts';

const KMK = { JPY: '113.7125', USD: '17707' };

test('research worked example: JPY 60.000 jastip (NON_PERSONAL) → Rp1.885.000 (engine CEIL_1000)', () => {
  const r = estimateNonPersonal({ unitPrice: '60000', quantity: 1, itemToIdr: KMK.JPY, usdToIdr: KMK.USD });
  assert.equal(r.customsValueIdr, 6_822_750);
  assert.equal(r.dutyIdr, 683_000);
  assert.equal(r.importValueIdr, 7_505_750);
  assert.equal(r.vatIdr, 826_000);
  assert.equal(r.incomeTaxIdr, 376_000);
  assert.equal(r.totalIdr, 1_885_000);
  assert.equal(effectiveRatePct(r.totalIdr, r.customsValueIdr), '27,6');
});

test('no-NPWP scenario uses the DRAFT 10% PPh rate', () => {
  const r = estimateNonPersonal({ unitPrice: '60000', quantity: 1, itemToIdr: KMK.JPY, usdToIdr: KMK.USD, noNpwpScenario: true });
  assert.equal(r.incomeTaxIdr, 751_000); // 750.575 → CEIL_1000
  assert.equal(r.ruleVersion, 2);
});

test('PERSONAL comparison: JPY 100.000 with USD 500 exemption', () => {
  const r = estimatePersonal({ unitPrice: '100000', quantity: 1, itemToIdr: KMK.JPY, usdToIdr: KMK.USD });
  assert.equal(r.customsValueIdr, 11_371_250);
  assert.equal(r.exemptionAppliedIdr, 8_853_500);
  assert.equal(r.dutyIdr, 252_000);
  assert.equal(r.vatIdr, 305_000);
  assert.equal(r.incomeTaxIdr, 0);
  assert.equal(r.totalIdr, 557_000);
});

test('PERSONAL under USD 500 is fully exempt', () => {
  const r = estimatePersonal({ unitPrice: '100', quantity: 1, itemToIdr: KMK.USD, usdToIdr: KMK.USD });
  assert.equal(r.totalIdr, 0);
});

test('decimal prices in 2-dp currencies are exact', () => {
  assert.equal(mulHalfUp('129.90', 2, '13893.47'), 3_609_524); // 3.609.523,506 → half-up
  const r = estimateNonPersonal({ unitPrice: '129.90', quantity: 2, itemToIdr: '13893.47', usdToIdr: KMK.USD });
  assert.equal(r.customsValueIdr, 3_609_524);
});

test('formatIdr follows the brand format', () => {
  assert.equal(formatIdr(11577140), 'Rp 11.577.140');
  assert.equal(formatIdr(-50000), '−Rp 50.000');
  assert.equal(formatIdr(1234567, 'en'), 'IDR 1,234,567');
});
