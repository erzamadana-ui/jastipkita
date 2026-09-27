import { issueSession } from '../../../services/session';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext, type TestUser } from '../../../../test/helpers';
import { type Admin, as, auditRows, createAdmin } from '../test-support';

let t: TestContext;
let superA: Admin;
let superB: Admin;
let superNoMfa: Admin;
let support: Admin;
let risk: Admin;
let marketing: Admin;
let target: TestUser;

beforeAll(async () => {
  t = await createTestContext();
  superA = await createAdmin(t, ['SUPER_ADMIN']);
  superB = await createAdmin(t, ['SUPER_ADMIN']);
  superNoMfa = await createAdmin(t, ['SUPER_ADMIN'], { mfa: false });
  support = await createAdmin(t, ['SUPPORT']);
  risk = await createAdmin(t, ['RISK']);
  marketing = await createAdmin(t, ['MARKETING']);
  target = await t.createUser({ kycLevel: 2, email: 'rina.pratiwi@example.com', phone: '+6281234567890', displayName: 'Rina Pratiwi' });
});
afterAll(async () => {
  await t.close();
});

describe('user search & detail (PII masked)', () => {
  it('search masks e-mail / phone / name; MARKETING (no users.read) is denied', async () => {
    const res = await as(t, support, 'GET', '/v1/admin/users?q=rina.pratiwi@');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toHaveLength(1);
    const u = res.body.data[0];
    expect(u).toMatchObject({ id: target.id, email: 'r***@example.com', phone: '+6281****890', displayName: 'Rina P.', piiMasked: true, kycLevel: 2 });
    expect(JSON.stringify(res.body)).not.toContain('rina.pratiwi@example.com');
    expect(JSON.stringify(res.body)).not.toContain('+6281234567890');
    const byPhone = await as(t, support, 'GET', '/v1/admin/users?q=081234567890');
    expect(byPhone.body.data.map((x: any) => x.id)).toContain(target.id);
    const denied = await as(t, marketing, 'GET', '/v1/admin/users');
    expect(denied.status).toBe(403);
    expect(denied.body.error).toMatchObject({ code: 'PERMISSION_DENIED', details: { missing: ['users.read'] } });
  });

  it('detail shows KYC, trust, risk, transactions summary, sessions — still masked', async () => {
    const res = await as(t, support, 'GET', `/v1/admin/users/${target.id}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ id: target.id, email: 'r***@example.com', kyc: { level: 2, levelCode: 'PHONE_VERIFIED' }, devices: { count: 0 } });
    expect(res.body.sessions.length).toBeGreaterThanOrEqual(1);
    expect(res.body.transactions.asBuyer.total).toBe(0);
    expect(res.body.trust.score).toBe(50);
  });

  it('reveal requires MFA and is audited + security event', async () => {
    const noMfa = await as(t, superNoMfa, 'POST', `/v1/admin/users/${target.id}/reveal-contact`, { reason: 'Konfirmasi identitas via telepon' });
    expect(noMfa.status).toBe(403);
    expect(noMfa.body.error.code).toBe('MFA_REQUIRED');
    const res = await as(t, support, 'POST', `/v1/admin/users/${target.id}/reveal-contact`, { reason: 'Konfirmasi identitas via telepon' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ email: 'rina.pratiwi@example.com', phone: '+6281234567890', displayName: 'Rina Pratiwi' });
    const a = await auditRows(t, 'users.pii_revealed', target.id);
    expect(a).toHaveLength(1);
    expect(a[0]!.actor_id).toBe(support.id);
    expect(JSON.stringify(a[0])).not.toContain('rina.pratiwi@example.com');
    const [sec] = await t.adminSql`SELECT severity FROM security_events WHERE type = 'ADMIN_PII_REVEALED' AND user_id = ${support.id}`;
    expect(sec!.severity).toBe('MEDIUM');
  });
});

describe('suspend / reactivate / force logout', () => {
  it('SUPPORT cannot suspend; RISK suspends with reason → sessions revoked → user gets 401', async () => {
    const victim = await t.createUser({ kycLevel: 2 });
    const denied = await as(t, support, 'POST', `/v1/admin/users/${victim.id}/suspend`, { reason: 'Penipuan terkonfirmasi' });
    expect(denied.status).toBe(403);
    const noReason = await as(t, risk, 'POST', `/v1/admin/users/${victim.id}/suspend`, {});
    expect(noReason.status).toBe(400);
    const res = await as(t, risk, 'POST', `/v1/admin/users/${victim.id}/suspend`, { reason: 'Penipuan terkonfirmasi' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ status: 'SUSPENDED', sessionsRevoked: 1 });
    const me = await t.request('GET', '/v1/me', { token: victim.accessToken });
    expect(me.status).toBe(401);
    const again = await as(t, risk, 'POST', `/v1/admin/users/${victim.id}/suspend`, { reason: 'Penipuan terkonfirmasi' });
    expect(again.status).toBe(422);
    const re = await as(t, risk, 'POST', `/v1/admin/users/${victim.id}/reactivate`, { reason: 'Banding diterima' });
    expect(re.status).toBe(200);
    const [u] = await t.adminSql<{ status: string }[]>`SELECT status FROM users WHERE id = ${victim.id}`;
    expect(u!.status).toBe('ACTIVE');
    expect((await auditRows(t, 'users.suspended', victim.id))).toHaveLength(1);
    expect((await auditRows(t, 'users.reactivated', victim.id))).toHaveLength(1);
  });

  it('cannot suspend yourself; force logout revokes every session', async () => {
    const self = await as(t, risk, 'POST', `/v1/admin/users/${risk.id}/suspend`, { reason: 'uji coba sendiri' });
    expect(self.status).toBe(422);
    const u = await t.createUser({ kycLevel: 1 });
    const res = await as(t, risk, 'POST', `/v1/admin/users/${u.id}/force-logout`, { reason: 'Perangkat hilang' });
    expect(res.status).toBe(200);
    expect(res.body.sessionsRevoked).toBe(1);
    expect((await t.request('GET', '/v1/me', { token: u.accessToken })).status).toBe(401);
  });
});

describe('RBAC & privileged role maker-checker', () => {
  it('non-privileged role is granted directly (rbac.manage + MFA); RISK cannot manage roles', async () => {
    const u = await t.createUser({ kycLevel: 2 });
    const denied = await as(t, risk, 'POST', `/v1/admin/users/${u.id}/roles`, { roleCode: 'SUPPORT', reason: 'Bergabung dengan tim CS' });
    expect(denied.status).toBe(403);
    const noMfa = await as(t, superNoMfa, 'POST', `/v1/admin/users/${u.id}/roles`, { roleCode: 'SUPPORT', reason: 'Bergabung dengan tim CS' });
    expect(noMfa.body.error.code).toBe('MFA_REQUIRED');
    const res = await as(t, superA, 'POST', `/v1/admin/users/${u.id}/roles`, { roleCode: 'SUPPORT', reason: 'Bergabung dengan tim CS' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe('GRANTED');
    // SEC-01: the new role only works from an MFA-verified session
    const noMfaSession = await t.request('GET', '/v1/admin/support/tickets', { token: u.accessToken });
    expect(noMfaSession.status).toBe(403);
    expect(noMfaSession.body.error.code).toBe('MFA_REQUIRED');
    const mfaSession = await issueSession(t.deps, t.sql, u.id, { mfaAt: Math.floor(t.clock.now().getTime() / 1000) });
    u.accessToken = mfaSession.accessToken;
    const tickets = await t.request('GET', '/v1/admin/support/tickets', { token: u.accessToken });
    expect(tickets.status).toBe(200);
    const dup = await as(t, superA, 'POST', `/v1/admin/users/${u.id}/roles`, { roleCode: 'SUPPORT', reason: 'Bergabung dengan tim CS' });
    expect(dup.status).toBe(409);
    const rev = await t.request('DELETE', `/v1/admin/users/${u.id}/roles/SUPPORT`, { token: superA.accessToken, body: { reason: 'Pindah divisi' } });
    expect(rev.status, JSON.stringify(rev.body)).toBe(200);
    expect((await t.request('GET', '/v1/admin/support/tickets', { token: u.accessToken })).status).toBe(403);
    expect(await auditRows(t, 'rbac.role_granted', u.id)).toHaveLength(1);
    expect(await auditRows(t, 'rbac.role_revoked', u.id)).toHaveLength(1);
  });

  it('SUPER_ADMIN grant → 202 request; requester/subject cannot approve; another SUPER_ADMIN approves', async () => {
    const cand = await t.createUser({ kycLevel: 2 });
    const res = await as(t, superA, 'POST', `/v1/admin/users/${cand.id}/roles`, { roleCode: 'SUPER_ADMIN', reason: 'CTO baru bergabung, akses penuh' });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(res.body.status).toBe('PENDING_APPROVAL');
    const reqId = res.body.requestId;
    const [none] = await t.adminSql`SELECT 1 FROM user_roles WHERE user_id = ${cand.id} AND role_code = 'SUPER_ADMIN'`;
    expect(none).toBeUndefined();
    const self = await as(t, superA, 'POST', `/v1/admin/rbac/role-requests/${reqId}/approve`, {});
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe('MAKER_CHECKER_VIOLATION');
    const noMfa = await as(t, superNoMfa, 'POST', `/v1/admin/rbac/role-requests/${reqId}/approve`, {});
    expect(noMfa.body.error.code).toBe('MFA_REQUIRED');
    const ok = await as(t, superB, 'POST', `/v1/admin/rbac/role-requests/${reqId}/approve`, { note: 'Disetujui' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.status).toBe('APPLIED');
    const [granted] = await t.adminSql<{ granted_by: string }[]>`SELECT granted_by FROM user_roles WHERE user_id = ${cand.id} AND role_code = 'SUPER_ADMIN' AND revoked_at IS NULL`;
    expect(granted!.granted_by).toBe(superB.id);
    const again = await as(t, superB, 'POST', `/v1/admin/rbac/role-requests/${reqId}/approve`, {});
    expect(again.status).toBe(422);
    expect(await auditRows(t, 'rbac.privileged_role_granted', cand.id)).toHaveLength(1);
    const list = await as(t, superA, 'GET', '/v1/admin/rbac/role-requests?status=APPLIED');
    expect(list.body.data.map((x: any) => x.id)).toContain(reqId);
  });

  it('never revoke your own SUPER_ADMIN; roles endpoint lists the least-privilege matrix', async () => {
    const own = await t.request('DELETE', `/v1/admin/users/${superA.id}/roles/SUPER_ADMIN`, { token: superA.accessToken, body: { reason: 'coba cabut sendiri' } });
    expect(own.status).toBe(422);
    expect(own.body.error.code).toBe('CANNOT_REVOKE_OWN_SUPER_ADMIN');
    const roles = await as(t, superA, 'GET', '/v1/admin/rbac/roles');
    const fsa = roles.body.roles.find((r: any) => r.code === 'FINANCE_SUPER_ADMIN');
    expect(fsa.permissions).toContain('finance.settlement.approve_change');
    expect(fsa.privileged).toBe(true);
    const sa = roles.body.roles.find((r: any) => r.code === 'SUPER_ADMIN');
    expect(sa.permissions).not.toContain('finance.settlement.approve_change');
  });
});
