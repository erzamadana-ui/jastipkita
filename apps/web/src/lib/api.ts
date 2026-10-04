/**
 * Tiny browser client for the public JastipKita API (docs/api/openapi.json). No dependencies.
 * - Every call has a timeout; network/CORS failures surface as ApiError{ kind: 'network' } so pages can
 *   fall back to static data ("layanan segera hadir") instead of spinning forever.
 * - Access token in memory only; the refresh token never reaches JavaScript: the API keeps it in the HttpOnly
 *   cookie `jk_rt` on its own host ("cookie transport", SEC-14). See `session` below.
 */
import { CONFIG } from '../config.ts';

export const API_BASE = CONFIG.apiBaseUrl;

export class ApiError extends Error {
  constructor(
    public kind: 'network' | 'http',
    public status: number,
    public code: string,
    message: string,
    public details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

interface RequestOpts {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  auth?: boolean;
  timeoutMs?: number;
  headers?: Record<string, string>;
  /** internal: set on the single retry after a 401 */
  retried?: boolean;
}

/**
 * Auth endpoints that issue, read or clear the refresh cookie. Only these are credentialed (`credentials: 'include'`)
 * and carry `X-JK-Token-Transport: cookie`; every other call stays cookie-less (`credentials: 'omit'`, bearer only).
 */
const COOKIE_TRANSPORT_PATHS = new Set(['/v1/auth/otp/verify', '/v1/auth/google', '/v1/auth/apple', '/v1/auth/refresh', '/v1/auth/logout']);
export const TOKEN_TRANSPORT_HEADER = 'X-JK-Token-Transport';

export async function api<T>(path: string, opts: RequestOpts = {}): Promise<T> {
  try {
    return await request<T>(path, opts);
  } catch (e) {
    // Access token expired/revoked mid-page: rotate once with the tab's refresh token, then retry once.
    if (opts.auth && e instanceof ApiError && e.status === 401 && session.hasSession() && !opts.retried) {
      session.dropAccessToken();
      if (await session.ensureAccessToken()) return request<T>(path, { ...opts, retried: true });
    }
    throw e;
  }
}

async function request<T>(path: string, opts: RequestOpts): Promise<T> {
  const url = new URL(`${API_BASE}${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const headers: Record<string, string> = { accept: 'application/json', ...(opts.headers ?? {}) };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const cookieTransport = COOKIE_TRANSPORT_PATHS.has(path);
  if (cookieTransport) headers[TOKEN_TRANSPORT_HEADER] = 'cookie';
  if (opts.auth) {
    const token = await session.ensureAccessToken();
    if (token) headers.authorization = `Bearer ${token}`;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 8000);
  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: ctrl.signal,
      credentials: cookieTransport ? 'include' : 'omit',
      mode: 'cors',
    });
  } catch (e) {
    throw new ApiError('network', 0, 'NETWORK', e instanceof Error ? e.message : 'Network error');
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string; details?: Record<string, unknown> } } | null)?.error;
    if (!err) throw new ApiError('network', res.status, 'UNEXPECTED_RESPONSE', `HTTP ${res.status}`);
    throw new ApiError('http', res.status, err.code ?? 'ERROR', err.message ?? `HTTP ${res.status}`, err.details ?? {});
  }
  if (json === null && text) throw new ApiError('network', res.status, 'UNEXPECTED_RESPONSE', 'Invalid JSON');
  return json as T;
}

function ss(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}
function ls(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Every key this site stores is prefixed with `jk:` (shared origin — SEC-14). */
export const STORAGE_PREFIX = 'jk:';
/** Pre-cookie-transport refresh token key (sessionStorage). Never written any more; deleted on every page load. */
export const LEGACY_REFRESH_KEY = `${STORAGE_PREFIX}refresh`;
const KEY_DEVICE = `${STORAGE_PREFIX}device`;
/** Web Locks name: refreshes are serialized across tabs (they share the one rotating cookie). */
const REFRESH_LOCK = `${STORAGE_PREFIX}auth-refresh`;

try {
  ss()?.removeItem(LEGACY_REFRESH_KEY);
} catch {
  /* storage unavailable */
}

interface Tokens {
  accessToken: string;
  accessTokenExpiresAt: string;
  /** Never stored: with cookie transport the API omits it; if a proxy dropped our header it is ignored. */
  refreshToken?: string;
}

/**
 * Web session (SEC-14, cookie transport):
 *  - the ACCESS token lives in memory only (lost on navigation/reload by design);
 *  - the REFRESH token is never visible to JavaScript: login/refresh responses set it as the HttpOnly, Secure,
 *    SameSite=Strict cookie `jk_rt` on the API host (Path=/v1/auth); nothing is written to sessionStorage/localStorage;
 *  - on page load an auth-needing page restores the session silently with POST /v1/auth/refresh (credentialed,
 *    `X-JK-Token-Transport: cookie`); the API rotates the cookie on every use. A "no session" answer is remembered for
 *    this page so anonymous visitors cost one request at most;
 *  - the cookie is shared by all tabs, so refreshes are serialized across tabs with the Web Locks API (two tabs
 *    presenting the same rotating token at once would trip the API's reuse detection and end the session);
 *  - logout revokes the session server-side (bearer and/or cookie), the API clears the cookie, and every `jk:` key
 *    in sessionStorage AND localStorage is removed. Nothing auth-related ever touches web storage.
 */
let memAccess: { token: string; expiresAt: number } | null = null;
let refreshing: Promise<string | null> | null = null;
/** True once the API said there is no (valid) refresh cookie — until the next login on this page. */
let noSession = false;

async function withRefreshLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks?.request) return fn(); // very old browsers: per-page single-flight only
  return await locks.request(REFRESH_LOCK, () => fn());
}

export const session = {
  dropAccessToken(): void {
    memAccess = null;
  },
  getAccessToken(): string | null {
    if (memAccess && memAccess.expiresAt - 15_000 > Date.now()) return memAccess.token;
    memAccess = null;
    return null;
  },
  /** False only when the API already answered that this browser has no session (no refresh cookie). */
  hasSession(): boolean {
    return !!this.getAccessToken() || !noSession;
  },
  save(tokens: Tokens): void {
    memAccess = { token: tokens.accessToken, expiresAt: new Date(tokens.accessTokenExpiresAt).getTime() };
    noSession = false;
  },
  /** Access token from memory, or a fresh one from the refresh cookie (single-flight per page, serialized across tabs). */
  async ensureAccessToken(): Promise<string | null> {
    const t = this.getAccessToken();
    if (t) return t;
    if (noSession) return null;
    refreshing ??= (async () => {
      try {
        const res = await withRefreshLock(() => rawRefresh());
        session.save(res);
        return res.accessToken;
      } catch (e) {
        // No cookie / expired / revoked / reused: the API already cleared the cookie. Network errors may be retried.
        if (e instanceof ApiError && e.kind === 'http') {
          memAccess = null;
          noSession = true;
        }
        return null;
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  },
  /** Silent session restore on page load (true = signed in). */
  async restore(): Promise<boolean> {
    return !!(await this.ensureAccessToken());
  },
  /** Revoke the session server-side (bearer if any + the refresh cookie), then wipe every local trace. */
  async logout(): Promise<void> {
    const token = this.getAccessToken();
    try {
      await withRefreshLock(() =>
        api('/v1/auth/logout', { method: 'POST', ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}) }),
      );
    } catch {
      /* offline / already logged out: the local state is cleared anyway */
    }
    this.clear();
  },
  /** Remove every JastipKita key (`jk:*`) from sessionStorage and localStorage, and the in-memory token. */
  clear(): void {
    memAccess = null;
    noSession = true;
    for (const store of [ss(), ls()]) {
      if (!store) continue;
      for (const k of Object.keys(store)) if (k.startsWith(STORAGE_PREFIX)) store.removeItem(k);
    }
  },
  /** Per-tab device id for DeviceInput.fingerprint (only its HMAC is stored server-side). */
  deviceId(): string {
    const store = ss();
    let id = store?.getItem(KEY_DEVICE) ?? null;
    if (!id) {
      id = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}-web`;
      store?.setItem(KEY_DEVICE, id);
    }
    return id;
  },
};

/** POST /v1/auth/refresh with the cookie (no body): the API rotates `jk_rt` and returns a new access token. */
async function rawRefresh(): Promise<Tokens> {
  const res = await api<{ tokens: Tokens }>('/v1/auth/refresh', { method: 'POST', auth: false });
  return res.tokens;
}

/** Human message for an API error (Indonesian default). */
export function describeError(e: unknown, lang: 'id' | 'en' = 'id'): string {
  if (e instanceof ApiError) {
    if (e.kind === 'network') {
      return lang === 'id'
        ? 'Layanan JastipKita belum dapat dihubungi. Server kami belum dibuka untuk umum — coba lagi nanti.'
        : 'The JastipKita service cannot be reached yet. Our servers are not open to the public — please try again later.';
    }
    return e.message;
  }
  return lang === 'id' ? 'Terjadi kesalahan. Coba lagi.' : 'Something went wrong. Please try again.';
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}
