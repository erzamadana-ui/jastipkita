import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../../../test/helpers';
import { tripAutomation } from '../../jobs/marketplace';
import { adminVerifyTrip, createActiveTrip, createDraftTrip, day, freshToken, insertFile, outboxEvents, setConfig, tripBody } from './fixtures';

const NOW = new Date('2026-10-05T03:00:00Z'); // 10:00 WIB
let t: TestContext;
beforeAll(async () => {
  t = await createTestContext({ now: NOW });
});
afterAll(async () => {
  await t.close();
});

describe('POST /v1/trips (create)', () => {
  it('requires auth', async () => {
    const res = await t.request('POST', '/v1/trips', { body: tripBody(t) });
    expect(res.status).toBe(401);
  });

  it('creates a DRAFT with owner view and trip_events row', async () => {
    const u = await t.createUser({ kycLevel: 3, mode: 'TRAVELER' });
    const res = await t.request('POST', '/v1/trips', { token: u.accessToken, body: tripBody(t, { excludedCategories: ['FOOD_SNACKS'], maxItems: 5 }) });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      status: 'DRAFT',
      travelerId: u.id,
      capacityKg: 10,
      reservedKg: 0,
      remainingCapacityKg: 10,
      maxItems: 5,
      fee: { type: 'PERCENT', value: 1000, label: '10% dari harga barang' },
      excludedCategories: ['FOOD_SNACKS'],
      verified: false,
    });
    expect(res.body.allowedActions).toEqual(expect.arrayContaining(['EDIT', 'CANCEL', 'UPLOAD_VERIFICATION']));
    expect(res.body.allowedActions).not.toContain('PUBLISH');
    const ev = await t.adminSql`SELECT to_status FROM trip_events WHERE trip_id = ${res.body.id}`;
    expect(ev.map((e) => e.to_status)).toEqual(['DRAFT']);
  });

  it('validates dates, capacity, countries, categories and fee bounds', async () => {
    const u = await t.createUser({ kycLevel: 3 });
    const cases: [Record<string, unknown>, number, string][] = [
      [{ arrivalDate: day(t, 14) }, 422, 'ARRIVAL_BEFORE_DEPARTURE'],
      [{ departureDate: day(t, -1), arrivalDate: day(t, -1) }, 422, 'DATE_IN_PAST'],
      [{ capacityKg: 40 }, 422, 'CAPACITY_TOO_LARGE'],
      [{ capacityKg: 1.234 }, 422, 'CAPACITY_INVALID'],
      [{ originCountry: 'CN' }, 422, 'COUNTRY_NOT_SUPPORTED'],
      [{ destinationCountry: 'JP' }, 422, 'SAME_COUNTRY'],
      [{ excludedCategories: ['NOT_A_CATEGORY'] }, 422, 'CATEGORY_UNKNOWN'],
      [{ fee: { type: 'PERCENT', value: 3500 } }, 422, 'FEE_OUT_OF_BOUNDS'],
      [{ departureDate: '2026-13-01' }, 400, 'VALIDATION_ERROR'],
      [{ capacityKg: -1 }, 400, 'VALIDATION_ERROR'],
    ];
    for (const [o, status, code] of cases) {
      const res = await t.request('POST', '/v1/trips', { token: u.accessToken, body: tripBody(t, o) });
      expect({ o, status: res.status, code: res.body.error?.code }).toEqual({ o, status, code });
    }
  });

  it('enforces trips.maxActiveTripsPerTraveler (5)', async () => {
    const u = await t.createUser({ kycLevel: 3 });
    for (let i = 0; i < 5; i++) await createDraftTrip(t, u);
    const res = await t.request('POST', '/v1/trips', { token: u.accessToken, body: tripBody(t) });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({ code: 'MAX_ACTIVE_TRIPS', details: { max: 5 } });
  });
});

describe('trip lifecycle', () => {
  it('verification → VERIFICATION_PENDING, publish gates, depart, complete', async () => {
    const u = await t.createUser({ kycLevel: 3, mode: 'TRAVELER', displayName: 'Budi Santoso' });
    const trip = await createDraftTrip(t, u);

    // publish without verified documents (allowUnverifiedActive = false)
    const early = await t.request('POST', `/v1/trips/${trip.id}/publish`, { token: u.accessToken });
    expect(early.status).toBe(422);
    expect(early.body.error.code).toBe('TRIP_NOT_VERIFIED');

    // document checks: owner, purpose, scan status
    const other = await t.createUser({ kycLevel: 3 });
    const foreign = await insertFile(t, other.id, 'TRIP_DOC');
    const photo = await insertFile(t, u.id, 'PRODUCT_PHOTO');
    const pending = await insertFile(t, u.id, 'TRIP_DOC', 'PENDING');
    for (const [fileId, status, code] of [
      [foreign, 404, 'FILE_NOT_FOUND'],
      [photo, 422, 'FILE_PURPOSE_MISMATCH'],
      [pending, 422, 'FILE_NOT_READY'],
    ] as const) {
      const r = await t.request('POST', `/v1/trips/${trip.id}/verification`, { token: u.accessToken, body: { docType: 'ETICKET', fileId } });
      expect([r.status, r.body.error.code]).toEqual([status, code]);
    }
    const byOther = await t.request('POST', `/v1/trips/${trip.id}/verification`, { token: other.accessToken, body: { docType: 'ETICKET', fileId: foreign } });
    expect(byOther.status).toBe(404);

    const fileId = await insertFile(t, u.id, 'TRIP_DOC');
    const v = await t.request('POST', `/v1/trips/${trip.id}/verification`, { token: u.accessToken, body: { docType: 'ETICKET', fileId, flightNumber: 'ga 875', flightDate: trip.departureDate } });
    expect(v.status).toBe(200);
    expect(v.body.status).toBe('VERIFICATION_PENDING');
    expect(v.body.verifications).toHaveLength(1);
    expect(v.body.verifications[0]).toMatchObject({ docType: 'ETICKET', status: 'PENDING', fileId, flightNumber: 'GA875' });
    const statusEvents = await outboxEvents(t, 'trip.status_changed', trip.id);
    expect(statusEvents.map((e) => e.payload.to)).toEqual(['VERIFICATION_PENDING']);

    // route/dates are locked once documents are submitted; operational fields stay editable
    const locked = await t.request('PATCH', `/v1/trips/${trip.id}`, { token: u.accessToken, body: { originCity: 'Osaka' } });
    expect(locked.status).toBe(409);
    expect(locked.body.error).toMatchObject({ code: 'TRIP_FIELD_LOCKED', details: { fields: ['originCity'] } });
    const cap = await t.request('PATCH', `/v1/trips/${trip.id}`, { token: u.accessToken, body: { capacityKg: 12.5, notes: 'Bisa COD Jaksel' } });
    expect(cap.status).toBe(200);
    expect(cap.body).toMatchObject({ capacityKg: 12.5, notes: 'Bisa COD Jaksel' });

    // K2 cannot publish even when verified
    await adminVerifyTrip(t, trip.id);
    const k2 = await t.createUser({ kycLevel: 2 });
    const k2Trip = await t.request('POST', '/v1/trips', { token: k2.accessToken, body: tripBody(t) });
    const k2Pub = await t.request('POST', `/v1/trips/${k2Trip.body.id}/publish`, { token: k2.accessToken });
    expect(k2Pub.status).toBe(403);
    expect(k2Pub.body.error.code).toBe('KYC_LEVEL_REQUIRED');

    const pub = await t.request('POST', `/v1/trips/${trip.id}/publish`, { token: u.accessToken });
    expect(pub.status).toBe(200);
    expect(pub.body).toMatchObject({ status: 'ACTIVE', verified: true });
    expect(pub.body.publishedAt).toBeTruthy();

    const tooEarly = await t.request('POST', `/v1/trips/${trip.id}/depart`, { token: u.accessToken });
    expect(tooEarly.status).toBe(422);
    expect(tooEarly.body.error.code).toBe('TOO_EARLY_TO_DEPART');

    // other users only see the public view
    const pubView = await t.request('GET', `/v1/trips/${trip.id}`, { token: other.accessToken });
    expect(pubView.body.view).toBe('PUBLIC');
    expect(pubView.body.trip.traveler).toMatchObject({ id: u.id, displayName: 'Budi S.', trustBadge: { tier: 'IDENTITY_VERIFIED' } });
    expect(pubView.body.trip.notes).toBeUndefined();
    const anon = await t.request('GET', `/v1/trips/${trip.id}`);
    expect(anon.body.view).toBe('PUBLIC');
    const own = await t.request('GET', `/v1/trips/${trip.id}`, { token: u.accessToken });
    expect(own.body.view).toBe('OWNER');
    expect(own.body.trip.notes).toBe('Bisa COD Jaksel');

    t.clock.set(new Date(`${trip.departureDate}T01:00:00Z`));
    try {
      const token = await freshToken(t, u);
      const dep = await t.request('POST', `/v1/trips/${trip.id}/depart`, { token });
      expect(dep.status).toBe(200);
      expect(dep.body.status).toBe('TRAVELING');
      const done = await t.request('POST', `/v1/trips/${trip.id}/complete`, { token });
      expect(done.status).toBe(200);
      expect(done.body.status).toBe('COMPLETED');
      const edit = await t.request('PATCH', `/v1/trips/${trip.id}`, { token, body: { notes: 'x' } });
      expect(edit.status).toBe(409);
    } finally {
      t.clock.set(NOW);
    }
  });

  it('non-owners cannot see or mutate unpublished trips', async () => {
    const u = await t.createUser({ kycLevel: 3 });
    const other = await t.createUser({ kycLevel: 3 });
    const trip = await createDraftTrip(t, u);
    expect((await t.request('GET', `/v1/trips/${trip.id}`, { token: other.accessToken })).status).toBe(404);
    expect((await t.request('PATCH', `/v1/trips/${trip.id}`, { token: other.accessToken, body: { notes: 'hi' } })).status).toBe(404);
    expect((await t.request('POST', `/v1/trips/${trip.id}/cancel`, { token: other.accessToken, body: { reason: 'nope' } })).status).toBe(404);
    const mine = await t.request('GET', '/v1/trips/mine', { token: u.accessToken });
    expect(mine.status).toBe(200);
    expect(mine.body.data.map((x: { id: string }) => x.id)).toContain(trip.id);
  });

  it('cancel moves any open trip to CANCELLED and emits trip.cancelled', async () => {
    const u = await t.createUser({ kycLevel: 3 });
    const trip = await createActiveTrip(t, u);
    const res = await t.request('POST', `/v1/trips/${trip.id}/cancel`, { token: u.accessToken, body: { reason: 'Jadwal berubah' } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'CANCELLED', cancelledReason: 'Jadwal berubah' });
    const ev = await outboxEvents(t, 'trip.cancelled', trip.id);
    expect(ev[0]!.payload).toMatchObject({ tripId: trip.id, travelerId: u.id, openTransactionIds: [] });
    const again = await t.request('POST', `/v1/trips/${trip.id}/cancel`, { token: u.accessToken, body: { reason: 'lagi' } });
    expect(again.status).toBe(409);
  });

  it('allows DRAFT → ACTIVE only when trips.allowUnverifiedActive = true', async () => {
    const t2 = await createTestContext({ now: NOW });
    try {
      await setConfig(t2, 'trips', { allowUnverifiedActive: true, maxActiveTripsPerTraveler: 5, maxCapacityKg: 32 });
      const u = await t2.createUser({ kycLevel: 3 });
      const trip = await createDraftTrip(t2, u);
      const pub = await t2.request('POST', `/v1/trips/${trip.id}/publish`, { token: u.accessToken });
      expect(pub.status).toBe(200);
      expect(pub.body).toMatchObject({ status: 'ACTIVE', verified: false });
      const [ev] = await t2.adminSql<{ meta: { unverified: boolean } }[]>`SELECT meta FROM trip_events WHERE trip_id = ${trip.id} AND to_status = 'ACTIVE'`;
      expect(ev!.meta.unverified).toBe(true);
    } finally {
      await t2.close();
    }
  });
});

describe('GET /v1/trips (public discovery)', () => {
  it('filters, paginates and exposes no PII', async () => {
    const t3 = await createTestContext({ now: NOW });
    try {
      const a = await t3.createUser({ kycLevel: 4, displayName: 'Siti Rahmawati Putri', email: 'siti.private@example.com' });
      const b = await t3.createUser({ kycLevel: 3, displayName: 'Andi' });
      const tripA = await createActiveTrip(t3, a, { departureDate: day(t3, 10), arrivalDate: day(t3, 10), excludedCategories: ['FOOD_SNACKS'] });
      const tripB = await createActiveTrip(t3, b, { departureDate: day(t3, 12), arrivalDate: day(t3, 13), destinationCity: 'Surabaya' });
      await createActiveTrip(t3, b, { originCountry: 'KR', originCity: 'Seoul', departureDate: day(t3, 11), arrivalDate: day(t3, 11) });
      await createDraftTrip(t3, a); // drafts are never listed
      await t3.adminSql`UPDATE users SET trust_score = 88 WHERE id = ${a.id}`;
      await t3.adminSql`INSERT INTO user_rating_summaries (user_id, as_traveler_count, as_traveler_avg, as_traveler_weighted) VALUES (${a.id}, 12, 4.80, 4.75)`;

      // signed-in viewer: exact dates (SEC-19 — anonymous visitors get week precision, see below)
      const viewer = await t3.createUser();
      const get = (path: string) => t3.request('GET', path, { token: viewer.accessToken });
      const all = await get('/v1/trips');
      expect(all.status).toBe(200);
      expect(all.body.data).toHaveLength(3);
      expect(all.body.data.map((x: { departureDate: string }) => x.departureDate)).toEqual([day(t3, 10), day(t3, 11), day(t3, 12)]);
      expect(all.body.data[0]).toMatchObject({ datePrecision: 'DAY', departureWindow: { from: day(t3, 10), to: day(t3, 10) } });

      const jp = await get('/v1/trips?originCountry=jp');
      expect(jp.body.data.map((x: { id: string }) => x.id)).toEqual([tripA.id, tripB.id]);
      const food = await get('/v1/trips?originCountry=JP&categoryCode=FOOD_SNACKS');
      expect(food.body.data.map((x: { id: string }) => x.id)).toEqual([tripB.id]);
      const sby = await get('/v1/trips?destinationCity=surabaya');
      expect(sby.body.data.map((x: { id: string }) => x.id)).toEqual([tripB.id]);
      const arrivalBy = await get(`/v1/trips?arrivalBy=${day(t3, 11)}`);
      expect(arrivalBy.body.data).toHaveLength(2);

      const p1 = await get('/v1/trips?limit=2');
      expect(p1.body.data).toHaveLength(2);
      expect(p1.body.nextCursor).toBeTruthy();
      const p2 = await get(`/v1/trips?limit=2&cursor=${p1.body.nextCursor}`);
      expect(p2.body.data).toHaveLength(1);
      expect(p2.body.nextCursor).toBeNull();
      expect((await get('/v1/trips?cursor=garbage')).status).toBe(400);

      const first = all.body.data[0];
      expect(first.traveler).toEqual({
        id: a.id,
        displayName: 'Siti P.',
        trustBadge: { tier: 'TRAVELER_VERIFIED', label: 'Traveler Terverifikasi' },
        trustScore: 88,
        trustTier: { tier: 'EXCELLENT', label: 'Sangat tepercaya', labelEn: 'Excellent' },
        kycLevel: 4,
        identityVerified: true,
        rating: { average: 4.75, count: 12 },
        completedTransactions: 0,
      });
      expect(first).toMatchObject({ verified: true, capacityRemainingKg: 10, fee: { type: 'PERCENT', value: 1000 } });
      const json = JSON.stringify(all.body);
      for (const secret of [a.email, b.email, a.phone, b.phone, 'Rahmawati', 'travelerId', 'notes', 'version']) {
        expect(json).not.toContain(secret);
      }
      // the only user ids present are the public profile ids
      const uuids = new Set(json.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g));
      const tripIds = new Set(all.body.data.map((x: { id: string }) => x.id));
      for (const id of uuids) expect(tripIds.has(id) || id === a.id || id === b.id).toBe(true);
    } finally {
      await t3.close();
    }
  });
});

describe('SEC-19: anonymous discovery sees ISO-week precision, signed-in users exact dates', () => {
  it('coarsens dates, windows and ordering; week-granular filters; private caching; strict optional bearer; detail view', async () => {
    // NOW = Monday 2026-10-05 10:00 WIB → day(+10..+13) = Thu 15 .. Sun 18 Oct (week 12–18), day(+14) = Mon 19 Oct
    const t4 = await createTestContext({ now: NOW });
    try {
      const a = await t4.createUser({ kycLevel: 4, displayName: 'Rina Wulandari' });
      const b = await t4.createUser({ kycLevel: 4, displayName: 'Dimas Pratama' });
      const thu = await createActiveTrip(t4, a, { departureDate: day(t4, 10), arrivalDate: day(t4, 10) });
      const fri = await createActiveTrip(t4, b, { departureDate: day(t4, 11), arrivalDate: day(t4, 11) });
      const sat = await createActiveTrip(t4, a, { departureDate: day(t4, 12), arrivalDate: day(t4, 13) });
      const mon = await createActiveTrip(t4, b, { departureDate: day(t4, 14), arrivalDate: day(t4, 15) });
      const week = { from: '2026-10-12', to: '2026-10-18' };
      const next = { from: '2026-10-19', to: '2026-10-25' };

      const anon = await t4.request('GET', '/v1/trips');
      expect(anon.status).toBe(200);
      expect(anon.headers.get('cache-control')).toBe('public, max-age=30');
      expect(anon.headers.get('vary')).toContain('Authorization');
      const ids = anon.body.data.map((x: { id: string }) => x.id);
      // ordered by week, then id — the order inside a week says nothing about the exact day
      expect(ids.slice(0, 3)).toEqual([thu.id, fri.id, sat.id].sort());
      expect(ids[3]).toBe(mon.id);
      for (const x of anon.body.data.slice(0, 3)) {
        expect(x).toMatchObject({ datePrecision: 'WEEK', departureWindow: week, departureDate: week.from, arrivalWindow: week, arrivalDate: week.from });
      }
      expect(anon.body.data[3]).toMatchObject({ datePrecision: 'WEEK', departureWindow: next, arrivalWindow: next, departureDate: next.from });
      const json = JSON.stringify(anon.body);
      for (const exact of [day(t4, 10), day(t4, 11), day(t4, 12), day(t4, 15)]) expect(json).not.toContain(exact); // 15, 16, 17, 20 Oct

      // a day-precise filter cannot single out one day for anonymous visitors (whole weeks), it can for signed-in users
      const viewer = await t4.createUser();
      const asUser = (path: string) => t4.request('GET', path, { token: viewer.accessToken });
      const probe = `/v1/trips?departureFrom=${day(t4, 11)}&departureTo=${day(t4, 11)}`;
      expect((await t4.request('GET', probe)).body.data.map((x: { id: string }) => x.id).sort()).toEqual([thu.id, fri.id, sat.id].sort());
      expect((await asUser(probe)).body.data.map((x: { id: string }) => x.id)).toEqual([fri.id]);
      const byArrival = `/v1/trips?arrivalBy=${day(t4, 10)}`;
      expect((await t4.request('GET', byArrival)).body.data.map((x: { id: string }) => x.id).sort()).toEqual([thu.id, fri.id, sat.id].sort());
      expect((await asUser(byArrival)).body.data.map((x: { id: string }) => x.id)).toEqual([thu.id]);

      // keyset pagination on (week, id): no duplicates or gaps
      const p1 = await t4.request('GET', '/v1/trips?limit=2');
      const p2 = await t4.request('GET', `/v1/trips?limit=2&cursor=${p1.body.nextCursor}`);
      expect([...p1.body.data, ...p2.body.data].map((x: { id: string }) => x.id)).toEqual(ids);
      expect(p2.body.nextCursor).toBeNull();

      // signed-in: exact dates, private response
      const exact = await asUser('/v1/trips');
      expect(exact.headers.get('cache-control')).toBe('private, no-store');
      expect(exact.body.data.map((x: { id: string }) => x.id)).toEqual([thu.id, fri.id, sat.id, mon.id]);
      expect(exact.body.data[2]).toMatchObject({ datePrecision: 'DAY', departureDate: day(t4, 12), arrivalDate: day(t4, 13), departureWindow: { from: day(t4, 12), to: day(t4, 12) } });

      // a token that does not verify is refused (the app refreshes) instead of silently answering with coarse dates
      const bad = await t4.request('GET', '/v1/trips', { token: 'not-a-jwt' });
      expect(bad.status).toBe(401);

      // trip detail: anonymous WEEK, signed-in non-owner DAY, owner OWNER view
      const dAnon = await t4.request('GET', `/v1/trips/${fri.id}`);
      expect(dAnon.body).toMatchObject({ view: 'PUBLIC', trip: { datePrecision: 'WEEK', departureDate: week.from, departureWindow: week } });
      expect(dAnon.headers.get('cache-control')).toBe('public, max-age=30');
      const dUser = await asUser(`/v1/trips/${fri.id}`);
      expect(dUser.body).toMatchObject({ view: 'PUBLIC', trip: { datePrecision: 'DAY', departureDate: day(t4, 11) } });
      expect(dUser.headers.get('cache-control')).toBe('private, no-store');
      const dOwner = await t4.request('GET', `/v1/trips/${fri.id}`, { token: b.accessToken });
      expect(dOwner.body).toMatchObject({ view: 'OWNER', trip: { departureDate: day(t4, 11) } });
      // a suspended account is served like an anonymous visitor
      await t4.adminSql`UPDATE users SET status = 'SUSPENDED' WHERE id = ${viewer.id}`;
      expect((await asUser(`/v1/trips/${fri.id}`)).body.trip.datePrecision).toBe('WEEK');
    } finally {
      await t4.close();
    }
  });
});

describe('trip automation job', () => {
  it('ACTIVE → TRAVELING on departure date, TRAVELING → COMPLETED after arrival, stale drafts cancelled', async () => {
    const t4 = await createTestContext({ now: NOW });
    try {
      const u = await t4.createUser({ kycLevel: 3 });
      const d1 = day(t4, 1);
      const d2 = day(t4, 2);
      const d3 = day(t4, 3);
      const trip = await createActiveTrip(t4, u, { departureDate: d2, arrivalDate: d3 });
      const draft = await createDraftTrip(t4, u, { departureDate: d1, arrivalDate: d1 });

      expect(await tripAutomation(t4.deps)).toMatchObject({ traveling: 0, completed: 0, cancelledUnpublished: 0 });
      t4.clock.set(new Date(`${d2}T00:30:00+07:00`));
      expect(await tripAutomation(t4.deps)).toMatchObject({ traveling: 1, cancelledUnpublished: 1 });
      let [row] = await t4.adminSql<{ status: string }[]>`SELECT status FROM trips WHERE id = ${trip.id}`;
      expect(row!.status).toBe('TRAVELING');
      [row] = await t4.adminSql<{ status: string }[]>`SELECT status FROM trips WHERE id = ${draft.id}`;
      expect(row!.status).toBe('CANCELLED');
      const [ev] = await t4.adminSql<{ actor_type: string }[]>`SELECT actor_type FROM trip_events WHERE trip_id = ${trip.id} AND to_status = 'TRAVELING'`;
      expect(ev!.actor_type).toBe('SYSTEM');

      t4.clock.set(new Date(`${d3}T20:00:00+07:00`)); // arrival day not yet passed
      expect((await tripAutomation(t4.deps)).completed).toBe(0);
      t4.clock.set(new Date(`${d3}T00:00:00+07:00`));
      t4.clock.advance(86_400_000); // day after arrival
      expect((await tripAutomation(t4.deps)).completed).toBe(1);
      [row] = await t4.adminSql<{ status: string }[]>`SELECT status FROM trips WHERE id = ${trip.id}`;
      expect(row!.status).toBe('COMPLETED');
    } finally {
      await t4.close();
    }
  });
});
