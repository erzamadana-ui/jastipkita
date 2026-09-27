/**
 * SEC-12 / SEC-13 (docs/security/review-2026-09.md).
 *   SEC-12 — refund destinations and payout accounts need a fresh step-up: a SENSITIVE_ACTION OTP to the user's VERIFIED
 *   phone / e-mail, bound to action + target id, 10 minutes, single use. With a verified identity (≥ L3) a bank holder
 *   name that differs from the KYC name is never auto-accepted (refund destination → PENDING_REVIEW, FINANCE decides).
 *   SEC-13 — TOTP (re-)enrollment only from a fresh OTP-login session (≤ 15 min); a pending factor belongs to the session
 *   that started it; a confirmed factor is reset only by maker-checker (another SUPER_ADMIN approves).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totpAt } from '../../src/lib/crypto';
import { otpRequest, phoneLogin, sensitiveStepUp } from '../../src/modules/auth/test-support';
import { processRefunds } from '../../src/modules/refunds/service';
import { call, createMatchedTx, idem, quoteAndPay, seedFx, setupParties, txStatus, type Parties } from '../../src/modules/transactions/test-fixtures';
import { createTestContext, type TestContext } from '../helpers';

let t: TestContext;
let p: Parties;
beforeAll(async () => {
  t = await createTestContext();
  await seedFx(t);
  p = await setupParties(t);
});
afterAll(() => t?.close());

const step = () => Math.floor(t.clock.now().getTime() / 30_000);

/** Traveler cancels a VA-paid deal → refund that needs a buyer bank account (PAYOUT_TO_BUYER). */
async function vaRefund(): Promise<{ txId: string; refundId: string; totalIdr: number }> {
  const tx = await createMatchedTx(t, p);
  const { quote } = await quoteAndPay(t, p, tx, { channel: 'VA' });
  const res = await call(t, p.traveler, 'POST', `/v1/transactions/${tx.id}/cancel`, { reason: 'Jadwal berubah' }, idem());
  expect(res.body.status).toBe('REFUND_PENDING');
  const list = await call(t, p.buyer, 'GET', `/v1/transactions/${tx.id}/refunds`);
  return { txId: tx.id, refundId: list.body.data[0].id, totalIdr: quote.totalIdr };
}

async function giveVerifiedIdentity(userId: string, fullName: string) {
  const id = crypto.randomUUID();
  const enc = async (v: string, aad: string) => Buffer.from(await t.deps.crypto.encrypt(v, aad));
  const idNumber = `3171${String(Math.floor(Math.random() * 1e12)).padStart(12, '0')}`;
  await t.adminSql`
    INSERT INTO identity_records (id, user_id, id_type, id_number_enc, id_number_hash, full_name_enc, enc_key_id, verified_at)
    VALUES (${id}, ${userId}, 'KTP', ${await enc(idNumber, `identity_records.id_number:${id}`)},
            ${Buffer.from(await t.deps.crypto.hashIdentifier('id_number', `KTP:${idNumber}`))},
            ${await enc(fullName, `identity_records.full_name:${id}`)}, ${t.deps.crypto.activeKeyId}, now())
    ON CONFLICT (user_id) DO NOTHING`;
}

describe('SEC-12 step-up for money destinations', () => {
  it('SENSITIVE_ACTION OTP: bearer required, action + target required, verified destination only, 10-minute TTL', async () => {
    const u = p.buyer;
    const body = { channel: 'EMAIL', destination: u.email, purpose: 'SENSITIVE_ACTION', action: 'REFUND_DESTINATION_SET', targetId: crypto.randomUUID() };
    expect((await otpRequest(t, body)).status).toBe(401);
    const noTarget = await otpRequest(t, { ...body, targetId: undefined }, { token: u.accessToken, ip: '198.51.100.201' });
    expect(noTarget.status).toBe(400);
    expect(noTarget.body.error.code).toBe('STEP_UP_ACTION_REQUIRED');
    const foreign = await otpRequest(t, { ...body, action: 'PAYOUT_ACCOUNT_ADD', targetId: p.traveler.id }, { token: u.accessToken, ip: '198.51.100.202' });
    expect(foreign.status).toBe(422);
    expect(foreign.body.error.code).toBe('STEP_UP_TARGET_INVALID');
    const unverified = await otpRequest(t, { ...body, destination: 'someone-else@example.net' }, { token: u.accessToken, ip: '198.51.100.203' });
    expect(unverified.status).toBe(422);
    expect(unverified.body.error.code).toBe('STEP_UP_DESTINATION_NOT_VERIFIED');
    // the challenge row is bound to action + target and lives 10 minutes
    const proof = await sensitiveStepUp(t, u, 'REFUND_DESTINATION_SET', body.targetId);
    const [row] = await t.adminSql<{ purpose: string; action: string; target_id: string; created_at: Date; expires_at: Date }[]>`
      SELECT purpose, action, target_id, created_at, expires_at FROM otp_challenges WHERE id = ${proof.challengeId}`;
    expect(row).toMatchObject({ purpose: 'SENSITIVE_ACTION', action: 'REFUND_DESTINATION_SET', target_id: body.targetId });
    expect(row!.expires_at.getTime() - row!.created_at.getTime()).toBe(600_000);
  });

  it('refund destination: expired step-up refused; verified identity + different holder name → PENDING_REVIEW, paid only after FINANCE approval', async () => {
    const { txId, refundId, totalIdr } = await vaRefund();
    await giveVerifiedIdentity(p.buyer.id, 'Siti Rahmawati');
    const original = t.payment.validateBankAccount.bind(t.payment);
    t.payment.validateBankAccount = (async () => ({ valid: true, holderName: 'ANDI WIJAYA' })) as typeof t.payment.validateBankAccount;
    try {
      const dest = { bankCode: 'BCA', accountNumber: '7712340099', accountHolderName: 'Siti Rahmawati' };
      // a proof older than 10 minutes is useless
      const old = await sensitiveStepUp(t, p.buyer, 'REFUND_DESTINATION_SET', refundId);
      t.clock.advance(11 * 60_000);
      const expired = await call(t, p.buyer, 'POST', `/v1/refunds/${refundId}/destination`, { ...dest, stepUp: old });
      expect(expired.status).toBe(400);
      expect(expired.body.error.code).toBe('OTP_EXPIRED');
      // a proof for another refund is refused
      const other = await sensitiveStepUp(t, p.buyer, 'REFUND_DESTINATION_SET', crypto.randomUUID());
      const mism = await call(t, p.buyer, 'POST', `/v1/refunds/${refundId}/destination`, { ...dest, stepUp: other });
      expect(mism.status).toBe(403);
      expect(mism.body.error.code).toBe('STEP_UP_MISMATCH');

      const set = await call(t, p.buyer, 'POST', `/v1/refunds/${refundId}/destination`, { ...dest, stepUp: await sensitiveStepUp(t, p.buyer, 'REFUND_DESTINATION_SET', refundId) });
      expect(set.status, JSON.stringify(set.body)).toBe(200);
      expect(set.body).toMatchObject({ validationStatus: 'PENDING_REVIEW', reviewRequired: true, validatedAt: null });
      const [d] = await t.adminSql<{ id: string; name_match: string; step_up_challenge_id: string | null }[]>`
        SELECT id, name_match, step_up_challenge_id FROM refund_destinations WHERE refund_id = ${refundId}`;
      expect(d).toMatchObject({ name_match: 'MISMATCH' });
      expect(d!.step_up_challenge_id).toBeTruthy();
      expect((await t.adminSql`SELECT 1 FROM security_events WHERE user_id = ${p.buyer.id} AND type = 'REFUND_DESTINATION_NAME_MISMATCH'`).length).toBe(1);

      // never paid out while under review
      await processRefunds(t.deps, { transactionId: txId });
      expect(t.payment.payouts.find((x) => x.accountNumber === '7712340099')).toBeUndefined();
      expect(await txStatus(t, txId)).toBe('REFUND_PENDING');

      // FINANCE queue + decision (refunds.approve + MFA + Idempotency-Key); the buyer can never review their own
      const finance = await t.createUser({ roles: ['FINANCE'], mfa: true });
      const queue = await t.request('GET', '/v1/admin/refund-destinations', { token: finance.accessToken });
      expect(queue.status).toBe(200);
      const item = queue.body.data.find((x: any) => x.refundId === refundId);
      expect(item).toMatchObject({ id: d!.id, validationStatus: 'PENDING_REVIEW', nameMatch: 'MISMATCH', accountMask: '****0099', canReview: true });
      expect(JSON.stringify(queue.body)).not.toContain('7712340099');
      const noKey = await t.request('POST', `/v1/admin/refund-destinations/${d!.id}/review`, { token: finance.accessToken, body: { decision: 'APPROVE', note: 'Rekening suami, dikonfirmasi via telepon' } });
      expect(noKey.status).toBe(400);
      const ok = await t.request('POST', `/v1/admin/refund-destinations/${d!.id}/review`, {
        token: finance.accessToken,
        body: { decision: 'APPROVE', note: 'Rekening suami, dikonfirmasi via telepon' },
        headers: idem(),
      });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(ok.body.validationStatus).toBe('VALID');
      expect(await txStatus(t, txId)).toBe('REFUNDED');
      expect(t.payment.payouts.find((x) => x.accountNumber === '7712340099')?.amountIdr).toBe(totalIdr);
      const again = await t.request('POST', `/v1/admin/refund-destinations/${d!.id}/review`, { token: finance.accessToken, body: { decision: 'REJECT', note: 'terlambat' }, headers: idem() });
      expect(again.status).toBe(409);
      expect((await t.adminSql`SELECT 1 FROM audit_logs WHERE action = 'refund.destination_reviewed' AND entity_id = ${refundId}`).length).toBe(1);
    } finally {
      t.payment.validateBankAccount = original;
    }
  });

  it('refund destination rejected by FINANCE → buyer asked again; matching name is accepted directly', async () => {
    const { refundId } = await vaRefund();
    const original = t.payment.validateBankAccount.bind(t.payment);
    try {
      t.payment.validateBankAccount = (async () => ({ valid: true, holderName: 'BUKAN PEMILIK' })) as typeof t.payment.validateBankAccount;
      const sms = { channel: 'SMS' as const, destination: p.buyer.phone }; // the e-mail destination used its hourly budget above
      const set = await call(t, p.buyer, 'POST', `/v1/refunds/${refundId}/destination`, {
        bankCode: 'BNI', accountNumber: '8812340077', accountHolderName: 'Siti Rahmawati', stepUp: await sensitiveStepUp(t, p.buyer, 'REFUND_DESTINATION_SET', refundId, sms),
      });
      expect(set.body.validationStatus).toBe('PENDING_REVIEW');
      const [d] = await t.adminSql<{ id: string }[]>`SELECT id FROM refund_destinations WHERE refund_id = ${refundId}`;
      const finance = await t.createUser({ roles: ['FINANCE'], mfa: true });
      const rej = await t.request('POST', `/v1/admin/refund-destinations/${d!.id}/review`, { token: finance.accessToken, body: { decision: 'REJECT', note: 'Nama tidak cocok, minta rekening sendiri' }, headers: idem() });
      expect(rej.body.validationStatus).toBe('REJECTED');
      t.payment.validateBankAccount = (async () => ({ valid: true, holderName: 'SITI RAHMAWATI' })) as typeof t.payment.validateBankAccount;
      const fix = await call(t, p.buyer, 'POST', `/v1/refunds/${refundId}/destination`, {
        bankCode: 'BNI', accountNumber: '8812340088', accountHolderName: 'Siti Rahmawati', stepUp: await sensitiveStepUp(t, p.buyer, 'REFUND_DESTINATION_SET', refundId, sms),
      });
      expect(fix.body).toMatchObject({ validationStatus: 'VALID', reviewRequired: false });
      const [after] = await t.adminSql<{ name_match: string; reviewed_by: string | null }[]>`SELECT name_match, reviewed_by FROM refund_destinations WHERE refund_id = ${refundId}`;
      expect(after).toMatchObject({ name_match: 'MATCH', reviewed_by: null });
    } finally {
      t.payment.validateBankAccount = original;
    }
  });
});

describe('SEC-13 TOTP enrollment trust-on-first-use window', () => {
  async function otpAdmin(role = 'OPERATIONS') {
    const login = await phoneLogin(t);
    await t.adminSql`INSERT INTO user_roles (user_id, role_code, reason) VALUES (${login.user.id}, ${role}, 'sec test')`;
    return login;
  }

  it('enrollment needs an OTP-login session younger than 15 minutes (a refreshed old session does not count)', async () => {
    const a = await otpAdmin();
    const [rt] = await t.adminSql<{ auth_method: string; session_started_at: Date }[]>`
      SELECT auth_method, session_started_at FROM refresh_tokens WHERE family_id = ${a.tokens.sessionId} LIMIT 1`;
    expect(rt!.auth_method).toBe('OTP');
    t.clock.advance(16 * 60_000);
    const ref = await t.request('POST', '/v1/auth/refresh', { body: { refreshToken: a.tokens.refreshToken } });
    expect(ref.status).toBe(200);
    const [rot] = await t.adminSql<{ auth_method: string; session_started_at: Date }[]>`
      SELECT auth_method, session_started_at FROM refresh_tokens WHERE family_id = ${a.tokens.sessionId} AND revoked_at IS NULL`;
    expect(rot).toMatchObject({ auth_method: 'OTP', session_started_at: rt!.session_started_at }); // copied on rotation
    const stale = await t.request('POST', '/v1/auth/mfa/totp/enroll', { token: ref.body.tokens.accessToken });
    expect(stale.status).toBe(403);
    expect(stale.body.error).toMatchObject({ code: 'MFA_ENROLL_FRESH_LOGIN_REQUIRED', details: { requiredAuthMethod: 'OTP' } });
    // a fresh OTP login works
    const again = await phoneLogin(t, a.phone);
    expect((await t.request('POST', '/v1/auth/mfa/totp/enroll', { token: again.tokens.accessToken })).status).toBe(200);
  });

  it('a pending factor belongs to its session: another session can neither confirm nor replace it (until 15 min pass)', async () => {
    const a = await otpAdmin();
    const enr = await t.request('POST', '/v1/auth/mfa/totp/enroll', { token: a.tokens.accessToken });
    expect(enr.status).toBe(200);
    t.clock.advance(61_000);
    const b = await phoneLogin(t, a.phone); // second session (e.g. an attacker with a stolen OTP)
    const replace = await t.request('POST', '/v1/auth/mfa/totp/enroll', { token: b.tokens.accessToken });
    expect(replace.status).toBe(409);
    expect(replace.body.error.code).toBe('MFA_ENROLLMENT_IN_PROGRESS');
    const confirmOther = await t.request('POST', '/v1/auth/mfa/totp/confirm', { token: b.tokens.accessToken, body: { code: await totpAt(enr.body.secret, step()) } });
    expect(confirmOther.status).toBe(403);
    expect(confirmOther.body.error.code).toBe('MFA_ENROLL_SESSION_MISMATCH');
    // the owner may restart its own enrollment (new secret) and confirm it
    const re = await t.request('POST', '/v1/auth/mfa/totp/enroll', { token: a.tokens.accessToken });
    expect(re.status).toBe(200);
    expect(re.body.secret).not.toBe(enr.body.secret);
    const conf = await t.request('POST', '/v1/auth/mfa/totp/confirm', { token: a.tokens.accessToken, body: { code: await totpAt(re.body.secret, step()) } });
    expect(conf.status).toBe(200);
    // confirmed → no self-service re-enrollment, even from a fresh session
    t.clock.advance(61_000);
    const c = await phoneLogin(t, a.phone);
    const reset = await t.request('POST', '/v1/auth/mfa/totp/enroll', { token: c.tokens.accessToken });
    expect(reset.status).toBe(409);
    expect(reset.body.error.code).toBe('MFA_ALREADY_ENROLLED');
  });

  it('a confirmed factor is reset only by maker-checker: requester ≠ approver (another SUPER_ADMIN, fresh MFA) ≠ subject', async () => {
    t.clock.set(new Date()); // the DB guard checks MFA freshness against the database clock
    const subject = await otpAdmin('FINANCE');
    const enr = await t.request('POST', '/v1/auth/mfa/totp/enroll', { token: subject.tokens.accessToken });
    await t.request('POST', '/v1/auth/mfa/totp/confirm', { token: subject.tokens.accessToken, body: { code: await totpAt(enr.body.secret, step()) } });
    const maker = await t.createUser({ roles: ['SUPER_ADMIN'], mfa: true });
    const checker = await t.createUser({ roles: ['SUPER_ADMIN'], mfa: true });
    const ops = await t.createUser({ roles: ['OPERATIONS'], mfa: true });

    expect((await t.request('POST', `/v1/admin/users/${subject.user.id}/mfa-reset-requests`, { token: ops.accessToken, body: { reason: 'HP admin hilang, perlu reset' } })).status).toBe(403);
    const selfReq = await t.request('POST', `/v1/admin/users/${maker.id}/mfa-reset-requests`, { token: maker.accessToken, body: { reason: 'reset authenticator sendiri' } });
    expect(selfReq.status).toBe(403);
    const req = await t.request('POST', `/v1/admin/users/${subject.user.id}/mfa-reset-requests`, { token: maker.accessToken, body: { reason: 'HP admin hilang, perlu reset' } });
    expect(req.status, JSON.stringify(req.body)).toBe(202);
    expect(req.body.status).toBe('PENDING');
    const dup = await t.request('POST', `/v1/admin/users/${subject.user.id}/mfa-reset-requests`, { token: checker.accessToken, body: { reason: 'HP admin hilang, perlu reset' } });
    expect(dup.status).toBe(409);
    // the requester cannot approve their own request
    const selfApprove = await t.request('POST', `/v1/admin/rbac/mfa-reset-requests/${req.body.id}/approve`, { token: maker.accessToken, body: {} });
    expect(selfApprove.status).toBe(403);
    expect(selfApprove.body.error.code).toBe('MAKER_CHECKER_VIOLATION');
    // nothing changed yet: the subject's factor still works
    expect((await t.request('GET', '/v1/admin/payouts', { token: subject.tokens.accessToken })).status).toBe(200);

    const list = await t.request('GET', '/v1/admin/rbac/mfa-reset-requests?status=PENDING', { token: checker.accessToken });
    expect(list.body.data.map((r: any) => r.id)).toContain(req.body.id);
    const ok = await t.request('POST', `/v1/admin/rbac/mfa-reset-requests/${req.body.id}/approve`, { token: checker.accessToken, body: { note: 'Identitas diverifikasi via video call' } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ status: 'APPLIED', userId: subject.user.id });
    expect(ok.body.sessionsRevoked).toBeGreaterThanOrEqual(1);
    // factor disabled, recovery codes gone, sessions revoked, HIGH security event
    expect((await t.adminSql`SELECT 1 FROM mfa_factors WHERE user_id = ${subject.user.id} AND disabled_at IS NULL`).length).toBe(0);
    expect((await t.adminSql`SELECT 1 FROM mfa_recovery_codes WHERE user_id = ${subject.user.id}`).length).toBe(0);
    expect((await t.request('POST', '/v1/auth/refresh', { body: { refreshToken: subject.tokens.refreshToken } })).status).toBe(401);
    const [ev] = await t.adminSql<{ severity: string }[]>`SELECT severity FROM security_events WHERE user_id = ${subject.user.id} AND type = 'MFA_RESET'`;
    expect(ev!.severity).toBe('HIGH');
    // the DB keeps the history immutable
    await expect(t.adminSql`UPDATE admin_mfa_reset_requests SET reason = 'diubah setelahnya' WHERE id = ${req.body.id}`).rejects.toThrow();
    // the subject re-enrolls from a fresh OTP login
    t.clock.advance(61_000);
    const fresh = await phoneLogin(t, subject.phone);
    expect((await t.request('POST', '/v1/auth/mfa/totp/enroll', { token: fresh.tokens.accessToken })).status).toBe(200);
  });
});
