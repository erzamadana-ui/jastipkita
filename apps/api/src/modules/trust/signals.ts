/**
 * Trust Score inputs from real DB facts (docs/00-domain-model.md §12). Definitions (see
 * docs/api/engagement.md for the full table):
 *   completed / value      COMPLETED transactions as buyer or traveler, Σ total_idr
 *   cancellations          transitions to CANCELLED / REFUND_PENDING initiated by the user (BUYER/TRAVELER
 *                          actor), excluding a buyer rejecting a price change (§5: no fault) and dispute outcomes;
 *                          rate = count / transactions the user took part in (MATCHED or later)
 *   disputes lost          traveler side of a refunding resolution; buyer who opened a dispute resolved NO_REFUND
 *   on-time delivery       traveler: delivered on/before requests.needed_by (else trip arrival + 7 days), WIB dates
 *   verified trips         trips with verified_at; null when the user never created a trip (buyer)
 *   fraud                  risk_reviews CONFIRMED_FRAUD (CRITICAL) + USER risk assessments HOLD/BLOCK/REVIEW (180 d)
 *   payment history        FAILED payments as buyer; chargebacks = 0 (no chargeback feed yet — ASSUMPTION)
 *   rating                 abuse-weighted average of PUBLISHED ratings received (weights from the ratings module)
 */
import type { FraudSeverity, TrustSignals } from '@jastipkita/core';
import type { Db } from '../../db/sql';

export async function loadTrustSignals(db: Db, userId: string, now: Date): Promise<TrustSignals & { participated: number }> {
  const since = new Date(now.getTime() - 180 * 86400_000);
  const [r] = await db<
    {
      kyc_level: number;
      created_at: Date;
      completed: number;
      completed_value: number | null;
      participated: number;
      cancellations: number;
      disputes_lost: number;
      delivered: number;
      on_time: number;
      trips_total: number;
      trips_verified: number;
      confirmed_fraud: number;
      block: number;
      hold: number;
      review: number;
      failed_payments: number;
      rating_sum: string | null;
      rating_weight: string | null;
    }[]
  >`
    SELECT u.kyc_level, u.created_at,
      (SELECT count(*) FROM transactions t WHERE (t.buyer_id = u.id OR t.traveler_id = u.id) AND t.status = 'COMPLETED')::int AS completed,
      (SELECT sum(t.total_idr) FROM transactions t WHERE (t.buyer_id = u.id OR t.traveler_id = u.id) AND t.status = 'COMPLETED')::bigint AS completed_value,
      (SELECT count(*) FROM transactions t WHERE (t.buyer_id = u.id OR t.traveler_id = u.id) AND t.traveler_id IS NOT NULL AND t.status <> 'REQUEST_CREATED')::int AS participated,
      (SELECT count(DISTINCT te.transaction_id) FROM transaction_events te
        WHERE te.actor_id = u.id AND te.actor_type IN ('BUYER','TRAVELER') AND te.to_status IN ('CANCELLED','REFUND_PENDING')
          AND te.from_status IS DISTINCT FROM 'DISPUTED'
          AND coalesce(te.meta->>'cause', '') <> 'PRICE_CHANGE_REJECTED'
          AND NOT (te.from_status = 'PRICE_CHANGE_PENDING' AND te.actor_type = 'BUYER'))::int AS cancellations,
      (SELECT count(*) FROM disputes d JOIN transactions t ON t.id = d.transaction_id
        WHERE d.resolution IS NOT NULL AND d.status IN ('RESOLVED','CLOSED')
          AND ((t.traveler_id = u.id AND d.resolution IN ('REFUND_FULL','REFUND_PARTIAL','RETURN_AND_REFUND'))
            OR (t.buyer_id = u.id AND d.opened_by = u.id AND d.resolution = 'NO_REFUND')))::int AS disputes_lost,
      (SELECT count(*) FROM transactions t WHERE t.traveler_id = u.id AND t.delivered_at IS NOT NULL)::int AS delivered,
      (SELECT count(*) FROM transactions t JOIN requests rq ON rq.id = t.request_id LEFT JOIN trips tr ON tr.id = t.trip_id
        WHERE t.traveler_id = u.id AND t.delivered_at IS NOT NULL
          AND (t.delivered_at AT TIME ZONE 'Asia/Jakarta')::date <= coalesce(rq.needed_by, tr.arrival_date + 7, (t.delivered_at AT TIME ZONE 'Asia/Jakarta')::date))::int AS on_time,
      (SELECT count(*) FROM trips tr WHERE tr.traveler_id = u.id)::int AS trips_total,
      (SELECT count(*) FROM trips tr WHERE tr.traveler_id = u.id AND tr.verified_at IS NOT NULL)::int AS trips_verified,
      (SELECT count(*) FROM risk_reviews rr WHERE rr.subject_type = 'USER' AND rr.subject_id = u.id AND rr.status = 'CONFIRMED_FRAUD')::int AS confirmed_fraud,
      (SELECT count(*) FROM risk_assessments ra WHERE ra.subject_type = 'USER' AND ra.subject_id = u.id AND ra.decision = 'BLOCK' AND ra.created_at > ${since})::int AS block,
      (SELECT count(*) FROM risk_assessments ra WHERE ra.subject_type = 'USER' AND ra.subject_id = u.id AND ra.decision = 'HOLD' AND ra.created_at > ${since})::int AS hold,
      (SELECT count(*) FROM risk_assessments ra WHERE ra.subject_type = 'USER' AND ra.subject_id = u.id AND ra.decision = 'REVIEW' AND ra.created_at > ${since})::int AS review,
      (SELECT count(*) FROM payments p JOIN transactions t ON t.id = p.transaction_id WHERE t.buyer_id = u.id AND p.status = 'FAILED')::int AS failed_payments,
      (SELECT sum(rt.overall * rt.weight) FROM ratings rt WHERE rt.ratee_id = u.id AND rt.status = 'PUBLISHED') AS rating_sum,
      (SELECT sum(rt.weight) FROM ratings rt WHERE rt.ratee_id = u.id AND rt.status = 'PUBLISHED') AS rating_weight
    FROM users u WHERE u.id = ${userId}`;
  if (!r) throw new Error(`user ${userId} not found`);
  const participated = r.participated;
  const denom = Math.max(1, participated);
  const maxSeverity: FraudSeverity = r.confirmed_fraud > 0 ? 'CRITICAL' : r.block > 0 ? 'HIGH' : r.hold > 0 ? 'MEDIUM' : r.review > 0 ? 'LOW' : 'NONE';
  const ratingWeight = Number(r.rating_weight ?? 0);
  return {
    kycLevel: r.kyc_level,
    completedTransactions: r.completed,
    totalCompletedValueIdr: Number(r.completed_value ?? 0),
    accountCreatedAt: r.created_at,
    cancellations: { count: r.cancellations, rate: Math.min(1, r.cancellations / denom) },
    disputesLost: { count: r.disputes_lost, rate: Math.min(1, r.disputes_lost / denom) },
    onTimeDeliveryRate: r.delivered > 0 ? r.on_time / r.delivered : null,
    verifiedTrips: r.trips_total > 0 ? r.trips_verified : null,
    fraudSignals: { count: r.confirmed_fraud + r.block + r.hold, maxSeverity },
    paymentHistory: { failedPayments: r.failed_payments, chargebacks: 0 },
    ratingAvg: ratingWeight > 0 ? Number(r.rating_sum) / ratingWeight : null,
    ratingCount: ratingWeight,
    participated,
  };
}

/** Level-5 (TRUSTED_TRAVELER) facts: completed as traveler and dispute rate on traveler transactions. */
export async function trustedTravelerFacts(db: Db, userId: string) {
  const [r] = await db<{ completed: number; base: number; disputed: number }[]>`
    SELECT (SELECT count(*) FROM transactions WHERE traveler_id = ${userId} AND status = 'COMPLETED')::int AS completed,
           (SELECT count(*) FROM transactions WHERE traveler_id = ${userId} AND (delivered_at IS NOT NULL OR status = 'COMPLETED'))::int AS base,
           (SELECT count(DISTINCT d.transaction_id) FROM disputes d JOIN transactions t ON t.id = d.transaction_id
             WHERE t.traveler_id = ${userId} AND NOT (d.status = 'CLOSED' AND d.resolution IS NULL))::int AS disputed`;
  const base = Math.max(1, r?.base ?? 0);
  return { completedAsTraveler: r?.completed ?? 0, disputeRate: (r?.disputed ?? 0) / base, disputedTransactions: r?.disputed ?? 0 };
}
