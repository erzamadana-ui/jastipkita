/**
 * SEC-07 (docs/security/review-2026-09.md): logging out must stop this account's push notifications on that device.
 * Before the fix logout only revoked the refresh-token family; the device stayed linked (user_devices) and kept
 * receiving the previous account's chat previews, PIN reminders and payout notices after the phone changed hands.
 * Also covers session revocation semantics (access tokens die with the session; refresh reuse kills the family).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../helpers';
import { CONSENTS, otpRequest, otpVerify, randomPhone } from '../../src/modules/auth/test-support';

let t: TestContext;
beforeAll(async () => {
  t = await createTestContext();
});
afterAll(() => t?.close());

async function loginOnDevice(phone: string, fingerprint: string, pushToken: string) {
  const req = await otpRequest(t, { channel: 'SMS', destination: phone, purpose: 'LOGIN' });
  expect(req.status, JSON.stringify(req.body)).toBe(200);
  const ver = await otpVerify(t, { challengeId: req.body.challengeId, code: req.body.devCode, consents: CONSENTS, device: { platform: 'ANDROID', fingerprint, pushToken } });
  expect(ver.status, JSON.stringify(ver.body)).toBe(200);
  return ver.body as { tokens: { accessToken: string; refreshToken: string; sessionId: string }; user: { id: string } };
}

async function pushTokensOf(userId: string) {
  const rows = await t.adminSql<{ push_token: string }[]>`
    SELECT DISTINCT dv.push_token FROM user_devices ud JOIN devices dv ON dv.id = ud.device_id
     WHERE ud.user_id = ${userId} AND ud.revoked_at IS NULL AND dv.push_token IS NOT NULL`;
  return rows.map((r) => r.push_token);
}

describe('SEC-07 logout unlinks the device from the account push audience', () => {
  it('after logout the phone no longer receives the account notifications; a second live session keeps its device', async () => {
    const phone = randomPhone();
    const fp = `fp-shared-phone-${crypto.randomUUID()}`;
    const a = await loginOnDevice(phone, fp, `push-token-${crypto.randomUUID()}`);
    expect(await pushTokensOf(a.user.id)).toHaveLength(1);

    // a second device of the same user (tablet) stays subscribed when the phone logs out
    t.clock.advance(61_000);
    const tabletToken = `push-token-${crypto.randomUUID()}`;
    await loginOnDevice(phone, `fp-tablet-${crypto.randomUUID()}`, tabletToken);
    expect(await pushTokensOf(a.user.id)).toHaveLength(2);

    const out = await t.request('POST', '/v1/auth/logout', { token: a.tokens.accessToken });
    expect(out.status).toBe(200);
    expect(await pushTokensOf(a.user.id)).toEqual([tabletToken]);
    // access token and refresh token of the logged-out session are dead immediately
    expect((await t.request('GET', '/v1/me', { token: a.tokens.accessToken })).status).toBe(401);
    expect((await t.request('POST', '/v1/auth/refresh', { body: { refreshToken: a.tokens.refreshToken } })).status).toBe(401);

    // logging in again on the phone re-subscribes it
    t.clock.advance(61_000);
    await loginOnDevice(phone, fp, `push-token-${crypto.randomUUID()}`);
    expect(await pushTokensOf(a.user.id)).toHaveLength(2);
  });

  it('refresh-token reuse revokes the whole family (theft detection) and leaves a HIGH security event', async () => {
    const phone = randomPhone();
    const a = await loginOnDevice(phone, `fp-${crypto.randomUUID()}`, `push-${crypto.randomUUID()}`);
    const r1 = await t.request('POST', '/v1/auth/refresh', { body: { refreshToken: a.tokens.refreshToken } });
    expect(r1.status).toBe(200);
    // attacker replays the stolen (already rotated) token
    const replay = await t.request('POST', '/v1/auth/refresh', { body: { refreshToken: a.tokens.refreshToken } });
    expect(replay.status).toBe(401);
    // the legitimate rotated token is dead too, and so are the access tokens of the family
    expect((await t.request('POST', '/v1/auth/refresh', { body: { refreshToken: r1.body.tokens.refreshToken } })).status).toBe(401);
    expect((await t.request('GET', '/v1/me', { token: r1.body.tokens.accessToken })).status).toBe(401);
    const [ev] = await t.adminSql<{ severity: string }[]>`SELECT severity FROM security_events WHERE user_id = ${a.user.id} AND type = 'REFRESH_TOKEN_REUSE'`;
    expect(ev!.severity).toBe('HIGH');
  });

  it('JWTs with alg=none, a foreign key, wrong audience or an expired exp are rejected', async () => {
    const { SignJWT } = await import('jose');
    const u = await t.createUser();
    const claims = { sid: u.sessionId, typ: 'access' };
    const key = (s: string) => new TextEncoder().encode(s);
    const base = () => new SignJWT(claims).setSubject(u.id).setIssuer(t.env.JWT_ISSUER).setAudience(t.env.JWT_AUDIENCE).setIssuedAt();
    const none = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${Buffer.from(
      JSON.stringify({ ...claims, sub: u.id, iss: t.env.JWT_ISSUER, aud: t.env.JWT_AUDIENCE, exp: Math.floor(Date.now() / 1000) + 600 }),
    ).toString('base64url')}.`;
    const forged = await base().setProtectedHeader({ alg: 'HS256' }).setExpirationTime('10m').sign(key('attacker-secret-attacker-secret-0123456789'));
    const wrongAud = await new SignJWT(claims).setSubject(u.id).setIssuer(t.env.JWT_ISSUER).setAudience('other-app').setIssuedAt().setExpirationTime('10m')
      .setProtectedHeader({ alg: 'HS256' }).sign(key(t.env.JWT_SECRET));
    const expired = await base().setProtectedHeader({ alg: 'HS256' }).setExpirationTime(Math.floor(t.clock.now().getTime() / 1000) - 1).sign(key(t.env.JWT_SECRET));
    const hs512 = await base().setProtectedHeader({ alg: 'HS512' }).setExpirationTime('10m').sign(key(t.env.JWT_SECRET));
    for (const tok of [none, forged, wrongAud, expired, hs512]) {
      const r = await t.request('GET', '/v1/me', { token: tok });
      expect(r.status).toBe(401);
    }
  });
});
