/**
 * Pins every number shown in packages/core/README.md "Worked example: JPY → IDR landed cost".
 * If this test fails after an intentional change, update the README together with it.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BUSINESS_CONFIG as cfg,
  type Promotion,
  allocateFunds,
  buildQuote,
  computeRateFee,
  convert,
  createFxLock,
  crossRate,
  crossRateChecked,
  estimateCustoms,
  evaluateCancellation,
  evaluatePromotions,
  gatewayFee,
  markupBpsFor,
} from './index';
import { CUSTOMS_RULES } from './testing/fixtures';

describe('README worked example', () => {
  const now = new Date('2026-09-27T03:00:00Z');
  const table = { base: 'EUR', asOf: new Date('2026-09-26T14:00:00Z'), rates: { JPY: '162.3', IDR: '17800', USD: '1.08' } };
  const spot = crossRateChecked(table, 'JPY', 'IDR', now, cfg['fx.lock'].maxRateAgeMinutes);
  const usdIdr = crossRate(table, 'USD', 'IDR');
  const lock = createFxLock({
    base: 'JPY',
    quote: 'IDR',
    spotRate: spot,
    markupBps: markupBpsFor('JPY', cfg['pricing.fx_markup']),
    now,
    lockMinutes: cfg['fx.lock'].lockMinutes,
    rateAsOf: table.asOf,
    maxRateAgeMinutes: cfg['fx.lock'].maxRateAgeMinutes,
  });
  const customs = estimateCustoms({
    originCountry: 'JP',
    destinationCountry: 'ID',
    hsCode: '9503.00',
    categoryCode: 'TOYS_HOBBIES',
    itemValueMinor: 50_000,
    currency: 'JPY',
    quantity: 1,
    fx: { itemToIdr: spot, usdToIdr: usdIdr },
    date: now,
    rules: CUSTOMS_RULES,
  });
  const itemIdr = convert(50_000, 'JPY', 'IDR', lock.lockedRate);
  const firstTx: Promotion = {
    id: 'promo-first',
    type: 'FIRST_TRANSACTION',
    name: 'Diskon transaksi pertama',
    status: 'ACTIVE',
    startsAt: new Date('2026-09-01T00:00:00Z'),
    endsAt: new Date('2026-10-01T00:00:00Z'),
    benefit: { kind: 'FIXED', amountIdr: 50_000 },
  };
  const promo = evaluatePromotions(
    {
      itemValueIdr: itemIdr,
      travelerFeeIdr: 0,
      platformFeeIdr: computeRateFee(itemIdr, cfg['pricing.platform_fee']),
      originCountry: 'JP',
      categoryCode: 'TOYS_HOBBIES',
    },
    [firstTx],
    { id: 'u1', isFirstTransaction: true },
    now,
  );
  const quote = buildQuote(
    {
      item: { unitPriceMinor: 50_000, currency: 'JPY', quantity: 1, unitWeightKg: 0.8 },
      fxLock: lock,
      travelerFee: { type: 'PERCENT', rateBps: 1000 },
      customs,
      paymentChannel: 'QRIS',
      promotion: promo,
      referralCreditAvailableIdr: 25_000,
      now,
      configVersion: 1,
    },
    cfg,
  );

  it('FX: cross rate, markup, lock window', () => {
    expect(spot).toBe('109.6734442391');
    expect(usdIdr).toBe('16481.4814814815');
    expect(lock.lockedRate).toBe('111.3185459027');
    expect(lock.expiresAt.toISOString()).toBe('2026-09-27T03:30:00.000Z');
  });

  it('customs estimate', () => {
    expect(customs).toMatchObject({
      ruleCode: 'ID_PASSENGER_GENERIC',
      customsValueIdr: 5_483_672,
      dutyIdr: 549_000,
      vatIdr: 664_000,
      luxuryTaxIdr: 0,
      incomeTaxIdr: 1_207_000,
      importTaxIdr: 1_871_000,
      totalIdr: 2_420_000,
    });
  });

  it('quote lines and total', () => {
    expect(quote.lines.map((l) => [l.type, l.amountIdr])).toEqual([
      ['ITEM_PRICE', 5_565_927],
      ['TRAVELER_FEE', 556_593],
      ['CUSTOMS_DUTY', 549_000],
      ['IMPORT_TAX', 1_871_000],
      ['PROTECTION_FEE', 83_489],
      ['PLATFORM_FEE', 278_296],
      ['SERVICE_TAX', 39_796],
      ['PAYMENT_FEE', 62_522],
      ['DISCOUNT', -50_000],
      ['REFERRAL_CREDIT', -25_000],
      ['TOTAL', 8_931_623],
    ]);
    expect(gatewayFee(quote.totalIdr, cfg['pricing.payment_fees'].channels.QRIS ?? { fixedIdr: 0, rateBps: 0 })).toBe(62_522);
    expect(quote.blocksCheckout).toBe(false);
  });

  it('fund allocation', () => {
    const a = allocateFunds(quote);
    expect(a.byBucket).toMatchObject({
      PRODUCT_FUND: 5_565_927,
      TRAVELER_EARNING: 556_593,
      CUSTOMS_RESERVE: 2_420_000,
      PLATFORM_REVENUE: 361_785,
      TAX_PAYABLE: 39_796,
      PAYMENT_FEE: 62_522,
      PROMOTION_CREDIT: -75_000,
    });
    expect(a).toMatchObject({ cashInIdr: 8_931_623, promotionFundingIdr: 75_000, obligationsIdr: 9_006_623, balanced: true });
  });

  it('buyer cancels at PURCHASE_APPROVED', () => {
    const c = evaluateCancellation({ status: 'PURCHASE_APPROVED', actor: 'BUYER', quoteLines: quote.lines, paymentCaptured: true }, cfg['cancellation.matrix']);
    expect(c).toMatchObject({
      stage: 'BEFORE_PURCHASE',
      refundIdr: 8_654_396,
      travelerCompensationIdr: 55_659,
      platformRetainedIdr: 139_148,
      paymentFeeRetainedIdr: 62_522,
      serviceTaxRetainedIdr: 19_898,
      creditRestoredIdr: 25_000,
      discountReversedIdr: 50_000,
      trustPenalty: 3,
    });
  });
});
