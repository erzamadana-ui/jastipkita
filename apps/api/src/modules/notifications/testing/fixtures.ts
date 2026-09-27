/**
 * Test fixtures for the engagement modules: trips, requests, offers, transactions (with a realistic
 * §10 quote breakdown) moved through the §4 state machine with transition_transaction(), devices with
 * push tokens. Uses t.adminSql (fixtures only) — the code under test runs as jk_app.
 */
import { randomBytes } from 'node:crypto';
import type { TestContext } from '../../../../test/helpers';

export interface TxFixture {
  id: string;
  number: string;
  buyerId: string;
  travelerId: string;
  tripId: string;
  requestId: string;
  offerId: string;
  quoteId: string;
  totalIdr: number;
}

/** Happy path from REQUEST_CREATED (actor per §4). */
export const HAPPY_PATH: [string, 'BUYER' | 'TRAVELER' | 'SYSTEM'][] = [
  ['MATCHED', 'BUYER'],
  ['AWAITING_PAYMENT', 'BUYER'],
  ['PAYMENT_SECURED', 'SYSTEM'],
  ['PURCHASE_APPROVED', 'TRAVELER'],
  ['PURCHASED', 'TRAVELER'],
  ['TRAVELING', 'TRAVELER'],
  ['ARRIVED', 'TRAVELER'],
  ['READY_FOR_HANDOVER', 'TRAVELER'],
  ['DELIVERED', 'TRAVELER'],
  ['BUYER_CONFIRMED', 'BUYER'],
  ['COMPLETED', 'SYSTEM'],
];

export function breakdown(itemIdr: number) {
  const lines: [string, string, string, number, string | null, boolean][] = [
    ['ITEM_PRICE', 'Harga Barang', 'Item Price', itemIdr, 'PRODUCT_FUND', false],
    ['TRAVELER_FEE', 'Traveler Fee', 'Traveler Fee', Math.round(itemIdr * 0.1), 'TRAVELER_EARNING', false],
    ['CUSTOMS_DUTY', 'Bea Masuk', 'Customs Duty', Math.round(itemIdr * 0.05), 'CUSTOMS_RESERVE', true],
    ['IMPORT_TAX', 'Pajak Impor', 'Import Tax', Math.round(itemIdr * 0.12), 'CUSTOMS_RESERVE', true],
    ['PROTECTION_FEE', 'JastipKita Protection', 'JastipKita Protection', Math.round(itemIdr * 0.015), 'PLATFORM_REVENUE', false],
    ['PLATFORM_FEE', 'Platform Fee', 'Platform Fee', Math.round(itemIdr * 0.05), 'PLATFORM_REVENUE', false],
    ['SERVICE_TAX', 'Pajak atas layanan', 'Service Tax', 7150, 'TAX_PAYABLE', false],
    ['PAYMENT_FEE', 'Biaya Pembayaran', 'Payment Fee', 4500, 'PAYMENT_FEE', false],
    ['DISCOUNT', 'Diskon promo', 'Promo discount', -25000, 'PROMOTION_CREDIT', false],
    ['REFERRAL_CREDIT', 'JastipKita Credit', 'JastipKita Credit', 0, 'PROMOTION_CREDIT', false],
  ];
  const total = lines.reduce((s, l) => s + l[3], 0);
  return { lines: [...lines, ['TOTAL', 'Total Landed Cost', 'Total Landed Cost', total, null, true] as (typeof lines)[number]], total };
}

export async function createTrip(t: TestContext, travelerId: string, opts: { verified?: boolean } = {}) {
  const [trip] = await t.adminSql<{ id: string }[]>`
    INSERT INTO trips (traveler_id, origin_country, origin_city, destination_country, destination_city, departure_date, arrival_date,
                       capacity_kg, fee_type, fee_value, verified_at)
    VALUES (${travelerId}, 'JP', 'Tokyo', 'ID', 'Jakarta', current_date + 3, current_date + 4, 10, 'FIXED', 100000,
            ${opts.verified ? new Date() : null})
    RETURNING id`;
  return trip!.id;
}

export async function createTransaction(
  t: TestContext,
  opts: { buyerId: string; travelerId: string; to?: string; itemIdr?: number; productName?: string; tripId?: string },
): Promise<TxFixture> {
  const itemIdr = opts.itemIdr ?? 1_000_000;
  const tripId = opts.tripId ?? (await createTrip(t, opts.travelerId));
  const [req] = await t.adminSql<{ id: string }[]>`
    INSERT INTO requests (buyer_id, source_type, product_name, merchant_country, quantity, status)
    VALUES (${opts.buyerId}, 'MANUAL', ${opts.productName ?? 'Nintendo Switch OLED'}, 'JP', 1, 'MATCHED') RETURNING id`;
  const [offer] = await t.adminSql<{ id: string }[]>`
    INSERT INTO offers (request_id, trip_id, traveler_id, initiated_by, traveler_fee_idr, status, responded_at)
    VALUES (${req!.id}, ${tripId}, ${opts.travelerId}, 'TRAVELER', ${Math.round(itemIdr * 0.1)}, 'ACCEPTED', now()) RETURNING id`;
  const { lines, total } = breakdown(itemIdr);
  const out = await t.adminSql.begin(async (tx) => {
    const [row] = await tx<{ id: string; number: string }[]>`
      INSERT INTO transactions (request_id, trip_id, offer_id, buyer_id, traveler_id, total_idr, quantity, delivery_method, item_currency)
      VALUES (${req!.id}, ${tripId}, ${offer!.id}, ${opts.buyerId}, ${opts.travelerId}, ${total}, 1, 'MEETUP', 'JPY')
      RETURNING id, number`;
    const [q] = await tx<{ id: string }[]>`
      INSERT INTO quotes (transaction_id, total_idr, expires_at) VALUES (${row!.id}, ${total}, now() + interval '30 minutes') RETURNING id`;
    let sort = 1;
    for (const [type, id, en, amount, bucket, est] of lines) {
      await tx`INSERT INTO quote_lines (quote_id, line_type, label_id, label_en, amount_idr, bucket, is_estimate, sort)
               VALUES (${q!.id}, ${type}, ${id}, ${en}, ${amount}, ${bucket}, ${est}, ${sort++})`;
    }
    await tx`UPDATE transactions SET active_quote_id = ${q!.id} WHERE id = ${row!.id}`;
    return { id: row!.id, number: row!.number, quoteId: q!.id };
  });
  const fx: TxFixture = { ...out, buyerId: opts.buyerId, travelerId: opts.travelerId, tripId, requestId: req!.id, offerId: offer!.id, totalIdr: total };
  if (opts.to) await advance(t, fx.id, opts.to);
  return fx;
}

/** Moves a transaction along HAPPY_PATH until it reaches `to` (CANCELLED: from MATCHED by BUYER). */
export async function advance(t: TestContext, txId: string, to: string): Promise<void> {
  const [cur] = await t.adminSql<{ status: string; buyer_id: string; traveler_id: string }[]>`SELECT status, buyer_id, traveler_id FROM transactions WHERE id = ${txId}`;
  let status = cur!.status;
  if (to === 'CANCELLED') {
    if (status === 'REQUEST_CREATED') await transition(t, txId, 'MATCHED', 'BUYER');
    await transition(t, txId, 'CANCELLED', 'BUYER', 'buyer changed mind');
    return;
  }
  const idx = HAPPY_PATH.findIndex(([s]) => s === to);
  if (idx < 0) throw new Error(`fixture cannot reach ${to}`);
  const start = status === 'REQUEST_CREATED' ? 0 : HAPPY_PATH.findIndex(([s]) => s === status) + 1;
  for (let i = start; i <= idx; i++) {
    const [s, actor] = HAPPY_PATH[i]!;
    if (s === 'AWAITING_PAYMENT') await t.adminSql`UPDATE quotes SET status = 'ACCEPTED', accepted_at = now() WHERE transaction_id = ${txId} AND status = 'ACTIVE'`;
    await transition(t, txId, s, actor);
    status = s;
  }
  void cur;
}

export async function transition(t: TestContext, txId: string, to: string, actor: 'BUYER' | 'TRAVELER' | 'SYSTEM' | 'ADMIN', reason: string | null = null, meta: Record<string, unknown> = {}) {
  const [cur] = await t.adminSql<{ version: number; buyer_id: string; traveler_id: string }[]>`SELECT version, buyer_id, traveler_id FROM transactions WHERE id = ${txId}`;
  const actorId = actor === 'BUYER' ? cur!.buyer_id : actor === 'TRAVELER' ? cur!.traveler_id : null;
  await t.adminSql`SELECT transition_transaction(${txId}, ${cur!.version}, ${to}, ${actor}, ${actorId}, ${reason}, ${t.adminSql.json(meta as never)})`;
}

export async function addDevice(t: TestContext, userId: string, pushToken: string | null = `fcm-${randomBytes(6).toString('hex')}`) {
  const [d] = await t.adminSql<{ id: string }[]>`
    INSERT INTO devices (fingerprint_hash, platform, push_token) VALUES (${randomBytes(32)}, 'ANDROID', ${pushToken}) RETURNING id`;
  await t.adminSql`INSERT INTO user_devices (user_id, device_id) VALUES (${userId}, ${d!.id})`;
  return d!.id;
}

/** Links an existing device to another user (shared-device fraud scenario). */
export async function shareDevice(t: TestContext, deviceId: string, userId: string) {
  await t.adminSql`INSERT INTO user_devices (user_id, device_id) VALUES (${userId}, ${deviceId}) ON CONFLICT DO NOTHING`;
}

export async function outboxEvents(t: TestContext, eventType: string, aggregateId?: string) {
  return t.adminSql<{ event_id: string; payload: Record<string, unknown>; published_at: Date | null }[]>`
    SELECT event_id, payload, published_at FROM outbox_events
     WHERE event_type = ${eventType} ${aggregateId ? t.adminSql`AND aggregate_id = ${aggregateId}` : t.adminSql``}
     ORDER BY id`;
}
