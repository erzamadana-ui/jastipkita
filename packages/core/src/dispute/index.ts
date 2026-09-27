import type { DisputeSlaConfig } from '../config';
import {
  DISPUTE_RESOLUTIONS,
  DISPUTE_TYPES,
  type DisputeResolution,
  type DisputeStatus,
  type TransactionStatus,
} from '../domain';
import type { Reason } from '../errors';
import { addHours } from '../internal/time';
import { assertNonNegativeInteger } from '../money';

export { DISPUTE_RESOLUTIONS, DISPUTE_TYPES };

export interface DisputeSla {
  readonly openedAt: Date;
  /** End of EVIDENCE_COLLECTION. */
  readonly evidenceDueAt: Date;
  /** Admin decision deadline (evidence + review). */
  readonly reviewDueAt: Date;
}

export function computeSla(openedAt: Date, sla: DisputeSlaConfig): DisputeSla {
  const evidenceDueAt = addHours(openedAt, sla.evidenceHours);
  return { openedAt: new Date(openedAt.getTime()), evidenceDueAt, reviewDueAt: addHours(evidenceDueAt, sla.reviewHours) };
}

export function appealDeadline(resolvedAt: Date, sla: Pick<DisputeSlaConfig, 'appealWindowHours'>): Date {
  return addHours(resolvedAt, sla.appealWindowHours);
}

export function disputeWindowClosesAt(deliveredAt: Date, sla: Pick<DisputeSlaConfig, 'openWindowHoursAfterDelivery'>): Date {
  return addHours(deliveredAt, sla.openWindowHoursAfterDelivery);
}

export type SlaBreach = 'EVIDENCE_OVERDUE' | 'REVIEW_OVERDUE' | null;

/** Which SLA deadline (if any) is breached for a dispute in `status` at `now`. */
export function slaBreach(status: DisputeStatus, sla: DisputeSla, now: Date): SlaBreach {
  if ((status === 'OPEN' || status === 'EVIDENCE_COLLECTION') && now.getTime() > sla.evidenceDueAt.getTime()) {
    return 'EVIDENCE_OVERDUE';
  }
  if (status !== 'RESOLVED' && status !== 'CLOSED' && now.getTime() > sla.reviewDueAt.getTime()) {
    return 'REVIEW_OVERDUE';
  }
  return null;
}

const DISPUTABLE: readonly TransactionStatus[] = [
  'PURCHASED',
  'TRAVELING',
  'ARRIVED',
  'CUSTOMS_PROCESS',
  'READY_FOR_HANDOVER',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
];

export type CanOpenDisputeResult =
  | { readonly ok: true; readonly windowClosesAt: Date | null }
  | { readonly ok: false; readonly code: string; readonly message: string };

/**
 * A dispute may be opened from PURCHASED … DELIVERED (§4). Once DELIVERED, only within
 * `openWindowHoursAfterDelivery` of delivery. Before delivery there is no deadline.
 */
export function canOpenDispute(
  txStatus: TransactionStatus,
  deliveredAt: Date | null,
  now: Date,
  sla: Pick<DisputeSlaConfig, 'openWindowHoursAfterDelivery'>,
): CanOpenDisputeResult {
  if (!DISPUTABLE.includes(txStatus)) {
    return { ok: false, code: 'STATUS_NOT_DISPUTABLE', message: `Cannot open a dispute in ${txStatus}` };
  }
  if (txStatus !== 'DELIVERED') return { ok: true, windowClosesAt: null };
  if (!deliveredAt) {
    return { ok: false, code: 'DELIVERED_AT_MISSING', message: 'deliveredAt is required once DELIVERED' };
  }
  const closes = disputeWindowClosesAt(deliveredAt, sla);
  if (now.getTime() > closes.getTime()) {
    return { ok: false, code: 'DISPUTE_WINDOW_CLOSED', message: `Dispute window closed at ${closes.toISOString()}` };
  }
  return { ok: true, windowClosesAt: closes };
}

export interface ResolutionInput {
  readonly resolution: DisputeResolution;
  readonly refundIdr: number;
  /** Cash captured for the transaction (TOTAL). */
  readonly capturedIdr: number;
  readonly alreadyRefundedIdr?: number;
}

export interface ResolutionValidation {
  readonly ok: boolean;
  readonly errors: readonly Reason[];
  readonly refundableIdr: number;
  /** Transaction status the resolution leads to from DISPUTED. */
  readonly nextTransactionStatus: 'REFUND_PENDING' | 'BUYER_CONFIRMED';
}

/** Resolution → refund amount validation: refunds never exceed the remaining captured amount. */
export function validateDisputeResolution(input: ResolutionInput): ResolutionValidation {
  assertNonNegativeInteger(input.refundIdr, 'refundIdr');
  assertNonNegativeInteger(input.capturedIdr, 'capturedIdr');
  const already = input.alreadyRefundedIdr ?? 0;
  assertNonNegativeInteger(already, 'alreadyRefundedIdr');
  const refundable = Math.max(0, input.capturedIdr - already);
  const errors: Reason[] = [];
  if (input.refundIdr > refundable) {
    errors.push({ code: 'REFUND_EXCEEDS_CAPTURED', message: `Refund ${input.refundIdr} > refundable ${refundable}` });
  }
  switch (input.resolution) {
    case 'REFUND_FULL':
      if (input.refundIdr !== refundable) {
        errors.push({ code: 'FULL_REFUND_AMOUNT', message: `Full refund must equal ${refundable}` });
      }
      break;
    case 'REFUND_PARTIAL':
      if (input.refundIdr <= 0 || input.refundIdr >= refundable) {
        errors.push({ code: 'PARTIAL_REFUND_AMOUNT', message: `Partial refund must be between 1 and ${refundable - 1}` });
      }
      break;
    case 'RETURN_AND_REFUND':
      if (input.refundIdr <= 0) errors.push({ code: 'REFUND_REQUIRED', message: 'Return & refund needs a refund amount' });
      break;
    case 'NO_REFUND':
      if (input.refundIdr !== 0) errors.push({ code: 'NO_REFUND_AMOUNT', message: 'NO_REFUND must have refund 0' });
      break;
    case 'OTHER':
      break;
  }
  return {
    ok: errors.length === 0,
    errors,
    refundableIdr: refundable,
    nextTransactionStatus: input.refundIdr > 0 ? 'REFUND_PENDING' : 'BUYER_CONFIRMED',
  };
}
