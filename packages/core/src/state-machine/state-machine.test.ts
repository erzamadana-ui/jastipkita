import { describe, expect, it } from 'vitest';
import { ACTORS, TRANSACTION_STATUSES, type TransactionStatus } from '../domain';
import { CoreError } from '../errors';
import { SEEDS, createPrng } from '../testing/prng';
import {
  type Fsm,
  TRANSACTION_TRANSITIONS,
  type TransactionGuardContext,
  assertTransition,
  canTransition,
  createFsm,
  disputeFsm,
  fxLockFsm,
  isTerminal,
  kycSubmissionFsm,
  nextAllowed,
  paymentFsm,
  payoutFsm,
  priceConfirmationFsm,
  purchaseGate,
  quoteFsm,
  refundFsm,
  transactionFsm,
  tripFsm,
} from './index';

const OK: Readonly<Record<string, TransactionGuardContext>> = {
  MATCH_PRECONDITIONS: {
    offerAcceptedByBoth: true,
    tripStatus: 'ACTIVE',
    capacitySufficient: true,
    limitPassed: true,
    restrictedClassification: 'RESTRICTED',
  },
  CHECKOUT_PRECONDITIONS: {
    quoteActive: true,
    fxLockValid: true,
    buyerKycLevel: 2,
    restrictedClassification: 'RESTRICTED',
    restrictedAcknowledged: true,
  },
  CANCELLATION_MATRIX: { cancellationAllowed: true },
  PAYMENT_VERIFIED: { paymentSignatureValid: true, paymentAmountMatches: true, paymentCurrencyMatches: true },
  INVOICE_OR_QUOTE_EXPIRED: { quoteExpired: true },
  NO_FUNDS_RECEIVED: { fundsReceived: false },
  PRICE_WITHIN_TOLERANCE: { priceWithinTolerance: true },
  PRICE_OUTSIDE_TOLERANCE: { priceWithinTolerance: false },
  PRICE_CHANGE_APPROVED_FUNDED: { priceChangeApproved: true, securedFundsSufficient: true },
  PRICE_CHANGE_APPROVED_UNFUNDED: { priceChangeApproved: true, securedFundsSufficient: false },
  PRICE_CHANGE_EXIT: { priceChangeRejected: true, priceConfirmationExpired: true, cancellationAllowed: true },
  ADMIN_OVERRIDE_REFUND: { cancellationAllowed: true, adminApprovalRecorded: true },
  PURCHASE_PROOF: { proofComplete: true, purchasePriceWithinApproved: true },
  TRIP_TRAVELING: { tripStatus: 'TRAVELING' },
  TRIP_ARRIVED: { tripArrived: true },
  CUSTOMS_PROOF: { customsDutyPaid: true, customsProofUploaded: true },
  COURIER_DISPATCH: { deliveryMethod: 'COURIER', trackingNumber: 'JNE-123' },
  MEETUP_PIN: { deliveryMethod: 'MEETUP', pinVerified: true },
  DELIVERY_PROOF: { deliveryProofProvided: true },
  BUYER_CONFIRMATION: { disputeOpen: false, autoConfirmDue: true },
  COMPLETION: { payoutScheduled: true, ledgerFinal: true },
  DISPUTE_WINDOW: { withinDisputeWindow: true },
  DISPUTE_REFUND: { disputeResolution: 'REFUND_PARTIAL' },
  DISPUTE_NO_REFUND: { disputeResolution: 'NO_REFUND' },
  REFUND_FULL_SUCCEEDED: { refundSucceeded: true, refundType: 'FULL' },
  REFUND_PARTIAL_SETTLED: { refundSucceeded: true, refundType: 'PARTIAL', remainderPaidOut: true },
};

const okCtx = (guardCode: string | null): TransactionGuardContext => (guardCode ? (OK[guardCode] ?? {}) : {});

describe('transaction FSM — table', () => {
  it('every allowed transition passes for every listed actor with a satisfying context', () => {
    for (const t of TRANSACTION_TRANSITIONS) {
      for (const actor of t.actors) {
        const r = canTransition(t.from, t.to, actor, okCtx(t.guardCode));
        expect(r.ok, `${t.from}→${t.to} by ${actor}: ${r.ok ? '' : r.code}`).toBe(true);
      }
    }
  });

  it('every guarded transition fails closed with an empty context', () => {
    for (const t of TRANSACTION_TRANSITIONS.filter((x) => x.guardCode !== null)) {
      const actor = t.actors[0] ?? 'SYSTEM';
      const r = canTransition(t.from, t.to, actor, {});
      expect(r.ok, `${t.from}→${t.to} should fail closed`).toBe(false);
    }
  });

  it('rejects actors not listed for a transition', () => {
    for (const t of TRANSACTION_TRANSITIONS) {
      for (const actor of ACTORS.filter((a) => !t.actors.includes(a))) {
        const r = canTransition(t.from, t.to, actor, okCtx(t.guardCode));
        expect(r.ok ? 'ok' : r.code).toBe('ACTOR_NOT_ALLOWED');
      }
    }
  });

  it('rejects representative undefined transitions', () => {
    const cases: [TransactionStatus, TransactionStatus][] = [
      ['REQUEST_CREATED', 'PAYMENT_SECURED'],
      ['MATCHED', 'PURCHASE_APPROVED'],
      ['PAYMENT_SECURED', 'PURCHASED'],
      ['AWAITING_PAYMENT', 'PURCHASE_APPROVED'],
      ['DELIVERED', 'REFUND_PENDING'],
      ['DELIVERED', 'COMPLETED'],
      ['BUYER_CONFIRMED', 'DISPUTED'],
    ];
    for (const [from, to] of cases) {
      const r = canTransition(from, to, 'ADMIN', {});
      expect(r.ok ? 'ok' : r.code).toBe('INVALID_TRANSITION');
    }
  });

  it('terminal statuses have no exits', () => {
    for (const s of ['COMPLETED', 'CANCELLED', 'REFUNDED'] as const) {
      expect(isTerminal(s)).toBe(true);
      expect(transactionFsm.transitionsFrom(s)).toHaveLength(0);
      for (const to of TRANSACTION_STATUSES) {
        const r = canTransition(s, to, 'ADMIN', {});
        expect(r.ok ? 'ok' : r.code).toBe('TERMINAL_STATUS');
      }
    }
  });

  it('every status is reachable from REQUEST_CREATED and every non-terminal has an exit', () => {
    const reach = transactionFsm.reachableFrom('REQUEST_CREATED');
    expect([...reach].sort()).toEqual([...TRANSACTION_STATUSES].sort());
    for (const s of TRANSACTION_STATUSES) {
      if (!isTerminal(s)) expect(transactionFsm.transitionsFrom(s).length, s).toBeGreaterThan(0);
    }
  });

  it('every non-terminal status can still reach a terminal status', () => {
    for (const s of TRANSACTION_STATUSES) {
      const reach = transactionFsm.reachableFrom(s);
      expect([...reach].some((x) => isTerminal(x)), s).toBe(true);
    }
  });
});

describe('transaction FSM — guards', () => {
  it('blocks checkout for KYC < 2, missing acknowledgement, or prohibited items', () => {
    const base = OK.CHECKOUT_PRECONDITIONS as TransactionGuardContext;
    const kyc = canTransition('MATCHED', 'AWAITING_PAYMENT', 'BUYER', { ...base, buyerKycLevel: 1 });
    expect(kyc.ok ? '' : kyc.code).toBe('KYC_LEVEL_INSUFFICIENT');
    const ack = canTransition('MATCHED', 'AWAITING_PAYMENT', 'BUYER', { ...base, restrictedAcknowledged: false });
    expect(ack.ok ? '' : ack.code).toBe('RESTRICTED_NOT_ACKNOWLEDGED');
    const allowed = canTransition('MATCHED', 'AWAITING_PAYMENT', 'BUYER', {
      ...base,
      restrictedClassification: 'ALLOWED',
      restrictedAcknowledged: false,
    });
    expect(allowed.ok).toBe(true);
  });

  it('match requires trip ACTIVE and non-prohibited items', () => {
    const base = OK.MATCH_PRECONDITIONS as TransactionGuardContext;
    const r = canTransition('REQUEST_CREATED', 'MATCHED', 'BUYER', { ...base, tripStatus: 'FULL' });
    expect(r.ok ? '' : r.code).toBe('TRIP_NOT_ACTIVE');
    const p = canTransition('REQUEST_CREATED', 'MATCHED', 'TRAVELER', { ...base, restrictedClassification: 'PROHIBITED' });
    expect(p.ok ? '' : p.code).toBe('ITEM_PROHIBITED');
  });

  it('payment webhook must match signature, amount and currency', () => {
    const r = canTransition('AWAITING_PAYMENT', 'PAYMENT_SECURED', 'SYSTEM', {
      paymentSignatureValid: true,
      paymentAmountMatches: false,
      paymentCurrencyMatches: true,
    });
    expect(r.ok ? '' : r.code).toBe('PAYMENT_AMOUNT_MISMATCH');
  });

  it('price-change refund: BUYER needs rejection, SYSTEM needs expiry, TRAVELER needs the matrix', () => {
    expect(canTransition('PRICE_CHANGE_PENDING', 'REFUND_PENDING', 'BUYER', { priceConfirmationExpired: true }).ok).toBe(false);
    expect(canTransition('PRICE_CHANGE_PENDING', 'REFUND_PENDING', 'SYSTEM', { priceChangeRejected: true }).ok).toBe(false);
    expect(canTransition('PRICE_CHANGE_PENDING', 'REFUND_PENDING', 'SYSTEM', { priceConfirmationExpired: true }).ok).toBe(true);
    expect(canTransition('PRICE_CHANGE_PENDING', 'REFUND_PENDING', 'TRAVELER', { priceChangeRejected: true }).ok).toBe(false);
    expect(canTransition('PRICE_CHANGE_PENDING', 'REFUND_PENDING', 'TRAVELER', { cancellationAllowed: true }).ok).toBe(true);
  });

  it('admin override refund from TRAVELING … OUT_FOR_DELIVERY needs matrix + recorded approval (not DELIVERED)', () => {
    for (const s of ['TRAVELING', 'ARRIVED', 'CUSTOMS_PROCESS', 'READY_FOR_HANDOVER', 'OUT_FOR_DELIVERY'] as const) {
      const noApproval = canTransition(s, 'REFUND_PENDING', 'ADMIN', { cancellationAllowed: true });
      expect(noApproval.ok ? '' : noApproval.code).toBe('ADMIN_APPROVAL_REQUIRED');
      expect(canTransition(s, 'REFUND_PENDING', 'ADMIN', { cancellationAllowed: true, adminApprovalRecorded: true }).ok).toBe(true);
      const buyer = canTransition(s, 'REFUND_PENDING', 'BUYER', { cancellationAllowed: true, adminApprovalRecorded: true });
      expect(buyer.ok ? '' : buyer.code).toBe('ACTOR_NOT_ALLOWED');
    }
    const delivered = canTransition('DELIVERED', 'REFUND_PENDING', 'ADMIN', { cancellationAllowed: true, adminApprovalRecorded: true });
    expect(delivered.ok ? '' : delivered.code).toBe('INVALID_TRANSITION');
  });

  it('auto-confirm requires due time and no dispute; buyer only needs no dispute', () => {
    expect(canTransition('DELIVERED', 'BUYER_CONFIRMED', 'SYSTEM', { disputeOpen: false, autoConfirmDue: false }).ok).toBe(false);
    expect(canTransition('DELIVERED', 'BUYER_CONFIRMED', 'BUYER', { disputeOpen: false }).ok).toBe(true);
    const open = canTransition('DELIVERED', 'BUYER_CONFIRMED', 'BUYER', { disputeOpen: true });
    expect(open.ok ? '' : open.code).toBe('DISPUTE_OPEN');
  });

  it('customs proof needed only when duty was paid', () => {
    expect(canTransition('CUSTOMS_PROCESS', 'READY_FOR_HANDOVER', 'TRAVELER', { customsDutyPaid: false }).ok).toBe(true);
    expect(canTransition('CUSTOMS_PROCESS', 'READY_FOR_HANDOVER', 'TRAVELER', { customsDutyPaid: true }).ok).toBe(false);
  });

  it('assertTransition throws CoreError carrying the guard code', () => {
    expect(() => assertTransition('PURCHASE_APPROVED', 'PURCHASED', 'TRAVELER', { proofComplete: false })).toThrowError(
      expect.objectContaining({ code: 'PURCHASE_PROOF_INCOMPLETE' }),
    );
    expect(() => assertTransition('PURCHASE_APPROVED', 'PURCHASED', 'TRAVELER', {})).toThrowError(CoreError);
  });

  it('nextAllowed lists targets by actor', () => {
    expect(nextAllowed('PAYMENT_SECURED', 'TRAVELER').sort()).toEqual(['PRICE_CHANGE_PENDING', 'PURCHASE_APPROVED', 'REFUND_PENDING']);
    expect(nextAllowed('AWAITING_PAYMENT', 'TRAVELER')).toEqual([]);
    expect(transactionFsm.nextAvailable('PAYMENT_SECURED', 'TRAVELER', { priceWithinTolerance: true })).toEqual(['PURCHASE_APPROVED']);
  });

  it('random walks with satisfying contexts always stay valid and end terminal (property)', () => {
    for (const seed of SEEDS.slice(0, 100)) {
      const r = createPrng(seed);
      let s: TransactionStatus = 'REQUEST_CREATED';
      for (let step = 0; step < 40 && !isTerminal(s); step++) {
        const options = transactionFsm.transitionsFrom(s);
        const t = r.pick(options);
        const actor = r.pick(t.actors);
        expect(canTransition(s, t.to, actor, okCtx(t.guardCode)).ok).toBe(true);
        s = t.to;
      }
      expect(TRANSACTION_STATUSES).toContain(s);
    }
  });
});

describe('purchaseGate (golden rule)', () => {
  it('only PURCHASE_APPROVED allows purchase; every earlier status shows DO_NOT_PURCHASE', () => {
    for (const s of TRANSACTION_STATUSES) {
      const g = purchaseGate(s);
      expect(g.canPurchase, s).toBe(s === 'PURCHASE_APPROVED');
    }
    for (const s of ['REQUEST_CREATED', 'MATCHED', 'AWAITING_PAYMENT', 'PAYMENT_SECURED', 'PRICE_CHANGE_PENDING'] as const) {
      expect(purchaseGate(s).banner).toBe('DO_NOT_PURCHASE');
    }
    expect(purchaseGate('PAYMENT_SECURED').paymentBadge).toBe('PAYMENT_SECURED');
    expect(purchaseGate('MATCHED').paymentBadge).toBeNull();
    expect(purchaseGate('PURCHASED').banner).toBe('ALREADY_PURCHASED');
    expect(purchaseGate('CANCELLED').banner).toBe('TRANSACTION_CLOSED');
  });
});

describe('supporting FSMs', () => {
  function checkShape<S extends string, C>(fsm: Fsm<S, C>): void {
    const def = fsm.definition;
    expect([...fsm.reachableFrom(def.initial)].sort(), def.name).toEqual([...def.states].sort());
    for (const t of def.terminal) expect(fsm.transitionsFrom(t), `${def.name}:${t}`).toHaveLength(0);
    for (const s of def.states) {
      if (!fsm.isTerminal(s)) expect(fsm.transitionsFrom(s).length, `${def.name}:${s} dead end`).toBeGreaterThan(0);
    }
  }

  it('every state is reachable from the initial state; terminals have no exits; no dead ends', () => {
    checkShape(tripFsm);
    checkShape(priceConfirmationFsm);
    checkShape(disputeFsm);
    checkShape(kycSubmissionFsm);
    checkShape(refundFsm);
    checkShape(payoutFsm);
    checkShape(paymentFsm);
    checkShape(quoteFsm);
    checkShape(fxLockFsm);
  });

  it('trip: unverified ACTIVE needs config; ACTIVE ↔ FULL on capacity', () => {
    const r = tripFsm.canTransition('DRAFT', 'ACTIVE', 'TRAVELER', { allowUnverifiedActive: false, remainingCapacityKg: 10 });
    expect(r.ok ? '' : r.code).toBe('UNVERIFIED_ACTIVE_NOT_ALLOWED');
    expect(tripFsm.canTransition('DRAFT', 'ACTIVE', 'TRAVELER', { allowUnverifiedActive: true, remainingCapacityKg: 10 }).ok).toBe(true);
    expect(tripFsm.canTransition('ACTIVE', 'FULL', 'SYSTEM', { remainingCapacityKg: 0 }).ok).toBe(true);
    expect(tripFsm.canTransition('ACTIVE', 'FULL', 'SYSTEM', { remainingCapacityKg: 3 }).ok).toBe(false);
    expect(tripFsm.canTransition('FULL', 'ACTIVE', 'SYSTEM', { remainingCapacityKg: 3 }).ok).toBe(true);
    expect(tripFsm.canTransition('COMPLETED', 'CANCELLED', 'ADMIN', {}).ok).toBe(false);
    expect(tripFsm.canTransition('TRAVELING', 'CANCELLED', 'ADMIN', {}).ok).toBe(true);
  });

  it('price confirmation: clarification resets to PENDING; expiry only by SYSTEM after window', () => {
    expect(priceConfirmationFsm.canTransition('PENDING', 'APPROVED', 'BUYER', { windowExpired: false }).ok).toBe(true);
    expect(priceConfirmationFsm.canTransition('PENDING', 'APPROVED', 'BUYER', { windowExpired: true }).ok).toBe(false);
    expect(priceConfirmationFsm.canTransition('CLARIFICATION_REQUESTED', 'PENDING', 'TRAVELER', {}).ok).toBe(true);
    expect(priceConfirmationFsm.canTransition('PENDING', 'EXPIRED', 'BUYER', { windowExpired: true }).ok).toBe(false);
  });

  it('dispute: one appeal within window', () => {
    expect(disputeFsm.canTransition('RESOLVED', 'APPEALED', 'BUYER', { withinAppealWindow: true, alreadyAppealed: false }).ok).toBe(true);
    const twice = disputeFsm.canTransition('RESOLVED', 'APPEALED', 'BUYER', { withinAppealWindow: true, alreadyAppealed: true });
    expect(twice.ok ? '' : twice.code).toBe('APPEAL_ALREADY_USED');
  });

  it('trip: traveler may mark FULL at will; SYSTEM only when capacity is exhausted', () => {
    expect(tripFsm.canTransition('ACTIVE', 'FULL', 'TRAVELER', { remainingCapacityKg: 5 }).ok).toBe(true);
    expect(tripFsm.canTransition('ACTIVE', 'FULL', 'SYSTEM', { remainingCapacityKg: 5 }).ok).toBe(false);
    expect(tripFsm.canTransition('VERIFICATION_PENDING', 'DRAFT', 'TRAVELER', {}).ok).toBe(true);
  });

  it('dispute: withdrawal and back-to-evidence edges', () => {
    expect(disputeFsm.canTransition('OPEN', 'CLOSED', 'BUYER', {}).ok).toBe(true);
    expect(disputeFsm.canTransition('EVIDENCE_COLLECTION', 'CLOSED', 'TRAVELER', {}).ok).toBe(true);
    expect(disputeFsm.canTransition('UNDER_REVIEW', 'CLOSED', 'BUYER', {}).ok).toBe(false);
    expect(disputeFsm.canTransition('UNDER_REVIEW', 'EVIDENCE_COLLECTION', 'ADMIN', {}).ok).toBe(true);
    expect(disputeFsm.canTransition('OPEN', 'UNDER_REVIEW', 'SYSTEM', {}).ok).toBe(false);
  });

  it('price confirmation: buyer may reject while clarification is pending', () => {
    expect(priceConfirmationFsm.canTransition('CLARIFICATION_REQUESTED', 'REJECTED', 'BUYER', {}).ok).toBe(true);
    expect(priceConfirmationFsm.canTransition('CLARIFICATION_REQUESTED', 'APPROVED', 'BUYER', {}).ok).toBe(false);
  });

  it('payment: late funds after EXPIRED/FAILED are still verified and recorded', () => {
    const ok = { signatureValid: true, amountMatches: true, currencyMatches: true };
    expect(paymentFsm.canTransition('EXPIRED', 'SECURED', 'SYSTEM', ok).ok).toBe(true);
    const bad = paymentFsm.canTransition('FAILED', 'SECURED', 'SYSTEM', { ...ok, currencyMatches: false });
    expect(bad.ok ? '' : bad.code).toBe('PAYMENT_CURRENCY_MISMATCH');
    expect(paymentFsm.canTransition('SECURED', 'REFUNDED', 'ADMIN', {}).ok).toBe(false);
    expect(paymentFsm.isTerminal('REFUNDED')).toBe(true);
  });

  it('refund: auto-approve limit, maker-checker, reasons, retry budget', () => {
    const sysApprove = refundFsm.canTransition('REQUESTED', 'APPROVED', 'SYSTEM', { amountWithinCaptured: true, aboveAutoApproveLimit: true });
    expect(sysApprove.ok ? '' : sysApprove.code).toBe('APPROVAL_REQUIRED');
    expect(refundFsm.canTransition('REQUESTED', 'APPROVED', 'SYSTEM', { amountWithinCaptured: true, aboveAutoApproveLimit: false }).ok).toBe(true);
    expect(refundFsm.canTransition('REQUESTED', 'PENDING_APPROVAL', 'SYSTEM', { aboveAutoApproveLimit: true }).ok).toBe(true);
    const self = refundFsm.canTransition('PENDING_APPROVAL', 'APPROVED', 'ADMIN', { amountWithinCaptured: true, requestedBy: 'fin-1', approvedBy: 'fin-1' });
    expect(self.ok ? '' : self.code).toBe('MAKER_CHECKER_VIOLATION');
    expect(refundFsm.canTransition('PENDING_APPROVAL', 'APPROVED', 'ADMIN', { amountWithinCaptured: true, requestedBy: 'fin-1', approvedBy: 'fin-2' }).ok).toBe(true);
    const noReason = refundFsm.canTransition('REQUESTED', 'REJECTED', 'ADMIN', { reason: ' ' });
    expect(noReason.ok ? '' : noReason.code).toBe('REASON_REQUIRED');
    expect(refundFsm.canTransition('FAILED', 'PROCESSING', 'SYSTEM', { attempts: 3, maxAttempts: 3 }).ok).toBe(false);
    expect(refundFsm.canTransition('FAILED', 'PROCESSING', 'ADMIN', { attempts: 3, maxAttempts: 3 }).ok).toBe(true);
    expect(refundFsm.definition.terminal).toEqual(['SUCCEEDED', 'REJECTED', 'CANCELLED']);
  });

  it('payout: starts SCHEDULED; clear/hold/release/cancel guards', () => {
    expect(payoutFsm.definition.initial).toBe('SCHEDULED');
    const hold = payoutFsm.canTransition('SCHEDULED', 'PROCESSING', 'SYSTEM', {
      riskDecision: 'HOLD',
      disputeOpen: false,
      bankAccountVerified: true,
    });
    expect(hold.ok ? '' : hold.code).toBe('RISK_HOLD');
    expect(payoutFsm.canTransition('SCHEDULED', 'ON_HOLD', 'SYSTEM', {}).ok).toBe(false);
    expect(payoutFsm.canTransition('SCHEDULED', 'ON_HOLD', 'SYSTEM', { reason: 'Dispute risk' }).ok).toBe(true);
    expect(payoutFsm.canTransition('ON_HOLD', 'SCHEDULED', 'ADMIN', { holdReleasedBy: 'admin-1' }).ok).toBe(true);
    // SYSTEM auto-release only for a cleared dispute hold; never with an approver alone
    const sys = payoutFsm.canTransition('ON_HOLD', 'SCHEDULED', 'SYSTEM', { holdReleasedBy: 'admin-1' });
    expect(sys.ok ? '' : sys.code).toBe('AUTO_RELEASE_NOT_ELIGIBLE');
    expect(payoutFsm.canTransition('ON_HOLD', 'SCHEDULED', 'SYSTEM', { autoReleaseEligible: true }).ok).toBe(true);
    expect(payoutFsm.canTransition('ON_HOLD', 'SCHEDULED', 'ADMIN', { autoReleaseEligible: true }).ok).toBe(false);
    expect(payoutFsm.canTransition('FAILED', 'CANCELLED', 'SYSTEM', {}).ok).toBe(false);
    expect(payoutFsm.isTerminal('CANCELLED')).toBe(true);
    expect(kycSubmissionFsm.canTransition('IN_REVIEW', 'APPROVED', 'ADMIN', { livenessPassed: true, documentMatches: true, notDuplicate: false }).ok).toBe(false);
  });

  it('quote & FX lock are SYSTEM-only', () => {
    expect(quoteFsm.canTransition('ACCEPTED', 'SUPERSEDED', 'SYSTEM', {}).ok).toBe(true);
    expect(quoteFsm.canTransition('ACTIVE', 'ACCEPTED', 'BUYER', {}).ok).toBe(false);
    expect(fxLockFsm.canTransition('ACTIVE', 'CONSUMED', 'SYSTEM', {}).ok).toBe(true);
    expect(fxLockFsm.isTerminal('EXPIRED')).toBe(true);
  });

  it('createFsm rejects invalid definitions', () => {
    const base = { name: 'x', states: ['A', 'B'] as const, initial: 'A' as const, guards: {} };
    expect(() =>
      createFsm({ ...base, terminal: ['A'], transitions: [{ from: 'A', to: 'B', actors: ['SYSTEM'], guardCode: null, description: '' }] }),
    ).toThrowError(/terminal/);
    expect(() =>
      createFsm({ ...base, terminal: [], transitions: [{ from: 'A', to: 'B', actors: ['SYSTEM'], guardCode: 'NOPE', description: '' }] }),
    ).toThrowError(/missing guard/);
    const t = { from: 'A', to: 'B', actors: ['SYSTEM'], guardCode: null, description: '' } as const;
    expect(() => createFsm({ ...base, terminal: [], transitions: [t, t] })).toThrowError(/duplicate/);
  });
});
