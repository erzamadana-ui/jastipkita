import type { Db } from '../../db/sql';

export type RequestStatus = 'DRAFT' | 'OPEN' | 'MATCHED' | 'CLOSED' | 'CANCELLED' | 'EXPIRED';
export type RestrictionClass = 'ALLOWED' | 'RESTRICTED' | 'DECLARATION_REQUIRED' | 'PERMIT_REQUIRED' | 'PROHIBITED';

export interface RequestRow {
  id: string;
  buyer_id: string;
  source_type: 'URL' | 'PHOTO' | 'SEARCH' | 'MANUAL';
  product_url: string | null;
  product_name: string;
  merchant_name: string | null;
  merchant_country: string | null;
  category_code: string | null;
  hs_code: string | null;
  quantity: number;
  variant: string | null;
  unit_price_minor: number | null;
  price_currency: string | null;
  est_weight_kg: string | null;
  notes: string | null;
  max_budget_idr: number | null;
  needed_by: string | null;
  destination_country: string;
  destination_city: string | null;
  delivery_preference: 'MEETUP' | 'COURIER' | 'PARTNER_LOGISTICS' | 'ANY' | null;
  restriction_class: RestrictionClass | null;
  restriction_rule_ref: string | null;
  restriction_ack_at: Date | null;
  extraction: Record<string, unknown>;
  status: RequestStatus;
  published_at: Date | null;
  expires_at: Date | null;
  closed_at: Date | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

export const requestCols = (db: Db) => db`
  r.id, r.buyer_id, r.source_type, r.product_url, r.product_name, r.merchant_name, r.merchant_country, r.category_code, r.hs_code,
  r.quantity, r.variant, r.unit_price_minor, r.price_currency, r.est_weight_kg::text AS est_weight_kg, r.notes, r.max_budget_idr,
  r.needed_by::text AS needed_by, r.destination_country, r.destination_city, r.delivery_preference, r.restriction_class,
  r.restriction_rule_ref, r.restriction_ack_at, r.extraction, r.status, r.published_at, r.expires_at, r.closed_at, r.version,
  r.created_at, r.updated_at`;

export async function getRequest(db: Db, id: string, opts: { forUpdate?: boolean } = {}): Promise<RequestRow | null> {
  const [row] = opts.forUpdate
    ? await db<RequestRow[]>`SELECT ${requestCols(db)} FROM requests r WHERE r.id = ${id} FOR UPDATE`
    : await db<RequestRow[]>`SELECT ${requestCols(db)} FROM requests r WHERE r.id = ${id}`;
  return row ?? null;
}

export interface RequestValues {
  sourceType: RequestRow['source_type'];
  productUrl: string | null;
  productName: string;
  merchantName: string | null;
  merchantCountry: string;
  categoryCode: string;
  hsCode: string | null;
  quantity: number;
  variant: string | null;
  unitPriceMinor: number;
  priceCurrency: string;
  estWeightKg: number | null;
  notes: string | null;
  maxBudgetIdr: number | null;
  neededBy: string | null;
  destinationCountry: string;
  destinationCity: string | null;
  deliveryPreference: RequestRow['delivery_preference'];
  restrictionClass: RestrictionClass;
  restrictionRuleRef: string | null;
  restrictionAckAt: Date | null;
  extraction: Record<string, unknown>;
  status: 'DRAFT' | 'OPEN';
  publishedAt: Date | null;
  expiresAt: Date | null;
}

export async function insertRequest(db: Db, buyerId: string, v: RequestValues): Promise<string> {
  const [row] = await db<{ id: string }[]>`
    INSERT INTO requests (buyer_id, source_type, product_url, product_name, merchant_name, merchant_country, category_code, hs_code,
                          quantity, variant, unit_price_minor, price_currency, est_weight_kg, notes, max_budget_idr, needed_by,
                          destination_country, destination_city, delivery_preference, restriction_class, restriction_rule_ref,
                          restriction_ack_at, extraction, status, published_at, expires_at)
    VALUES (${buyerId}, ${v.sourceType}, ${v.productUrl}, ${v.productName}, ${v.merchantName}, ${v.merchantCountry}, ${v.categoryCode},
            ${v.hsCode}, ${v.quantity}, ${v.variant}, ${v.unitPriceMinor}, ${v.priceCurrency}, ${v.estWeightKg}, ${v.notes},
            ${v.maxBudgetIdr}, ${v.neededBy}::date, ${v.destinationCountry}, ${v.destinationCity}, ${v.deliveryPreference},
            ${v.restrictionClass}, ${v.restrictionRuleRef}, ${v.restrictionAckAt}, ${db.json(v.extraction as never)}, ${v.status},
            ${v.publishedAt}, ${v.expiresAt})
    RETURNING id`;
  return row!.id;
}

export async function updateRequest(db: Db, id: string, v: RequestValues): Promise<void> {
  await db`
    UPDATE requests SET
      product_url = ${v.productUrl}, product_name = ${v.productName}, merchant_name = ${v.merchantName},
      merchant_country = ${v.merchantCountry}, category_code = ${v.categoryCode}, hs_code = ${v.hsCode}, quantity = ${v.quantity},
      variant = ${v.variant}, unit_price_minor = ${v.unitPriceMinor}, price_currency = ${v.priceCurrency},
      est_weight_kg = ${v.estWeightKg}, notes = ${v.notes}, max_budget_idr = ${v.maxBudgetIdr}, needed_by = ${v.neededBy}::date,
      destination_country = ${v.destinationCountry}, destination_city = ${v.destinationCity},
      delivery_preference = ${v.deliveryPreference}, restriction_class = ${v.restrictionClass},
      restriction_rule_ref = ${v.restrictionRuleRef}, restriction_ack_at = ${v.restrictionAckAt}, status = ${v.status},
      published_at = ${v.publishedAt}, expires_at = ${v.expiresAt}, version = version + 1
    WHERE id = ${id}`;
}

export async function setStatus(db: Db, id: string, status: RequestStatus, now: Date): Promise<void> {
  await db`
    UPDATE requests SET status = ${status}, version = version + 1,
           closed_at = CASE WHEN ${status} IN ('CLOSED','CANCELLED','EXPIRED') THEN ${now}::timestamptz ELSE NULL END
     WHERE id = ${id}`;
}

export interface ImageRow {
  id: string;
  file_id: string | null;
  source_url: string | null;
  sort: number;
}

export async function listImages(db: Db, requestIds: string[]): Promise<Map<string, ImageRow[]>> {
  const out = new Map<string, ImageRow[]>();
  if (requestIds.length === 0) return out;
  const rows = await db<(ImageRow & { request_id: string })[]>`
    SELECT id, request_id, file_id, source_url, sort FROM request_images WHERE request_id IN ${db(requestIds)} ORDER BY request_id, sort`;
  for (const r of rows) out.set(r.request_id, [...(out.get(r.request_id) ?? []), r]);
  return out;
}

export async function replaceImages(db: Db, requestId: string, images: { fileId: string | null; sourceUrl: string | null }[]): Promise<void> {
  await db`DELETE FROM request_images WHERE request_id = ${requestId}`;
  let sort = 0;
  for (const img of images) {
    await db`INSERT INTO request_images (request_id, file_id, source_url, sort) VALUES (${requestId}, ${img.fileId}, ${img.sourceUrl}, ${sort++})`;
  }
}

export async function pendingOfferCount(db: Db, requestIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (requestIds.length === 0) return out;
  const rows = await db<{ request_id: string; n: number }[]>`
    SELECT request_id, count(*)::int AS n FROM offers WHERE request_id IN ${db(requestIds)} AND status = 'PENDING' GROUP BY request_id`;
  for (const r of rows) out.set(r.request_id, r.n);
  return out;
}

export async function categoryDefaults(db: Db, codes: string[]): Promise<Map<string, { weightKg: number | null; risk: 'LOW' | 'MEDIUM' | 'HIGH' }>> {
  const out = new Map<string, { weightKg: number | null; risk: 'LOW' | 'MEDIUM' | 'HIGH' }>();
  const uniq = [...new Set(codes.filter(Boolean))];
  if (uniq.length === 0) return out;
  const rows = await db<{ code: string; default_weight_kg: string | null; risk_level: 'LOW' | 'MEDIUM' | 'HIGH' }[]>`
    SELECT code, default_weight_kg::text AS default_weight_kg, risk_level FROM product_categories WHERE code IN ${db(uniq)}`;
  for (const r of rows) out.set(r.code, { weightKg: r.default_weight_kg === null ? null : Number(r.default_weight_kg), risk: r.risk_level });
  return out;
}
