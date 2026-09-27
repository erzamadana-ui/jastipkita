import type { PriceConfirmationConfig } from '../config';
import { CoreError } from '../errors';
import { addSeconds } from '../internal/time';
import { applyBps, assertBps, assertNonNegativeInteger } from '../money';

export interface PriceChangeInput {
  /** Item price (IDR) the buyer's payment secured. */
  readonly securedItemIdr: number;
  /** Buyer's stated ceiling for the item; null/undefined = none. */
  readonly maxBudgetIdr?: number | null;
  /** Actual item price found by the traveler (IDR at the locked rate). */
  readonly actualItemIdr: number;
  readonly toleranceBps: number;
  readonly toleranceMaxIdr: number;
}

export type PriceChangeOutcome = 'WITHIN_TOLERANCE' | 'NEEDS_CONFIRMATION';

export interface PriceChangeEvaluation {
  readonly outcome: PriceChangeOutcome;
  readonly autoApprove: boolean;
  readonly direction: 'INCREASE' | 'DECREASE' | 'UNCHANGED';
  /** actual − secured */
  readonly differenceIdr: number;
  /** min(secured × toleranceBps, toleranceMaxIdr) */
  readonly toleranceIdr: number;
  /** Increase inside tolerance: not collected from the buyer (absorbed; see README). */
  readonly absorbedWithinToleranceIdr: number;
  /** If the buyer approves a NEEDS_CONFIRMATION increase, the top-up required. */
  readonly supplementalRequiredIdr: number;
  /** Price decreased: difference refundable to the buyer. */
  readonly refundDueIdr: number;
  readonly exceedsMaxBudget: boolean;
  /** Transaction status the traveler's report leads to (from PAYMENT_SECURED). */
  readonly nextTransactionStatus: 'PURCHASE_APPROVED' | 'PRICE_CHANGE_PENDING';
}

/**
 * Decides whether the traveler's actual price can be auto-approved.
 * - decrease or unchanged → WITHIN_TOLERANCE (refund the difference later)
 * - increase ≤ tolerance and within the buyer's max budget → WITHIN_TOLERANCE
 * - otherwise → NEEDS_CONFIRMATION (buyer approves / rejects / asks)
 */
export function evaluatePriceChange(input: PriceChangeInput): PriceChangeEvaluation {
  assertNonNegativeInteger(input.securedItemIdr, 'securedItemIdr');
  assertNonNegativeInteger(input.actualItemIdr, 'actualItemIdr');
  assertNonNegativeInteger(input.toleranceMaxIdr, 'toleranceMaxIdr');
  assertBps(input.toleranceBps, 'toleranceBps');
  if (input.maxBudgetIdr !== undefined && input.maxBudgetIdr !== null) {
    assertNonNegativeInteger(input.maxBudgetIdr, 'maxBudgetIdr');
  }
  const differenceIdr = input.actualItemIdr - input.securedItemIdr;
  const toleranceIdr = Math.min(applyBps(input.securedItemIdr, input.toleranceBps, 'FLOOR'), input.toleranceMaxIdr);
  const exceedsMaxBudget =
    input.maxBudgetIdr !== undefined && input.maxBudgetIdr !== null && input.actualItemIdr > input.maxBudgetIdr;
  const direction = differenceIdr > 0 ? 'INCREASE' : differenceIdr < 0 ? 'DECREASE' : 'UNCHANGED';
  const within = differenceIdr <= toleranceIdr && !exceedsMaxBudget;
  return {
    outcome: within ? 'WITHIN_TOLERANCE' : 'NEEDS_CONFIRMATION',
    autoApprove: within,
    direction,
    differenceIdr,
    toleranceIdr,
    absorbedWithinToleranceIdr: within && differenceIdr > 0 ? differenceIdr : 0,
    supplementalRequiredIdr: !within && differenceIdr > 0 ? differenceIdr : 0,
    refundDueIdr: differenceIdr < 0 ? -differenceIdr : 0,
    exceedsMaxBudget,
    nextTransactionStatus: within ? 'PURCHASE_APPROVED' : 'PRICE_CHANGE_PENDING',
  };
}

export function windowExpiresAt(now: Date, windowSeconds: number): Date {
  if (!Number.isSafeInteger(windowSeconds) || windowSeconds <= 0) {
    throw new CoreError('INVALID_WINDOW', `windowSeconds must be a positive integer, got ${windowSeconds}`);
  }
  return addSeconds(now, windowSeconds);
}

export function isWindowExpired(expiresAt: Date, now: Date): boolean {
  return now.getTime() >= expiresAt.getTime();
}

export interface ExpiredResolution {
  readonly priceConfirmationStatus: 'EXPIRED';
  readonly action: 'REJECT' | 'APPROVE';
  readonly transactionTo: 'REFUND_PENDING' | 'PURCHASE_APPROVED';
  readonly reason: string;
}

/**
 * What happens when the window lapses without a buyer response. Default config: REJECT (§4 —
 * "window habis tanpa respon (default: expired = reject)"). APPROVE_WITHIN_BUDGET only auto-approves
 * when the change needs no top-up and stays within the buyer's max budget.
 */
export function resolveExpired(
  config: Pick<PriceConfirmationConfig, 'expiredAction'>,
  evaluation?: Pick<PriceChangeEvaluation, 'supplementalRequiredIdr' | 'exceedsMaxBudget'>,
): ExpiredResolution {
  if (
    config.expiredAction === 'APPROVE_WITHIN_BUDGET' &&
    evaluation &&
    evaluation.supplementalRequiredIdr === 0 &&
    !evaluation.exceedsMaxBudget
  ) {
    return {
      priceConfirmationStatus: 'EXPIRED',
      action: 'APPROVE',
      transactionTo: 'PURCHASE_APPROVED',
      reason: 'Window expired; change fits secured funds and budget → auto-approved by config',
    };
  }
  return {
    priceConfirmationStatus: 'EXPIRED',
    action: 'REJECT',
    transactionTo: 'REFUND_PENDING',
    reason: 'Window expired without buyer response → treated as reject',
  };
}
