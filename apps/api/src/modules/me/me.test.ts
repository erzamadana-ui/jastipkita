import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../../../test/helpers';
import { otpVerify, phoneLogin } from '../auth/test-support';

let t: TestContext;
beforeAll(async () => {
  t = await createTestContext();
});
afterAll(async () => {
  await t.close();
});

describe('/me', () => {
  it('requires auth', async () => {
    expect((await t.request('GET', '/v1/me')).status).toBe(401);
    expect((await t.request('GET', '/v1/me', { token: 'garbage' })).body.error.code).toBe('TOKEN_INVALID');
  });

  it('GET returns roles, kycLevel, activeMode, trustScore, referralCode, transactionEmail', async () => {
    const u = await t.createUser({ kycLevel: 3, roles: ['SUPPORT'], mode: 'TRAVELER' });
    const r = await t.request('GET', '/v1/me', { token: u.accessToken });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      id: u.id,
      email: u.email,
      kycLevel: 3,
      activeMode: 'TRAVELER',
      trustScore: 50,
      roles: ['SUPPORT'],
      transactionEmail: null,
      mfaEnabled: false,
      status: 'ACTIVE',
      deletionScheduledFor: null,
    });
    expect(r.body.referralCode).toMatch(/^[0-9A-Z]{4,16}$/);
  });

  it('PATCH updates profile fields and validates the country', async () => {
    const u = await t.createUser();
    const r = await t.request('PATCH', '/v1/me', { token: u.accessToken, body: { displayName: 'Andi Wijaya', locale: 'en', countryCode: 'SG' } });
    expect(r.status).toBe(200);
    expect(r.body.user).toMatchObject({ displayName: 'Andi Wijaya', locale: 'en', countryCode: 'SG' });
    expect(r.body.pendingVerification).toBeNull();
    expect((await t.request('PATCH', '/v1/me', { token: u.accessToken, body: { countryCode: 'XX' } })).body.error.code).toBe('COUNTRY_INVALID');
    expect((await t.request('PATCH', '/v1/me', { token: u.accessToken, body: { kycLevel: 5 } })).status).toBe(400); // strict body
    expect((await t.request('PATCH', '/v1/me', { token: u.accessToken, body: { avatarFileId: crypto.randomUUID() } })).body.error.code).toBe('AVATAR_FILE_INVALID');
  });

  it('changing transactionEmail requires e-mail OTP verification', async () => {
    const u = await phoneLogin(t); // phone-only account, Google/Apple e-mail not involved
    const token = u.tokens.accessToken;
    const newEmail = `nota-${Date.now()}@example.com`;
    const p = await t.request('PATCH', '/v1/me', { token, body: { transactionEmail: newEmail.toUpperCase() } });
    expect(p.status).toBe(200);
    expect(p.body.user.transactionEmail).toBeNull(); // not applied yet
    expect(p.body.pendingVerification).toMatchObject({ channel: 'EMAIL', purpose: 'VERIFY_EMAIL' });
    expect(t.email.outbox.at(-1)!.to).toBe(newEmail);

    // wrong code does not apply it; another user cannot redeem the challenge
    const other = await t.createUser();
    expect((await otpVerify(t, { challengeId: p.body.pendingVerification.challengeId, code: p.body.pendingVerification.devCode }, { token: other.accessToken })).body.error.code).toBe('OTP_INVALID');
    const wrong = p.body.pendingVerification.devCode === '000000' ? '111111' : '000000';
    expect((await otpVerify(t, { challengeId: p.body.pendingVerification.challengeId, code: wrong }, { token })).status).toBe(400);
    expect((await t.request('GET', '/v1/me', { token })).body.transactionEmail).toBeNull();

    const v = await otpVerify(t, { challengeId: p.body.pendingVerification.challengeId, code: p.body.pendingVerification.devCode }, { token });
    expect(v.status).toBe(200);
    expect(v.body.purpose).toBe('VERIFY_EMAIL');
    expect(v.body.user.transactionEmail).toBe(newEmail);
    // a phone-only account also gains the verified login e-mail
    expect(v.body.user.email).toBe(newEmail);
    expect(v.body.user.emailVerified).toBe(true);

    // clearing needs no OTP; re-selecting the verified login e-mail applies immediately
    expect((await t.request('PATCH', '/v1/me', { token, body: { transactionEmail: null } })).body.user.transactionEmail).toBeNull();
    const back = await t.request('PATCH', '/v1/me', { token, body: { transactionEmail: newEmail } });
    expect(back.body.pendingVerification).toBeNull();
    expect(back.body.user.transactionEmail).toBe(newEmail);
  });

  it('POST /me/mode switches BUYER ↔ TRAVELER at any level', async () => {
    const u = await t.createUser({ kycLevel: 1 });
    const r = await t.request('POST', '/v1/me/mode', { token: u.accessToken, body: { mode: 'TRAVELER' } });
    expect(r.status).toBe(200);
    expect(r.body.activeMode).toBe('TRAVELER');
    expect((await t.request('POST', '/v1/me/mode', { token: u.accessToken, body: { mode: 'BUYER' } })).body.activeMode).toBe('BUYER');
    expect((await t.request('POST', '/v1/me/mode', { token: u.accessToken, body: { mode: 'ADMIN' } })).status).toBe(400);
  });

  it('devices: register (push token + fingerprint HMAC), list, token moves between installs, unlink', async () => {
    const u = await t.createUser();
    const d1 = await t.request('POST', '/v1/me/devices', { token: u.accessToken, body: { platform: 'ANDROID', fingerprint: 'install-aaaa-bbbb-cccc-0001', pushToken: 'fcm-token-1234567890', appVersion: '1.2.0' } });
    expect(d1.status).toBe(200);
    expect(d1.body).toMatchObject({ platform: 'ANDROID', appVersion: '1.2.0', pushEnabled: true });
    const [row] = await t.adminSql<{ fingerprint_hash: Buffer }[]>`SELECT fingerprint_hash FROM devices WHERE id = ${d1.body.id}`;
    expect(row!.fingerprint_hash.toString('latin1')).not.toContain('install-aaaa');
    // same token registered from another install → removed from the first
    const d2 = await t.request('POST', '/v1/me/devices', { token: u.accessToken, body: { platform: 'ANDROID', fingerprint: 'install-aaaa-bbbb-cccc-0002', pushToken: 'fcm-token-1234567890' } });
    const list = await t.request('GET', '/v1/me/devices', { token: u.accessToken });
    expect(list.body.data).toHaveLength(2);
    expect(list.body.data.find((d: any) => d.id === d1.body.id).pushEnabled).toBe(false);
    expect(list.body.data.find((d: any) => d.id === d2.body.id).pushEnabled).toBe(true);
    expect((await t.request('DELETE', `/v1/me/devices/${d2.body.id}`, { token: u.accessToken })).status).toBe(200);
    expect((await t.request('GET', '/v1/me/devices', { token: u.accessToken })).body.data).toHaveLength(1);
    expect((await t.request('DELETE', `/v1/me/devices/${d2.body.id}`, { token: u.accessToken })).status).toBe(404);
  });

  it('consents: append-only, versioned, current view', async () => {
    const u = await phoneLogin(t);
    const token = u.tokens.accessToken;
    const g = await t.request('GET', '/v1/me/consents', { token });
    expect(g.body.requiredAtSignup).toEqual(['TOS', 'PRIVACY']);
    expect(g.body.current.map((c: any) => c.type)).toEqual(['PRIVACY', 'TOS']);
    expect((await t.request('POST', '/v1/me/consents', { token, body: { type: 'MARKETING', version: '0.1-template', granted: true } })).status).toBe(201);
    t.clock.advance(1000);
    expect((await t.request('POST', '/v1/me/consents', { token, body: { type: 'MARKETING', version: '0.1-template', granted: false } })).status).toBe(201);
    const after = await t.request('GET', '/v1/me/consents', { token });
    expect(after.body.current.find((c: any) => c.type === 'MARKETING').granted).toBe(false);
    expect(after.body.history.filter((c: any) => c.type === 'MARKETING')).toHaveLength(2);
    // published legal document versions are enforced once they exist
    await t.adminSql`INSERT INTO legal_documents (type, version, locale, title, body_md, published_at) VALUES ('KYC', 'v3', 'id', 'Persetujuan KYC', '...', now())`;
    const bad = await t.request('POST', '/v1/me/consents', { token, body: { type: 'KYC', version: 'v1' } });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('CONSENT_VERSION_INVALID');
    expect((await t.request('POST', '/v1/me/consents', { token, body: { type: 'KYC', version: 'v3' } })).status).toBe(201);
    // append-only at the DB level
    await expect(t.adminSql`UPDATE consents SET granted = true WHERE user_id = ${u.user.id}`).rejects.toThrow(/append-only/);
  });
});
