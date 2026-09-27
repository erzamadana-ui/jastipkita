import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../../../test/helpers';
import { expireOffers } from '../../jobs/marketplace';
import { createActiveTrip, createOpenRequest, day, freshToken, outboxEvents } from '../trips/fixtures';

const NOW = new Date('2026-10-05T03:00:00Z'); // WIB date 2026-10-05 → numbers JK-261005-XXXXXX
const TX_NUMBER = /^JK-261005-[0-9A-HJKMNP-TV-Z]{6}$/;
let t: TestContext;
beforeAll(async () => {
  t = await createTestContext({ now: NOW });
});
afterAll(async () => {
  await t.close();
});

async function scenario(tripOverrides: Record<string, unknown> = {}, requestOverrides: Record<string, unknown> = {}) {
  const buyer = await t.createUser({ kycLevel: 2, displayName: 'Rina Susanti' });
  const traveler = await t.createUser({ kycLevel: 3, mode: 'TRAVELER', displayName: 'Budi Santoso' });
  const trip = await createActiveTrip(t, traveler, tripOverrides);
  const request = await createOpenRequest(t, buyer, requestOverrides);
  return { buyer, traveler, trip, request };
}

describe('POST /v1/requests/{id}/offers (traveler)', () => {
  it('KYC ≥ 3, own ACTIVE trip, same route, not own request', async () => {
    const { buyer, traveler, trip, request } = await scenario();
    const k2 = await t.createUser({ kycLevel: 2 });
    const r1 = await t.request('POST', `/v1/requests/${request.id}/offers`, { token: k2.accessToken, body: { tripId: trip.id } });
    expect([r1.status, r1.body.error.code]).toEqual([403, 'KYC_LEVEL_REQUIRED']);
    const other = await t.createUser({ kycLevel: 3 });
    const r2 = await t.request('POST', `/v1/requests/${request.id}/offers`, { token: other.accessToken, body: { tripId: trip.id } });
    expect([r2.status, r2.body.error.code]).toEqual([404, 'TRIP_NOT_FOUND']);
    const krTrip = await createActiveTrip(t, traveler, { originCountry: 'KR', originCity: 'Seoul' });
    const r3 = await t.request('POST', `/v1/requests/${request.id}/offers`, { token: traveler.accessToken, body: { tripId: krTrip.id } });
    expect([r3.status, r3.body.error.code]).toEqual([422, 'ROUTE_MISMATCH']);
    // buyer who is also a traveler cannot serve their own request
    await t.adminSql`UPDATE users SET kyc_level = 3 WHERE id = ${buyer.id}`;
    const ownTrip = await createActiveTrip(t, buyer);
    const r4 = await t.request('POST', `/v1/requests/${request.id}/offers`, { token: await freshToken(t, buyer), body: { tripId: ownTrip.id } });
    expect([r4.status, r4.body.error.code]).toEqual([422, 'SELF_OFFER']);
  });

  it('fee must be within pricing.traveler_fee_bounds; default fee from trip spec; one pending offer per trip', async () => {
    const { traveler, trip, request } = await scenario();
    const low = await t.request('POST', `/v1/requests/${request.id}/offers`, { token: traveler.accessToken, body: { tripId: trip.id, travelerFeeIdr: 10_000 } });
    expect(low.status).toBe(422);
    expect(low.body.error).toMatchObject({ code: 'FEE_OUT_OF_BOUNDS', details: { minIdr: 25_000 } });
    const high = await t.request('POST', `/v1/requests/${request.id}/offers`, { token: traveler.accessToken, body: { tripId: trip.id, travelerFeeIdr: 5_000_000 } });
    expect(high.body.error.code).toBe('FEE_OUT_OF_BOUNDS');

    const ok = await t.request('POST', `/v1/requests/${request.id}/offers`, { token: traveler.accessToken, body: { tripId: trip.id, message: 'Siap bantu, beli di Ginza' } });
    expect(ok.status).toBe(201);
    // 10% of ≈Rp680k = 68k → within bounds (min 25k)
    expect(ok.body).toMatchObject({ status: 'PENDING', initiatedBy: 'TRAVELER', traveler: { displayName: 'Budi S.' }, allowedActions: ['WITHDRAW'] });
    expect(ok.body.travelerFeeIdr).toBeGreaterThan(60_000);
    // public profile carries the Trust Score and its tier (contract fix: consistent everywhere)
    expect(ok.body.traveler).toMatchObject({ trustScore: expect.any(Number), trustTier: { tier: expect.stringMatching(/^(EXCELLENT|GOOD|FAIR|LOW)$/) }, kycLevel: expect.any(Number) });
    expect(new Date(ok.body.expiresAt).getTime() - NOW.getTime()).toBe(48 * 3_600_000);
    const ev = await outboxEvents(t, 'offer.created', ok.body.id);
    expect(ev[0]!.payload).toMatchObject({ offerId: ok.body.id, requestId: request.id, tripId: trip.id, travelerId: traveler.id, initiatedBy: 'TRAVELER' });

    const dup = await t.request('POST', `/v1/requests/${request.id}/offers`, { token: traveler.accessToken, body: { tripId: trip.id } });
    expect([dup.status, dup.body.error.code]).toEqual([409, 'OFFER_ALREADY_PENDING']);
  });

  it('refuses when the trip lacks capacity or arrives after needed_by', async () => {
    const { traveler, trip, request } = await scenario({ capacityKg: 0.5 }, { estWeightKg: 0.4, quantity: 2 });
    const res = await t.request('POST', `/v1/requests/${request.id}/offers`, { token: traveler.accessToken, body: { tripId: trip.id } });
    expect([res.status, res.body.error.code]).toEqual([422, 'CAPACITY_INSUFFICIENT']);
    const late = await scenario({ departureDate: day(t, 20), arrivalDate: day(t, 21) }, { neededBy: day(t, 20) });
    const r2 = await t.request('POST', `/v1/requests/${late.request.id}/offers`, { token: late.traveler.accessToken, body: { tripId: late.trip.id } });
    expect([r2.status, r2.body.error.code]).toEqual([422, 'ARRIVES_TOO_LATE']);
  });
});

describe('accept', () => {
  it('buyer accepts a traveler offer → MATCHED transaction, capacity reserved, other offers declined, events', async () => {
    const { buyer, traveler, trip, request } = await scenario();
    const t2 = await t.createUser({ kycLevel: 3 });
    const trip2 = await createActiveTrip(t, t2);
    const o1 = await t.request('POST', `/v1/requests/${request.id}/offers`, { token: traveler.accessToken, body: { tripId: trip.id } });
    const o2 = await t.request('POST', `/v1/requests/${request.id}/offers`, { token: t2.accessToken, body: { tripId: trip2.id } });
    expect([o1.status, o2.status]).toEqual([201, 201]);

    const byTraveler = await t.request('POST', `/v1/offers/${o1.body.id}/accept`, { token: traveler.accessToken });
    expect([byTraveler.status, byTraveler.body.error.code]).toEqual([403, 'NOT_COUNTERPARTY']);
    const stranger = await t.createUser({ kycLevel: 3 });
    expect((await t.request('POST', `/v1/offers/${o1.body.id}/accept`, { token: stranger.accessToken })).status).toBe(404);

    const list = await t.request('GET', `/v1/requests/${request.id}/offers`, { token: buyer.accessToken });
    expect(list.body.data).toHaveLength(2);
    expect(list.body.data[0].allowedActions).toEqual(['ACCEPT', 'DECLINE']);

    const res = await t.request('POST', `/v1/offers/${o1.body.id}/accept`, { token: buyer.accessToken });
    expect(res.status).toBe(200);
    const tx = res.body.transaction;
    expect(tx.number).toMatch(TX_NUMBER);
    expect(tx).toMatchObject({ status: 'MATCHED', version: 2, buyerId: buyer.id, travelerId: traveler.id, tripId: trip.id, requestId: request.id, offerId: o1.body.id });
    expect(res.body.offer).toMatchObject({ status: 'ACCEPTED', transactionId: tx.id });

    const [row] = await t.adminSql<{ status: string; number: string; item_currency: string; quantity: number }[]>`
      SELECT status, number, item_currency, quantity FROM transactions WHERE id = ${tx.id}`;
    expect(row).toMatchObject({ status: 'MATCHED', number: tx.number, item_currency: 'JPY', quantity: 2 });
    const events = await t.adminSql<{ from_status: string | null; to_status: string; actor_type: string; actor_id: string; version: number }[]>`
      SELECT from_status, to_status, actor_type, actor_id, version FROM transaction_events WHERE transaction_id = ${tx.id} ORDER BY id`;
    expect(events).toEqual([
      { from_status: null, to_status: 'REQUEST_CREATED', actor_type: 'BUYER', actor_id: buyer.id, version: 1 },
      { from_status: 'REQUEST_CREATED', to_status: 'MATCHED', actor_type: 'BUYER', actor_id: buyer.id, version: 2 },
    ]);

    // capacity: 2 × 0.3 kg reserved (ledger row + running total)
    const [tr] = await t.adminSql<{ reserved_kg: string; reserved_items: number; status: string }[]>`SELECT reserved_kg::text, reserved_items, status FROM trips WHERE id = ${trip.id}`;
    expect(tr).toMatchObject({ reserved_kg: '0.60', reserved_items: 2, status: 'ACTIVE' });
    const [resv] = await t.adminSql<{ kg: string; released_at: Date | null }[]>`SELECT kg::text, released_at FROM trip_capacity_reservations WHERE transaction_id = ${tx.id}`;
    expect(resv).toMatchObject({ kg: '0.60', released_at: null });

    const [req] = await t.adminSql<{ status: string }[]>`SELECT status FROM requests WHERE id = ${request.id}`;
    expect(req!.status).toBe('MATCHED');
    const [other] = await t.adminSql<{ status: string; decline_reason: string }[]>`SELECT status, decline_reason FROM offers WHERE id = ${o2.body.id}`;
    expect(other).toMatchObject({ status: 'DECLINED', decline_reason: 'OTHER_OFFER_ACCEPTED' });

    const accepted = await outboxEvents(t, 'offer.accepted', o1.body.id);
    expect(accepted[0]!.payload).toMatchObject({ offerId: o1.body.id, transactionId: tx.id, transactionNumber: tx.number, buyerId: buyer.id, travelerId: traveler.id, acceptedBy: 'BUYER' });
    expect(await outboxEvents(t, 'offer.declined', o2.body.id)).toHaveLength(1);
    const changed = await outboxEvents(t, 'transaction.status_changed', tx.id);
    expect(changed.map((e) => e.payload.to)).toEqual(['MATCHED']);

    const again = await t.request('POST', `/v1/offers/${o1.body.id}/accept`, { token: buyer.accessToken });
    expect([again.status, again.body.error.code]).toEqual([409, 'OFFER_ALREADY_ACCEPTED']);
    const mine = await t.request('GET', '/v1/offers/mine?role=traveler', { token: traveler.accessToken });
    expect(mine.body.data[0]).toMatchObject({ id: o1.body.id, status: 'ACCEPTED', transactionId: tx.id });
  });

  it('buyer invite → traveler (K3) accepts; capacity exhausted → trip FULL; cancellation releases → ACTIVE and request re-opens', async () => {
    const { buyer, traveler, trip, request } = await scenario({ capacityKg: 0.6 }, { estWeightKg: 0.3, quantity: 2 });
    const inv = await t.request('POST', `/v1/trips/${trip.id}/invites`, { token: buyer.accessToken, body: { requestId: request.id, message: 'Bisa bantu?' } });
    expect(inv.status).toBe(201);
    expect(inv.body).toMatchObject({ initiatedBy: 'BUYER', status: 'PENDING', allowedActions: ['WITHDRAW'] });
    const byBuyer = await t.request('POST', `/v1/offers/${inv.body.id}/accept`, { token: buyer.accessToken });
    expect(byBuyer.body.error.code).toBe('NOT_COUNTERPARTY');

    const res = await t.request('POST', `/v1/offers/${inv.body.id}/accept`, { token: traveler.accessToken });
    expect(res.status).toBe(200);
    expect(res.body.transaction.number).toMatch(TX_NUMBER);
    const [ev] = await t.adminSql<{ actor_type: string }[]>`SELECT actor_type FROM transaction_events WHERE transaction_id = ${res.body.transaction.id} AND to_status = 'MATCHED'`;
    expect(ev!.actor_type).toBe('TRAVELER');
    let [tr] = await t.adminSql<{ status: string; reserved_kg: string }[]>`SELECT status, reserved_kg::text FROM trips WHERE id = ${trip.id}`;
    expect(tr).toMatchObject({ status: 'FULL', reserved_kg: '0.60' });
    const [full] = await t.adminSql<{ actor_type: string }[]>`SELECT actor_type FROM trip_events WHERE trip_id = ${trip.id} AND to_status = 'FULL'`;
    expect(full!.actor_type).toBe('SYSTEM');

    // money group cancels the transaction (MATCHED → CANCELLED); our outbox consumer releases capacity
    await t.sql`SELECT id FROM transition_transaction(${res.body.transaction.id}, 2, 'CANCELLED', 'BUYER', ${buyer.id}, 'changed mind', '{}'::jsonb)`;
    await t.drain();
    [tr] = await t.adminSql<{ status: string; reserved_kg: string }[]>`SELECT status, reserved_kg::text FROM trips WHERE id = ${trip.id}`;
    expect(tr).toMatchObject({ status: 'ACTIVE', reserved_kg: '0.00' });
    const [resv] = await t.adminSql<{ released_at: Date | null; release_reason: string }[]>`SELECT released_at, release_reason FROM trip_capacity_reservations WHERE transaction_id = ${res.body.transaction.id}`;
    expect(resv!.released_at).not.toBeNull();
    const [req] = await t.adminSql<{ status: string }[]>`SELECT status FROM requests WHERE id = ${request.id}`;
    expect(req!.status).toBe('OPEN');
    expect(await outboxEvents(t, 'request.reopened', request.id)).toHaveLength(1);
    // replaying the event is harmless (idempotent release)
    await t.adminSql`UPDATE outbox_events SET published_at = NULL WHERE event_type = 'transaction.status_changed' AND aggregate_id = ${res.body.transaction.id}`;
    await t.drain();
    [tr] = await t.adminSql<{ status: string; reserved_kg: string }[]>`SELECT status, reserved_kg::text FROM trips WHERE id = ${trip.id}`;
    expect(tr!.reserved_kg).toBe('0.00');
  });

  it('decline / withdraw permissions and expiry', async () => {
    const { buyer, traveler, trip, request } = await scenario();
    const o = await t.request('POST', `/v1/requests/${request.id}/offers`, { token: traveler.accessToken, body: { tripId: trip.id } });
    expect((await t.request('POST', `/v1/offers/${o.body.id}/decline`, { token: traveler.accessToken })).body.error.code).toBe('NOT_COUNTERPARTY');
    expect((await t.request('POST', `/v1/offers/${o.body.id}/withdraw`, { token: buyer.accessToken })).body.error.code).toBe('NOT_INITIATOR');
    const w = await t.request('POST', `/v1/offers/${o.body.id}/withdraw`, { token: traveler.accessToken });
    expect(w.body.status).toBe('WITHDRAWN');
    expect(await outboxEvents(t, 'offer.withdrawn', o.body.id)).toHaveLength(1);

    const o2 = await t.request('POST', `/v1/requests/${request.id}/offers`, { token: traveler.accessToken, body: { tripId: trip.id } });
    const d = await t.request('POST', `/v1/offers/${o2.body.id}/decline`, { token: buyer.accessToken, body: { reason: 'Fee terlalu tinggi' } });
    expect(d.body).toMatchObject({ status: 'DECLINED', declineReason: 'Fee terlalu tinggi' });

    const o3 = await t.request('POST', `/v1/requests/${request.id}/offers`, { token: traveler.accessToken, body: { tripId: trip.id } });
    t.clock.advance(49 * 3_600_000);
    try {
      const token = await freshToken(t, buyer);
      const late = await t.request('POST', `/v1/offers/${o3.body.id}/accept`, { token });
      expect([late.status, late.body.error.code]).toEqual([409, 'OFFER_EXPIRED']);
      expect((await expireOffers(t.deps)).expired).toBeGreaterThanOrEqual(1);
      const [row] = await t.adminSql<{ status: string }[]>`SELECT status FROM offers WHERE id = ${o3.body.id}`;
      expect(row!.status).toBe('EXPIRED');
      expect(await outboxEvents(t, 'offer.expired', o3.body.id)).toHaveLength(1);
    } finally {
      t.clock.set(NOW);
    }
  });

  it('re-checks restriction at accept time (rule becomes PROHIBITED → refused)', async () => {
    const { buyer, traveler, trip, request } = await scenario({}, { productName: 'Hario V60 coffee dripper', categoryCode: 'HOME_APPLIANCES', unitPriceMinor: 3500, quantity: 1 });
    const o = await t.request('POST', `/v1/requests/${request.id}/offers`, { token: traveler.accessToken, body: { tripId: trip.id } });
    await t.adminSql`
      INSERT INTO restricted_items (code, version, destination_country, keywords, classification, message_id, message_en, source_reference,
                                    effective_from, last_verified_at, status)
      VALUES ('RI_TEST_DRIPPER', 1, 'ID', ARRAY['coffee dripper'], 'PROHIBITED', 'Dilarang (uji)', 'Prohibited (test)', 'test', DATE '2026-01-01', DATE '2026-10-01', 'ACTIVE')`;
    const res = await t.request('POST', `/v1/offers/${o.body.id}/accept`, { token: buyer.accessToken });
    expect([res.status, res.body.error.code]).toEqual([422, 'ITEM_PROHIBITED']);
    const [cnt] = await t.adminSql<{ n: number }[]>`SELECT count(*)::int AS n FROM transactions WHERE request_id = ${request.id}`;
    expect(cnt!.n).toBe(0);
    await t.adminSql`UPDATE restricted_items SET status = 'RETIRED' WHERE code = 'RI_TEST_DRIPPER'`;
  });

  it('trip cancel with an open transaction emits trip.cancelled for the money group (no refund here)', async () => {
    const { buyer, traveler, trip, request } = await scenario();
    const o = await t.request('POST', `/v1/requests/${request.id}/offers`, { token: traveler.accessToken, body: { tripId: trip.id } });
    const acc = await t.request('POST', `/v1/offers/${o.body.id}/accept`, { token: buyer.accessToken });
    expect(acc.status).toBe(200);
    const c = await t.request('POST', `/v1/trips/${trip.id}/cancel`, { token: traveler.accessToken, body: { reason: 'Penerbangan dibatalkan' } });
    expect(c.status).toBe(200);
    const ev = await outboxEvents(t, 'trip.cancelled', trip.id);
    expect(ev[0]!.payload).toMatchObject({ tripId: trip.id, openTransactionIds: [acc.body.transaction.id], reason: 'Penerbangan dibatalkan' });
    const [txRow] = await t.adminSql<{ status: string }[]>`SELECT status FROM transactions WHERE id = ${acc.body.transaction.id}`;
    expect(txRow!.status).toBe('MATCHED');
  });
});

describe('concurrency', () => {
  it('two accepts racing on the same request → exactly one transaction', async () => {
    const { buyer, traveler, trip, request } = await scenario();
    const t2 = await t.createUser({ kycLevel: 3 });
    const trip2 = await createActiveTrip(t, t2);
    const o1 = await t.request('POST', `/v1/requests/${request.id}/offers`, { token: traveler.accessToken, body: { tripId: trip.id } });
    const o2 = await t.request('POST', `/v1/requests/${request.id}/offers`, { token: t2.accessToken, body: { tripId: trip2.id } });
    const results = await Promise.all([
      t.request('POST', `/v1/offers/${o1.body.id}/accept`, { token: buyer.accessToken }),
      t.request('POST', `/v1/offers/${o2.body.id}/accept`, { token: buyer.accessToken }),
      t.request('POST', `/v1/offers/${o1.body.id}/accept`, { token: buyer.accessToken }),
    ]);
    const ok = results.filter((r) => r.status === 200);
    expect(ok).toHaveLength(1);
    for (const r of results.filter((x) => x.status !== 200)) {
      expect(r.status).toBe(409);
      expect(['OFFER_NOT_PENDING', 'OFFER_ALREADY_ACCEPTED', 'REQUEST_ALREADY_MATCHED']).toContain(r.body.error.code);
    }
    const [cnt] = await t.adminSql<{ n: number }[]>`SELECT count(*)::int AS n FROM transactions WHERE request_id = ${request.id}`;
    expect(cnt!.n).toBe(1);
    const [sum] = await t.adminSql<{ total: string }[]>`
      SELECT (SELECT coalesce(sum(reserved_kg), 0) FROM trips WHERE id IN (${trip.id}, ${trip2.id}))::text AS total`;
    expect(sum!.total).toBe('0.60');
  });
});
