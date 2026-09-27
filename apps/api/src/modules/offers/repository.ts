import type { Db, TxSql } from '../../db/sql';

export type OfferStatus = 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'WITHDRAWN' | 'EXPIRED';

export interface OfferRow {
  id: string;
  request_id: string;
  trip_id: string;
  traveler_id: string;
  initiated_by: 'TRAVELER' | 'BUYER';
  traveler_fee_idr: number;
  message: string | null;
  status: OfferStatus;
  expires_at: Date | null;
  responded_at: Date | null;
  decline_reason: string | null;
  created_at: Date;
  updated_at: Date;
  buyer_id: string;
  transaction_id: string | null;
}

const offerCols = (db: Db) => db`
  o.id, o.request_id, o.trip_id, o.traveler_id, o.initiated_by, o.traveler_fee_idr, o.message, o.status, o.expires_at,
  o.responded_at, o.decline_reason, o.created_at, o.updated_at, r.buyer_id,
  (SELECT x.id FROM transactions x WHERE x.offer_id = o.id ORDER BY x.created_at DESC LIMIT 1) AS transaction_id`;

export async function getOffer(db: Db, id: string, opts: { forUpdate?: boolean } = {}): Promise<OfferRow | null> {
  const [row] = opts.forUpdate
    ? await db<OfferRow[]>`SELECT ${offerCols(db)} FROM offers o JOIN requests r ON r.id = o.request_id WHERE o.id = ${id} FOR UPDATE OF o`
    : await db<OfferRow[]>`SELECT ${offerCols(db)} FROM offers o JOIN requests r ON r.id = o.request_id WHERE o.id = ${id}`;
  return row ?? null;
}

export async function insertOffer(
  db: Db,
  o: { requestId: string; tripId: string; travelerId: string; initiatedBy: 'TRAVELER' | 'BUYER'; travelerFeeIdr: number; message: string | null; expiresAt: Date },
): Promise<string> {
  const [row] = await db<{ id: string }[]>`
    INSERT INTO offers (request_id, trip_id, traveler_id, initiated_by, traveler_fee_idr, message, expires_at)
    VALUES (${o.requestId}, ${o.tripId}, ${o.travelerId}, ${o.initiatedBy}, ${o.travelerFeeIdr}, ${o.message}, ${o.expiresAt})
    RETURNING id`;
  return row!.id;
}

export async function listForRequest(db: Db, requestId: string, travelerId: string | null): Promise<OfferRow[]> {
  return db<OfferRow[]>`
    SELECT ${offerCols(db)} FROM offers o JOIN requests r ON r.id = o.request_id
     WHERE o.request_id = ${requestId} ${travelerId ? db`AND o.traveler_id = ${travelerId}` : db``}
     ORDER BY o.created_at DESC, o.id DESC`;
}

export async function listMine(
  db: Db,
  userId: string,
  q: { role: 'traveler' | 'buyer' | undefined; status?: OfferStatus | undefined; limit: number; cursor: { t: string; id: string } | null },
): Promise<OfferRow[]> {
  return db<OfferRow[]>`
    SELECT ${offerCols(db)} FROM offers o JOIN requests r ON r.id = o.request_id
     WHERE ${q.role === 'traveler' ? db`o.traveler_id = ${userId}` : q.role === 'buyer' ? db`r.buyer_id = ${userId}` : db`(o.traveler_id = ${userId} OR r.buyer_id = ${userId})`}
       ${q.status ? db`AND o.status = ${q.status}` : db``}
       ${q.cursor ? db`AND (o.created_at, o.id) < (${q.cursor.t}::timestamptz, ${q.cursor.id}::uuid)` : db``}
     ORDER BY o.created_at DESC, o.id DESC LIMIT ${q.limit + 1}`;
}

export async function setOfferStatus(db: Db, id: string, status: OfferStatus, now: Date, reason: string | null = null): Promise<void> {
  await db`UPDATE offers SET status = ${status}, responded_at = ${now}, decline_reason = ${reason} WHERE id = ${id}`;
}

export interface NewTransaction {
  number: string;
  requestId: string;
  tripId: string;
  offerId: string;
  buyerId: string;
  travelerId: string;
  itemCurrency: string | null;
  quantity: number;
  deliveryMethod: 'MEETUP' | 'COURIER' | 'PARTNER_LOGISTICS' | null;
}

/** Inserts inside a SAVEPOINT so a number collision (23505) can be retried in the same transaction. */
export async function insertTransaction(db: TxSql, t: NewTransaction): Promise<{ id: string; number: string; version: number }> {
  const rows = (await db.savepoint(
    (sp) => sp<{ id: string; number: string; version: number }[]>`
      INSERT INTO transactions (number, request_id, trip_id, offer_id, buyer_id, traveler_id, item_currency, quantity, delivery_method)
      VALUES (${t.number}, ${t.requestId}, ${t.tripId}, ${t.offerId}, ${t.buyerId}, ${t.travelerId}, ${t.itemCurrency}, ${t.quantity}, ${t.deliveryMethod})
      RETURNING id, number, version`,
  )) as unknown as { id: string; number: string; version: number }[];
  return rows[0]!;
}

export async function hasPendingOffer(db: Db, requestId: string, tripId: string): Promise<boolean> {
  const [row] = await db<{ ok: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM offers WHERE request_id = ${requestId} AND trip_id = ${tripId} AND status = 'PENDING') AS ok`;
  return row?.ok === true;
}
