/**
 * Closing pending offers in bulk (trip cancelled/departed, request cancelled/expired, another offer
 * accepted, expiry job) + the matching outbox events. Runs inside the caller's DB transaction.
 */
import type { Db } from '../../db/sql';
import { emitEvent } from '../../services/outbox';

export type OfferCloseStatus = 'DECLINED' | 'WITHDRAWN' | 'EXPIRED';

export interface ClosedOffer {
  id: string;
  request_id: string;
  trip_id: string;
  traveler_id: string;
  initiated_by: 'TRAVELER' | 'BUYER';
  buyer_id: string;
}

const EVENT: Record<OfferCloseStatus, string> = {
  DECLINED: 'offer.declined',
  WITHDRAWN: 'offer.withdrawn',
  EXPIRED: 'offer.expired',
};

export function offerEventPayload(
  o: Pick<ClosedOffer, 'id' | 'request_id' | 'trip_id' | 'traveler_id' | 'initiated_by' | 'buyer_id'>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    offerId: o.id,
    requestId: o.request_id,
    tripId: o.trip_id,
    buyerId: o.buyer_id,
    travelerId: o.traveler_id,
    initiatedBy: o.initiated_by,
    ...extra,
  };
}

export async function closePendingOffers(
  db: Db,
  filter: { tripId?: string; requestId?: string; offerIds?: string[]; excludeOfferId?: string; expiresBefore?: Date },
  status: OfferCloseStatus,
  reason: string,
  now: Date,
): Promise<ClosedOffer[]> {
  if (filter.offerIds && filter.offerIds.length === 0) return [];
  const rows = await db<ClosedOffer[]>`
    UPDATE offers o
       SET status = ${status}, responded_at = ${now}, decline_reason = ${reason}
      FROM requests r
     WHERE r.id = o.request_id
       AND o.status = 'PENDING'
       ${filter.tripId ? db`AND o.trip_id = ${filter.tripId}` : db``}
       ${filter.requestId ? db`AND o.request_id = ${filter.requestId}` : db``}
       ${filter.offerIds ? db`AND o.id IN ${db(filter.offerIds)}` : db``}
       ${filter.excludeOfferId ? db`AND o.id <> ${filter.excludeOfferId}` : db``}
       ${filter.expiresBefore ? db`AND o.expires_at <= ${filter.expiresBefore}` : db``}
    RETURNING o.id, o.request_id, o.trip_id, o.traveler_id, o.initiated_by, r.buyer_id`;
  for (const o of rows) {
    await emitEvent(db, 'offer', o.id, EVENT[status], offerEventPayload(o, { status, reason }));
  }
  return rows;
}
