import type { CancellationMatrix, CancellationMatrixRow, MatrixActor } from '../config';
import {
  type Actor,
  type CancellationStage,
  CHARGE_LINE_TYPES,
  type ChargeLineType,
  type PriceLineType,
  type TransactionStatus,
} from '../domain';
import { CoreError } from '../errors';
import { applyBps, assertSafeInteger, sumMinor } from '../money';
import { transactionFsm } from '../state-machine';

const STAGE_BY_STATUS: Readonly<Partial<Record<TransactionStatus, CancellationStage>>> = {
  REQUEST_CREATED: 'BEFORE_MATCH',
  MATCHED: 'AFTER_MATCH',
  AWAITING_PAYMENT: 'AFTER_MATCH',
  PAYMENT_SECURED: 'AFTER_PAYMENT',
  PRICE_CHANGE_PENDING: 'AFTER_PAYMENT',
  PURCHASE_APPROVED: 'BEFORE_PURCHASE',
  PURCHASED: 'AFTER_PURCHASE',
  TRAVELING: 'DURING_TRAVEL',
  ARRIVED: 'AFTER_ARRIVAL',
  CUSTOMS_PROCESS: 'AFTER_ARRIVAL',
  READY_FOR_HANDOVER: 'AFTER_ARRIVAL',
  OUT_FOR_DELIVERY: 'AFTER_ARRIVAL',
  DELIVERED: 'AFTER_ARRIVAL',
};

/** null = not cancellable (terminal, DISPUTED, REFUND_PENDING, BUYER_CONFIRMED). */
export function cancellationStage(status: TransactionStatus): CancellationStage | null {
  return STAGE_BY_STATUS[status] ?? null;
}

export interface PaidLine {
  readonly type: PriceLineType;
  readonly amountIdr: number;
}

/** Known causes (free-form UPPER_SNAKE codes are allowed; these have matrix rows by default). */
export const CANCELLATION_CAUSES = { PRICE_CHANGE_REJECTED: 'PRICE_CHANGE_REJECTED' } as const;

export interface CancellationInput {
  readonly status: TransactionStatus;
  readonly actor: Actor;
  /** e.g. PRICE_CHANGE_REJECTED — selects a cause-specific matrix row when one exists. */
  readonly cause?: string;
  /** Lines as charged (a Quote's `lines`); DISCOUNT/REFERRAL_CREDIT negative. */
  readonly quoteLines: readonly PaidLine[];
  readonly paymentCaptured: boolean;
}

export interface CancellationResult {
  readonly allowed: boolean;
  readonly stage: CancellationStage | null;
  readonly matrixActor: MatrixActor | null;
  /** Cause of the matched row (null when a generic row matched). */
  readonly matrixCause: string | null;
  readonly reasonCode: string | null;
  readonly reason: string | null;
  /** Cash paid by the buyer (TOTAL), 0 if not captured. */
  readonly paidIdr: number;
  /** Cash back to the buyer. */
  readonly refundIdr: number;
  /** Gross refund per charge line (before promo netting). */
  readonly refundByLine: Readonly<Record<ChargeLineType, number>>;
  readonly retainedByLine: Readonly<Record<ChargeLineType, number>>;
  readonly travelerCompensationIdr: number;
  readonly platformRetainedIdr: number;
  readonly paymentFeeRetainedIdr: number;
  readonly customsRetainedIdr: number;
  readonly serviceTaxRetainedIdr: number;
  /** Promo money used to cover retained amounts when retained > cash paid. */
  readonly promoConsumedIdr: number;
  /** Referral credit returned to the buyer's wallet (as credit, not cash). */
  readonly creditRestoredIdr: number;
  /** Discount reversed back to the promotion budget. */
  readonly discountReversedIdr: number;
  readonly trustPenalty: number;
  readonly penalizedActor: Actor | null;
  readonly requiresAdminApproval: boolean;
  /** Transaction statuses to walk (e.g. ['REFUND_PENDING'] or ['DISPUTED','REFUND_PENDING']). */
  readonly transitionPath: readonly TransactionStatus[];
  /** Whether the FSM lets this actor take the first step directly (else an ADMIN must execute it). */
  readonly fsmPermitsActor: boolean;
}

function zeroLines(): Record<ChargeLineType, number> {
  return Object.fromEntries(CHARGE_LINE_TYPES.map((t) => [t, 0])) as Record<ChargeLineType, number>;
}

/**
 * Row lookup order (business-config `_meta.matrixMatching`):
 * (stage, actor, cause) → (stage, actor, no cause) → (stage, ANY, cause) → (stage, ANY, no cause).
 * A row that carries a cause only ever matches that cause.
 */
export function findMatrixRow(
  matrix: CancellationMatrix,
  stage: CancellationStage,
  actor: Actor,
  cause?: string,
): CancellationMatrixRow | undefined {
  const pick = (a: MatrixActor, withCause: boolean) =>
    matrix.find((r) => r.stage === stage && r.actor === a && (withCause ? cause !== undefined && r.cause === cause : r.cause === undefined));
  return pick(actor, true) ?? pick(actor, false) ?? pick('ANY', true) ?? pick('ANY', false);
}

function pathFor(status: TransactionStatus, stage: CancellationStage): TransactionStatus[] {
  switch (stage) {
    case 'BEFORE_MATCH':
    case 'AFTER_MATCH':
      return ['CANCELLED'];
    default:
      // §4: AFTER_PAYMENT … AFTER_ARRIVAL go straight to REFUND_PENDING when the edge exists
      // (ADMIN override edges for TRAVELING … OUT_FOR_DELIVERY); DELIVERED has none → via DISPUTED.
      return transactionFsm.findTransition(status, 'REFUND_PENDING') ? ['REFUND_PENDING'] : ['DISPUTED', 'REFUND_PENDING'];
  }
}

/**
 * Applies the cancellation matrix. Reconciliation (tested):
 *   refundIdr + travelerCompensation + platformRetained + paymentFeeRetained + customsRetained
 *   + serviceTaxRetained = paidIdr + promoConsumedIdr
 * Promotions never turn into cash: retained amounts are first charged to the buyer's cash, and any
 * unused discount is reversed to the budget / referral credit restored to the wallet.
 */
export function evaluateCancellation(input: CancellationInput, matrix: CancellationMatrix): CancellationResult {
  const stage = cancellationStage(input.status);
  const empty = zeroLines();
  const denied = (
    reasonCode: string,
    reason: string,
    extra: Partial<CancellationResult> = {},
  ): CancellationResult => ({
    allowed: false,
    stage,
    matrixActor: null,
    matrixCause: null,
    reasonCode,
    reason,
    paidIdr: 0,
    refundIdr: 0,
    refundByLine: empty,
    retainedByLine: empty,
    travelerCompensationIdr: 0,
    platformRetainedIdr: 0,
    paymentFeeRetainedIdr: 0,
    customsRetainedIdr: 0,
    serviceTaxRetainedIdr: 0,
    promoConsumedIdr: 0,
    creditRestoredIdr: 0,
    discountReversedIdr: 0,
    trustPenalty: 0,
    penalizedActor: null,
    requiresAdminApproval: false,
    transitionPath: [],
    fsmPermitsActor: false,
    ...extra,
  });

  if (stage === null) {
    return denied('NOT_CANCELLABLE', `Status ${input.status} cannot be cancelled; use the dispute/refund flow`);
  }

  // Paid amounts
  const charges = zeroLines();
  let discount = 0;
  let credit = 0;
  let totalLine: number | null = null;
  for (const l of input.quoteLines) {
    assertSafeInteger(l.amountIdr, `line ${l.type}`);
    if (l.type === 'DISCOUNT') discount += -l.amountIdr;
    else if (l.type === 'REFERRAL_CREDIT') credit += -l.amountIdr;
    else if (l.type === 'TOTAL') totalLine = l.amountIdr;
    else charges[l.type] += l.amountIdr;
  }
  if (discount < 0 || credit < 0 || CHARGE_LINE_TYPES.some((t) => charges[t] < 0)) {
    throw new CoreError('INVALID_QUOTE_LINES', 'Charge lines must be >= 0 and credit lines <= 0');
  }
  const gross = sumMinor(CHARGE_LINE_TYPES.map((t) => charges[t]));
  const cash = gross - discount - credit;
  if (totalLine !== null && totalLine !== cash) {
    throw new CoreError('QUOTE_TOTAL_MISMATCH', `TOTAL ${totalLine} ≠ Σ lines ${cash}`);
  }

  const transitionPath = pathFor(input.status, stage);
  const firstStep = transitionPath[0] as TransactionStatus;
  const fsmPermitsActor = transactionFsm.findTransition(input.status, firstStep)?.actors.includes(input.actor) ?? false;

  const row = findMatrixRow(matrix, stage, input.actor, input.cause);
  if (!row) {
    if (!input.paymentCaptured && (input.actor === 'SYSTEM' || input.actor === 'ADMIN')) {
      // No money has moved: operational cancellation needs no matrix policy.
      return {
        ...denied('', ''),
        allowed: true,
        reasonCode: null,
        reason: null,
        transitionPath,
        fsmPermitsActor,
      };
    }
    return denied('NO_MATRIX_ROW', `No cancellation policy for ${input.actor} at ${stage}; escalate to admin`, {
      requiresAdminApproval: true,
      transitionPath,
      fsmPermitsActor,
    });
  }
  if (!row.allowed) {
    return denied('NOT_ALLOWED_BY_MATRIX', row.reason ?? 'Not allowed at this stage', {
      matrixActor: row.actor,
      matrixCause: row.cause ?? null,
      transitionPath,
      fsmPermitsActor,
    });
  }

  const penalizedActor = row.trustPenalty > 0 ? input.actor : null;
  const common = {
    allowed: true,
    stage,
    matrixActor: row.actor,
    matrixCause: row.cause ?? null,
    reasonCode: null,
    reason: null,
    trustPenalty: row.trustPenalty,
    penalizedActor,
    requiresAdminApproval: row.requiresAdminApproval === true,
    transitionPath,
    fsmPermitsActor,
  } as const;

  if (!input.paymentCaptured) {
    return { ...denied('', ''), ...common };
  }

  const refundByLine = zeroLines();
  const retainedByLine = zeroLines();
  for (const t of CHARGE_LINE_TYPES) {
    refundByLine[t] = applyBps(charges[t], row.refund[t] ?? 0, 'HALF_UP');
    retainedByLine[t] = charges[t] - refundByLine[t];
  }
  const retained = sumMinor(CHARGE_LINE_TYPES.map((t) => retainedByLine[t]));
  const refundIdr = Math.max(0, cash - retained);
  const promoConsumedIdr = Math.max(0, retained - cash);
  const discountUsed = Math.min(discount, promoConsumedIdr);
  const creditUsed = promoConsumedIdr - discountUsed;

  const pool = retainedByLine.ITEM_PRICE + retainedByLine.TRAVELER_FEE + retainedByLine.PROTECTION_FEE + retainedByLine.PLATFORM_FEE;
  const comp = row.travelerCompensation;
  const wanted =
    comp.rateBpsOfTravelerFee === 0 && comp.minIdr === 0
      ? 0
      : Math.max(comp.minIdr, applyBps(charges.TRAVELER_FEE, comp.rateBpsOfTravelerFee, 'HALF_UP'));
  const travelerCompensationIdr = Math.min(pool, wanted);

  return {
    ...common,
    paidIdr: cash,
    refundIdr,
    refundByLine,
    retainedByLine,
    travelerCompensationIdr,
    platformRetainedIdr: pool - travelerCompensationIdr,
    paymentFeeRetainedIdr: retainedByLine.PAYMENT_FEE,
    customsRetainedIdr: retainedByLine.CUSTOMS_DUTY + retainedByLine.IMPORT_TAX,
    serviceTaxRetainedIdr: retainedByLine.SERVICE_TAX,
    promoConsumedIdr,
    creditRestoredIdr: credit - creditUsed,
    discountReversedIdr: discount - discountUsed,
  };
}
