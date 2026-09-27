import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../../../../test/helpers';
import { recordRiskAssessment } from '../../../services/risk';
import { type Admin, as, auditRows, createAdmin } from '../test-support';

let t: TestContext;
let risk: Admin;
let riskNoMfa: Admin;
let compliance: Admin;
let support: Admin;
let superA: Admin;
let superB: Admin;

beforeAll(async () => {
  t = await createTestContext();
  risk = await createAdmin(t, ['RISK']);
  riskNoMfa = await createAdmin(t, ['RISK'], { mfa: false });
  compliance = await createAdmin(t, ['COMPLIANCE']);
  support = await createAdmin(t, ['SUPPORT']);
  superA = await createAdmin(t, ['SUPER_ADMIN']);
  superB = await createAdmin(t, ['SUPER_ADMIN']);
});
afterAll(async () => {
  await t.close();
});

async function userReview(userId: string) {
  await recordRiskAssessment(t.adminSql, 'USER', userId, { score: 85, decision: 'REVIEW', reasons: [{ code: 'MULTI_ACCOUNT_DEVICE' }] }, { deviceAccounts: 4 });
  const [r] = await t.adminSql<{ id: string }[]>`SELECT id FROM risk_reviews WHERE subject_type = 'USER' AND subject_id = ${userId} AND status = 'OPEN'`;
  return r!.id;
}

describe('risk reviews', () => {
  it('permissions: SUPPORT has no risk.read; COMPLIANCE reads but cannot resolve', async () => {
    const u = await t.createUser({ kycLevel: 2 });
    const id = await userReview(u.id);
    expect((await as(t, support, 'GET', '/v1/admin/risk/reviews')).status).toBe(403);
    const q = await as(t, compliance, 'GET', '/v1/admin/risk/reviews');
    expect(q.status, JSON.stringify(q.body)).toBe(200);
    expect(q.body.data.find((x: any) => x.id === id)).toMatchObject({ status: 'OPEN', subjectType: 'USER', subjectId: u.id });
    const d = await as(t, compliance, 'GET', `/v1/admin/risk/reviews/${id}`);
    expect(d.status).toBe(200);
    expect(d.body.assessment).toMatchObject({ score: 85, decision: 'REVIEW' });
    const denied = await as(t, compliance, 'POST', `/v1/admin/risk/reviews/${id}/resolve`, { outcome: 'CLEARED', notes: 'Perangkat keluarga, bukan fraud' });
    expect(denied.status).toBe(403);
  });

  it('resolve CLEARED needs MFA; emits risk.review_resolved with the user; audit', async () => {
    const u = await t.createUser({ kycLevel: 2 });
    const id = await userReview(u.id);
    const assign = await as(t, risk, 'POST', `/v1/admin/risk/reviews/${id}/assign`, {});
    expect(assign.status).toBe(200);
    expect((await as(t, riskNoMfa, 'POST', `/v1/admin/risk/reviews/${id}/resolve`, { outcome: 'CLEARED', notes: 'Perangkat keluarga, bukan fraud' })).body.error.code).toBe('MFA_REQUIRED');
    const ok = await as(t, risk, 'POST', `/v1/admin/risk/reviews/${id}/resolve`, { outcome: 'CLEARED', notes: 'Perangkat keluarga, bukan fraud' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ status: 'CLEARED', userId: u.id });
    const [ev] = await t.adminSql<{ payload: any }[]>`SELECT payload FROM outbox_events WHERE event_type = 'risk.review_resolved' AND aggregate_id = ${id}`;
    expect(ev!.payload).toMatchObject({ reviewId: id, subjectType: 'USER', subjectId: u.id, userId: u.id, outcome: 'CLEARED' });
    expect(await auditRows(t, 'risk.review_resolved', id)).toHaveLength(1);
    const again = await as(t, risk, 'POST', `/v1/admin/risk/reviews/${id}/resolve`, { outcome: 'CLEARED', notes: 'Perangkat keluarga, bukan fraud' });
    expect(again.body.error.code).toBe('RISK_REVIEW_CLOSED');
    await t.drain();
  });

  it('CONFIRMED_FRAUD + suspendUser suspends the account (RISK has users.suspend)', async () => {
    const u = await t.createUser({ kycLevel: 2 });
    const id = await userReview(u.id);
    const bad = await as(t, risk, 'POST', `/v1/admin/risk/reviews/${id}/resolve`, { outcome: 'CLEARED', notes: 'Tidak valid kombinasinya', suspendUser: true });
    expect(bad.status).toBe(400);
    const ok = await as(t, risk, 'POST', `/v1/admin/risk/reviews/${id}/resolve`, { outcome: 'CONFIRMED_FRAUD', notes: 'Akun ganda untuk farming referral', suspendUser: true });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.suspension).toMatchObject({ status: 'SUSPENDED' });
    const [row] = await t.adminSql<{ status: string }[]>`SELECT status FROM users WHERE id = ${u.id}`;
    expect(row!.status).toBe('SUSPENDED');
    await t.drain();
  });
});

describe('trust score overrides (maker-checker)', () => {
  it('RISK requests (MFA) → RISK cannot approve (no permission) → requester SUPER_ADMIN cannot self-approve → another SUPER_ADMIN applies', async () => {
    const u = await t.createUser({ kycLevel: 3 });
    const req = await as(t, risk, 'POST', '/v1/admin/trust/overrides', { userId: u.id, newScore: 80, reason: 'Riwayat transaksi luring terverifikasi' });
    expect(req.status, JSON.stringify(req.body)).toBe(201);
    expect(req.body).toMatchObject({ status: 'PENDING', previousScore: 50, newScore: 80 });
    const dup = await as(t, risk, 'POST', '/v1/admin/trust/overrides', { userId: u.id, newScore: 70, reason: 'Riwayat transaksi luring terverifikasi' });
    expect(dup.status).toBe(409);
    expect((await as(t, risk, 'POST', `/v1/admin/trust/overrides/${req.body.id}/approve`, {})).status).toBe(403);
    const ok = await as(t, superA, 'POST', `/v1/admin/trust/overrides/${req.body.id}/approve`, { note: 'OK' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ status: 'APPLIED', score: 80 });
    expect(await auditRows(t, 'trust.override_approved', u.id)).toHaveLength(1);

    const u2 = await t.createUser({ kycLevel: 3 });
    const own = await as(t, superA, 'POST', '/v1/admin/trust/overrides', { userId: u2.id, newScore: 20, reason: 'Keluhan berulang dari pembeli' });
    const self = await as(t, superA, 'POST', `/v1/admin/trust/overrides/${own.body.id}/approve`, {});
    expect(self.body.error.code).toBe('MAKER_CHECKER_VIOLATION');
    const rej = await as(t, superB, 'POST', `/v1/admin/trust/overrides/${own.body.id}/reject`, { note: 'Belum cukup bukti' });
    expect(rej.body.status).toBe('REJECTED');
    const selfScore = await as(t, risk, 'POST', '/v1/admin/trust/overrides', { userId: risk.id, newScore: 99, reason: 'Menaikkan skor sendiri' });
    expect(selfScore.body.error.code).toBe('MAKER_CHECKER_VIOLATION');
  });
});
