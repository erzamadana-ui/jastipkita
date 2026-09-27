/**
 * Trust Score recompute triggers (outbox). Each part recomputes the affected users; the recompute is
 * idempotent (same facts → same score, history only on change).
 */
import type { AppDeps } from '../../context';
import type { OutboxEvent } from '../../jobs/types';
import { pid, pstr, type EventPart } from '../notifications/util';
import { recomputeTrustScore } from './service';

const TX_TRIGGERS = new Set(['DELIVERED', 'COMPLETED', 'CANCELLED', 'REFUNDED', 'REFUND_PENDING']);

async function affectedUsers(deps: AppDeps, ev: OutboxEvent): Promise<string[]> {
  const p = ev.payload;
  switch (ev.eventType) {
    case 'transaction.status_changed':
      return TX_TRIGGERS.has(pstr(p, 'to') ?? '') ? [pid(p, 'buyerId'), pid(p, 'travelerId')].filter((x): x is string => !!x) : [];
    case 'dispute.status_changed':
    case 'dispute.resolved': {
      if (ev.eventType === 'dispute.status_changed' && !['RESOLVED', 'CLOSED'].includes(pstr(p, 'to') ?? '')) return [];
      const disputeId = pid(p, 'disputeId');
      if (!disputeId) return [];
      const [r] = await deps.sql<{ buyer_id: string; traveler_id: string | null }[]>`
        SELECT t.buyer_id, t.traveler_id FROM disputes d JOIN transactions t ON t.id = d.transaction_id WHERE d.id = ${disputeId}`;
      return r ? [r.buyer_id, r.traveler_id].filter((x): x is string => !!x) : [];
    }
    case 'kyc.level_changed':
    case 'kyc.approved':
      return [pid(p, 'userId')].filter((x): x is string => !!x);
    case 'rating.created':
      return [pid(p, 'rateeId')].filter((x): x is string => !!x);
    case 'trip.verified':
      return [pid(p, 'travelerId')].filter((x): x is string => !!x);
    case 'payment.failed':
      return [pid(p, 'buyerId')].filter((x): x is string => !!x);
    case 'risk.review_resolved':
      // contract for the admin group: { reviewId, subjectType, subjectId, status, userId? }
      return [pid(p, 'userId') ?? (pstr(p, 'subjectType') === 'USER' ? pid(p, 'subjectId') : undefined)].filter((x): x is string => !!x);
    default:
      return [];
  }
}

export const TRUST_EVENT_TYPES = [
  'transaction.status_changed',
  'dispute.status_changed',
  'dispute.resolved',
  'kyc.level_changed',
  'kyc.approved',
  'rating.created',
  'trip.verified',
  'payment.failed',
  'risk.review_resolved',
];

export const trustPart: EventPart = async function trustRecompute(deps, ev) {
  for (const userId of [...new Set(await affectedUsers(deps, ev))]) {
    await recomputeTrustScore(deps, userId, ev.eventType === 'transaction.status_changed' ? `transaction:${pstr(ev.payload, 'to')}` : ev.eventType);
  }
};
