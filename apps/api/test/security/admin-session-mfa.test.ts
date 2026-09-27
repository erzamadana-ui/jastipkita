/**
 * SEC-01 (docs/security/review-2026-09.md): admin sessions must be MFA-verified SERVER-SIDE.
 * Before the fix the admin SPA's TOTP gate was a sessionStorage flag; an admin OTP session (phished / SIM-swapped)
 * could call every /v1/admin/* read and stream KYC documents without ever passing TOTP.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totpAt } from '../../src/lib/crypto';
import { createTestContext, type TestContext } from '../helpers';
import { phoneLogin } from '../../src/modules/auth/test-support';

let t: TestContext;
beforeAll(async () => {
  t = await createTestContext();
});
afterAll(() => t?.close());

const step = () => Math.floor(t.clock.now().getTime() / 30_000);

/** Logs in through the real OTP flow (no MFA) and grants the given admin role. */
async function otpAdmin(role: string) {
  const login = await phoneLogin(t);
  await t.adminSql`INSERT INTO user_roles (user_id, role_code, reason) VALUES (${login.user.id}, ${role}, 'sec test')`;
  return login;
}

describe('SEC-01 admin session MFA is enforced by the API', () => {
  it('an OTP-only admin session cannot read admin data; MFA enrollment/verify unlocks it and survives refresh', async () => {
    const admin = await otpAdmin('SUPER_ADMIN');
    const token = admin.tokens.accessToken;

    // 1. OTP-only session → every admin read is refused with MFA_REQUIRED (scope SESSION)
    for (const path of ['/v1/admin/users', '/v1/admin/transactions', '/v1/admin/kyc/submissions', '/v1/admin/audit-logs']) {
      const r = await t.request('GET', path, { token });
      expect(r.status, path).toBe(403);
      expect(r.body.error.code, path).toBe('MFA_REQUIRED');
      expect(r.body.error.details.scope).toBe('SESSION');
    }

    // 2. enrollment itself stays reachable without session MFA (otherwise nobody could enroll)
    const enr = await t.request('POST', '/v1/auth/mfa/totp/enroll', { token });
    expect(enr.status).toBe(200);
    const conf = await t.request('POST', '/v1/auth/mfa/totp/confirm', { token, body: { code: await totpAt(enr.body.secret, step()) } });
    expect(conf.status).toBe(200);

    // 3. the ORIGINAL access token (no mfa_at claim) now works: the session itself is MFA-verified
    expect((await t.request('GET', '/v1/admin/users', { token })).status).toBe(200);

    // 4. refresh rotation keeps the session MFA (the rotated access token carries no mfa_at)
    t.clock.advance(20 * 60_000);
    const ref = await t.request('POST', '/v1/auth/refresh', { body: { refreshToken: admin.tokens.refreshToken } });
    expect(ref.status).toBe(200);
    const rotated = ref.body.tokens.accessToken as string;
    const claims = JSON.parse(Buffer.from(rotated.split('.')[1]!, 'base64url').toString());
    expect(claims.mfa_at).toBeUndefined();
    expect((await t.request('GET', '/v1/admin/users', { token: rotated })).status).toBe(200);
    // ... but a sensitive write still needs a fresh (≤ 15 min) step-up
    const other = await t.createUser();
    const sus = await t.request('POST', `/v1/admin/users/${other.id}/suspend`, { token: rotated, body: { reason: 'uji keamanan sesi' } });
    expect(sus.status).toBe(403);
    expect(sus.body.error.code).toBe('MFA_REQUIRED');
    expect(sus.body.error.details?.scope).toBeUndefined();

    // 5. session MFA expires after ADMIN_SESSION_MFA_MAX_AGE_SEC (12 h default)
    t.clock.advance(12 * 3600_000);
    const ref2 = await t.request('POST', '/v1/auth/refresh', { body: { refreshToken: ref.body.tokens.refreshToken } });
    expect(ref2.status).toBe(200);
    const stale = await t.request('GET', '/v1/admin/users', { token: ref2.body.tokens.accessToken });
    expect(stale.status).toBe(403);
    expect(stale.body.error.code).toBe('MFA_REQUIRED');
    // a new TOTP verification renews it
    const ver = await t.request('POST', '/v1/auth/mfa/verify', { token: ref2.body.tokens.accessToken, body: { code: await totpAt(enr.body.secret, step()) } });
    expect(ver.status).toBe(200);
    expect((await t.request('GET', '/v1/admin/users', { token: ref2.body.tokens.accessToken })).status).toBe(200);
  });

  it('MFA verified on one session does not unlock another session of the same admin', async () => {
    const admin = await otpAdmin('OPERATIONS');
    const enr = await t.request('POST', '/v1/auth/mfa/totp/enroll', { token: admin.tokens.accessToken });
    await t.request('POST', '/v1/auth/mfa/totp/confirm', { token: admin.tokens.accessToken, body: { code: await totpAt(enr.body.secret, step()) } });
    expect((await t.request('GET', '/v1/admin/transactions', { token: admin.tokens.accessToken })).status).toBe(200);
    // attacker logs in with the (phished) OTP on another device → new session family, no MFA
    t.clock.advance(61_000); // OTP resend cooldown
    const second = await phoneLogin(t, admin.phone);
    expect(second.user.id).toBe(admin.user.id);
    const r = await t.request('GET', '/v1/admin/transactions', { token: second.tokens.accessToken });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('MFA_REQUIRED');
    // and cannot re-enroll a new authenticator to bypass it
    const re = await t.request('POST', '/v1/auth/mfa/totp/enroll', { token: second.tokens.accessToken });
    expect(re.status).toBe(409);
  });

  it('staff streaming of KYC documents requires the MFA-verified session', async () => {
    const owner = await t.createUser({ kycLevel: 2 });
    const [f] = await t.adminSql<{ id: string }[]>`
      INSERT INTO files (owner_id, purpose, storage_provider, storage_key, mime, size_bytes, scan_status, scanned_at, completed_at, encrypted, enc_key_id)
      VALUES (${owner.id}, 'KYC', 'MOCK', ${`kyc/enc/${crypto.randomUUID()}.jke`}, 'image/jpeg', 10, 'CLEAN', now(), now(), true, 'k1')
      RETURNING id`;
    const reviewer = await otpAdmin('OPERATIONS');
    const r = await t.request('GET', `/v1/files/${f!.id}/content`, { token: reviewer.tokens.accessToken });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('MFA_REQUIRED');
    const u = await t.request('GET', `/v1/files/${f!.id}/url`, { token: reviewer.tokens.accessToken });
    expect(u.status).toBe(403);
    // no audit row / security event claims the document was viewed
    const [a] = await t.adminSql<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'kyc.document_viewed' AND entity_id = ${f!.id}`;
    expect(a!.n).toBe(0);
  });
});
