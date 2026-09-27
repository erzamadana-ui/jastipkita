import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../../../test/helpers';
import { CONSENTS, otpRequest, otpVerify, phoneLogin, randomPhone } from './test-support';

let t: TestContext;
beforeAll(async () => {
  t = await createTestContext();
});
afterAll(async () => {
  await t.close();
});

describe('OTP login / sign-up', () => {
  it('phone OTP: request → verify creates a level-2 account with consents, session and events', async () => {
    const phone = randomPhone();
    const req = await otpRequest(t, { channel: 'SMS', destination: phone.replace('+62', '0'), purpose: 'LOGIN' });
    expect(req.status).toBe(200);
    expect(req.body.devCode).toMatch(/^\d{6}$/);
    expect(t.sms.sent.at(-1)!.to).toBe(phone); // 08… normalized to +62…
    expect(t.sms.sent.at(-1)!.body).toContain(req.body.devCode);

    // only the HMAC of the code and the ciphertext of the destination are stored
    const [row] = await t.adminSql<{ code_hash: Buffer; destination_enc: Buffer }[]>`SELECT code_hash, destination_enc FROM otp_challenges WHERE id = ${req.body.challengeId}`;
    expect(row!.code_hash.length).toBe(32);
    expect(row!.code_hash.toString('utf8')).not.toContain(req.body.devCode);
    expect(row!.destination_enc.toString('latin1')).not.toContain(phone);

    const ver = await otpVerify(t, {
      challengeId: req.body.challengeId,
      code: req.body.devCode,
      consents: [...CONSENTS, { type: 'MARKETING', version: '0.1-template', granted: false }],
      device: { platform: 'ANDROID', fingerprint: 'fp-android-0001-abcdef', appVersion: '1.0.0' },
    });
    expect(ver.status).toBe(200);
    expect(ver.body.isNewUser).toBe(true);
    expect(ver.body.user.kycLevel).toBe(2);
    expect(ver.body.user.phone).toBe(phone);
    expect(ver.body.user.phoneVerified).toBe(true);
    expect(ver.body.tokens.accessToken).toBeTruthy();

    const me = await t.request('GET', '/v1/me', { token: ver.body.tokens.accessToken });
    expect(me.status).toBe(200);
    expect(me.body.id).toBe(ver.body.user.id);

    const uid = ver.body.user.id as string;
    const consents = await t.adminSql<{ type: string; granted: boolean }[]>`SELECT type, granted FROM consents WHERE user_id = ${uid} ORDER BY type`;
    expect(consents.map((c) => `${c.type}:${c.granted}`)).toEqual(['MARKETING:false', 'PRIVACY:true', 'TOS:true']);
    const events = await t.adminSql<{ event_type: string; payload: any }[]>`SELECT event_type, payload FROM outbox_events WHERE aggregate_id = ${uid} ORDER BY id`;
    expect(events.map((e) => e.event_type)).toEqual(['user.registered', 'user.phone_verified', 'kyc.level_changed']);
    expect(events[0]!.payload).toEqual({ userId: uid, method: 'PHONE' });
    expect(events[2]!.payload).toEqual({ userId: uid, from: 1, to: 2 });
    const sec = await t.adminSql<{ type: string }[]>`SELECT type FROM security_events WHERE user_id = ${uid} ORDER BY id`;
    expect(sec.map((s) => s.type)).toEqual(expect.arrayContaining(['USER_REGISTERED', 'LOGIN_SUCCESS']));
    const [risk] = await t.adminSql<{ decision: string }[]>`SELECT decision FROM risk_assessments WHERE subject_id = ${uid}`;
    expect(risk!.decision).toBe('ALLOW');
    const [dev] = await t.adminSql<{ n: number }[]>`SELECT count(*)::int AS n FROM user_devices WHERE user_id = ${uid}`;
    expect(dev!.n).toBe(1);

    // second login with the same phone → same account, not new
    t.clock.advance(61_000);
    const again = await phoneLogin(t, phone);
    expect(again.isNewUser).toBe(false);
    expect(again.user.id).toBe(uid);
  });

  it('a new account needs TOS + PRIVACY consent; the code stays usable', async () => {
    const phone = randomPhone();
    const req = await otpRequest(t, { channel: 'WHATSAPP', destination: phone, purpose: 'LOGIN' });
    expect(t.sms.sent.at(-1)!.channel).toBe('WHATSAPP');
    const noConsent = await otpVerify(t, { challengeId: req.body.challengeId, code: req.body.devCode });
    expect(noConsent.status).toBe(422);
    expect(noConsent.body.error.code).toBe('CONSENT_REQUIRED');
    expect(noConsent.body.error.details.required).toEqual(['TOS', 'PRIVACY']);
    const ok = await otpVerify(t, { challengeId: req.body.challengeId, code: req.body.devCode, consents: CONSENTS });
    expect(ok.status).toBe(200);
  });

  it('e-mail OTP creates a level-1 account (registration is separate from KYC)', async () => {
    const email = `otp-${Date.now()}@example.com`;
    const req = await otpRequest(t, { channel: 'EMAIL', destination: email.toUpperCase(), purpose: 'LOGIN' });
    expect(req.status).toBe(200);
    expect(t.email.outbox.at(-1)!.to).toBe(email);
    const ver = await otpVerify(t, { challengeId: req.body.challengeId, code: req.body.devCode, consents: CONSENTS });
    expect(ver.status).toBe(200);
    expect(ver.body.user.kycLevel).toBe(1);
    expect(ver.body.user.email).toBe(email);
    expect(ver.body.user.emailVerified).toBe(true);
    expect(ver.body.user.transactionEmail).toBeNull();
  });

  it('wrong code: counts attempts and locks after 5; lockout is persisted', async () => {
    const phone = randomPhone();
    const req = await otpRequest(t, { channel: 'SMS', destination: phone, purpose: 'LOGIN' });
    const wrong = req.body.devCode === '000000' ? '111111' : '000000';
    for (let i = 1; i <= 4; i++) {
      const r = await otpVerify(t, { challengeId: req.body.challengeId, code: wrong, consents: CONSENTS });
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('OTP_INVALID');
      expect(r.body.error.details.remainingAttempts).toBe(5 - i);
    }
    const fifth = await otpVerify(t, { challengeId: req.body.challengeId, code: wrong, consents: CONSENTS });
    expect(fifth.status).toBe(429);
    expect(fifth.body.error.code).toBe('OTP_LOCKED');
    // even the right code is refused now
    const right = await otpVerify(t, { challengeId: req.body.challengeId, code: req.body.devCode, consents: CONSENTS });
    expect(right.status).toBe(429);
    expect(right.body.error.code).toBe('OTP_LOCKED');
    const [row] = await t.adminSql<{ attempts: number }[]>`SELECT attempts FROM otp_challenges WHERE id = ${req.body.challengeId}`;
    expect(row!.attempts).toBe(5);
    const sec = await t.adminSql<{ type: string }[]>`SELECT type FROM security_events WHERE meta->>'challengeId' = ${req.body.challengeId} ORDER BY id`;
    expect(sec.filter((s) => s.type === 'OTP_VERIFY_FAILED')).toHaveLength(4);
    expect(sec.at(-1)!.type).toBe('OTP_LOCKED');
  });

  it('code expires after 5 minutes (FixedClock)', async () => {
    const req = await otpRequest(t, { channel: 'SMS', destination: randomPhone(), purpose: 'LOGIN' });
    t.clock.advance(5 * 60_000 + 1);
    const r = await otpVerify(t, { challengeId: req.body.challengeId, code: req.body.devCode, consents: CONSENTS });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('OTP_EXPIRED');
  });

  it('a consumed code cannot be reused', async () => {
    const phone = randomPhone();
    const req = await otpRequest(t, { channel: 'SMS', destination: phone, purpose: 'LOGIN' });
    const first = await otpVerify(t, { challengeId: req.body.challengeId, code: req.body.devCode, consents: CONSENTS });
    expect(first.status).toBe(200);
    const second = await otpVerify(t, { challengeId: req.body.challengeId, code: req.body.devCode, consents: CONSENTS });
    expect(second.status).toBe(400);
    expect(second.body.error.code).toBe('OTP_INVALID');
  });

  it('60 s resend cooldown and 5/hour per destination', async () => {
    const phone = randomPhone();
    const first = await otpRequest(t, { channel: 'SMS', destination: phone, purpose: 'LOGIN' });
    expect(first.status).toBe(200);
    const tooSoon = await otpRequest(t, { channel: 'SMS', destination: phone, purpose: 'LOGIN' });
    expect(tooSoon.status).toBe(429);
    expect(tooSoon.body.error.code).toBe('OTP_COOLDOWN');
    expect(tooSoon.body.error.details.retryAfterSec).toBeGreaterThan(0);
    // a newer code supersedes the previous one
    for (let i = 2; i <= 5; i++) {
      t.clock.advance(61_000);
      const r = await otpRequest(t, { channel: 'SMS', destination: phone, purpose: 'LOGIN' });
      expect(r.status).toBe(200);
    }
    const old = await otpVerify(t, { challengeId: first.body.challengeId, code: first.body.devCode, consents: CONSENTS });
    expect(old.body.error.code).toBe('OTP_INVALID');
    t.clock.advance(61_000);
    const sixth = await otpRequest(t, { channel: 'SMS', destination: phone, purpose: 'LOGIN' });
    expect(sixth.status).toBe(429);
    expect(sixth.body.error.code).toBe('OTP_RATE_LIMITED');
    const [ev] = await t.adminSql<{ n: number }[]>`SELECT count(*)::int AS n FROM security_events WHERE type = 'OTP_RATE_LIMITED' AND meta->>'scope' = 'DESTINATION_HOUR'`;
    expect(ev!.n).toBeGreaterThanOrEqual(1);
    // the window slides
    t.clock.advance(3600_000);
    const later = await otpRequest(t, { channel: 'SMS', destination: phone, purpose: 'LOGIN' });
    expect(later.status).toBe(200);
  });

  it('per-IP limit (20/hour) applies across destinations', async () => {
    const ip = '198.51.100.77';
    for (let i = 0; i < 20; i++) {
      const r = await otpRequest(t, { channel: 'SMS', destination: randomPhone(), purpose: 'LOGIN' }, { ip });
      expect(r.status).toBe(200);
    }
    const r = await otpRequest(t, { channel: 'SMS', destination: randomPhone(), purpose: 'LOGIN' }, { ip });
    expect(r.status).toBe(429);
    expect(r.body.error.code).toBe('OTP_RATE_LIMITED');
    t.clock.advance(3600_000 + 1000);
  });

  it('no account enumeration: identical response shape for existing and unknown destinations', async () => {
    const existing = await t.createUser({ kycLevel: 2 });
    const a = await otpRequest(t, { channel: 'SMS', destination: existing.phone, purpose: 'LOGIN' });
    const b = await otpRequest(t, { channel: 'SMS', destination: randomPhone(), purpose: 'LOGIN' });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(Object.keys(a.body).sort()).toEqual(Object.keys(b.body).sort());
    const e1 = await otpRequest(t, { channel: 'EMAIL', destination: existing.email, purpose: 'LOGIN' });
    const e2 = await otpRequest(t, { channel: 'EMAIL', destination: `nobody-${Date.now()}@example.com`, purpose: 'LOGIN' });
    expect(e1.status).toBe(e2.status);
    expect(Object.keys(e1.body).sort()).toEqual(Object.keys(e2.body).sort());
    // an existing user logs straight in with the code
    const ver = await otpVerify(t, { challengeId: a.body.challengeId, code: a.body.devCode });
    expect(ver.status).toBe(200);
    expect(ver.body.user.id).toBe(existing.id);
    expect(ver.body.isNewUser).toBe(false);
  });

  it('invalid destinations and wrong channel/purpose combinations are rejected', async () => {
    expect((await otpRequest(t, { channel: 'SMS', destination: 'not-a-phone', purpose: 'LOGIN' })).body.error.code).toBe('INVALID_DESTINATION');
    expect((await otpRequest(t, { channel: 'EMAIL', destination: 'not-an-email', purpose: 'LOGIN' })).body.error.code).toBe('INVALID_DESTINATION');
    // VERIFY_* needs auth
    const r = await otpRequest(t, { channel: 'SMS', destination: randomPhone(), purpose: 'VERIFY_PHONE' });
    expect(r.status).toBe(401);
    const u = await t.createUser();
    const r2 = await otpRequest(t, { channel: 'EMAIL', destination: randomPhone(), purpose: 'VERIFY_PHONE' }, { token: u.accessToken });
    expect(r2.body.error.code).toBe('OTP_CHANNEL_INVALID');
  });

  it('VERIFY_PHONE raises level 1 → 2 and rejects a phone owned by another account', async () => {
    const u = await t.createUser({ kycLevel: 1 });
    const phone = randomPhone();
    const req = await otpRequest(t, { channel: 'SMS', destination: phone, purpose: 'VERIFY_PHONE' }, { token: u.accessToken });
    expect(req.status).toBe(200);
    // another user cannot redeem it
    const other = await t.createUser();
    const stolen = await otpVerify(t, { challengeId: req.body.challengeId, code: req.body.devCode }, { token: other.accessToken });
    expect(stolen.body.error.code).toBe('OTP_INVALID');
    const ver = await otpVerify(t, { challengeId: req.body.challengeId, code: req.body.devCode }, { token: u.accessToken });
    expect(ver.status).toBe(200);
    expect(ver.body.purpose).toBe('VERIFY_PHONE');
    expect(ver.body.user.kycLevel).toBe(2);
    expect(ver.body.user.phone).toBe(phone);
    expect(ver.body.tokens).toBeUndefined();
    const [ev] = await t.adminSql<{ n: number }[]>`SELECT count(*)::int AS n FROM outbox_events WHERE event_type = 'user.phone_verified' AND aggregate_id = ${u.id}`;
    expect(ev!.n).toBe(1);

    const v = await t.createUser({ kycLevel: 1 });
    t.clock.advance(61_000); // per-destination cooldown applies across accounts
    const req2 = await otpRequest(t, { channel: 'SMS', destination: phone, purpose: 'VERIFY_PHONE' }, { token: v.accessToken });
    const conflict = await otpVerify(t, { challengeId: req2.body.challengeId, code: req2.body.devCode }, { token: v.accessToken });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('PHONE_IN_USE');
  });

  it('suspended accounts cannot log in (security event recorded)', async () => {
    const u = await t.createUser({ kycLevel: 2 });
    await t.adminSql`UPDATE users SET status = 'SUSPENDED', suspended_at = now() WHERE id = ${u.id}`;
    t.clock.advance(61_000);
    const req = await otpRequest(t, { channel: 'SMS', destination: u.phone, purpose: 'LOGIN' });
    const ver = await otpVerify(t, { challengeId: req.body.challengeId, code: req.body.devCode });
    expect(ver.status).toBe(403);
    expect(ver.body.error.code).toBe('ACCOUNT_SUSPENDED');
    const [ev] = await t.adminSql<{ n: number }[]>`SELECT count(*)::int AS n FROM security_events WHERE user_id = ${u.id} AND type = 'LOGIN_FAILED'`;
    expect(ev!.n).toBe(1);
  });

  it('signup risk: BLOCK prevents the sign-up and is recorded; REVIEW/HOLD are allowed', async () => {
    const fingerprint = 'shared-device-fingerprint-xyz-001';
    const ip = '192.0.2.200';
    const fp = Buffer.from(await t.deps.crypto.hashIdentifier('device', fingerprint));
    const ipHash = Buffer.from(await t.deps.crypto.hashIdentifier('ip', ip));
    const [dev] = await t.adminSql<{ id: string }[]>`INSERT INTO devices (fingerprint_hash, platform) VALUES (${fp}, 'ANDROID') RETURNING id`;
    for (let i = 0; i < 6; i++) {
      const u = await t.createUser();
      await t.adminSql`INSERT INTO user_devices (user_id, device_id) VALUES (${u.id}, ${dev!.id})`;
      await t.adminSql`INSERT INTO security_events (user_id, type, ip_hash, created_at) VALUES (${u.id}, 'USER_REGISTERED', ${ipHash}, ${t.clock.now()})`;
    }
    const phone = randomPhone();
    const req = await otpRequest(t, { channel: 'SMS', destination: phone, purpose: 'LOGIN' }, { ip });
    const ver = await otpVerify(
      t,
      { challengeId: req.body.challengeId, code: req.body.devCode, consents: CONSENTS, device: { platform: 'ANDROID', fingerprint } },
      { ip },
    );
    expect(ver.status).toBe(403);
    expect(ver.body.error.code).toBe('SIGNUP_BLOCKED');
    const [u] = await t.adminSql`SELECT id FROM users WHERE phone_e164 = ${phone}`;
    expect(u).toBeUndefined();
    const [blocked] = await t.adminSql<{ decision: string; score: number; signals: any }[]>`
      SELECT decision, score, signals FROM risk_assessments WHERE decision = 'BLOCK' ORDER BY created_at DESC LIMIT 1`;
    expect(blocked!.decision).toBe('BLOCK');
    expect(blocked!.signals.accountsOnDevice).toBe(7);
    const [sec] = await t.adminSql<{ n: number }[]>`SELECT count(*)::int AS n FROM security_events WHERE type = 'SIGNUP_BLOCKED'`;
    expect(sec!.n).toBe(1);

    // a lighter signal set (new IP, 2 other accounts on a fresh device) → allowed but recorded
    const fp2 = 'second-device-fingerprint-abc-002';
    const fpHash2 = Buffer.from(await t.deps.crypto.hashIdentifier('device', fp2));
    const [dev2] = await t.adminSql<{ id: string }[]>`INSERT INTO devices (fingerprint_hash, platform) VALUES (${fpHash2}, 'IOS') RETURNING id`;
    for (let i = 0; i < 3; i++) {
      const x = await t.createUser();
      await t.adminSql`INSERT INTO user_devices (user_id, device_id) VALUES (${x.id}, ${dev2!.id})`;
    }
    const ok = await phoneLogin(t, randomPhone(), { device: { platform: 'IOS', fingerprint: fp2 } }, '192.0.2.201');
    expect(ok.isNewUser).toBe(true);
    const [ra] = await t.adminSql<{ decision: string }[]>`SELECT decision FROM risk_assessments WHERE subject_id = ${ok.user.id}`;
    expect(['REVIEW', 'HOLD']).toContain(ra!.decision);
    const [review] = await t.adminSql<{ n: number }[]>`SELECT count(*)::int AS n FROM risk_reviews WHERE subject_id = ${ok.user.id}`;
    expect(review!.n).toBe(1);
  });
});
