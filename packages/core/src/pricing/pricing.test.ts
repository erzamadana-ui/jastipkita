import { describe, expect, it } from 'vitest';
import { DEFAULT_BUSINESS_CONFIG, type PaymentChannelConfig } from '../config';
import { type CustomsEstimate, estimateCustoms } from '../customs';
import { PRICE_LINE_TYPES } from '../domain';
import { createFxLock } from '../fx';
import { CUSTOMS_RULES } from '../testing/fixtures';
import { SEEDS, createPrng } from '../testing/prng';
import {
  type PricingConfig,
  type QuoteInput,
  allocateFunds,
  buildQuote,
  computePaymentFee,
  computeRateFee,
  computeTravelerFee,
  gatewayFee,
  quoteLineAmount,
} from './index';

const NOW = new Date('2026-09-27T03:00:00Z');
const CFG: PricingConfig = DEFAULT_BUSINESS_CONFIG;
const LOCK = createFxLock({ base: 'JPY', quote: 'IDR', spotRate: '108.5432', markupBps: 150, now: NOW, lockMinutes: 30 });

function customsFor(unitJpy: number, qty = 1): CustomsEstimate {
  return estimateCustoms({
    originCountry: 'JP',
    destinationCountry: 'ID',
    hsCode: '9503',
    categoryCode: 'TOYS_HOBBIES',
    itemValueMinor: unitJpy,
    currency: 'JPY',
    quantity: qty,
    fx: { itemToIdr: '108.5432', usdToIdr: '16000' },
    date: NOW,
    rules: CUSTOMS_RULES,
  });
}

function input(over: Partial<QuoteInput> = {}): QuoteInput {
  return {
    item: { unitPriceMinor: 50_000, currency: 'JPY', quantity: 1, unitWeightKg: 0.8 },
    fxLock: LOCK,
    travelerFee: { type: 'PERCENT', rateBps: 1000 },
    customs: customsFor(50_000),
    now: NOW,
    configVersion: 1,
    ...over,
  };
}

function sumLines(q: { lines: readonly { type: string; amountIdr: number }[] }): number {
  return q.lines.filter((l) => l.type !== 'TOTAL').reduce((a, l) => a + l.amountIdr, 0);
}

describe('buildQuote — full JPY→IDR quote', () => {
  const q = buildQuote(input(), CFG);

  it('emits all lines in §10 display order with buckets', () => {
    expect(q.lines.map((l) => l.type)).toEqual([...PRICE_LINE_TYPES]);
    expect(q.lines.map((l) => l.bucket)).toEqual([
      'PRODUCT_FUND',
      'TRAVELER_EARNING',
      'CUSTOMS_RESERVE',
      'CUSTOMS_RESERVE',
      'PLATFORM_REVENUE',
      'PLATFORM_REVENUE',
      'TAX_PAYABLE',
      'PAYMENT_FEE',
      'PROMOTION_CREDIT',
      'PROMOTION_CREDIT',
      'CLEARING',
    ]);
  });

  it('computes each line exactly', () => {
    expect(q.amounts.ITEM_PRICE).toBe(5_508_567); // ¥50,000 × 110.171348
    expect(q.amounts.TRAVELER_FEE).toBe(550_857); // 10%
    expect(q.amounts.CUSTOMS_DUTY).toBe(543_000);
    expect(q.amounts.IMPORT_TAX).toBe(1_852_000);
    expect(q.amounts.PROTECTION_FEE).toBe(82_629); // 1.5% = 82,628.505
    expect(q.amounts.PLATFORM_FEE).toBe(275_428); // 5% = 275,428.35
    expect(q.amounts.SERVICE_TAX).toBe(39_386); // 358,057 × 0.916667 × 12%
    expect(q.amounts.PAYMENT_FEE).toBe(4_500); // VA fixed, 0 bps
    expect(q.amounts.DISCOUNT).toBe(0);
    expect(q.totalIdr).toBe(8_856_367);
    expect(sumLines(q)).toBe(q.totalIdr);
  });

  it('marks customs lines and TOTAL as estimates with rule references', () => {
    const duty = q.lines.find((l) => l.type === 'CUSTOMS_DUTY');
    expect(duty?.isEstimate).toBe(true);
    expect(duty?.ruleRef).toBe('customs_rules:r-generic@v3');
    expect(q.lines.find((l) => l.type === 'TOTAL')?.isEstimate).toBe(true);
    expect(q.lines.find((l) => l.type === 'PLATFORM_FEE')?.ruleRef).toBe('business_configs:pricing.platform_fee@v1');
    expect(q.lines.find((l) => l.type === 'SERVICE_TAX')?.labelId).toBe('PPN atas layanan (12% x DPP 11/12)');
    expect(q.expiresAt?.toISOString()).toBe('2026-09-27T03:30:00.000Z');
    expect(q.blocksCheckout).toBe(false);
  });

  it('is deterministic', () => {
    expect(buildQuote(input(), CFG)).toEqual(q);
  });
});

describe('buildQuote — validation', () => {
  it('requires a matching FX lock for foreign currencies', () => {
    expect(() => buildQuote(input({ fxLock: null }), CFG)).toThrowError(expect.objectContaining({ code: 'FX_LOCK_REQUIRED' }));
    const krw = createFxLock({ base: 'KRW', quote: 'IDR', spotRate: '11.7', markupBps: 200, now: NOW, lockMinutes: 30 });
    expect(() => buildQuote(input({ fxLock: krw }), CFG)).toThrowError(expect.objectContaining({ code: 'FX_LOCK_MISMATCH' }));
  });

  it('flags an expired lock as blocking', () => {
    const q = buildQuote(input({ now: new Date('2026-09-27T03:31:00Z') }), CFG);
    expect(q.issues.map((i) => i.code)).toContain('FX_LOCK_EXPIRED');
    expect(q.blocksCheckout).toBe(true);
  });

  it('enforces the minimum transaction value', () => {
    const q = buildQuote(input({ item: { unitPriceMinor: 900, currency: 'JPY', quantity: 1 }, customs: customsFor(900) }), CFG);
    expect(q.amounts.ITEM_PRICE).toBe(99_154);
    expect(q.issues.find((i) => i.code === 'BELOW_MINIMUM_TRANSACTION')?.message).toBe('Nilai barang minimal Rp100.000.');
  });

  it('blocks when the customs estimate is missing or has no rule', () => {
    expect(buildQuote(input({ customs: null }), CFG).issues.map((i) => i.code)).toContain('CUSTOMS_ESTIMATE_MISSING');
    const noRule = estimateCustoms({ ...customsInputBase(), destinationCountry: 'MY' });
    const q = buildQuote(input({ customs: noRule }), CFG);
    expect(q.issues.map((i) => i.code)).toContain('CUSTOMS_NO_RULE');
    expect(q.amounts.CUSTOMS_DUTY).toBe(0);
  });

  it('supports IDR-priced items without an FX lock', () => {
    const q = buildQuote(input({ item: { unitPriceMinor: 1_000_000, currency: 'IDR', quantity: 2 }, fxLock: null }), CFG);
    expect(q.amounts.ITEM_PRICE).toBe(2_000_000);
    expect(q.fxRate).toBeNull();
    expect(q.expiresAt).toBeNull();
  });

  it('rejects unknown payment channels', () => {
    expect(() => buildQuote(input({ paymentChannel: 'CASH' }), CFG)).toThrowError(
      expect.objectContaining({ code: 'UNKNOWN_PAYMENT_CHANNEL' }),
    );
  });
});

function customsInputBase() {
  return {
    originCountry: 'JP',
    destinationCountry: 'ID',
    hsCode: '9503',
    categoryCode: 'TOYS_HOBBIES',
    itemValueMinor: 50_000,
    currency: 'JPY',
    quantity: 1,
    fx: { itemToIdr: '108.5432', usdToIdr: '16000' },
    date: NOW,
    rules: CUSTOMS_RULES,
  };
}

describe('traveler fee & rate fees', () => {
  const bounds = CFG['pricing.traveler_fee_bounds'];

  it('raises FIXED fees below the minimum and caps PERCENT fees above 30%', () => {
    expect(computeTravelerFee({ type: 'FIXED', amountIdr: 10_000 }, 1_000_000, null, bounds)).toMatchObject({
      amountIdr: 25_000,
      adjustment: 'RAISED_TO_MIN',
    });
    expect(computeTravelerFee({ type: 'PERCENT', rateBps: 5000 }, 1_000_000, null, bounds)).toMatchObject({
      amountIdr: 300_000,
      adjustment: 'CAPPED_AT_MAX_RATE',
    });
  });

  it('computes PER_KG fees from total weight and requires weight', () => {
    expect(computeTravelerFee({ type: 'PER_KG', perKgIdr: 150_000 }, 2_000_000, 1.25, bounds).amountIdr).toBe(187_500);
    expect(() => computeTravelerFee({ type: 'PER_KG', perKgIdr: 150_000 }, 2_000_000, null, bounds)).toThrowError(
      expect.objectContaining({ code: 'WEIGHT_REQUIRED' }),
    );
    const q = buildQuote(input({ travelerFee: { type: 'PER_KG', perKgIdr: 150_000 }, item: { unitPriceMinor: 25_000, currency: 'JPY', quantity: 2, unitWeightKg: 0.8 } }), CFG);
    expect(q.amounts.TRAVELER_FEE).toBe(240_000);
  });

  it('clamps platform and protection fees to min/max', () => {
    expect(computeRateFee(100_000, CFG['pricing.platform_fee'])).toBe(10_000);
    expect(computeRateFee(100_000_000, CFG['pricing.platform_fee'])).toBe(750_000);
    expect(computeRateFee(100_000, CFG['pricing.protection_fee'])).toBe(5_000);
  });
});

describe('payment fee gross-up', () => {
  const qris = CFG['pricing.payment_fees'].channels.QRIS as PaymentChannelConfig;
  const card = CFG['pricing.payment_fees'].channels.CARD as PaymentChannelConfig;

  it('covers the gateway fee on itself (QRIS 0.7%)', () => {
    const r = computePaymentFee(1_000_000, qris);
    // T = ceil(1,000,000 × 10,000 / 9,930) = 1,007,050 ; gateway = ceil(7,049.35) = 7,050 = fee
    const total = 1_000_000 + r.chargedIdr;
    expect(r.chargedIdr - gatewayFee(total, qris)).toBeGreaterThanOrEqual(0);
    expect(r.platformBorneIdr).toBe(0);
    expect(r.chargedIdr).toBe(7_050);
  });

  it('gross-up is minimal and sufficient for random payables and channels (property)', () => {
    for (const seed of SEEDS) {
      const r = createPrng(seed);
      const payable = r.int(1, 500_000_000);
      const ch: PaymentChannelConfig = { label: 'x', fixedIdr: r.int(0, 10_000), rateBps: r.int(0, 500), bearer: 'BUYER' };
      const { chargedIdr } = computePaymentFee(payable, ch);
      const T = payable + chargedIdr;
      expect(chargedIdr).toBeGreaterThanOrEqual(gatewayFee(T, ch));
      // one rupiah less would not cover the gateway fee
      expect(chargedIdr - 1).toBeLessThan(gatewayFee(T - 1, ch));
    }
  });

  it('CARD: fixed + rate grossed up', () => {
    const r = computePaymentFee(2_000_000, card);
    // T = ceil(2,002,000 × 10,000 / 9,710) = 2,061,792 ; gateway = 2,000 + ceil(59,791.97) = 61,792
    expect(r.chargedIdr).toBe(61_792);
    expect(r.chargedIdr).toBeGreaterThanOrEqual(gatewayFee(2_000_000 + r.chargedIdr, card));
  });

  it('bearer PLATFORM: no buyer line, platform absorbs the gateway fee', () => {
    const cfg: PricingConfig = {
      ...CFG,
      'pricing.payment_fees': { defaultChannel: 'QRIS', channels: { QRIS: { ...qris, bearer: 'PLATFORM' } } },
    };
    const q = buildQuote(input(), cfg);
    expect(q.amounts.PAYMENT_FEE).toBe(0);
    expect(q.platformBornePaymentFeeIdr).toBe(gatewayFee(q.totalIdr, qris));
    const alloc = allocateFunds(q);
    expect(alloc.byBucket.PAYMENT_FEE).toBe(q.platformBornePaymentFeeIdr);
    expect(alloc.balanced).toBe(true);
  });

  it('grossUp=false charges the fee on the pre-fee subtotal; shortfall is platform-borne', () => {
    const r = computePaymentFee(1_000_000, { ...qris, grossUp: false });
    expect(r.chargedIdr).toBe(7_000);
    expect(r.platformBorneIdr).toBe(49); // gateway on 1,007,000 = 7,049 → 49 short
  });
});

describe('promotions & credits', () => {
  it('caps the discount at the eligible base (never discounts taxes)', () => {
    const q = buildQuote(input({ promotion: { discountIdr: 999_999_999, promoIds: ['P1'] } }), CFG);
    const eligible = q.amounts.ITEM_PRICE + q.amounts.TRAVELER_FEE + q.amounts.PROTECTION_FEE + q.amounts.PLATFORM_FEE;
    expect(q.amounts.DISCOUNT).toBe(-eligible);
    expect(q.adjustments.map((a) => a.code)).toContain('CAPPED_AT_ELIGIBLE_BASE');
    expect(q.lines.find((l) => l.type === 'DISCOUNT')?.ruleRef).toBe('promotions:P1');
    expect(q.totalIdr).toBeGreaterThan(0);
  });

  it('referral credit cannot exceed payable; TOTAL 0 means payment fee 0', () => {
    const q = buildQuote(input({ referralCreditAvailableIdr: 50_000_000 }), CFG);
    expect(q.totalIdr).toBe(0);
    expect(q.amounts.PAYMENT_FEE).toBe(0);
    expect(q.adjustments.map((a) => a.code)).toContain('CAPPED_AT_PAYABLE');
    expect(sumLines(q)).toBe(0);
  });

  it('FREE_PLATFORM_FEE waives the line, keeps the original amount and lowers service tax', () => {
    const base = buildQuote(input(), CFG);
    const q = buildQuote(input({ promotion: { discountIdr: 0, freePlatformFee: true } }), CFG);
    const pl = q.lines.find((l) => l.type === 'PLATFORM_FEE');
    expect(pl?.amountIdr).toBe(0);
    expect(pl?.originalAmountIdr).toBe(275_428);
    expect(q.amounts.SERVICE_TAX).toBe(9_089); // 82,629 × 0.916667 × 12%
    expect(q.totalIdr).toBeLessThan(base.totalIdr);
  });

  it('service tax is zero when disabled', () => {
    const q = buildQuote(input(), { ...CFG, 'pricing.service_tax': { ...CFG['pricing.service_tax'], enabled: false } });
    expect(q.amounts.SERVICE_TAX).toBe(0);
  });
});

describe('allocateFunds', () => {
  it('maps lines to buckets and balances with promotion funding', () => {
    const q = buildQuote(input({ promotion: { discountIdr: 100_000 }, referralCreditAvailableIdr: 25_000 }), CFG);
    const a = allocateFunds(q);
    expect(a.byBucket.PRODUCT_FUND).toBe(q.amounts.ITEM_PRICE);
    expect(a.byBucket.CUSTOMS_RESERVE).toBe(q.amounts.CUSTOMS_DUTY + q.amounts.IMPORT_TAX);
    expect(a.byBucket.PLATFORM_REVENUE).toBe(q.amounts.PROTECTION_FEE + q.amounts.PLATFORM_FEE);
    expect(a.byBucket.PROMOTION_CREDIT).toBe(-125_000);
    expect(a.promotionFundingIdr).toBe(125_000);
    expect(a.obligationsIdr).toBe(q.totalIdr + 125_000);
    expect(a.balanced).toBe(true);
  });
});

describe('buildQuote — invariants (property)', () => {
  it('Σ lines = TOTAL, TOTAL ≥ 0, allocation balanced, deterministic', () => {
    const channels = Object.keys(CFG['pricing.payment_fees'].channels);
    for (const seed of SEEDS) {
      const r = createPrng(seed);
      const unit = r.int(0, 3_000_000);
      const qty = r.int(1, 4);
      const fee = r.pick([
        { type: 'FIXED', amountIdr: r.int(0, 2_000_000) },
        { type: 'PERCENT', rateBps: r.int(0, 6000) },
        { type: 'PER_KG', perKgIdr: r.int(0, 400_000) },
      ] as const);
      const inp = input({
        item: { unitPriceMinor: unit, currency: 'JPY', quantity: qty, unitWeightKg: r.int(1, 30) / 10 },
        travelerFee: fee,
        customs: customsFor(unit, qty),
        paymentChannel: r.pick(channels),
        promotion: r.bool() ? { discountIdr: r.int(0, 5_000_000), freePlatformFee: r.bool(0.2) } : null,
        referralCreditAvailableIdr: r.bool(0.3) ? r.int(0, 20_000_000) : 0,
      });
      const q = buildQuote(inp, CFG);
      expect(sumLines(q)).toBe(q.totalIdr);
      expect(q.totalIdr).toBeGreaterThanOrEqual(0);
      expect(quoteLineAmount(q, 'TOTAL')).toBe(q.totalIdr);
      if (q.totalIdr === 0) expect(q.amounts.PAYMENT_FEE).toBe(0);
      for (const l of q.lines) {
        expect(Number.isSafeInteger(l.amountIdr)).toBe(true);
        if (l.type === 'DISCOUNT' || l.type === 'REFERRAL_CREDIT') expect(l.amountIdr).toBeLessThanOrEqual(0);
        else expect(l.amountIdr).toBeGreaterThanOrEqual(0);
      }
      expect(allocateFunds(q).balanced).toBe(true);
      expect(buildQuote(inp, CFG)).toEqual(q);
    }
  });
});
