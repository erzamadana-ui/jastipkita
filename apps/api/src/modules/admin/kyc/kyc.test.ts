import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../../../../test/helpers';
import { JPEG, phoneLogin, uploadFile } from '../../auth/test-support';
import { createPayoutAccount, setTripStatus } from '../../transactions/test-fixtures';
import { type Admin, as, auditRows, createAdmin } from '../test-support';

let t: TestContext;
let reviewer: Admin;
let reviewerNoMfa: Admin;
let support: Admin;
let ops: Admin;

beforeAll(async () => {
  t = await createTestContext(); // KYC_PROVIDER=manual → submissions wait for an admin
  reviewer = await createAdmin(t, ['COMPLIANCE']);
  reviewerNoMfa = await createAdmin(t, ['RISK'], { mfa: false });
  support = await createAdmin(t, ['SUPPORT']);
  ops = await createAdmin(t, ['OPERATIONS']);
});
afterAll(async () => {
  await t.close();
});

let seq = 0;
const nik = () => `3174${String(Date.now()).slice(-8)}${String(seq++).padStart(4, '0')}`;

async function submitted(idNumber = nik()) {
  const u = await phoneLogin(t);
  const token = u.tokens.accessToken as string;
  t.clock.advance(61_000);
  await t.request('POST', '/v1/me/consents', { token, body: { type: 'KYC', version: '0.1-template' } });
  const idFront = await uploadFile(t, token, 'KYC', 'image/jpeg', JPEG(300, 3));
  const selfie = await uploadFile(t, token, 'KYC', 'image/jpeg', JPEG(300, 5));
  const res = await t.request('POST', '/v1/kyc/submissions', {
    token,
    body: { idType: 'KTP', idNumber, fullName: 'Siti Rahmawati', dateOfBirth: '1992-03-04', documents: { idFront, selfie } },
  });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  return { userId: u.user.id as string, token, submissionId: res.body.submission.id as string, idNumber, idFront };
}

describe('KYC review queue', () => {
  it('SUPPORT has no kyc.review; queue lists PENDING; detail masks identity, links files, audits the view', async () => {
    const s = await submitted();
    expect((await as(t, support, 'GET', '/v1/admin/kyc/submissions')).status).toBe(403);
    const q = await as(t, reviewer, 'GET', '/v1/admin/kyc/submissions');
    expect(q.status, JSON.stringify(q.body)).toBe(200);
    const row = q.body.data.find((x: any) => x.id === s.submissionId);
    expect(row).toMatchObject({ userId: s.userId, provider: 'MANUAL', targetLevel: 3 });
    expect(['PENDING', 'IN_REVIEW']).toContain(row.status);
    const d = await as(t, reviewer, 'GET', `/v1/admin/kyc/submissions/${s.submissionId}`);
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    expect(d.body.identity).toMatchObject({ idType: 'KTP', idNumberMasked: `••••••••${s.idNumber.slice(-4)}`, fullNameMasked: 'Siti R.' });
    expect(JSON.stringify(d.body)).not.toContain(s.idNumber);
    expect(JSON.stringify(d.body)).not.toContain('Rahmawati');
    expect(d.body.documents.map((x: any) => x.type).sort()).toEqual(['KTP', 'SELFIE']);
    expect(d.body.documents[0].content.url).toMatch(/\/v1\/files\/[0-9a-f-]+\/content$/);
    expect(d.body.allowedActions).toEqual(['APPROVE', 'REJECT']);
    expect(await auditRows(t, 'kyc.submission_viewed', s.submissionId)).toHaveLength(1);
  });

  it('approve (MFA) runs the FSM checks → APPROVED, level 3, kyc.approved event, audit', async () => {
    const s = await submitted();
    const noMfa = await as(t, reviewerNoMfa, 'POST', `/v1/admin/kyc/submissions/${s.submissionId}/approve`, { livenessPassed: true, documentMatches: true });
    expect(noMfa.body.error.code).toBe('MFA_REQUIRED');
    const failed = await as(t, reviewer, 'POST', `/v1/admin/kyc/submissions/${s.submissionId}/approve`, { livenessPassed: false, documentMatches: true });
    expect(failed.status).toBe(422);
    const ok = await as(t, reviewer, 'POST', `/v1/admin/kyc/submissions/${s.submissionId}/approve`, { livenessPassed: true, documentMatches: true, note: 'Foto KTP dan selfie cocok' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ status: 'APPROVED', kycLevel: 3 });
    const [u] = await t.adminSql<{ kyc_level: number }[]>`SELECT kyc_level FROM users WHERE id = ${s.userId}`;
    expect(u!.kyc_level).toBe(3);
    const ev = await t.adminSql<{ event_type: string; payload: any }[]>`SELECT event_type, payload FROM outbox_events WHERE aggregate_id = ${s.submissionId} AND event_type = 'kyc.approved'`;
    expect(ev[0]!.payload).toMatchObject({ userId: s.userId, submissionId: s.submissionId, targetLevel: 3 });
    const docs = await t.adminSql<{ status: string }[]>`SELECT status FROM kyc_documents WHERE submission_id = ${s.submissionId}`;
    expect(docs.every((d) => d.status === 'ACCEPTED')).toBe(true);
    const a = await auditRows(t, 'kyc.approved', s.submissionId);
    expect(a[0]!.meta).toMatchObject({ level: { from: 2, to: 3 } });
    const again = await as(t, reviewer, 'POST', `/v1/admin/kyc/submissions/${s.submissionId}/approve`, { livenessPassed: true, documentMatches: true });
    expect(again.body.error.code).toBe('KYC_NOT_REVIEWABLE');
  });

  it('reject needs a reason → REJECTED, kyc.rejected event; level unchanged', async () => {
    const s = await submitted();
    expect((await as(t, reviewer, 'POST', `/v1/admin/kyc/submissions/${s.submissionId}/reject`, {})).status).toBe(400);
    const res = await as(t, reviewer, 'POST', `/v1/admin/kyc/submissions/${s.submissionId}/reject`, { reason: 'Foto KTP buram, mohon unggah ulang', code: 'DOCUMENT_UNREADABLE' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'REJECTED', rejectionCode: 'DOCUMENT_UNREADABLE' });
    const [ev] = await t.adminSql<{ payload: any }[]>`SELECT payload FROM outbox_events WHERE aggregate_id = ${s.submissionId} AND event_type = 'kyc.rejected'`;
    expect(ev!.payload.reason).toBe('Foto KTP buram, mohon unggah ulang');
    const [u] = await t.adminSql<{ kyc_level: number }[]>`SELECT kyc_level FROM users WHERE id = ${s.userId}`;
    expect(u!.kyc_level).toBe(2);
  });
});

describe('payout account override & trip verification → level 4', () => {
  it('payout account override (MFA) + trip verified → trip.verified → drain → TRAVELER_VERIFIED (level 4)', async () => {
    const s = await submitted();
    await as(t, reviewer, 'POST', `/v1/admin/kyc/submissions/${s.submissionId}/approve`, { livenessPassed: true, documentMatches: true });
    const pa = await createPayoutAccount(t, s.userId, { verified: false });
    const q = await as(t, reviewer, 'GET', '/v1/admin/kyc/payout-accounts');
    expect(q.body.data.find((x: any) => x.id === pa)).toMatchObject({ verificationStatus: 'UNVERIFIED', bankCode: 'BCA' });
    const ov = await as(t, reviewer, 'POST', `/v1/admin/kyc/payout-accounts/${pa}/verification-override`, { status: 'VERIFIED', reason: 'Nama rekening sesuai buku tabungan' });
    expect(ov.status, JSON.stringify(ov.body)).toBe(200);
    expect(await auditRows(t, 'kyc.payout_account_override', pa)).toHaveLength(1);

    const [trip] = await t.adminSql<{ id: string }[]>`
      INSERT INTO trips (traveler_id, origin_country, origin_city, destination_country, destination_city, departure_date, arrival_date, capacity_kg, fee_type, fee_value)
      VALUES (${s.userId}, 'JP', 'Osaka', 'ID', 'Surabaya', '2026-11-10', '2026-11-11', 8, 'FIXED', 200000) RETURNING id`;
    await t.adminSql`SELECT transition_trip(${trip!.id}::uuid, 1, 'VERIFICATION_PENDING', 'TRAVELER', ${s.userId}::uuid)`;
    const [f] = await t.adminSql<{ id: string }[]>`
      INSERT INTO files (owner_id, purpose, storage_provider, storage_key, mime, size_bytes, scan_status, encrypted, enc_key_id)
      VALUES (${s.userId}, 'TRIP_DOC', 'MOCK', ${`td/${trip!.id}`}, 'application/pdf', 4096, 'CLEAN', true, ${t.deps.crypto.activeKeyId}) RETURNING id`;
    await t.adminSql`INSERT INTO trip_verifications (trip_id, doc_type, file_id, flight_number, flight_date) VALUES (${trip!.id}, 'ETICKET', ${f!.id}, 'GA885', '2026-11-10')`;

    expect((await as(t, support, 'GET', '/v1/admin/trips/verifications')).status).toBe(403);
    const queue = await as(t, ops, 'GET', '/v1/admin/trips/verifications');
    expect(queue.body.data.find((x: any) => x.id === trip!.id)).toMatchObject({ status: 'VERIFICATION_PENDING', pendingDocuments: 1 });
    const detail = await as(t, ops, 'GET', `/v1/admin/trips/${trip!.id}`);
    expect(detail.body.documents[0]).toMatchObject({ docType: 'ETICKET', flightNumber: 'GA885', status: 'PENDING' });

    const ok = await as(t, ops, 'POST', `/v1/admin/trips/${trip!.id}/verification/approve`, { note: 'E-ticket valid' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.status).toBe('VERIFIED');
    const [ev] = await t.adminSql<{ payload: any }[]>`SELECT payload FROM outbox_events WHERE event_type = 'trip.verified' AND aggregate_id = ${trip!.id}`;
    expect(ev!.payload).toEqual({ tripId: trip!.id, travelerId: s.userId, verifiedBy: 'ADMIN' });
    await t.drain();
    const [u] = await t.adminSql<{ kyc_level: number }[]>`SELECT kyc_level FROM users WHERE id = ${s.userId}`;
    expect(u!.kyc_level).toBe(4);
    expect(await auditRows(t, 'trips.verified', trip!.id)).toHaveLength(1);
  });

  it('reject returns the trip to DRAFT; a non-pending trip cannot be approved', async () => {
    const traveler = await t.createUser({ kycLevel: 3, mode: 'TRAVELER' });
    const [trip] = await t.adminSql<{ id: string }[]>`
      INSERT INTO trips (traveler_id, origin_country, origin_city, destination_country, destination_city, departure_date, arrival_date, capacity_kg, fee_type, fee_value)
      VALUES (${traveler.id}, 'SG', 'Singapore', 'ID', 'Jakarta', '2026-11-20', '2026-11-20', 5, 'FIXED', 100000) RETURNING id`;
    await t.adminSql`SELECT transition_trip(${trip!.id}::uuid, 1, 'VERIFICATION_PENDING', 'TRAVELER', ${traveler.id}::uuid)`;
    await t.adminSql`INSERT INTO trip_verifications (trip_id, doc_type, flight_number, flight_date) VALUES (${trip!.id}, 'ITINERARY', 'SQ956', '2026-11-20')`;
    const rej = await as(t, ops, 'POST', `/v1/admin/trips/${trip!.id}/verification/reject`, { reason: 'Nama penumpang tidak sesuai' });
    expect(rej.status, JSON.stringify(rej.body)).toBe(200);
    expect(rej.body.status).toBe('DRAFT');
    const again = await as(t, ops, 'POST', `/v1/admin/trips/${trip!.id}/verification/approve`, {});
    expect(again.body.error.code).toBe('TRIP_NOT_PENDING_VERIFICATION');
    void setTripStatus;
  });
});
