import { beforeEach, describe, expect, it } from 'vitest';
import { API, apiError, fakeJwt, json, mockFetch, tokens } from '../test/utils';
import { call, createApiClient } from './client';
import { isApiError } from './errors';
import { SessionStore } from './session';

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

describe('auth middleware: refresh single-flight', () => {
  let store: SessionStore;
  beforeEach(() => {
    window.sessionStorage.clear();
    store = new SessionStore();
  });

  it('shares ONE refresh between concurrent requests with an expired access token', async () => {
    store.setTokens(tokens({ access: 'old', expiresInSec: -60, refresh: 'rt-old' }));
    let refreshes = 0;
    const m = mockFetch([
      [
        'POST',
        '/v1/auth/refresh',
        async (req) => {
          refreshes++;
          const body = (await req.json()) as { refreshToken: string };
          expect(body.refreshToken).toBe('rt-old');
          await delay(20);
          return json({ tokens: tokens({ access: 'new', refresh: 'rt-new' }) });
        },
      ],
      ['GET', '/v1/admin/dashboard/kpis', (req) => (req.headers.get('authorization') === 'Bearer new' ? json({ metrics: [] }) : apiError(401, 'UNAUTHORIZED'))],
    ]);
    const { client } = createApiClient({ baseUrl: API, fetch: m.fetchImpl, session: store });
    const results = await Promise.all(Array.from({ length: 5 }, () => call<{ metrics: unknown[] }>(client.GET('/v1/admin/dashboard/kpis'))));
    expect(results).toHaveLength(5);
    expect(refreshes).toBe(1);
    expect(store.getAccessToken()).toBe('new');
    expect(store.getRefreshToken()).toBe('rt-new');
    expect(m.calls.filter((c) => c.path === '/v1/admin/dashboard/kpis').every((c) => c.headers.get('authorization') === 'Bearer new')).toBe(true);
  });

  it('on 401 refreshes once and replays each failed request (body included)', async () => {
    store.setTokens(tokens({ access: 'revoked', refresh: 'rt-1' }));
    let refreshes = 0;
    const m = mockFetch([
      [
        'POST',
        '/v1/auth/refresh',
        async () => {
          refreshes++;
          await delay(10);
          return json({ tokens: tokens({ access: 'fresh', refresh: 'rt-2' }) });
        },
      ],
      ['POST', /\/v1\/admin\/users\/.+\/force-logout/, async (req) => (req.headers.get('authorization') === 'Bearer fresh' ? json({ id: 'u', sessionsRevoked: 2, echo: await req.json() }) : apiError(401, 'TOKEN_EXPIRED'))],
    ]);
    const { client } = createApiClient({ baseUrl: API, fetch: m.fetchImpl, session: store });
    const [a, b] = await Promise.all([
      call<{ echo: { reason: string } }>(client.POST('/v1/admin/users/{id}/force-logout', { params: { path: { id: 'u1' } }, body: { reason: 'alasan satu' } })),
      call<{ echo: { reason: string } }>(client.POST('/v1/admin/users/{id}/force-logout', { params: { path: { id: 'u2' } }, body: { reason: 'alasan dua' } })),
    ]);
    expect(refreshes).toBe(1);
    expect(a.echo.reason).toBe('alasan satu');
    expect(b.echo.reason).toBe('alasan dua');
  });

  it('clears the session (EXPIRED) and surfaces 401 when the refresh token is rejected', async () => {
    store.setTokens(tokens({ access: 'x', expiresInSec: -5 }));
    const m = mockFetch([
      ['POST', '/v1/auth/refresh', () => apiError(401, 'REFRESH_TOKEN_INVALID')],
      ['GET', '/v1/me', () => apiError(401, 'UNAUTHORIZED')],
    ]);
    const { client } = createApiClient({ baseUrl: API, fetch: m.fetchImpl, session: store });
    const err = await call(client.GET('/v1/me')).catch((e: unknown) => e);
    expect(isApiError(err) && err.status).toBe(401);
    expect(store.getSnapshot().authenticated).toBe(false);
    expect(store.getSnapshot().endReason).toBe('EXPIRED');
    expect(m.calls.filter((c) => c.path === '/v1/auth/refresh')).toHaveLength(1);
  });

  it('never sends the bearer token or refreshes for OTP login calls', async () => {
    store.setTokens(tokens({ access: 'secret-access' }));
    const m = mockFetch([['POST', '/v1/auth/otp/request', () => json({ challengeId: 'c', expiresAt: '', resendAvailableAt: '' })]]);
    const { client } = createApiClient({ baseUrl: API, fetch: m.fetchImpl, session: store });
    await call(client.POST('/v1/auth/otp/request', { body: { channel: 'EMAIL', destination: 'a@b.co', purpose: 'LOGIN' } }));
    expect(m.calls[0]!.headers.get('authorization')).toBeNull();
  });

  it('keeps the refresh token out of localStorage and the access token out of all storage', () => {
    store.setTokens(tokens({ access: fakeJwt({ exp: 9999999999 }), refresh: 'rt-z' }));
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.getItem('jk_admin_rt')).toBe('rt-z');
    expect(JSON.stringify({ ...window.sessionStorage })).not.toContain(store.getAccessToken()!);
  });

  it('normalizes API errors to {code, message, requestId}', async () => {
    store.setTokens(tokens());
    const m = mockFetch([['GET', '/v1/admin/config', () => apiError(403, 'PERMISSION_DENIED', 'Butuh izin config.read')]]);
    const { client } = createApiClient({ baseUrl: API, fetch: m.fetchImpl, session: store });
    const err = await call(client.GET('/v1/admin/config')).catch((e: unknown) => e);
    expect(isApiError(err)).toBe(true);
    if (isApiError(err)) {
      expect(err.code).toBe('PERMISSION_DENIED');
      expect(err.message).toBe('Butuh izin config.read');
      expect(err.requestId).toBe('req-PERMISSION_DENIED');
    }
  });
});
