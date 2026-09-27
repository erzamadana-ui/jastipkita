/**
 * Typed API client (openapi-fetch over the generated `schema.d.ts`) with the auth middleware:
 *   1. before a request: if the in-memory access token is missing/expiring and a refresh token exists → refresh
 *      (single-flight: concurrent callers share ONE POST /v1/auth/refresh, because refresh tokens rotate and a
 *      second use of the old token would trip reuse detection and revoke the whole session family)
 *   2. attach `Authorization: Bearer <access>`
 *   3. on 401 (not for /v1/auth/*): refresh once (same single-flight) and replay the original request; if refresh
 *      fails the session is cleared (reason EXPIRED) and the error surfaces
 * Errors are normalized to ApiError by `call()`.
 */
import createClient, { type Middleware } from 'openapi-fetch';
import { ENV } from '../env';
import { ApiError, networkError, normalizeError } from './errors';
import type { paths } from './schema';
import { session as defaultSession, type SessionStore, type Tokens } from './session';

type FetchFn = (input: Request) => Promise<Response>;

export interface ApiClientOptions {
  baseUrl?: string;
  fetch?: FetchFn;
  session?: SessionStore;
}

function isAuthPath(url: string): boolean {
  try {
    return new URL(url).pathname.includes('/v1/auth/');
  } catch {
    return url.includes('/v1/auth/');
  }
}

export function createApiClient(opts: ApiClientOptions = {}) {
  const baseUrl = opts.baseUrl ?? ENV.apiBaseUrl;
  const store = opts.session ?? defaultSession;
  const doFetch: FetchFn = opts.fetch ?? ((r) => globalThis.fetch(r));

  let inflight: Promise<boolean> | null = null;

  async function doRefresh(refreshToken: string): Promise<boolean> {
    let res: Response;
    try {
      res = await doFetch(
        new Request(`${baseUrl}/v1/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken }),
        }),
      );
    } catch {
      return false; // network: keep the session, the caller surfaces a network error
    }
    if (!res.ok) {
      store.clear('EXPIRED');
      return false;
    }
    const body = (await res.json().catch(() => null)) as { tokens?: Tokens } | null;
    if (!body?.tokens?.accessToken) {
      store.clear('EXPIRED');
      return false;
    }
    store.setTokens(body.tokens);
    return true;
  }

  /** Single-flight refresh. Every concurrent caller receives the same promise. */
  function refresh(): Promise<boolean> {
    if (inflight) return inflight;
    const rt = store.getRefreshToken();
    if (!rt) return Promise.resolve(false);
    const p = doRefresh(rt).finally(() => {
      if (inflight === p) inflight = null;
    });
    inflight = p;
    return p;
  }

  const replay = new Map<string, Request>();

  const auth: Middleware = {
    async onRequest({ request, id }) {
      if (!isAuthPath(request.url) || request.url.includes('/v1/auth/mfa/') || request.url.includes('/v1/auth/logout') || request.url.includes('/v1/auth/sessions')) {
        if (store.accessNeedsRefresh() && store.getRefreshToken()) await refresh();
        const token = store.getAccessToken();
        if (token) request.headers.set('Authorization', `Bearer ${token}`);
      }
      if (!isAuthPath(request.url)) replay.set(id, request.clone());
      return request;
    },
    async onResponse({ response, id }) {
      const original = replay.get(id);
      replay.delete(id);
      if (response.status !== 401 || !original) return response;
      const ok = await refresh();
      if (!ok) return response;
      const token = store.getAccessToken();
      if (token) original.headers.set('Authorization', `Bearer ${token}`);
      return doFetch(original);
    },
    onError({ id }) {
      replay.delete(id);
    },
  };

  const client = createClient<paths>({ baseUrl, fetch: doFetch });
  client.use(auth);

  /** Authenticated raw fetch (file streaming) with the same refresh/401 handling. */
  async function authFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const url = path.startsWith('http') ? path : `${baseUrl}${path}`;
    if (store.accessNeedsRefresh() && store.getRefreshToken()) await refresh();
    const build = () => {
      const headers = new Headers(init.headers);
      const t = store.getAccessToken();
      if (t) headers.set('Authorization', `Bearer ${t}`);
      return new Request(url, { ...init, headers, cache: 'no-store' });
    };
    let res: Response;
    try {
      res = await doFetch(build());
      if (res.status === 401 && (await refresh())) res = await doFetch(build());
    } catch (e) {
      throw networkError(e);
    }
    return res;
  }

  return { client, refresh, authFetch, session: store, baseUrl };
}

export type ApiClient = ReturnType<typeof createApiClient>;

/** Unwraps an openapi-fetch result: returns data or throws a normalized ApiError. */
export async function call<T>(p: Promise<{ data?: unknown; error?: unknown; response: Response }>): Promise<T> {
  let r: { data?: unknown; error?: unknown; response: Response };
  try {
    r = await p;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw networkError(e);
  }
  if (!r.response.ok) throw normalizeError(r.response.status, r.error, r.response);
  return r.data as T;
}

let singleton: ApiClient | null = null;

export function api(): ApiClient {
  if (!singleton) singleton = createApiClient();
  return singleton;
}

/** Test hook: replace the singleton (e.g. with a client over a mocked fetch). */
export function setApiClient(c: ApiClient | null) {
  singleton = c;
}
