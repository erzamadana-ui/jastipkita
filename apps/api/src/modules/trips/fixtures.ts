/**
 * Test fixtures for the marketplace modules (used by *.test.ts only). Kept inside the marketplace
 * group because test/helpers.ts is a shared file.
 */
import { expect } from 'vitest';
import type { TestContext, TestUser } from '../../../test/helpers';
import { issueSession } from '../../services/session';
import { addDaysIso, wibDate } from '../catalog/shared';

export function day(t: TestContext, offsetDays: number): string {
  return addDaysIso(wibDate(t.clock.now()), offsetDays);
}

export async function insertFile(t: TestContext, ownerId: string, purpose: 'TRIP_DOC' | 'PRODUCT_PHOTO' | 'KYC', scan: 'CLEAN' | 'PENDING' = 'CLEAN'): Promise<string> {
  const encrypted = purpose === 'TRIP_DOC' || purpose === 'KYC';
  const [row] = await t.adminSql<{ id: string }[]>`
    INSERT INTO files (owner_id, purpose, storage_provider, storage_key, mime, size_bytes, encrypted, enc_key_id, scan_status)
    VALUES (${ownerId}, ${purpose}, 'MOCK', ${`test/${purpose.toLowerCase()}/${crypto.randomUUID()}`}, 'image/jpeg', 1234,
            ${encrypted}, ${encrypted ? 'k1' : null}, ${scan})
    RETURNING id`;
  return row!.id;
}

export function tripBody(t: TestContext, overrides: Record<string, unknown> = {}) {
  return {
    originCountry: 'JP',
    originCity: 'Tokyo',
    destinationCountry: 'ID',
    destinationCity: 'Jakarta',
    departureDate: day(t, 15),
    arrivalDate: day(t, 15),
    capacityKg: 10,
    fee: { type: 'PERCENT', value: 1000 },
    ...overrides,
  };
}

export async function createDraftTrip(t: TestContext, user: TestUser, overrides: Record<string, unknown> = {}) {
  const res = await t.request('POST', '/v1/trips', { token: user.accessToken, body: tripBody(t, overrides) });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

/** Admin approval of the trip documents (admin group's job) simulated directly in the DB. */
export async function adminVerifyTrip(t: TestContext, tripId: string): Promise<void> {
  const [trip] = await t.adminSql<{ version: number }[]>`SELECT version FROM trips WHERE id = ${tripId}`;
  await t.adminSql`UPDATE trip_verifications SET status = 'APPROVED', reviewed_at = now() WHERE trip_id = ${tripId} AND status = 'PENDING'`;
  await t.adminSql`SELECT id FROM transition_trip(${tripId}, ${trip!.version}, 'VERIFIED', 'ADMIN', NULL, 'documents approved (test)', '{}'::jsonb)`;
}

/** DRAFT → document → VERIFIED → ACTIVE through the API (traveler must be KYC ≥ 3). */
export async function createActiveTrip(t: TestContext, user: TestUser, overrides: Record<string, unknown> = {}) {
  const trip = await createDraftTrip(t, user, overrides);
  const fileId = await insertFile(t, user.id, 'TRIP_DOC');
  const v = await t.request('POST', `/v1/trips/${trip.id}/verification`, { token: user.accessToken, body: { docType: 'ETICKET', fileId, flightNumber: 'GA875' } });
  expect(v.status, JSON.stringify(v.body)).toBe(200);
  await adminVerifyTrip(t, trip.id);
  const p = await t.request('POST', `/v1/trips/${trip.id}/publish`, { token: user.accessToken });
  expect(p.status, JSON.stringify(p.body)).toBe(200);
  expect(p.body.status).toBe('ACTIVE');
  return p.body;
}

export function requestBody(t: TestContext, overrides: Record<string, unknown> = {}) {
  return {
    sourceType: 'MANUAL',
    productName: 'Uniqlo AIRism Cotton Oversized T-Shirt',
    merchantName: 'UNIQLO',
    merchantCountry: 'JP',
    categoryCode: 'FASHION_APPAREL',
    quantity: 2,
    unitPriceMinor: 2990,
    priceCurrency: 'JPY',
    estWeightKg: 0.3,
    maxBudgetIdr: 2_000_000,
    neededBy: day(t, 30),
    destinationCountry: 'ID',
    destinationCity: 'Jakarta',
    ...overrides,
  };
}

export async function createOpenRequest(t: TestContext, buyer: TestUser, overrides: Record<string, unknown> = {}) {
  const res = await t.request('POST', '/v1/requests', { token: buyer.accessToken, body: { ...requestBody(t, overrides), publish: true, acknowledgeRestriction: true } });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  expect(res.body.status).toBe('OPEN');
  return res.body;
}

export async function outboxEvents(t: TestContext, type: string, aggregateId?: string) {
  return aggregateId
    ? t.adminSql<{ event_type: string; payload: Record<string, unknown> }[]>`
        SELECT event_type, payload FROM outbox_events WHERE event_type = ${type} AND aggregate_id = ${aggregateId} ORDER BY id`
    : t.adminSql<{ event_type: string; payload: Record<string, unknown> }[]>`
        SELECT event_type, payload FROM outbox_events WHERE event_type = ${type} ORDER BY id`;
}

/** Activates a new business_configs version (maker-checker) and clears the config cache. */
export async function setConfig(t: TestContext, key: string, value: unknown): Promise<void> {
  const maker = await t.createUser();
  const checker = await t.createUser();
  const [v] = await t.adminSql<{ v: number }[]>`SELECT coalesce(max(version), 0) + 1 AS v FROM business_configs WHERE key = ${key}`;
  const [row] = await t.adminSql<{ id: string }[]>`
    INSERT INTO business_configs (key, version, value, status, change_reason, created_by)
    VALUES (${key}, ${v!.v}, ${t.adminSql.json(value as never)}, 'PENDING_APPROVAL', 'test override', ${maker.id}) RETURNING id`;
  await t.adminSql`SELECT activate_business_config(${row!.id}, ${checker.id})`;
  t.deps.config.invalidate();
}

/** Fresh access token at the (possibly advanced) test clock — access tokens live 15 minutes. */
export async function freshToken(t: TestContext, user: TestUser): Promise<string> {
  return (await issueSession(t.deps, t.sql, user.id)).accessToken;
}
