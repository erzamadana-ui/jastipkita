import { describe, expect, it } from 'vitest';
import { DEFAULT_BUSINESS_CONFIG } from '../config';
import { SEEDS, createPrng } from '../testing/prng';
import {
  DEFAULT_RISK_RULES,
  type ReceiptProofInput,
  type RiskRule,
  type RiskSignals,
  assessReceipt,
  merchantBrandTokens,
  merchantsMatch,
  receiptHoldRequired,
  SOFT_RECEIPT_SIGNALS,
  assessRisk,
  createRiskRuleRegistry,
  decisionForScore,
  haversineKm,
} from './index';

const T = DEFAULT_BUSINESS_CONFIG['risk.thresholds'];
const codes = (s: RiskSignals, type: Parameters<typeof assessRisk>[0] = 'USER') => assessRisk(type, s, T).reasons.map((x) => x.code);

describe('decisionForScore', () => {
  it('maps 0–100 to ALLOW/REVIEW/HOLD/BLOCK at 40/70/90', () => {
    expect(decisionForScore(39, T)).toBe('ALLOW');
    expect(decisionForScore(40, T)).toBe('REVIEW');
    expect(decisionForScore(70, T)).toBe('HOLD');
    expect(decisionForScore(90, T)).toBe('BLOCK');
  });
});

describe('assessRisk rules', () => {
  it('clean signals → ALLOW with score 0', () => {
    expect(assessRisk('TRANSACTION', {}, T)).toMatchObject({ score: 0, decision: 'ALLOW', reasons: [] });
  });

  it('multi-account: shared identity forces at least REVIEW', () => {
    const a = assessRisk('USER', { sharedIdentityHashAccounts: 1 }, T);
    expect(a.score).toBe(40);
    expect(a.decision).toBe('REVIEW');
    expect(codes({ sharedDeviceAccounts: 2, sharedPaymentInstrumentAccounts: 1 })).toEqual(['SHARED_PAYMENT_INSTRUMENT', 'SHARED_DEVICE']);
  });

  it('device abuse and signup bursts', () => {
    expect(codes({ accountsOnDevice: 8 })).toContain('DEVICE_FARM');
    expect(codes({ accountsOnDevice: 4 })).toContain('DEVICE_MANY_ACCOUNTS');
    expect(codes({ accountsCreatedFromIpLast24h: 5, accountsCreatedFromDeviceLast24h: 3 })).toEqual([
      'SIGNUP_BURST_DEVICE',
      'SIGNUP_BURST_IP',
    ]);
  });

  it('suspicious transactions: history multiple, first-tx high value, new traveler, country mismatch', () => {
    const c = codes(
      {
        transactionValueIdr: 12_000_000,
        userAvgTransactionIdr: 1_000_000,
        userCompletedTransactions: 5,
        isFirstTransaction: true,
        counterpartyIsNewTraveler: true,
        userCountry: 'ID',
        ipCountry: 'NG',
      },
      'TRANSACTION',
    );
    expect(c.sort()).toEqual(['COUNTRY_MISMATCH', 'FIRST_TX_HIGH_VALUE', 'NEW_TRAVELER_HIGH_VALUE', 'VALUE_FAR_ABOVE_HISTORY']);
  });

  it('payment anomalies and chargebacks', () => {
    expect(codes({ failedPaymentsLast24h: 6, cardBinCountry: 'US', userCountry: 'ID' }, 'PAYMENT')).toEqual([
      'MANY_FAILED_PAYMENTS',
      'CARD_BIN_COUNTRY_MISMATCH',
    ]);
    expect(assessRisk('PAYMENT', { chargebackCount: 2 }, T).decision).toBe('HOLD');
  });

  it('refund abuse needs enough history', () => {
    expect(codes({ refundCount: 2, transactionCount: 2 })).toEqual([]);
    expect(codes({ refundCount: 2, transactionCount: 5 })).toEqual(['REFUND_RATE_HIGH']);
    expect(codes({ refundCount: 4, transactionCount: 5 })).toEqual(['REFUND_RATE_VERY_HIGH']);
  });

  it('referral abuse: self-referral blocks, shared payment holds; only for REFERRAL subjects', () => {
    const self = assessRisk('REFERRAL', { referral: { referrerId: 'u1', refereeId: 'u1' } }, T);
    expect(self.decision).toBe('BLOCK');
    const pay = assessRisk('REFERRAL', { referral: { referrerId: 'a', refereeId: 'b', sharedPaymentInstrument: true } }, T);
    expect(pay.decision).toBe('HOLD');
    expect(assessRisk('USER', { referral: { referrerId: 'u1', refereeId: 'u1' } }, T).reasons).toHaveLength(0);
    expect(
      codes({ referral: { referrerId: 'a', refereeId: 'b', sharedDevice: true, sharedIp: true, referrerReferralsLast24h: 9 } }, 'REFERRAL'),
    ).toEqual(['REFERRAL_SHARED_DEVICE', 'REFERRAL_VELOCITY', 'REFERRAL_SHARED_IP']);
  });

  it('location anomalies: impossible travel and trip origin mismatch', () => {
    expect(haversineKm({ lat: -6.2, lon: 106.8 }, { lat: 35.68, lon: 139.69 })).toBeCloseTo(5_790, -2);
    const c = codes(
      {
        previousLogin: { lat: -6.2, lon: 106.8, at: new Date('2026-09-27T00:00:00Z') },
        currentLogin: { lat: 35.68, lon: 139.69, at: new Date('2026-09-27T02:00:00Z') },
        tripOriginCountry: 'JP',
        deviceCountryDuringTrip: 'ID',
      },
      'LOGIN',
    );
    expect(c).toEqual(['IMPOSSIBLE_TRAVEL', 'TRIP_ORIGIN_MISMATCH']);
  });

  it('traveler behavior: receipt reuse holds', () => {
    const a = assessRisk('TRIP', { receiptReuseCount: 1, travelerCancellations90d: 4, lateDeliveryRate: 0.5, priceChangeRequestRate: 0.4 }, T);
    expect(a.score).toBe(80);
    expect(a.decision).toBe('HOLD');
  });

  it('score is clamped to 100 and monotonic when adding signals (property)', () => {
    for (const seed of SEEDS.slice(0, 100)) {
      const r = createPrng(seed);
      const s: RiskSignals = {
        sharedDeviceAccounts: r.int(0, 5),
        accountsOnDevice: r.int(0, 10),
        failedPaymentsLast24h: r.int(0, 8),
        chargebackCount: r.int(0, 3),
        refundCount: r.int(0, 5),
        transactionCount: r.int(3, 10),
      };
      const a = assessRisk('USER', s, T);
      const b = assessRisk('USER', { ...s, sharedIdentityHashAccounts: 1 }, T);
      expect(a.score).toBeLessThanOrEqual(100);
      expect(b.score).toBeGreaterThanOrEqual(a.score);
    }
  });
});

describe('rule registry', () => {
  it('lets an ML-style rule plug in and replace/remove rules by code', () => {
    const model: RiskRule = {
      code: 'ML_V0',
      category: 'MODEL',
      appliesTo: 'ALL',
      evaluate: () => [{ code: 'ML_V0', category: 'MODEL', weight: 45, message: 'model p=0.45' }],
    };
    const reg = createRiskRuleRegistry().register(model);
    expect(reg.list()).toHaveLength(DEFAULT_RISK_RULES.length + 1);
    expect(reg.assess('USER', {}).decision).toBe('REVIEW');
    expect(reg.unregister('ML_V0').assess('USER', {}).decision).toBe('ALLOW');
    const bad: RiskRule = { ...model, evaluate: () => [{ code: 'X', category: 'MODEL', weight: Number.NaN, message: '' }] };
    expect(() => createRiskRuleRegistry([bad]).assess('USER', {})).toThrow();
  });
});

describe('assessReceipt', () => {
  const base: ReceiptProofInput = {
    transactionId: 'tx1',
    imageHash: 'h-abc',
    receiptNumber: 'R-0001',
    merchantName: 'Bic Camera Shinjuku',
    purchasedAt: new Date('2026-09-27T05:00:00Z'),
    amountMinor: 50_000,
    currency: 'JPY',
    serialNumber: 'SN123',
    hasVideo: true,
    expected: {
      paymentSecuredAt: new Date('2026-09-27T03:00:00Z'),
      purchaseApprovedAt: new Date('2026-09-27T04:00:00Z'),
      approvedAmountMinor: 50_000,
      approvedCurrency: 'JPY',
      merchantName: 'Bic Camera',
      requiresSerial: true,
      requiresVideo: true,
    },
    now: new Date('2026-09-27T06:00:00Z'),
  };

  it('clean proof → ALLOW, complete, within price', () => {
    const a = assessReceipt(base, { imageHashes: [{ hash: 'h-abc', transactionId: 'tx1' }] });
    expect(a).toMatchObject({ decision: 'ALLOW', score: 0, proofComplete: true, priceWithinApproved: true });
  });

  it('duplicate image / receipt number / serial from other transactions → HOLD', () => {
    const a = assessReceipt(base, {
      imageHashes: [{ hash: 'h-abc', transactionId: 'tx0' }],
      receiptNumbers: [{ merchant: 'BIC CAMERA', number: 'r-0001', transactionId: 'tx0' }],
      serialNumbers: [{ serial: 'sn123', transactionId: 'tx9' }],
    });
    expect(a.reasons.map((x) => x.code)).toEqual(['DUPLICATE_RECEIPT_IMAGE', 'DUPLICATE_RECEIPT_NUMBER', 'DUPLICATE_SERIAL']);
    expect(a.decision).toBe('BLOCK');
  });

  it('purchase before payment secured violates the golden rule', () => {
    const a = assessReceipt({ ...base, purchasedAt: new Date('2026-09-27T02:00:00Z') }, { imageHashes: [] });
    expect(a.reasons.map((x) => x.code)).toContain('PURCHASED_BEFORE_PAYMENT_SECURED');
    expect(a.decision).toBe('REVIEW');
  });

  it('price above approved, merchant mismatch, missing serial & video', () => {
    const a = assessReceipt(
      { ...base, amountMinor: 51_000, merchantName: 'Yodobashi', serialNumber: null, hasVideo: false },
      { imageHashes: [] },
    );
    expect(a.reasons.map((x) => x.code).sort()).toEqual(['MERCHANT_MISMATCH', 'MISSING_SERIAL', 'MISSING_VIDEO', 'PRICE_ABOVE_APPROVED']);
    expect(a.proofComplete).toBe(false);
    expect(a.priceWithinApproved).toBe(false);
    const tol = assessReceipt({ ...base, amountMinor: 50_900, expected: { ...base.expected, toleranceBps: 200 } }, { imageHashes: [] });
    expect(tol.priceWithinApproved).toBe(true);
  });
});

describe('merchant matching (brand vs domain) & soft receipt signals', () => {
  it('matches a URL-derived domain merchant with the brand\'s store; different brands do not match', () => {
    expect(merchantsMatch('Pokemon Center Tokyo DX', 'pokemoncenter-online.com')).toBe(true);
    expect(merchantsMatch('UNIQLO Ginza', 'https://www.uniqlo.com/jp/ja/products/E477133')).toBe(true);
    expect(merchantsMatch('Amazon Japan', 'www.amazon.co.jp')).toBe(true);
    expect(merchantsMatch('Yodobashi Camera Akiba', 'Yodobashi Camera')).toBe(true);
    expect(merchantsMatch('UNIQLO Official Store', 'Uniqlo')).toBe(true);
    expect(merchantsMatch('Bic Camera', 'Yodobashi')).toBe(false);
    expect(merchantsMatch('Don Quijote', 'uniqlo.com')).toBe(false);
    expect(merchantsMatch('Shop', 'Store')).toBe(false); // generic words alone never match
    expect(merchantBrandTokens('https://www.pokemoncenter-online.com/?p_cd=1')).toEqual(['pokemoncenter']);
  });

  it('MERCHANT_MISMATCH alone is a low-weight REVIEW signal that does not require a payout hold', () => {
    const base: ReceiptProofInput = {
      transactionId: 'tx1',
      imageHash: 'h-abc',
      merchantName: 'Bic Camera',
      purchasedAt: new Date('2026-09-27T05:00:00Z'),
      amountMinor: 50_000,
      currency: 'JPY',
      serialNumber: 'SN123',
      hasVideo: true,
      expected: {
        paymentSecuredAt: new Date('2026-09-27T03:00:00Z'),
        purchaseApprovedAt: new Date('2026-09-27T04:00:00Z'),
        approvedAmountMinor: 50_000,
        approvedCurrency: 'JPY',
        merchantName: 'Yodobashi',
        requiresSerial: true,
        requiresVideo: true,
      },
      now: new Date('2026-09-27T06:00:00Z'),
    };
    const a = assessReceipt(base, { imageHashes: [] });
    expect(a.reasons.map((x) => x.code)).toEqual(['MERCHANT_MISMATCH']);
    expect(a.decision).toBe('REVIEW');
    expect(a.score).toBeLessThanOrEqual(10);
    expect(receiptHoldRequired(a.reasons)).toBe(false);
    const hard = assessReceipt({ ...base, merchantName: 'Bic Camera', amountMinor: 51_000 }, { imageHashes: [] });
    expect(receiptHoldRequired(hard.reasons)).toBe(true);
    expect(SOFT_RECEIPT_SIGNALS.has('MERCHANT_MISMATCH')).toBe(true);
  });
});

