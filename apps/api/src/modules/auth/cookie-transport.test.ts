/**
 * SEC-14: opt-in cookie transport for the web refresh token (X-JK-Token-Transport: cookie).
 * HttpOnly; SameSite=Strict; Path=/v1/auth cookie `jk_rt`, body without refreshToken, refresh/logout from the cookie,
 * Origin allow-list (CSRF), credentialed CORS only for web origins, rotation + reuse detection unchanged.
 */
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppEnv } from '../../context';
import { createTestContext, type TestContext } from '../../../test/helpers';
import { REFRESH_COOKIE_NAME, setRefreshCookie, clearRefreshCookie, webCredentialOrigins } from './cookie-transport';
import { CONSENTS, installOAuthTestKeys, otpRequest, randomPhone, type OAuthTestKeys } from './test-support';

let t: TestContext;
let keys: OAuthTestKeys;
beforeAll(async () => {
  t = await createTestContext({ env: { CORS_ORIGINS: 'http://localhost:4321' } });
  keys = await installOAuthTestKeys(t);
});
afterAll(async () => {
  await t.close();
});

const WEB = 'http://web.test';
const cookieHeaders = (extra: Record<string, string> = {}) => ({ 'x-jk-token-transport': 'cookie', origin: WEB, 'x-forwarded-for': '203.0.113.20', ...extra });

/** Value of the jk_rt Set-Cookie (undefined when absent) + its raw attributes. */
function rtCookie(h: Headers): { value: string; raw: string } | undefined {
  const all = h.getSetCookie();
  const raw = all.find((c) => c.startsWith(`${REFRESH_COOKIE_NAME}=`));
  if (!raw) return undefined;
  return { value: decodeURIComponent(raw.slice(REFRESH_COOKIE_NAME.length + 1).split(';')[0]!), raw };
}

async function cookieLogin(phone = randomPhone()) {
  const rq = await otpRequest(t, { channel: 'SMS', destination: phone, purpose: 'LOGIN' }, { ip: '203.0.113.20' });
  expect(rq.status).toBe(200);
  const res = await t.request('POST', '/v1/auth/otp/verify', { body: { challengeId: rq.body.challengeId, code: rq.body.devCode, consents: CONSENTS }, headers: cookieHeaders() });
  return { res, phone };
}

describe('cookie transport — login', () => {
  it('OTP verify sets the HttpOnly SameSite=Strict cookie and omits refreshToken from the body', async () => {
    const { res } = await cookieLogin();
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.tokens.accessToken).toBeTruthy();
    expect(res.body.tokens.refreshTokenExpiresAt).toBeTruthy();
    expect(res.body.tokens).not.toHaveProperty('refreshToken');
    expect(JSON.stringify(res.body)).not.toMatch(/refreshToken"/);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const c = rtCookie(res.headers)!;
    expect(c.value.length).toBeGreaterThanOrEqual(40);
    const attrs = c.raw.split(';').map((s) => s.trim().toLowerCase());
    expect(attrs).toContain('httponly');
    expect(attrs).toContain('samesite=strict');
    expect(attrs).toContain('path=/v1/auth');
    expect(attrs).toContain(`max-age=${30 * 86400}`);
    expect(attrs.some((a) => a.startsWith('domain='))).toBe(false);
    expect(attrs).not.toContain('secure'); // APP_ENV=test (http) only — see the staging/production case below
    // the cookie value is a working refresh token of that session
    const [row] = await t.adminSql<{ n: number }[]>`SELECT count(*)::int AS n FROM refresh_tokens WHERE family_id = ${res.body.tokens.sessionId} AND revoked_at IS NULL`;
    expect(row!.n).toBe(1);
  });

  it('without the header the body transport is unchanged (no cookie) and a stray cookie is ignored', async () => {
    const rq = await otpRequest(t, { channel: 'SMS', destination: randomPhone(), purpose: 'LOGIN' });
    const res = await t.request('POST', '/v1/auth/otp/verify', { body: { challengeId: rq.body.challengeId, code: rq.body.devCode, consents: CONSENTS }, headers: { origin: WEB } });
    expect(res.status).toBe(200);
    expect(res.body.tokens.refreshToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(rtCookie(res.headers)).toBeUndefined();
    // cookie without the opt-in header: never read (refresh needs the body token)
    const ref = await t.request('POST', '/v1/auth/refresh', { headers: { origin: WEB, cookie: `${REFRESH_COOKIE_NAME}=${res.body.tokens.refreshToken}` } });
    expect(ref.status).toBe(400);
    expect(ref.body.error.code).toBe('VALIDATION_ERROR');
    expect(rtCookie(ref.headers)).toBeUndefined();
    // and an unknown transport value is a validation error
    const bad = await t.request('POST', '/v1/auth/refresh', { body: { refreshToken: res.body.tokens.refreshToken }, headers: { 'x-jk-token-transport': 'yes' } });
    expect(bad.status).toBe(400);
  });

  it('wrong / missing / admin Origin → 403 ORIGIN_NOT_ALLOWED before the OTP is consumed', async () => {
    const rq = await otpRequest(t, { channel: 'SMS', destination: randomPhone(), purpose: 'LOGIN' }, { ip: '203.0.113.21' });
    const body = { challengeId: rq.body.challengeId, code: rq.body.devCode, consents: CONSENTS };
    for (const origin of ['https://evil.example', 'http://admin.test', 'null', undefined]) {
      const headers: Record<string, string> = { 'x-jk-token-transport': 'cookie' };
      if (origin) headers.origin = origin;
      const res = await t.request('POST', '/v1/auth/otp/verify', { body, headers });
      expect(res.status, String(origin)).toBe(403);
      expect(res.body.error.code).toBe('ORIGIN_NOT_ALLOWED');
      expect(rtCookie(res.headers)).toBeUndefined();
    }
    const [ch] = await t.adminSql<{ consumed_at: Date | null; attempts: number }[]>`SELECT consumed_at, attempts FROM otp_challenges WHERE id = ${rq.body.challengeId}`;
    expect(ch).toMatchObject({ consumed_at: null, attempts: 0 });
    // an additional allow-listed web origin (CORS_ORIGINS) works
    const ok = await t.request('POST', '/v1/auth/otp/verify', { body, headers: { 'x-jk-token-transport': 'cookie', origin: 'http://localhost:4321' } });
    expect(ok.status).toBe(200);
    expect(rtCookie(ok.headers)).toBeDefined();
  });

  it('Google sign-in honours the cookie transport too', async () => {
    const idToken = await keys.sign('GOOGLE', { sub: 'google-cookie-1', email: `gc-${Date.now()}@gmail.com`, email_verified: true });
    const res = await t.request('POST', '/v1/auth/google', { body: { idToken, consents: CONSENTS }, headers: cookieHeaders() });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.tokens).not.toHaveProperty('refreshToken');
    expect(rtCookie(res.headers)?.value).toBeTruthy();
  });
});

describe('cookie transport — refresh', () => {
  it('refresh from the cookie rotates and re-sets it; replaying the old cookie trips reuse detection and clears it', async () => {
    const { res } = await cookieLogin();
    const c0 = rtCookie(res.headers)!.value;
    const r1 = await t.request('POST', '/v1/auth/refresh', { headers: cookieHeaders({ cookie: `${REFRESH_COOKIE_NAME}=${c0}` }) });
    expect(r1.status, JSON.stringify(r1.body)).toBe(200);
    expect(r1.body.tokens).not.toHaveProperty('refreshToken');
    expect(r1.body.tokens.sessionId).toBe(res.body.tokens.sessionId);
    expect(r1.headers.get('cache-control')).toBe('no-store');
    const c1 = rtCookie(r1.headers)!.value;
    expect(c1).not.toBe(c0);
    // an empty JSON body behaves the same as no body
    const r2 = await t.request('POST', '/v1/auth/refresh', { body: {}, headers: cookieHeaders({ cookie: `${REFRESH_COOKIE_NAME}=${c1}` }) });
    expect(r2.status).toBe(200);
    const c2 = rtCookie(r2.headers)!.value;
    expect((await t.request('GET', '/v1/me', { token: r2.body.tokens.accessToken })).status).toBe(200);

    // reuse of a rotated cookie value → whole family revoked + REFRESH_TOKEN_REUSE, cookie cleared
    const reuse = await t.request('POST', '/v1/auth/refresh', { headers: cookieHeaders({ cookie: `${REFRESH_COOKIE_NAME}=${c0}` }) });
    expect(reuse.status).toBe(401);
    expect(reuse.body.error.code).toBe('REFRESH_REVOKED');
    const cleared = rtCookie(reuse.headers)!;
    expect(cleared.value).toBe('');
    expect(cleared.raw.toLowerCase()).toContain('max-age=0');
    expect(cleared.raw.toLowerCase()).toContain('path=/v1/auth');
    const latest = await t.request('POST', '/v1/auth/refresh', { headers: cookieHeaders({ cookie: `${REFRESH_COOKIE_NAME}=${c2}` }) });
    expect(latest.status).toBe(401);
    expect((await t.request('GET', '/v1/me', { token: r2.body.tokens.accessToken })).status).toBe(401);
    const [ev] = await t.adminSql<{ n: number }[]>`SELECT count(*)::int AS n FROM security_events WHERE type = 'REFRESH_TOKEN_REUSE' AND meta->>'familyId' = ${res.body.tokens.sessionId}`;
    expect(ev!.n).toBe(1);
  });

  it('no cookie → 401 REFRESH_MISSING; wrong or missing Origin → 403 and the token is not rotated', async () => {
    const none = await t.request('POST', '/v1/auth/refresh', { headers: cookieHeaders() });
    expect(none.status).toBe(401);
    expect(none.body.error.code).toBe('REFRESH_MISSING');

    const { res } = await cookieLogin();
    const c0 = rtCookie(res.headers)!.value;
    for (const origin of ['https://evil.example', 'https://web.test', undefined]) {
      const headers: Record<string, string> = { 'x-jk-token-transport': 'cookie', cookie: `${REFRESH_COOKIE_NAME}=${c0}` };
      if (origin) headers.origin = origin;
      const r = await t.request('POST', '/v1/auth/refresh', { headers });
      expect(r.status, String(origin)).toBe(403);
      expect(r.body.error.code).toBe('ORIGIN_NOT_ALLOWED');
      expect(rtCookie(r.headers)).toBeUndefined();
    }
    const [row] = await t.adminSql<{ n: number }[]>`SELECT count(*)::int AS n FROM refresh_tokens WHERE family_id = ${res.body.tokens.sessionId}`;
    expect(row!.n).toBe(1); // never rotated by the rejected requests
    const ok = await t.request('POST', '/v1/auth/refresh', { headers: cookieHeaders({ cookie: `${REFRESH_COOKIE_NAME}=${c0}` }) });
    expect(ok.status).toBe(200);
  });

  it('a body refresh token still works with the cookie header (moved into the cookie)', async () => {
    const u = await t.createUser();
    const r = await t.request('POST', '/v1/auth/refresh', { body: { refreshToken: u.refreshToken }, headers: cookieHeaders() });
    expect(r.status).toBe(200);
    expect(r.body.tokens).not.toHaveProperty('refreshToken');
    expect(rtCookie(r.headers)?.value).toBeTruthy();
  });
});

describe('cookie transport — logout', () => {
  it('logout with only the cookie revokes the session and clears the cookie', async () => {
    const { res } = await cookieLogin();
    const c0 = rtCookie(res.headers)!.value;
    const out = await t.request('POST', '/v1/auth/logout', { headers: cookieHeaders({ cookie: `${REFRESH_COOKIE_NAME}=${c0}` }) });
    expect(out.status, JSON.stringify(out.body)).toBe(200);
    const cleared = rtCookie(out.headers)!;
    expect(cleared.value).toBe('');
    expect(cleared.raw.toLowerCase()).toContain('max-age=0');
    expect((await t.request('GET', '/v1/me', { token: res.body.tokens.accessToken })).status).toBe(401);
    expect((await t.request('POST', '/v1/auth/refresh', { headers: cookieHeaders({ cookie: `${REFRESH_COOKIE_NAME}=${c0}` }) })).status).toBe(401);
    const [ev] = await t.adminSql<{ via: string }[]>`SELECT meta->>'via' AS via FROM security_events WHERE type = 'LOGOUT' AND meta->>'sessionId' = ${res.body.tokens.sessionId}`;
    expect(ev?.via).toBe('REFRESH_TOKEN');
    // idempotent: the same (now dead) cookie again → 200, still cleared
    const again = await t.request('POST', '/v1/auth/logout', { headers: cookieHeaders({ cookie: `${REFRESH_COOKIE_NAME}=${c0}` }) });
    expect(again.status).toBe(200);
    expect(rtCookie(again.headers)?.value).toBe('');
  });

  it('bearer + cookie logout; cross-site Origin rejected (cookie kept); no credential → 401', async () => {
    const { res } = await cookieLogin();
    const c0 = rtCookie(res.headers)!.value;
    const evil = await t.request('POST', '/v1/auth/logout', { headers: { 'x-jk-token-transport': 'cookie', origin: 'https://evil.example', cookie: `${REFRESH_COOKIE_NAME}=${c0}` } });
    expect(evil.status).toBe(403);
    expect(rtCookie(evil.headers)).toBeUndefined();
    expect((await t.request('GET', '/v1/me', { token: res.body.tokens.accessToken })).status).toBe(200);

    const out = await t.request('POST', '/v1/auth/logout', { token: res.body.tokens.accessToken, headers: cookieHeaders({ cookie: `${REFRESH_COOKIE_NAME}=${c0}` }) });
    expect(out.status).toBe(200);
    expect(rtCookie(out.headers)?.value).toBe('');
    expect((await t.request('GET', '/v1/me', { token: res.body.tokens.accessToken })).status).toBe(401);

    const anon = await t.request('POST', '/v1/auth/logout', { headers: cookieHeaders() });
    expect(anon.status).toBe(401);
    expect(rtCookie(anon.headers)?.value).toBe(''); // a stale cookie would be cleared anyway
    // body transport (mobile) can log out with the refresh token alone; an invalid bearer is still rejected
    const u = await t.createUser();
    expect((await t.request('POST', '/v1/auth/logout', { token: 'not-a-jwt' })).status).toBe(401);
    const bodyOut = await t.request('POST', '/v1/auth/logout', { body: { refreshToken: u.refreshToken } });
    expect(bodyOut.status).toBe(200);
    expect((await t.request('GET', '/v1/me', { token: u.accessToken })).status).toBe(401);
  });
});

describe('CORS for the cookie transport', () => {
  it('preflight: web origins get credentials + the transport header; admin/unknown origins never get credentials', async () => {
    const pre = (origin: string) =>
      t.app.request('/v1/auth/refresh', {
        method: 'OPTIONS',
        headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-jk-token-transport' },
      });
    const web = await pre(WEB);
    expect(web.headers.get('access-control-allow-origin')).toBe(WEB);
    expect(web.headers.get('access-control-allow-credentials')).toBe('true');
    expect(web.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('x-jk-token-transport');
    const extra = await pre('http://localhost:4321');
    expect(extra.headers.get('access-control-allow-credentials')).toBe('true');
    const admin = await pre('http://admin.test');
    expect(admin.headers.get('access-control-allow-origin')).toBe('http://admin.test');
    expect(admin.headers.get('access-control-allow-credentials')).toBeNull();
    const evil = await pre('https://evil.example');
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();
    expect(evil.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('the credential allow-list is WEB_BASE_URL origin + CORS_ORIGINS, never `*`/null', () => {
    const set = webCredentialOrigins({ WEB_BASE_URL: 'https://antarkitaindonesia.com/jastipkita', CORS_ORIGINS: ['*', 'null', 'https://x.example/path', 'http://localhost:4321'] });
    expect([...set].sort()).toEqual(['http://localhost:4321', 'https://antarkitaindonesia.com', 'https://x.example']);
  });
});

describe('cookie attributes per environment', () => {
  const probe = (APP_ENV: string) => {
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('deps', { env: { APP_ENV, REFRESH_TOKEN_TTL_DAYS: 30 } } as never);
      await next();
    });
    app.get('/set', (c) => {
      setRefreshCookie(c, 'r'.repeat(43));
      return c.text('ok');
    });
    app.get('/clear', (c) => {
      clearRefreshCookie(c);
      return c.text('ok');
    });
    return app;
  };
  it('Secure is set in staging/production and omitted only in development/test', async () => {
    for (const env of ['staging', 'production']) {
      const raw = (await probe(env).request('/set')).headers.get('set-cookie')!;
      expect(raw).toBe(`jk_rt=${'r'.repeat(43)}; Max-Age=2592000; Path=/v1/auth; HttpOnly; Secure; SameSite=Strict`);
      const clear = (await probe(env).request('/clear')).headers.get('set-cookie')!;
      expect(clear).toContain('Max-Age=0');
      expect(clear).toContain('Secure');
    }
    for (const env of ['development', 'test']) {
      expect((await probe(env).request('/set')).headers.get('set-cookie')).not.toContain('Secure');
    }
  });
});
