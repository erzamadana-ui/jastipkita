import {
  type Actor,
  type DeliveryMethod,
  type DisputeResolution,
  type DisputeStatus,
  DISPUTE_STATUSES,
  FX_LOCK_STATUSES,
  type FxLockStatus,
  type KycSubmissionStatus,
  KYC_SUBMISSION_STATUSES,
  MIN_KYC_LEVEL_CHECKOUT,
  PAYMENT_STATUSES,
  type PaymentStatus,
  type PayoutStatus,
  PAYOUT_STATUSES,
  type PriceConfirmationStatus,
  PRICE_CONFIRMATION_STATUSES,
  QUOTE_STATUSES,
  type QuoteStatus,
  type RefundStatus,
  REFUND_STATUSES,
  type RestrictedClassification,
  type RiskDecision,
  TERMINAL_TRANSACTION_STATUSES,
  TRANSACTION_STATUSES,
  type TransactionStatus,
  TRIP_STATUSES,
  type TripStatus,
} from '../domain';
import { type Fsm, type GuardFailure, type TransitionCheck, type TransitionDef, createFsm, firstFailure, requireTrue } from './fsm';

export * from './fsm';

const B: Actor = 'BUYER';
const T: Actor = 'TRAVELER';
const S: Actor = 'SYSTEM';
const A: Actor = 'ADMIN';

// ===========================================================================
// Transaction (§4)
// ===========================================================================

/**
 * Facts the service layer gathers before asking for a transition. Every guard is fail-closed:
 * an undefined field is treated as "not satisfied".
 */
export interface TransactionGuardContext {
  // REQUEST_CREATED → MATCHED
  readonly offerAcceptedByBoth?: boolean;
  readonly tripStatus?: TripStatus;
  readonly capacitySufficient?: boolean;
  readonly limitPassed?: boolean;
  readonly restrictedClassification?: RestrictedClassification;
  // MATCHED → AWAITING_PAYMENT
  readonly quoteActive?: boolean;
  readonly fxLockValid?: boolean;
  readonly buyerKycLevel?: number;
  readonly restrictedAcknowledged?: boolean;
  // Cancellation (matrix decision from the cancellation engine)
  readonly cancellationAllowed?: boolean;
  /** Admin override edges (§4: DURING_TRAVEL / AFTER_ARRIVAL) need a recorded approval. */
  readonly adminApprovalRecorded?: boolean;
  // AWAITING_PAYMENT → PAYMENT_SECURED (webhook)
  readonly paymentSignatureValid?: boolean;
  readonly paymentAmountMatches?: boolean;
  readonly paymentCurrencyMatches?: boolean;
  // AWAITING_PAYMENT → MATCHED / CANCELLED
  readonly invoiceExpired?: boolean;
  readonly quoteExpired?: boolean;
  readonly fundsReceived?: boolean;
  // Price confirmation
  readonly priceWithinTolerance?: boolean;
  readonly priceChangeApproved?: boolean;
  readonly priceChangeRejected?: boolean;
  readonly priceConfirmationExpired?: boolean;
  readonly securedFundsSufficient?: boolean;
  // PURCHASE_APPROVED → PURCHASED
  readonly proofComplete?: boolean;
  readonly purchasePriceWithinApproved?: boolean;
  // Travel
  readonly tripArrived?: boolean;
  // Customs / delivery
  readonly customsDutyPaid?: boolean;
  readonly customsProofUploaded?: boolean;
  readonly deliveryMethod?: DeliveryMethod;
  readonly trackingNumber?: string | null;
  readonly pinVerified?: boolean;
  readonly deliveryProofProvided?: boolean;
  readonly autoConfirmDue?: boolean;
  readonly disputeOpen?: boolean;
  // Completion
  readonly payoutScheduled?: boolean;
  readonly ledgerFinal?: boolean;
  // Dispute
  readonly withinDisputeWindow?: boolean;
  readonly disputeResolution?: DisputeResolution;
  readonly partialRefundSettled?: boolean;
  // Refund
  readonly refundSucceeded?: boolean;
  readonly refundType?: 'FULL' | 'PARTIAL';
  readonly remainderPaidOut?: boolean;
}

type TxGuard = (ctx: TransactionGuardContext, actor: Actor) => GuardFailure | null;

const REFUNDING_RESOLUTIONS: readonly DisputeResolution[] = ['REFUND_FULL', 'REFUND_PARTIAL', 'RETURN_AND_REFUND'];

export const TRANSACTION_GUARDS: Readonly<Record<string, TxGuard>> = {
  MATCH_PRECONDITIONS: (c) =>
    firstFailure(
      requireTrue(c.offerAcceptedByBoth, 'OFFER_NOT_ACCEPTED', 'Offer must be accepted by buyer and traveler'),
      c.tripStatus === 'ACTIVE' ? null : { code: 'TRIP_NOT_ACTIVE', message: 'Trip must be ACTIVE' },
      requireTrue(c.capacitySufficient, 'CAPACITY_INSUFFICIENT', 'Trip capacity is insufficient'),
      requireTrue(c.limitPassed, 'LIMIT_EXCEEDED', 'Transaction limit check failed'),
      c.restrictedClassification === undefined
        ? { code: 'RESTRICTED_CHECK_MISSING', message: 'Restricted-item classification is required' }
        : c.restrictedClassification === 'PROHIBITED'
          ? { code: 'ITEM_PROHIBITED', message: 'Item is PROHIBITED' }
          : null,
    ),
  CHECKOUT_PRECONDITIONS: (c) =>
    firstFailure(
      requireTrue(c.quoteActive, 'QUOTE_NOT_ACTIVE', 'Quote must be ACTIVE'),
      requireTrue(c.fxLockValid, 'FX_LOCK_INVALID', 'FX lock must be ACTIVE'),
      (c.buyerKycLevel ?? 0) >= MIN_KYC_LEVEL_CHECKOUT
        ? null
        : { code: 'KYC_LEVEL_INSUFFICIENT', message: `Buyer KYC level must be >= ${MIN_KYC_LEVEL_CHECKOUT}` },
      c.restrictedClassification === 'PROHIBITED'
        ? { code: 'ITEM_PROHIBITED', message: 'Item is PROHIBITED' }
        : c.restrictedClassification === 'ALLOWED' || c.restrictedAcknowledged === true
          ? null
          : { code: 'RESTRICTED_NOT_ACKNOWLEDGED', message: 'Restricted-item warning must be acknowledged' },
    ),
  CANCELLATION_MATRIX: (c) =>
    requireTrue(c.cancellationAllowed, 'CANCELLATION_NOT_ALLOWED', 'Cancellation matrix does not allow this cancellation'),
  PAYMENT_VERIFIED: (c) =>
    firstFailure(
      requireTrue(c.paymentSignatureValid, 'PAYMENT_SIGNATURE_INVALID', 'Webhook signature invalid'),
      requireTrue(c.paymentAmountMatches, 'PAYMENT_AMOUNT_MISMATCH', 'Paid amount does not match'),
      requireTrue(c.paymentCurrencyMatches, 'PAYMENT_CURRENCY_MISMATCH', 'Paid currency does not match'),
    ),
  INVOICE_OR_QUOTE_EXPIRED: (c) =>
    c.invoiceExpired === true || c.quoteExpired === true
      ? null
      : { code: 'INVOICE_NOT_EXPIRED', message: 'Invoice/quote has not expired' },
  NO_FUNDS_RECEIVED: (c) =>
    c.fundsReceived === false ? null : { code: 'FUNDS_ALREADY_RECEIVED', message: 'Funds received or unknown; cannot cancel' },
  PRICE_WITHIN_TOLERANCE: (c) =>
    requireTrue(c.priceWithinTolerance, 'PRICE_OUTSIDE_TOLERANCE', 'Actual price is outside tolerance'),
  PRICE_OUTSIDE_TOLERANCE: (c) =>
    c.priceWithinTolerance === false
      ? null
      : { code: 'PRICE_WITHIN_TOLERANCE', message: 'Price is within tolerance; approve directly' },
  PRICE_CHANGE_APPROVED_FUNDED: (c) =>
    firstFailure(
      requireTrue(c.priceChangeApproved, 'PRICE_CHANGE_NOT_APPROVED', 'Buyer has not approved the price change'),
      requireTrue(c.securedFundsSufficient, 'SUPPLEMENTAL_PAYMENT_REQUIRED', 'Secured funds are insufficient'),
    ),
  PRICE_CHANGE_APPROVED_UNFUNDED: (c) =>
    firstFailure(
      requireTrue(c.priceChangeApproved, 'PRICE_CHANGE_NOT_APPROVED', 'Buyer has not approved the price change'),
      c.securedFundsSufficient === false
        ? null
        : { code: 'SUPPLEMENTAL_NOT_REQUIRED', message: 'Secured funds already sufficient' },
    ),
  PRICE_CHANGE_EXIT: (c, actor) => {
    switch (actor) {
      case 'SYSTEM':
        return requireTrue(c.priceConfirmationExpired, 'PRICE_CONFIRMATION_NOT_EXPIRED', 'Price confirmation window still open');
      case 'TRAVELER':
        return requireTrue(c.cancellationAllowed, 'CANCELLATION_NOT_ALLOWED', 'Cancellation matrix does not allow this cancellation');
      default:
        return requireTrue(c.priceChangeRejected, 'PRICE_CHANGE_NOT_REJECTED', 'Buyer has not rejected the price change');
    }
  },
  ADMIN_OVERRIDE_REFUND: (c) =>
    firstFailure(
      requireTrue(c.cancellationAllowed, 'CANCELLATION_NOT_ALLOWED', 'Cancellation matrix does not allow this cancellation'),
      requireTrue(c.adminApprovalRecorded, 'ADMIN_APPROVAL_REQUIRED', 'Admin override requires a recorded approval'),
    ),
  PURCHASE_PROOF: (c) =>
    firstFailure(
      requireTrue(c.proofComplete, 'PURCHASE_PROOF_INCOMPLETE', 'Purchase proof incomplete'),
      requireTrue(c.purchasePriceWithinApproved, 'PURCHASE_PRICE_EXCEEDS_APPROVED', 'Purchase price exceeds approved price'),
    ),
  TRIP_TRAVELING: (c) =>
    c.tripStatus === 'TRAVELING' ? null : { code: 'TRIP_NOT_TRAVELING', message: 'Trip is not TRAVELING' },
  TRIP_ARRIVED: (c) => requireTrue(c.tripArrived, 'TRIP_NOT_ARRIVED', 'Trip has not arrived'),
  CUSTOMS_PROOF: (c) =>
    c.customsDutyPaid === false || c.customsProofUploaded === true
      ? null
      : { code: 'CUSTOMS_PROOF_MISSING', message: 'Upload customs payment proof' },
  COURIER_DISPATCH: (c) =>
    firstFailure(
      c.deliveryMethod === 'COURIER' || c.deliveryMethod === 'PARTNER_LOGISTICS'
        ? null
        : { code: 'DELIVERY_METHOD_INVALID', message: 'Delivery method must be COURIER or PARTNER_LOGISTICS' },
      typeof c.trackingNumber === 'string' && c.trackingNumber.trim() !== ''
        ? null
        : { code: 'TRACKING_NUMBER_MISSING', message: 'Tracking number required' },
    ),
  MEETUP_PIN: (c) =>
    firstFailure(
      c.deliveryMethod === 'MEETUP' ? null : { code: 'DELIVERY_METHOD_INVALID', message: 'Delivery method must be MEETUP' },
      requireTrue(c.pinVerified, 'PIN_NOT_VERIFIED', 'Buyer PIN/QR not verified'),
    ),
  DELIVERY_PROOF: (c) => requireTrue(c.deliveryProofProvided, 'DELIVERY_PROOF_MISSING', 'Delivery proof/tracking required'),
  BUYER_CONFIRMATION: (c, actor) =>
    firstFailure(
      c.disputeOpen === false ? null : { code: 'DISPUTE_OPEN', message: 'A dispute is open (or unknown)' },
      actor === 'SYSTEM' ? requireTrue(c.autoConfirmDue, 'AUTO_CONFIRM_NOT_DUE', 'Auto-confirm window not reached') : null,
    ),
  COMPLETION: (c) =>
    firstFailure(
      requireTrue(c.payoutScheduled, 'PAYOUT_NOT_SCHEDULED', 'Traveler payout not scheduled'),
      requireTrue(c.ledgerFinal, 'LEDGER_NOT_FINAL', 'Ledger not final'),
    ),
  DISPUTE_WINDOW: (c) => requireTrue(c.withinDisputeWindow, 'DISPUTE_WINDOW_CLOSED', 'Dispute window closed'),
  DISPUTE_REFUND: (c) =>
    c.disputeResolution !== undefined && REFUNDING_RESOLUTIONS.includes(c.disputeResolution)
      ? null
      : { code: 'RESOLUTION_NOT_REFUND', message: 'Dispute resolution does not require a refund' },
  DISPUTE_NO_REFUND: (c) =>
    c.disputeResolution === 'NO_REFUND' ||
    c.disputeResolution === 'OTHER' ||
    (c.disputeResolution === 'REFUND_PARTIAL' && c.partialRefundSettled === true)
      ? null
      : { code: 'RESOLUTION_REQUIRES_REFUND', message: 'Resolution requires a (pending) refund' },
  REFUND_FULL_SUCCEEDED: (c) =>
    firstFailure(
      requireTrue(c.refundSucceeded, 'REFUND_NOT_SUCCEEDED', 'Refund not succeeded'),
      c.refundType === 'FULL' ? null : { code: 'REFUND_NOT_FULL', message: 'Refund is not a full refund' },
    ),
  REFUND_PARTIAL_SETTLED: (c) =>
    firstFailure(
      requireTrue(c.refundSucceeded, 'REFUND_NOT_SUCCEEDED', 'Refund not succeeded'),
      c.refundType === 'PARTIAL' ? null : { code: 'REFUND_NOT_PARTIAL', message: 'Refund is not partial' },
      requireTrue(c.remainderPaidOut, 'REMAINDER_NOT_PAID', 'Remaining funds not paid out'),
    ),
};

const DISPUTABLE: readonly TransactionStatus[] = [
  'PURCHASED',
  'TRAVELING',
  'ARRIVED',
  'CUSTOMS_PROCESS',
  'READY_FOR_HANDOVER',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
];

const ADMIN_OVERRIDE_REFUNDABLE: readonly TransactionStatus[] = [
  'TRAVELING',
  'ARRIVED',
  'CUSTOMS_PROCESS',
  'READY_FOR_HANDOVER',
  'OUT_FOR_DELIVERY',
];

function tx(
  from: TransactionStatus,
  to: TransactionStatus,
  actors: readonly Actor[],
  guardCode: string | null,
  description: string,
): TransitionDef<TransactionStatus> {
  return { from, to, actors, guardCode, description };
}

/** Transition table — exactly docs/00-domain-model.md §4 (parity-tested against the markdown). */
export const TRANSACTION_TRANSITIONS: readonly TransitionDef<TransactionStatus>[] = [
  tx('REQUEST_CREATED', 'MATCHED', [B, T], 'MATCH_PRECONDITIONS', 'Offer accepted; trip ACTIVE; capacity; limit; not PROHIBITED'),
  tx('REQUEST_CREATED', 'CANCELLED', [B, S, A], null, 'Cancel before match'),
  tx('MATCHED', 'AWAITING_PAYMENT', [B], 'CHECKOUT_PRECONDITIONS', 'Quote + FX lock ACTIVE; KYC ≥ 2; restricted acknowledged'),
  tx('MATCHED', 'CANCELLED', [B, T, S, A], 'CANCELLATION_MATRIX', 'Cancellation matrix AFTER_MATCH'),
  tx('AWAITING_PAYMENT', 'PAYMENT_SECURED', [S], 'PAYMENT_VERIFIED', 'Verified webhook (signature + amount + currency)'),
  tx('AWAITING_PAYMENT', 'MATCHED', [S], 'INVOICE_OR_QUOTE_EXPIRED', 'Invoice/quote expired → re-quote'),
  tx('AWAITING_PAYMENT', 'CANCELLED', [B, S, A], 'NO_FUNDS_RECEIVED', 'No funds received'),
  tx('PAYMENT_SECURED', 'PURCHASE_APPROVED', [T, S], 'PRICE_WITHIN_TOLERANCE', 'Actual price ≤ secured (tolerance)'),
  tx('PAYMENT_SECURED', 'PRICE_CHANGE_PENDING', [T], 'PRICE_OUTSIDE_TOLERANCE', 'Price outside tolerance → confirmation'),
  tx('PAYMENT_SECURED', 'REFUND_PENDING', [B, T, S, A], 'CANCELLATION_MATRIX', 'Cancellation matrix AFTER_PAYMENT'),
  tx('PRICE_CHANGE_PENDING', 'PURCHASE_APPROVED', [B], 'PRICE_CHANGE_APPROVED_FUNDED', 'Approved and secured funds suffice'),
  tx('PRICE_CHANGE_PENDING', 'AWAITING_PAYMENT', [B], 'PRICE_CHANGE_APPROVED_UNFUNDED', 'Approved; supplemental payment needed'),
  tx('PRICE_CHANGE_PENDING', 'PAYMENT_SECURED', [T], 'PRICE_WITHIN_TOLERANCE', 'Traveler revised price back within tolerance'),
  tx('PRICE_CHANGE_PENDING', 'REFUND_PENDING', [B, T, S], 'PRICE_CHANGE_EXIT', 'Buyer rejects (PRICE_CHANGE_REJECTED), window expired, or traveler cancels'),
  tx('PURCHASE_APPROVED', 'PURCHASED', [T], 'PURCHASE_PROOF', 'Complete purchase proof; price ≤ approved'),
  tx('PURCHASE_APPROVED', 'REFUND_PENDING', [B, T, S, A], 'CANCELLATION_MATRIX', 'Cancellation matrix BEFORE_PURCHASE'),
  tx('PURCHASED', 'TRAVELING', [T, S], 'TRIP_TRAVELING', 'Trip TRAVELING'),
  tx('PURCHASED', 'ARRIVED', [T], 'TRIP_ARRIVED', 'Trip already arrived'),
  tx('PURCHASED', 'REFUND_PENDING', [A], 'CANCELLATION_MATRIX', 'Cancellation matrix AFTER_PURCHASE'),
  tx('TRAVELING', 'ARRIVED', [T, S], null, 'Arrived'),
  tx('ARRIVED', 'CUSTOMS_PROCESS', [T], null, 'Customs processing'),
  tx('ARRIVED', 'READY_FOR_HANDOVER', [T], null, 'No customs step needed'),
  tx('CUSTOMS_PROCESS', 'READY_FOR_HANDOVER', [T], 'CUSTOMS_PROOF', 'Customs proof uploaded (if paid)'),
  tx('READY_FOR_HANDOVER', 'OUT_FOR_DELIVERY', [T], 'COURIER_DISPATCH', 'Courier/partner logistics + tracking number'),
  tx('READY_FOR_HANDOVER', 'DELIVERED', [T], 'MEETUP_PIN', 'Meetup: buyer PIN/QR valid'),
  tx('OUT_FOR_DELIVERY', 'DELIVERED', [T, S], 'DELIVERY_PROOF', 'Delivery proof / tracking delivered'),
  tx('DELIVERED', 'BUYER_CONFIRMED', [B, S], 'BUYER_CONFIRMATION', 'Buyer confirms, or auto-confirm without dispute'),
  tx('BUYER_CONFIRMED', 'COMPLETED', [S], 'COMPLETION', 'Payout scheduled, ledger final'),
  ...DISPUTABLE.map((s) => tx(s, 'DISPUTED', [B, T, A], 'DISPUTE_WINDOW', 'Dispute opened within window')),
  ...ADMIN_OVERRIDE_REFUNDABLE.map((s) =>
    tx(s, 'REFUND_PENDING', [A], 'ADMIN_OVERRIDE_REFUND', 'Admin override with approval (matrix DURING_TRAVEL / AFTER_ARRIVAL)'),
  ),
  tx('DISPUTED', 'REFUND_PENDING', [A, S], 'DISPUTE_REFUND', 'Resolution with refund'),
  tx('DISPUTED', 'BUYER_CONFIRMED', [A, S], 'DISPUTE_NO_REFUND', 'Resolution without refund / settled partial'),
  tx('REFUND_PENDING', 'REFUNDED', [S], 'REFUND_FULL_SUCCEEDED', 'Full refund succeeded'),
  tx('REFUND_PENDING', 'COMPLETED', [S], 'REFUND_PARTIAL_SETTLED', 'Partial refund succeeded, remainder paid'),
];

export const transactionFsm: Fsm<TransactionStatus, TransactionGuardContext> = createFsm<TransactionStatus, TransactionGuardContext>({
  name: 'transaction',
  states: TRANSACTION_STATUSES,
  initial: 'REQUEST_CREATED',
  terminal: TERMINAL_TRANSACTION_STATUSES,
  transitions: TRANSACTION_TRANSITIONS,
  guards: TRANSACTION_GUARDS,
});

export function canTransition(
  from: TransactionStatus,
  to: TransactionStatus,
  actor: Actor,
  ctx: TransactionGuardContext = {},
): TransitionCheck<TransactionStatus> {
  return transactionFsm.canTransition(from, to, actor, ctx);
}

export function assertTransition(
  from: TransactionStatus,
  to: TransactionStatus,
  actor: Actor,
  ctx: TransactionGuardContext = {},
): TransitionDef<TransactionStatus> {
  return transactionFsm.assertTransition(from, to, actor, ctx);
}

export function nextAllowed(from: TransactionStatus, actor: Actor): TransactionStatus[] {
  return transactionFsm.nextAllowed(from, actor);
}

export function isTerminal(status: TransactionStatus): boolean {
  return transactionFsm.isTerminal(status);
}

// ---------------------------------------------------------------------------
// Purchase gate — the golden rule (§4)
// ---------------------------------------------------------------------------

export type PurchaseBanner = 'DO_NOT_PURCHASE' | 'PURCHASE_APPROVED' | 'ALREADY_PURCHASED' | 'TRANSACTION_CLOSED';

export interface PurchaseGate {
  readonly canPurchase: boolean;
  readonly banner: PurchaseBanner;
  /** Secondary green badge when funds are held by SafePay (still DO_NOT_PURCHASE before approval). */
  readonly paymentBadge: 'PAYMENT_SECURED' | null;
  readonly tone: 'error' | 'success' | 'info' | 'neutral';
  readonly messageId: string;
  readonly messageEn: string;
}

const PRE_PURCHASE: readonly TransactionStatus[] = [
  'REQUEST_CREATED',
  'MATCHED',
  'AWAITING_PAYMENT',
  'PAYMENT_SECURED',
  'PRICE_CHANGE_PENDING',
];

/**
 * Traveler may buy only in PURCHASE_APPROVED. Every earlier status — including PAYMENT_SECURED —
 * shows the red DO NOT PURCHASE banner (doc §4 golden rule).
 */
export function purchaseGate(status: TransactionStatus): PurchaseGate {
  if (status === 'PURCHASE_APPROVED') {
    return {
      canPurchase: true,
      banner: 'PURCHASE_APPROVED',
      paymentBadge: 'PAYMENT_SECURED',
      tone: 'success',
      messageId: 'Dana sudah aman. Silakan beli barang sesuai harga yang disetujui.',
      messageEn: 'Funds secured. You may purchase at the approved price.',
    };
  }
  if (PRE_PURCHASE.includes(status)) {
    const secured = status === 'PAYMENT_SECURED' || status === 'PRICE_CHANGE_PENDING';
    return {
      canPurchase: false,
      banner: 'DO_NOT_PURCHASE',
      paymentBadge: secured ? 'PAYMENT_SECURED' : null,
      tone: 'error',
      messageId: secured
        ? 'JANGAN BELI DULU. Dana sudah aman, tunggu status Purchase Approved.'
        : 'JANGAN BELI. Pembayaran pembeli belum diamankan.',
      messageEn: secured
        ? 'DO NOT PURCHASE yet. Funds are secured; wait for Purchase Approved.'
        : 'DO NOT PURCHASE. Buyer payment is not secured.',
    };
  }
  if (status === 'CANCELLED' || status === 'REFUNDED' || status === 'COMPLETED' || status === 'REFUND_PENDING') {
    return {
      canPurchase: false,
      banner: 'TRANSACTION_CLOSED',
      paymentBadge: null,
      tone: 'neutral',
      messageId: 'Transaksi sudah ditutup. Jangan membeli barang.',
      messageEn: 'Transaction closed. Do not purchase.',
    };
  }
  return {
    canPurchase: false,
    banner: 'ALREADY_PURCHASED',
    paymentBadge: null,
    tone: 'info',
    messageId: 'Barang sudah dibeli.',
    messageEn: 'Item already purchased.',
  };
}

// ===========================================================================
// Secondary state machines — exactly docs/00-domain-model.md §15 (parity-tested)
// ===========================================================================

function edge<St extends string>(
  from: St,
  to: St,
  actors: readonly Actor[],
  guardCode: string | null,
  description: string,
): TransitionDef<St> {
  return { from, to, actors, guardCode, description };
}

const reasonRequired = (c: { readonly reason?: string | null }): GuardFailure | null =>
  typeof c.reason === 'string' && c.reason.trim() !== '' ? null : { code: 'REASON_REQUIRED', message: 'A reason is required' };

// ---------------------------------------------------------------------------
// §15.1 Trip
// ---------------------------------------------------------------------------

export interface TripGuardContext {
  readonly travelDocumentVerified?: boolean;
  readonly allowUnverifiedActive?: boolean;
  readonly remainingCapacityKg?: number;
}

const tripHasCapacity = (c: TripGuardContext): GuardFailure | null =>
  (c.remainingCapacityKg ?? 0) > 0 ? null : { code: 'NO_CAPACITY', message: 'No remaining capacity' };

export const TRIP_TRANSITIONS: readonly TransitionDef<TripStatus>[] = [
  edge('DRAFT', 'VERIFICATION_PENDING', [T], null, 'Travel documents uploaded'),
  edge('DRAFT', 'ACTIVE', [T, S], 'UNVERIFIED_ACTIVE', 'Publish without documents (trips.allowUnverifiedActive)'),
  edge('VERIFICATION_PENDING', 'VERIFIED', [A, S], 'DOCUMENT_VERIFIED', 'Documents approved'),
  edge('VERIFICATION_PENDING', 'DRAFT', [T, A, S], null, 'Documents rejected / withdrawn'),
  edge('VERIFICATION_PENDING', 'ACTIVE', [T, S], 'UNVERIFIED_ACTIVE', 'Publish while pending (config)'),
  edge('VERIFIED', 'ACTIVE', [T, S], 'HAS_CAPACITY', 'Publish'),
  edge('ACTIVE', 'FULL', [T, S], 'MARK_FULL', 'Capacity used up / traveler stops accepting'),
  edge('FULL', 'ACTIVE', [T, S], 'HAS_CAPACITY', 'Capacity available again'),
  edge('ACTIVE', 'TRAVELING', [T, S], null, 'Departed'),
  edge('FULL', 'TRAVELING', [T, S], null, 'Departed'),
  edge('TRAVELING', 'COMPLETED', [T, S], null, 'All handovers finished'),
  ...(['DRAFT', 'VERIFICATION_PENDING', 'VERIFIED', 'ACTIVE', 'FULL', 'TRAVELING'] as const).map((from) =>
    edge<TripStatus>(from, 'CANCELLED', [T, S, A], null, 'Cancel trip (open transactions follow the cancellation matrix)'),
  ),
];

export const tripFsm: Fsm<TripStatus, TripGuardContext> = createFsm<TripStatus, TripGuardContext>({
  name: 'trip',
  states: TRIP_STATUSES,
  initial: 'DRAFT',
  terminal: ['COMPLETED', 'CANCELLED'],
  transitions: TRIP_TRANSITIONS,
  guards: {
    UNVERIFIED_ACTIVE: (c) =>
      firstFailure(
        requireTrue(c.allowUnverifiedActive, 'UNVERIFIED_ACTIVE_NOT_ALLOWED', 'trips.allowUnverifiedActive is false'),
        tripHasCapacity(c),
      ),
    DOCUMENT_VERIFIED: (c) => requireTrue(c.travelDocumentVerified, 'DOCUMENT_NOT_VERIFIED', 'Travel document not verified'),
    HAS_CAPACITY: tripHasCapacity,
    // The traveler may stop accepting at any time; SYSTEM only when capacity is exhausted.
    MARK_FULL: (c, actor) =>
      actor === 'TRAVELER' || (c.remainingCapacityKg !== undefined && c.remainingCapacityKg <= 0)
        ? null
        : { code: 'CAPACITY_REMAINING', message: 'Trip still has capacity' },
  },
});

// ---------------------------------------------------------------------------
// §15.2 Price confirmation
// ---------------------------------------------------------------------------

export interface PriceConfirmationGuardContext {
  readonly windowExpired?: boolean;
}

export const PRICE_CONFIRMATION_TRANSITIONS: readonly TransitionDef<PriceConfirmationStatus>[] = [
  edge('PENDING', 'APPROVED', [B], 'WINDOW_OPEN', 'Buyer approves'),
  edge('PENDING', 'REJECTED', [B], 'WINDOW_OPEN', 'Buyer rejects'),
  edge('PENDING', 'CLARIFICATION_REQUESTED', [B], 'WINDOW_OPEN', 'Buyer asks the traveler'),
  edge('PENDING', 'EXPIRED', [S], 'WINDOW_EXPIRED', 'No response within the window'),
  edge('CLARIFICATION_REQUESTED', 'PENDING', [T], null, 'Traveler answers; window resets'),
  edge('CLARIFICATION_REQUESTED', 'REJECTED', [B], null, 'Buyer rejects without waiting'),
  edge('CLARIFICATION_REQUESTED', 'EXPIRED', [S], 'WINDOW_EXPIRED', 'Traveler never answered'),
];

export const priceConfirmationFsm: Fsm<PriceConfirmationStatus, PriceConfirmationGuardContext> = createFsm<PriceConfirmationStatus, PriceConfirmationGuardContext>({
  name: 'price_confirmation',
  states: PRICE_CONFIRMATION_STATUSES,
  initial: 'PENDING',
  terminal: ['APPROVED', 'REJECTED', 'EXPIRED'],
  transitions: PRICE_CONFIRMATION_TRANSITIONS,
  guards: {
    WINDOW_OPEN: (c) =>
      c.windowExpired === false ? null : { code: 'WINDOW_EXPIRED', message: 'Confirmation window expired (or unknown)' },
    WINDOW_EXPIRED: (c) => requireTrue(c.windowExpired, 'WINDOW_NOT_EXPIRED', 'Window still open'),
  },
});

// ---------------------------------------------------------------------------
// §15.3 Dispute
// ---------------------------------------------------------------------------

export interface DisputeGuardContext {
  readonly evidenceWindowClosed?: boolean;
  readonly resolutionRecorded?: boolean;
  readonly withinAppealWindow?: boolean;
  readonly alreadyAppealed?: boolean;
}

export const DISPUTE_TRANSITIONS: readonly TransitionDef<DisputeStatus>[] = [
  edge('OPEN', 'EVIDENCE_COLLECTION', [A, S], null, 'Case accepted; evidence window starts'),
  edge('OPEN', 'UNDER_REVIEW', [A], null, 'Evidence already complete'),
  edge('EVIDENCE_COLLECTION', 'UNDER_REVIEW', [A, S], 'EVIDENCE_DONE', 'Evidence period done'),
  edge('UNDER_REVIEW', 'EVIDENCE_COLLECTION', [A], null, 'More evidence needed'),
  edge('UNDER_REVIEW', 'RESOLVED', [A], 'RESOLUTION', 'Resolution type + amount recorded'),
  edge('RESOLVED', 'APPEALED', [B, T], 'APPEAL', 'Appeal within dispute.sla.appealWindowHours, once'),
  edge('APPEALED', 'UNDER_REVIEW', [A, S], null, 'Appeal reviewed'),
  edge('RESOLVED', 'CLOSED', [A, S], null, 'Appeal window over / resolution executed'),
  edge('OPEN', 'CLOSED', [B, T, A], null, 'Withdrawn by opener / invalid'),
  edge('EVIDENCE_COLLECTION', 'CLOSED', [B, T, A], null, 'Withdrawn by opener'),
];

export const disputeFsm: Fsm<DisputeStatus, DisputeGuardContext> = createFsm<DisputeStatus, DisputeGuardContext>({
  name: 'dispute',
  states: DISPUTE_STATUSES,
  initial: 'OPEN',
  terminal: ['CLOSED'],
  transitions: DISPUTE_TRANSITIONS,
  guards: {
    EVIDENCE_DONE: (c) => requireTrue(c.evidenceWindowClosed, 'EVIDENCE_WINDOW_OPEN', 'Evidence window still open'),
    RESOLUTION: (c) => requireTrue(c.resolutionRecorded, 'RESOLUTION_MISSING', 'Resolution type and amount required'),
    APPEAL: (c) =>
      firstFailure(
        requireTrue(c.withinAppealWindow, 'APPEAL_WINDOW_CLOSED', 'Appeal window closed'),
        c.alreadyAppealed === false ? null : { code: 'APPEAL_ALREADY_USED', message: 'Only one appeal is allowed' },
      ),
  },
});

// ---------------------------------------------------------------------------
// §15.4 KYC submission
// ---------------------------------------------------------------------------

export interface KycGuardContext {
  readonly livenessPassed?: boolean;
  readonly documentMatches?: boolean;
  readonly notDuplicate?: boolean;
  readonly reason?: string | null;
}

export const KYC_TRANSITIONS: readonly TransitionDef<KycSubmissionStatus>[] = [
  edge('PENDING', 'IN_REVIEW', [S, A], null, 'Picked up for review'),
  edge('PENDING', 'EXPIRED', [S], null, 'Submission abandoned'),
  edge('IN_REVIEW', 'APPROVED', [A, S], 'KYC_CHECKS', 'Liveness passed, document matches, not a duplicate'),
  edge('IN_REVIEW', 'REJECTED', [A, S], 'REASON_REQUIRED', 'Rejected (reason required)'),
  edge('APPROVED', 'EXPIRED', [S], null, 'Identity document expired'),
];

export const kycSubmissionFsm: Fsm<KycSubmissionStatus, KycGuardContext> = createFsm<KycSubmissionStatus, KycGuardContext>({
  name: 'kyc_submission',
  states: KYC_SUBMISSION_STATUSES,
  initial: 'PENDING',
  terminal: ['REJECTED', 'EXPIRED'],
  transitions: KYC_TRANSITIONS,
  guards: {
    KYC_CHECKS: (c) =>
      firstFailure(
        requireTrue(c.livenessPassed, 'LIVENESS_FAILED', 'Liveness check not passed'),
        requireTrue(c.documentMatches, 'DOCUMENT_MISMATCH', 'Document/selfie mismatch'),
        requireTrue(c.notDuplicate, 'DUPLICATE_IDENTITY', 'Identity already used by another account'),
      ),
    REASON_REQUIRED: reasonRequired,
  },
});

// ---------------------------------------------------------------------------
// §15.5 Payment
// ---------------------------------------------------------------------------

export interface PaymentGuardContext {
  readonly signatureValid?: boolean;
  readonly amountMatches?: boolean;
  readonly currencyMatches?: boolean;
}

export const PAYMENT_TRANSITIONS: readonly TransitionDef<PaymentStatus>[] = [
  edge('PENDING', 'SECURED', [S], 'PAYMENT_VERIFIED', 'Verified webhook; amount & currency match'),
  edge('PENDING', 'EXPIRED', [S], null, 'Invoice expired'),
  edge('PENDING', 'FAILED', [S], null, 'Provider failure'),
  edge('EXPIRED', 'SECURED', [S], 'PAYMENT_VERIFIED', 'Late funds still recorded → auto-refund if the transaction is cancelled'),
  edge('FAILED', 'SECURED', [S], 'PAYMENT_VERIFIED', 'Late funds still recorded'),
  edge('SECURED', 'PARTIALLY_REFUNDED', [S], null, 'Partial refund succeeded'),
  edge('SECURED', 'REFUNDED', [S], null, 'Full refund succeeded'),
  edge('PARTIALLY_REFUNDED', 'REFUNDED', [S], null, 'Remainder refunded'),
];

export const paymentFsm: Fsm<PaymentStatus, PaymentGuardContext> = createFsm<PaymentStatus, PaymentGuardContext>({
  name: 'payment',
  states: PAYMENT_STATUSES,
  initial: 'PENDING',
  terminal: ['REFUNDED'],
  transitions: PAYMENT_TRANSITIONS,
  guards: {
    PAYMENT_VERIFIED: (c) =>
      firstFailure(
        requireTrue(c.signatureValid, 'PAYMENT_SIGNATURE_INVALID', 'Webhook signature invalid'),
        requireTrue(c.amountMatches, 'PAYMENT_AMOUNT_MISMATCH', 'Paid amount does not match'),
        requireTrue(c.currencyMatches, 'PAYMENT_CURRENCY_MISMATCH', 'Paid currency does not match'),
      ),
  },
});

// ---------------------------------------------------------------------------
// §15.6 Refund
// ---------------------------------------------------------------------------

export interface RefundGuardContext {
  readonly amountWithinCaptured?: boolean;
  /** Amount above the auto-approve threshold → maker-checker. */
  readonly aboveAutoApproveLimit?: boolean;
  readonly requestedBy?: string | null;
  readonly approvedBy?: string | null;
  readonly reason?: string | null;
  readonly attempts?: number;
  /** SYSTEM retry budget (default 3). */
  readonly maxAttempts?: number;
}

export const REFUND_TRANSITIONS: readonly TransitionDef<RefundStatus>[] = [
  edge('REQUESTED', 'PENDING_APPROVAL', [S], 'ABOVE_AUTO_APPROVE', 'Amount above the auto-approve limit'),
  edge('REQUESTED', 'APPROVED', [A, S], 'AMOUNT_OK', 'Amount ≤ captured funds'),
  edge('REQUESTED', 'REJECTED', [A], 'REASON_REQUIRED', 'Rejected (reason required)'),
  edge('REQUESTED', 'CANCELLED', [A, S], null, 'Cancelled'),
  edge('PENDING_APPROVAL', 'APPROVED', [A], 'MAKER_CHECKER', 'Approver ≠ requester'),
  edge('PENDING_APPROVAL', 'REJECTED', [A], 'REASON_REQUIRED', 'Rejected (reason required)'),
  edge('PENDING_APPROVAL', 'CANCELLED', [A, S], null, 'Cancelled'),
  edge('APPROVED', 'PROCESSING', [S], null, 'Sent to provider (refund channel or disbursement)'),
  edge('APPROVED', 'CANCELLED', [A], null, 'Cancelled'),
  edge('PROCESSING', 'SUCCEEDED', [S], null, 'Provider success'),
  edge('PROCESSING', 'FAILED', [S], null, 'Provider failure'),
  edge('FAILED', 'PROCESSING', [S, A], 'RETRY_BUDGET', 'Retry (SYSTEM max 3×, ADMIN unlimited)'),
  edge('FAILED', 'CANCELLED', [A], null, 'Cancelled'),
];

export const refundFsm: Fsm<RefundStatus, RefundGuardContext> = createFsm<RefundStatus, RefundGuardContext>({
  name: 'refund',
  states: REFUND_STATUSES,
  initial: 'REQUESTED',
  terminal: ['SUCCEEDED', 'REJECTED', 'CANCELLED'],
  transitions: REFUND_TRANSITIONS,
  guards: {
    ABOVE_AUTO_APPROVE: (c) =>
      requireTrue(c.aboveAutoApproveLimit, 'WITHIN_AUTO_APPROVE_LIMIT', 'Amount is within the auto-approve limit'),
    AMOUNT_OK: (c, actor) =>
      firstFailure(
        requireTrue(c.amountWithinCaptured, 'REFUND_EXCEEDS_CAPTURED', 'Refund exceeds captured amount'),
        actor === 'SYSTEM' && c.aboveAutoApproveLimit !== false
          ? { code: 'APPROVAL_REQUIRED', message: 'Above (or unknown vs) auto-approve limit; needs PENDING_APPROVAL' }
          : null,
      ),
    MAKER_CHECKER: (c) =>
      firstFailure(
        requireTrue(c.amountWithinCaptured, 'REFUND_EXCEEDS_CAPTURED', 'Refund exceeds captured amount'),
        c.approvedBy && c.requestedBy && c.approvedBy !== c.requestedBy
          ? null
          : { code: 'MAKER_CHECKER_VIOLATION', message: 'Approver must be recorded and differ from the requester' },
      ),
    REASON_REQUIRED: reasonRequired,
    RETRY_BUDGET: (c, actor) =>
      actor === 'ADMIN' || (c.attempts ?? Number.POSITIVE_INFINITY) < (c.maxAttempts ?? 3)
        ? null
        : { code: 'RETRY_LIMIT_REACHED', message: 'Automatic retries exhausted; admin required' },
  },
});

// ---------------------------------------------------------------------------
// §15.7 Payout (traveler)
// ---------------------------------------------------------------------------

export interface PayoutGuardContext {
  readonly riskDecision?: RiskDecision;
  readonly disputeOpen?: boolean;
  readonly bankAccountVerified?: boolean;
  readonly holdReleasedBy?: string | null;
  readonly reason?: string | null;
}

export const PAYOUT_TRANSITIONS: readonly TransitionDef<PayoutStatus>[] = [
  edge('SCHEDULED', 'PROCESSING', [S, A], 'PAYOUT_CLEAR', 'Risk ALLOW/REVIEW, no open dispute, verified account'),
  edge('SCHEDULED', 'ON_HOLD', [S, A], 'REASON_REQUIRED', 'Hold (reason required)'),
  edge('SCHEDULED', 'CANCELLED', [A], null, 'Cancelled'),
  edge('ON_HOLD', 'SCHEDULED', [A], 'HOLD_RELEASE', 'Hold released (approver recorded)'),
  edge('ON_HOLD', 'CANCELLED', [A], null, 'Cancelled'),
  edge('PROCESSING', 'PAID', [S], null, 'Disbursement success'),
  edge('PROCESSING', 'FAILED', [S], null, 'Disbursement failure'),
  edge('FAILED', 'SCHEDULED', [S, A], null, 'Retry after fix'),
  edge('FAILED', 'ON_HOLD', [S, A], null, 'Repeated failure'),
  edge('FAILED', 'CANCELLED', [A], null, 'Cancelled'),
];

export const payoutFsm: Fsm<PayoutStatus, PayoutGuardContext> = createFsm<PayoutStatus, PayoutGuardContext>({
  name: 'payout',
  states: PAYOUT_STATUSES,
  initial: 'SCHEDULED',
  terminal: ['PAID', 'CANCELLED'],
  transitions: PAYOUT_TRANSITIONS,
  guards: {
    PAYOUT_CLEAR: (c) =>
      firstFailure(
        c.riskDecision === 'ALLOW' || c.riskDecision === 'REVIEW'
          ? null
          : { code: 'RISK_HOLD', message: 'Risk decision HOLD/BLOCK (or unknown)' },
        c.disputeOpen === false ? null : { code: 'DISPUTE_OPEN', message: 'Open dispute (or unknown)' },
        requireTrue(c.bankAccountVerified, 'BANK_ACCOUNT_UNVERIFIED', 'Payout account not verified'),
      ),
    HOLD_RELEASE: (c) =>
      typeof c.holdReleasedBy === 'string' && c.holdReleasedBy !== ''
        ? null
        : { code: 'RELEASE_APPROVER_MISSING', message: 'Hold release requires an approver' },
    REASON_REQUIRED: reasonRequired,
  },
});

// ---------------------------------------------------------------------------
// §15.8 Quote & FX lock (all SYSTEM)
// ---------------------------------------------------------------------------

export const QUOTE_TRANSITIONS: readonly TransitionDef<QuoteStatus>[] = [
  edge('ACTIVE', 'ACCEPTED', [S], null, 'Checkout started with this quote'),
  edge('ACTIVE', 'EXPIRED', [S], null, 'Quote / FX lock expired'),
  edge('ACTIVE', 'SUPERSEDED', [S], null, 'Re-quoted'),
  edge('ACCEPTED', 'SUPERSEDED', [S], null, 'Re-quoted after acceptance (e.g. supplemental payment)'),
];

export const quoteFsm: Fsm<QuoteStatus, Record<string, never>> = createFsm<QuoteStatus, Record<string, never>>({
  name: 'quote',
  states: QUOTE_STATUSES,
  initial: 'ACTIVE',
  terminal: ['EXPIRED', 'SUPERSEDED'],
  transitions: QUOTE_TRANSITIONS,
  guards: {},
});

export const FX_LOCK_TRANSITIONS: readonly TransitionDef<FxLockStatus>[] = [
  edge('ACTIVE', 'CONSUMED', [S], null, 'Used by a payment'),
  edge('ACTIVE', 'EXPIRED', [S], null, 'Lock window passed'),
];

export const fxLockFsm: Fsm<FxLockStatus, Record<string, never>> = createFsm<FxLockStatus, Record<string, never>>({
  name: 'fx_lock',
  states: FX_LOCK_STATUSES,
  initial: 'ACTIVE',
  terminal: ['CONSUMED', 'EXPIRED'],
  transitions: FX_LOCK_TRANSITIONS,
  guards: {},
});
