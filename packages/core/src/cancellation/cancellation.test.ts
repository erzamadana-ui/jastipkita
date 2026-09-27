import { describe, expect, it } from 'vitest';
import { DEFAULT_BUSINESS_CONFIG } from '../config';
import { ACTORS, TRANSACTION_STATUSES } from '../domain';
import { buildQuote } from '../pricing';
import { SEEDS, createPrng } from '../testing/prng';
import { type CancellationResult, type PaidLine, cancellationStage, evaluateCancellation } from './index';

const MATRIX = DEFAULT_BUSINESS_CONFIG['cancellation.matrix'];

function lines(over: Partial<Record<string, number>> = {}): PaidLine[] {
  const v = {
    ITEM_PRICE: 2_000_000,
    TRAVELER_FEE: 50_000,
    CUSTOMS_DUTY: 200_000,
    IMPORT_TAX: 460_000,
    PROTECTION_FEE: 30_000,
    PLATFORM_FEE: 100_000,
    SERVICE_TAX: 14_300,
    PAYMENT_FEE: 4_500,
    DISCOUNT: 0,
    REFERRAL_CREDIT: 0,
    ...over,
  };
  const total = Object.values(v).reduce((a, b) => a + b, 0);
  return [...Object.entries(v).map(([type, amountIdr]) => ({ type, amountIdr }) as PaidLine), { type: 'TOTAL', amountIdr: total }];
}

function reconciles(r: CancellationResult): boolean {
  return (
    r.refundIdr +
      r.travelerCompensationIdr +
      r.platformRetainedIdr +
      r.paymentFeeRetainedIdr +
      r.customsRetainedIdr +
      r.serviceTaxRetainedIdr ===
    r.paidIdr + r.promoConsumedIdr
  );
}

describe('cancellationStage', () => {
  it('maps statuses to matrix stages', () => {
    expect(cancellationStage('REQUEST_CREATED')).toBe('BEFORE_MATCH');
    expect(cancellationStage('AWAITING_PAYMENT')).toBe('AFTER_MATCH');
    expect(cancellationStage('PRICE_CHANGE_PENDING')).toBe('AFTER_PAYMENT');
    expect(cancellationStage('PURCHASE_APPROVED')).toBe('BEFORE_PURCHASE');
    expect(cancellationStage('PURCHASED')).toBe('AFTER_PURCHASE');
    expect(cancellationStage('TRAVELING')).toBe('DURING_TRAVEL');
    expect(cancellationStage('OUT_FOR_DELIVERY')).toBe('AFTER_ARRIVAL');
    for (const s of ['DISPUTED', 'REFUND_PENDING', 'BUYER_CONFIRMED', 'COMPLETED', 'CANCELLED', 'REFUNDED'] as const) {
      expect(cancellationStage(s)).toBeNull();
    }
  });
});

describe('evaluateCancellation', () => {
  it('BEFORE_MATCH (ANY row): allowed, nothing paid, → CANCELLED', () => {
    const r = evaluateCancellation({ status: 'REQUEST_CREATED', actor: 'BUYER', quoteLines: [], paymentCaptured: false }, MATRIX);
    expect(r).toMatchObject({ allowed: true, matrixActor: 'ANY', refundIdr: 0, transitionPath: ['CANCELLED'], fsmPermitsActor: true });
  });

  it('AFTER_PAYMENT by BUYER: everything back except the payment fee; penalty 2', () => {
    const r = evaluateCancellation({ status: 'PAYMENT_SECURED', actor: 'BUYER', quoteLines: lines(), paymentCaptured: true }, MATRIX);
    expect(r.allowed).toBe(true);
    expect(r.paidIdr).toBe(2_858_800);
    expect(r.refundIdr).toBe(2_854_300);
    expect(r.paymentFeeRetainedIdr).toBe(4_500);
    expect(r.trustPenalty).toBe(2);
    expect(r.penalizedActor).toBe('BUYER');
    expect(r.transitionPath).toEqual(['REFUND_PENDING']);
    expect(reconciles(r)).toBe(true);
  });

  it('BEFORE_PURCHASE by BUYER: partial fee refunds and traveler compensation (min Rp10.000)', () => {
    const r = evaluateCancellation({ status: 'PURCHASE_APPROVED', actor: 'BUYER', quoteLines: lines(), paymentCaptured: true }, MATRIX);
    expect(r.refundByLine.TRAVELER_FEE).toBe(45_000);
    expect(r.refundByLine.PLATFORM_FEE).toBe(50_000);
    expect(r.refundByLine.SERVICE_TAX).toBe(7_150);
    // pool = 5,000 (traveler) + 50,000 (platform) → comp max(10,000, 5,000) = 10,000
    expect(r.travelerCompensationIdr).toBe(10_000);
    expect(r.platformRetainedIdr).toBe(45_000);
    expect(r.serviceTaxRetainedIdr).toBe(7_150);
    expect(r.refundIdr).toBe(2_858_800 - 5_000 - 50_000 - 7_150 - 4_500);
    expect(reconciles(r)).toBe(true);
  });

  it('AFTER_PURCHASE by BUYER is refused with the matrix reason', () => {
    const r = evaluateCancellation({ status: 'PURCHASED', actor: 'BUYER', quoteLines: lines(), paymentCaptured: true }, MATRIX);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('Barang sudah dibeli; gunakan Dispute Center');
  });

  it('AFTER_PURCHASE by TRAVELER: full refund, admin approval, penalty 15, executed by ADMIN', () => {
    const r = evaluateCancellation({ status: 'PURCHASED', actor: 'TRAVELER', quoteLines: lines(), paymentCaptured: true }, MATRIX);
    expect(r).toMatchObject({ allowed: true, requiresAdminApproval: true, trustPenalty: 15, refundIdr: 2_858_800 });
    expect(r.fsmPermitsActor).toBe(false);
  });

  it('AFTER_ARRIVAL by ADMIN: traveler keeps fee as compensation, customs retained, direct REFUND_PENDING', () => {
    const r = evaluateCancellation({ status: 'ARRIVED', actor: 'ADMIN', quoteLines: lines(), paymentCaptured: true }, MATRIX);
    expect(r.travelerCompensationIdr).toBe(50_000);
    expect(r.customsRetainedIdr).toBe(660_000);
    expect(r.paymentFeeRetainedIdr).toBe(4_500);
    expect(r.requiresAdminApproval).toBe(true);
    expect(r.transitionPath).toEqual(['REFUND_PENDING']);
    expect(r.fsmPermitsActor).toBe(true);
    expect(reconciles(r)).toBe(true);
  });

  it('DURING_TRAVEL by ADMIN goes straight to REFUND_PENDING; DELIVERED still needs DISPUTED', () => {
    const t = evaluateCancellation({ status: 'TRAVELING', actor: 'ADMIN', quoteLines: lines(), paymentCaptured: true }, MATRIX);
    expect(t).toMatchObject({ allowed: true, transitionPath: ['REFUND_PENDING'], fsmPermitsActor: true, refundIdr: 2_858_800 });
    const d = evaluateCancellation({ status: 'DELIVERED', actor: 'ADMIN', quoteLines: lines(), paymentCaptured: true }, MATRIX);
    expect(d.transitionPath).toEqual(['DISPUTED', 'REFUND_PENDING']);
  });

  it('cause PRICE_CHANGE_REJECTED: buyer is not at fault (full refund incl. payment fee, no penalty)', () => {
    const r = evaluateCancellation(
      { status: 'PRICE_CHANGE_PENDING', actor: 'BUYER', cause: 'PRICE_CHANGE_REJECTED', quoteLines: lines(), paymentCaptured: true },
      MATRIX,
    );
    expect(r).toMatchObject({ allowed: true, matrixCause: 'PRICE_CHANGE_REJECTED', refundIdr: 2_858_800, paymentFeeRetainedIdr: 0, trustPenalty: 0 });
    expect(r.penalizedActor).toBeNull();
    const plain = evaluateCancellation({ status: 'PRICE_CHANGE_PENDING', actor: 'BUYER', quoteLines: lines(), paymentCaptured: true }, MATRIX);
    expect(plain).toMatchObject({ matrixCause: null, paymentFeeRetainedIdr: 4_500, trustPenalty: 2 });
  });

  it('matching order: (actor, cause) → (actor, no cause) → ANY; cause rows never match other causes/actors', () => {
    const unknownCause = evaluateCancellation(
      { status: 'PAYMENT_SECURED', actor: 'BUYER', cause: 'SOMETHING_ELSE', quoteLines: lines(), paymentCaptured: true },
      MATRIX,
    );
    expect(unknownCause).toMatchObject({ matrixActor: 'BUYER', matrixCause: null, trustPenalty: 2 });
    const travelerWithCause = evaluateCancellation(
      { status: 'PAYMENT_SECURED', actor: 'TRAVELER', cause: 'PRICE_CHANGE_REJECTED', quoteLines: lines(), paymentCaptured: true },
      MATRIX,
    );
    expect(travelerWithCause).toMatchObject({ matrixActor: 'TRAVELER', matrixCause: null, trustPenalty: 5 });
    const anyRow = evaluateCancellation({ status: 'REQUEST_CREATED', actor: 'TRAVELER', cause: 'X', quoteLines: [], paymentCaptured: false }, MATRIX);
    expect(anyRow.matrixActor).toBe('ANY');
  });

  it('traveler may now cancel from PRICE_CHANGE_PENDING (FSM edge exists)', () => {
    const r = evaluateCancellation({ status: 'PRICE_CHANGE_PENDING', actor: 'TRAVELER', quoteLines: lines(), paymentCaptured: true }, MATRIX);
    expect(r).toMatchObject({ allowed: true, fsmPermitsActor: true, trustPenalty: 5 });
  });

  it('promotions are never paid out as cash; credit is restored and discount reversed', () => {
    const r = evaluateCancellation(
      { status: 'PAYMENT_SECURED', actor: 'BUYER', quoteLines: lines({ DISCOUNT: -100_000, REFERRAL_CREDIT: -25_000 }), paymentCaptured: true },
      MATRIX,
    );
    expect(r.paidIdr).toBe(2_733_800);
    expect(r.refundIdr).toBe(2_733_800 - 4_500);
    expect(r.discountReversedIdr).toBe(100_000);
    expect(r.creditRestoredIdr).toBe(25_000);
    expect(reconciles(r)).toBe(true);
  });

  it('when promos exceed cash, retained fees consume promo funds first', () => {
    const r = evaluateCancellation(
      {
        status: 'PURCHASE_APPROVED',
        actor: 'BUYER',
        quoteLines: lines({ DISCOUNT: -2_000_000, REFERRAL_CREDIT: -830_000 }),
        paymentCaptured: true,
      },
      MATRIX,
    );
    expect(r.paidIdr).toBe(28_800);
    expect(r.refundIdr).toBe(0);
    expect(r.promoConsumedIdr).toBe(66_650 - 28_800);
    expect(r.discountReversedIdr).toBe(2_000_000 - 37_850);
    expect(r.creditRestoredIdr).toBe(830_000);
    expect(reconciles(r)).toBe(true);
  });

  it('SYSTEM/ADMIN rows after payment: full refund, no penalty; ADMIN needs approval', () => {
    const sys = evaluateCancellation({ status: 'PRICE_CHANGE_PENDING', actor: 'SYSTEM', quoteLines: lines(), paymentCaptured: true }, MATRIX);
    expect(sys).toMatchObject({ allowed: true, matrixActor: 'SYSTEM', refundIdr: 2_858_800, trustPenalty: 0, penalizedActor: null });
    const admin = evaluateCancellation({ status: 'PURCHASE_APPROVED', actor: 'ADMIN', quoteLines: lines(), paymentCaptured: true }, MATRIX);
    expect(admin).toMatchObject({ allowed: true, requiresAdminApproval: true, refundIdr: 2_858_800 });
    const noRow = evaluateCancellation({ status: 'PURCHASED', actor: 'SYSTEM', quoteLines: lines(), paymentCaptured: true }, MATRIX);
    expect(noRow).toMatchObject({ allowed: false, reasonCode: 'NO_MATRIX_ROW', requiresAdminApproval: true });
    const unpaid = evaluateCancellation({ status: 'AWAITING_PAYMENT', actor: 'SYSTEM', quoteLines: lines(), paymentCaptured: false }, MATRIX);
    expect(unpaid).toMatchObject({ allowed: true, refundIdr: 0, transitionPath: ['CANCELLED'], fsmPermitsActor: true });
  });

  it('refuses non-cancellable statuses and inconsistent totals', () => {
    expect(evaluateCancellation({ status: 'DISPUTED', actor: 'ADMIN', quoteLines: [], paymentCaptured: true }, MATRIX).reasonCode).toBe(
      'NOT_CANCELLABLE',
    );
    const bad = [...lines().slice(0, -1), { type: 'TOTAL', amountIdr: 1 } as PaidLine];
    expect(() => evaluateCancellation({ status: 'PAYMENT_SECURED', actor: 'BUYER', quoteLines: bad, paymentCaptured: true }, MATRIX)).toThrow(
      /TOTAL/,
    );
  });

  it('reconciles for random quotes, statuses and actors (property)', () => {
    const cfg = DEFAULT_BUSINESS_CONFIG;
    for (const seed of SEEDS) {
      const r = createPrng(seed);
      const q = buildQuote(
        {
          item: { unitPriceMinor: r.int(100_000, 20_000_000), currency: 'IDR', quantity: 1 },
          travelerFee: { type: 'PERCENT', rateBps: r.int(0, 3000) },
          customs: null,
          promotion: r.bool() ? { discountIdr: r.int(0, 3_000_000) } : null,
          referralCreditAvailableIdr: r.bool(0.3) ? r.int(0, 30_000_000) : 0,
          paymentChannel: r.pick(['VA', 'QRIS', 'EWALLET', 'CARD']),
          now: new Date(0),
        },
        cfg,
      );
      const status = r.pick(TRANSACTION_STATUSES);
      const actor = r.pick(ACTORS);
      const res = evaluateCancellation({ status, actor, quoteLines: q.lines, paymentCaptured: true }, MATRIX);
      if (res.allowed) {
        expect(reconciles(res)).toBe(true);
        expect(res.refundIdr).toBeLessThanOrEqual(q.totalIdr);
        expect(res.refundIdr).toBeGreaterThanOrEqual(0);
        expect(res.creditRestoredIdr + res.discountReversedIdr + res.promoConsumedIdr).toBe(
          0 - q.amounts.DISCOUNT - q.amounts.REFERRAL_CREDIT,
        );
      }
    }
  });
});
