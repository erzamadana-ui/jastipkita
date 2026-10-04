import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totpAt } from '../../lib/crypto';
import { createTestContext, type TestContext } from '../../../test/helpers';
import { appleSignIn, CONSENTS, installOAuthTestKeys, otpRequest, otpVerify, phoneLogin, type OAuthTestKeys } from './test-support';

let t: TestContext;
let keys: OAuthTestKeys;
beforeAll(async () => {
  t = await createTestContext();
  keys = await installOAuthTestKeys(t);
});
afterAll(async () => {
  await t.close();
});

const google = (body: Record<string, unknown>) => t.request('POST', '/v1/auth/google', { body });
const apple = (body: Record<string, unknown>) => t.request('POST', '/v1/auth/apple', { body });

describe('Google sign-in', () => {
  it('valid token creates a level-1 account; login e-mail is not the transaction e-mail', async () => {
    const email = `g-${Date.now()}@gmail.com`;
    const idToken = await keys.sign('GOOGLE', { sub: 'google-sub-1', email, email_verified: true, name: 'Budi Santoso' });
    const res = await google({ idToken, consents: CONSENTS });
    expect(res.status).toBe(200);
    expect(res.body.isNewUser).toBe(true);
    expect(res.body.user.email).toBe(email);
    expect(res.body.user.emailVerified).toBe(true);
    expect(res.body.user.displayName).toBe('Budi Santoso');
    expect(res.body.user.kycLevel).toBe(1);
    expect(res.body.user.transactionEmail).toBeNull();
    const [ev] = await t.adminSql<{ payload: any }[]>`SELECT payload FROM outbox_events WHERE event_type = 'user.registered' AND aggregate_id = ${res.body.user.id}`;
    expect(ev!.payload.method).toBe('GOOGLE');
    // second sign-in → same account
    const again = await google({ idToken: await keys.sign('GOOGLE', { sub: 'google-sub-1', email, email_verified: true }) });
    expect(again.status).toBe(200);
    expect(again.body.isNewUser).toBe(false);
    expect(again.body.user.id).toBe(res.body.user.id);
  });

  it('rejects a wrong audience, an expired token, a foreign issuer and a bad signature', async () => {
    const claims = { sub: 'google-sub-2', email: 'x2@gmail.com', email_verified: true };
    const wrongAud = await google({ idToken: await keys.sign('GOOGLE', claims, { aud: 'someone-else' }), consents: CONSENTS });
    expect(wrongAud.status).toBe(401);
    expect(wrongAud.body.error.code).toBe('OAUTH_TOKEN_INVALID');
    expect(wrongAud.body.error.details.reason).toBe('AUDIENCE_MISMATCH');
    const expired = await google({ idToken: await keys.sign('GOOGLE', claims, { expSec: -120 }), consents: CONSENTS });
    expect(expired.status).toBe(401);
    expect(expired.body.error.details.reason).toBe('TOKEN_EXPIRED');
    const iss = await google({ idToken: await keys.sign('GOOGLE', claims, { iss: 'https://evil.example.com' }), consents: CONSENTS });
    expect(iss.body.error.details.reason).toBe('ISSUER_MISMATCH');
    // signed by the Apple key but claiming a Google kid
    const forged = await google({ idToken: await keys.sign('APPLE', claims, { iss: 'https://accounts.google.com', aud: 'test-google-client-id', kid: 'a1' }), consents: CONSENTS });
    expect(forged.status).toBe(401);
    const [n] = await t.adminSql<{ n: number }[]>`SELECT count(*)::int AS n FROM security_events WHERE type = 'LOGIN_FAILED' AND meta->>'method' = 'GOOGLE'`;
    expect(n!.n).toBeGreaterThanOrEqual(4);
    const [u] = await t.adminSql`SELECT id FROM users WHERE email = 'x2@gmail.com'`;
    expect(u).toBeUndefined();
  });

  it('rejects an unverified e-mail', async () => {
    const res = await google({ idToken: await keys.sign('GOOGLE', { sub: 'google-sub-3', email: 'unverified@gmail.com', email_verified: false }), consents: CONSENTS });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('OAUTH_EMAIL_UNVERIFIED');
  });

  it('requires consents for a new account', async () => {
    const res = await google({ idToken: await keys.sign('GOOGLE', { sub: 'google-sub-4', email: 'c4@gmail.com', email_verified: true }) });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('CONSENT_REQUIRED');
  });

  it('checks the nonce when the client sends one', async () => {
    const nonce = 'web-nonce-abcdefghijklmnop';
    const tok = await keys.sign('GOOGLE', { sub: 'google-sub-5', email: 'n5@gmail.com', email_verified: true, nonce });
    expect((await google({ idToken: tok, nonce: 'web-nonce-zzzzzzzzzzzzzzzz', consents: CONSENTS })).body.error.details.reason).toBe('NONCE_MISMATCH');
    expect((await google({ idToken: tok, nonce, consents: CONSENTS })).status).toBe(200);
    // too short to be a nonce
    expect((await google({ idToken: tok, nonce: 'abc', consents: CONSENTS })).status).toBe(400);
  });
});

describe('Sign in with Apple', () => {
  it('private-relay e-mail, name only on first login', async () => {
    const relay = `abc${Date.now()}@privaterelay.appleid.com`;
    const first = await appleSignIn(keys, { sub: 'apple-sub-1', email: relay, email_verified: 'true', is_private_email: 'true' });
    const res = await apple({ ...first, fullName: { givenName: 'Siti', familyName: 'Rahma' }, consents: CONSENTS });
    expect(res.status).toBe(200);
    expect(res.body.isNewUser).toBe(true);
    expect(res.body.user.email).toBe(relay);
    expect(res.body.user.displayName).toBe('Siti Rahma');
    // later logins carry no name; the stored one is kept
    const again = await apple(await appleSignIn(keys, { sub: 'apple-sub-1', email: relay, email_verified: 'true' }));
    expect(again.body.user.displayName).toBe('Siti Rahma');
    expect(again.body.isNewUser).toBe(false);
  });

  it('wrong audience / expired are rejected', async () => {
    const wrong = await apple({ ...(await appleSignIn(keys, { sub: 'apple-sub-2' }, { aud: 'com.other.app' })), consents: CONSENTS });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.details.reason).toBe('AUDIENCE_MISMATCH');
    const expired = await apple({ ...(await appleSignIn(keys, { sub: 'apple-sub-2' }, { expSec: -300 })), consents: CONSENTS });
    expect(expired.body.error.details.reason).toBe('TOKEN_EXPIRED');
  });

  it('Apple without a verified e-mail signs in by subject only (no linking)', async () => {
    const owner = await t.createUser({ email: `shared-${Date.now()}@example.com` });
    const res = await apple({ ...(await appleSignIn(keys, { sub: 'apple-sub-3', email: owner.email, email_verified: 'false' })), consents: CONSENTS });
    expect(res.status).toBe(200);
    expect(res.body.user.id).not.toBe(owner.id);
    expect(res.body.user.email).toBeNull();
  });
});

describe('account linking by verified e-mail', () => {
  it('e-mail OTP account + Google + Apple with the same verified e-mail → one account', async () => {
    const email = `link-${Date.now()}@example.com`;
    const req = await otpRequest(t, { channel: 'EMAIL', destination: email, purpose: 'LOGIN' });
    const first = await otpVerify(t, { challengeId: req.body.challengeId, code: req.body.devCode, consents: CONSENTS });
    expect(first.status).toBe(200);
    const uid = first.body.user.id;
    const g = await google({ idToken: await keys.sign('GOOGLE', { sub: 'google-link-1', email, email_verified: true }) });
    expect(g.status).toBe(200);
    expect(g.body.user.id).toBe(uid);
    expect(g.body.isNewUser).toBe(false);
    const a = await apple(await appleSignIn(keys, { sub: 'apple-link-1', email, email_verified: true }));
    expect(a.body.user.id).toBe(uid);
    const ids = await t.adminSql<{ provider: string }[]>`SELECT provider FROM auth_identities WHERE user_id = ${uid} ORDER BY provider`;
    expect(ids.map((i) => i.provider)).toEqual(['APPLE', 'EMAIL', 'GOOGLE']);
    const [linked] = await t.adminSql<{ n: number }[]>`SELECT count(*)::int AS n FROM security_events WHERE user_id = ${uid} AND type = 'ACCOUNT_LINKED'`;
    expect(linked!.n).toBe(2);
    // and back: e-mail OTP after Google sign-up lands in the Google account
    const gEmail = `glink-${Date.now()}@gmail.com`;
    const gs = await google({ idToken: await keys.sign('GOOGLE', { sub: 'google-link-2', email: gEmail, email_verified: true }), consents: CONSENTS });
    t.clock.advance(61_000);
    const r2 = await otpRequest(t, { channel: 'EMAIL', destination: gEmail, purpose: 'LOGIN' });
    const v2 = await otpVerify(t, { challengeId: r2.body.challengeId, code: r2.body.devCode });
    expect(v2.body.user.id).toBe(gs.body.user.id);
  });
});

describe('sessions', () => {
  it('refresh rotation, reuse detection, logout, list & revoke', async () => {
    const a = await phoneLogin(t);
    const r1 = await t.request('POST', '/v1/auth/refresh', { body: { refreshToken: a.tokens.refreshToken } });
    expect(r1.status).toBe(200);
    expect(r1.body.tokens.refreshToken).not.toBe(a.tokens.refreshToken);
    expect(r1.body.tokens.sessionId).toBe(a.tokens.sessionId);
    // reuse of the rotated token → whole family revoked
    const reuse = await t.request('POST', '/v1/auth/refresh', { body: { refreshToken: a.tokens.refreshToken } });
    expect(reuse.status).toBe(401);
    expect(reuse.body.error.code).toBe('REFRESH_REVOKED');
    const r2 = await t.request('POST', '/v1/auth/refresh', { body: { refreshToken: r1.body.tokens.refreshToken } });
    expect(r2.status).toBe(401);
    const me = await t.request('GET', '/v1/me', { token: r1.body.tokens.accessToken });
    expect(me.status).toBe(401);
    expect(me.body.error.code).toBe('SESSION_REVOKED');
    const [ev] = await t.adminSql<{ n: number }[]>`SELECT count(*)::int AS n FROM security_events WHERE user_id = ${a.user.id} AND type = 'REFRESH_TOKEN_REUSE'`;
    expect(ev!.n).toBe(1);

    // two sessions → list, revoke the other one, logout the current one
    t.clock.advance(61_000);
    const s1 = await phoneLogin(t, a.phone);
    t.clock.advance(61_000);
    const s2 = await phoneLogin(t, a.phone, { device: { platform: 'IOS', fingerprint: 'iphone-fingerprint-000001', appVersion: '2.1.0' } });
    const list = await t.request('GET', '/v1/auth/sessions', { token: s1.tokens.accessToken });
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(2);
    expect(list.body.data.find((s: any) => s.current).id).toBe(s1.tokens.sessionId);
    expect(list.body.data.find((s: any) => s.id === s2.tokens.sessionId).device.platform).toBe('IOS');
    const del = await t.request('DELETE', `/v1/auth/sessions/${s2.tokens.sessionId}`, { token: s1.tokens.accessToken });
    expect(del.status).toBe(200);
    expect((await t.request('GET', '/v1/me', { token: s2.tokens.accessToken })).status).toBe(401);
    const notMine = await t.request('DELETE', `/v1/auth/sessions/${crypto.randomUUID()}`, { token: s1.tokens.accessToken });
    expect(notMine.status).toBe(404);
    const out = await t.request('POST', '/v1/auth/logout', { token: s1.tokens.accessToken });
    expect(out.status).toBe(200);
    expect((await t.request('GET', '/v1/me', { token: s1.tokens.accessToken })).status).toBe(401);
    expect((await t.request('POST', '/v1/auth/refresh', { body: { refreshToken: s1.tokens.refreshToken } })).status).toBe(401);
  });
});

describe('admin TOTP MFA', () => {
  it('enroll (admin only) → confirm → step-up verify with replay protection and recovery codes', async () => {
    const buyer = await t.createUser();
    const denied = await t.request('POST', '/v1/auth/mfa/totp/enroll', { token: buyer.accessToken });
    expect(denied.status).toBe(403);

    const admin = await t.createUser({ roles: ['OPERATIONS'] });
    const enr = await t.request('POST', '/v1/auth/mfa/totp/enroll', { token: admin.accessToken });
    expect(enr.status).toBe(200);
    expect(enr.body.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(enr.body.otpauthUri).toContain('otpauth://totp/');
    const [f] = await t.adminSql<{ secret_enc: Buffer }[]>`SELECT secret_enc FROM mfa_factors WHERE user_id = ${admin.id}`;
    expect(f!.secret_enc.toString('latin1')).not.toContain(enr.body.secret);

    const step = () => Math.floor(t.clock.now().getTime() / 30_000);
    const bad = await t.request('POST', '/v1/auth/mfa/totp/confirm', { token: admin.accessToken, body: { code: '000000' === (await totpAt(enr.body.secret, step())) ? '111111' : '000000' } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('MFA_CODE_INVALID');

    const code1 = await totpAt(enr.body.secret, step());
    const conf = await t.request('POST', '/v1/auth/mfa/totp/confirm', { token: admin.accessToken, body: { code: code1 } });
    expect(conf.status).toBe(200);
    expect(conf.body.recoveryCodes).toHaveLength(10);
    expect(conf.body.accessToken).toBeTruthy();
    // the secret is never returned again
    const again = await t.request('POST', '/v1/auth/mfa/totp/enroll', { token: admin.accessToken });
    expect(again.status).toBe(409);
    expect(JSON.stringify(again.body)).not.toContain(enr.body.secret);
    const me = await t.request('GET', '/v1/me', { token: admin.accessToken });
    expect(me.body.mfaEnabled).toBe(true);

    // replay of the confirmation code (same step) is rejected
    const replay = await t.request('POST', '/v1/auth/mfa/verify', { token: admin.accessToken, body: { code: code1 } });
    expect(replay.status).toBe(400);
    expect(replay.body.error.code).toBe('MFA_CODE_REPLAYED');

    t.clock.advance(30_000);
    const code2 = await totpAt(enr.body.secret, step());
    const ver = await t.request('POST', '/v1/auth/mfa/verify', { token: admin.accessToken, body: { code: code2 } });
    expect(ver.status).toBe(200);
    expect(ver.body.method).toBe('TOTP');
    expect(ver.body.mfaAt).toBe(Math.floor(t.clock.now().getTime() / 1000));
    const payload = JSON.parse(Buffer.from(ver.body.accessToken.split('.')[1], 'base64url').toString());
    expect(payload.mfa_at).toBe(ver.body.mfaAt);
    expect(payload.sid).toBe(admin.sessionId);
    // step-up token works on the same session
    expect((await t.request('GET', '/v1/me', { token: ver.body.accessToken })).status).toBe(200);
    const replay2 = await t.request('POST', '/v1/auth/mfa/verify', { token: admin.accessToken, body: { code: code2 } });
    expect(replay2.body.error.code).toBe('MFA_CODE_REPLAYED');

    // recovery code: single use
    const rc = conf.body.recoveryCodes[0];
    const r1 = await t.request('POST', '/v1/auth/mfa/verify', { token: admin.accessToken, body: { recoveryCode: rc } });
    expect(r1.status).toBe(200);
    expect(r1.body.method).toBe('RECOVERY_CODE');
    const r2 = await t.request('POST', '/v1/auth/mfa/verify', { token: admin.accessToken, body: { recoveryCode: rc } });
    expect(r2.status).toBe(400);

    const fails = await t.adminSql<{ n: number }[]>`SELECT count(*)::int AS n FROM security_events WHERE user_id = ${admin.id} AND type = 'MFA_FAILED'`;
    expect(fails[0]!.n).toBe(4);
    // lockout after 5 failures within 15 minutes
    await t.request('POST', '/v1/auth/mfa/verify', { token: admin.accessToken, body: { code: '123456' === code2 ? '654321' : '123456' } });
    const locked = await t.request('POST', '/v1/auth/mfa/verify', { token: admin.accessToken, body: { code: await totpAt(enr.body.secret, step() + 1) } });
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe('MFA_LOCKED');
    const audits = await t.adminSql<{ action: string }[]>`SELECT action FROM audit_logs WHERE actor_id = ${admin.id} ORDER BY id`;
    expect(audits.map((a) => a.action)).toEqual(['auth.mfa.enroll_started', 'auth.mfa.enabled']);
  });

  it('verify without an enrolled factor', async () => {
    const u = await t.createUser();
    const r = await t.request('POST', '/v1/auth/mfa/verify', { token: u.accessToken, body: { code: '123456' } });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('MFA_NOT_ENROLLED');
  });
});
