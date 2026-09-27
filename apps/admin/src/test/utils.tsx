import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { createApiClient, setApiClient } from '../api/client';
import { session } from '../api/session';
import { AuthProvider } from '../auth/AuthProvider';
import { MfaProvider } from '../auth/MfaProvider';
import { ToastProvider } from '../components/Toast';

export const API = 'http://api.test';

function b64url(o: unknown): string {
  return btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/** Unsigned JWT-shaped token (the UI never verifies signatures; it only reads exp/mfa_at hints). */
export function fakeJwt(claims: Record<string, unknown>): string {
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(claims)}.sig`;
}

export function tokens(opts: { access?: string; refresh?: string; expiresInSec?: number; mfaAt?: number } = {}) {
  const exp = Math.floor(Date.now() / 1000) + (opts.expiresInSec ?? 900);
  return {
    tokenType: 'Bearer' as const,
    accessToken: opts.access ?? fakeJwt({ sub: 'me', exp, ...(opts.mfaAt ? { mfa_at: opts.mfaAt } : {}) }),
    accessTokenExpiresAt: new Date(exp * 1000).toISOString(),
    refreshToken: opts.refresh ?? 'rt-1',
    refreshTokenExpiresAt: new Date(Date.now() + 30 * 86400_000).toISOString(),
    sessionId: 'sess-1',
  };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

export function apiError(status: number, code: string, message = code): Response {
  return json({ error: { code, message, details: {}, requestId: `req-${code}` } }, status);
}

export type Handler = (req: Request, url: URL) => Response | Promise<Response>;

/** Routes "METHOD /path" (exact path or regex) to handlers; records every request. */
export function mockFetch(routes: [string, RegExp | string, Handler][]) {
  const calls: { method: string; path: string; headers: Headers; body: string }[] = [];
  const fetchImpl = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const body = req.method === 'GET' ? '' : await req.clone().text();
    calls.push({ method: req.method, path: url.pathname, headers: req.headers, body });
    for (const [method, path, h] of routes) {
      if (method !== req.method) continue;
      if (typeof path === 'string' ? path === url.pathname : path.test(url.pathname)) return h(req, url);
    }
    return apiError(404, 'NOT_FOUND', `no mock for ${req.method} ${url.pathname}`);
  };
  return { fetchImpl, calls };
}

export function profile(roles: string[], id = 'admin-1') {
  return {
    id,
    email: `${id}@jastipkita.id`,
    emailVerified: true,
    phone: null,
    phoneVerified: false,
    displayName: 'Admin Satu',
    avatarFileId: null,
    locale: 'id',
    countryCode: 'ID',
    status: 'ACTIVE',
    kycLevel: 2,
    activeMode: 'BUYER',
    trustScore: 80,
    referralCode: 'ADM1',
    transactionEmail: null,
    roles,
    mfaEnabled: true,
    deletionScheduledFor: null,
    createdAt: '2026-01-01T00:00:00Z',
  };
}

/**
 * Renders a page inside the real providers with a signed-in admin whose `/v1/me` comes from the mocked fetch.
 * The session store and API client singleton are replaced for the test.
 */
export function renderApp(ui: ReactElement, opts: { roles: string[]; meId?: string; routes?: [string, RegExp | string, Handler][]; path?: string; route?: string; mfaFresh?: boolean }) {
  const store = session;
  store.clear();
  store.setTokens(tokens({ mfaAt: opts.mfaFresh === false ? undefined : Math.floor(Date.now() / 1000) }));
  try {
    window.sessionStorage.setItem('jk_admin_mfa_gate', '1');
  } catch {
    /* ignore */
  }
  const m = mockFetch([['GET', '/v1/me', () => json(profile(opts.roles, opts.meId))], ...(opts.routes ?? [])]);
  const client = createApiClient({ baseUrl: API, fetch: m.fetchImpl, session: store });
  setApiClient(client);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const path = opts.path ?? '/';
  const utils = render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <AuthProvider>
          <MfaProvider>
            <MemoryRouter initialEntries={[opts.route ?? path]}>
              <Routes>
                <Route path={path} element={ui} />
              </Routes>
            </MemoryRouter>
          </MfaProvider>
        </AuthProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { ...utils, calls: m.calls, store, client };
}

