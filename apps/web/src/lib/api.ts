/**
 * Tiny browser client for the public JastipKita API (docs/api/openapi.json). No dependencies.
 * - Every call has a timeout; network/CORS failures surface as ApiError{ kind: 'network' } so pages can
 *   fall back to static data ("layanan segera hadir") instead of spinning forever.
 * - Access token in memory only; refresh token in sessionStorage (`jk:refresh`, per tab). See `session` below.
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
      credentials: 'omit',
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
const KEY_REFRESH = `${STORAGE_PREFIX}refresh`;
const KEY_DEVICE = `${STORAGE_PREFIX}device`;

interface Tokens {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken?: string;
}

/**
 * Web session (SEC-14):
 *  - the ACCESS token lives in memory only (lost on navigation/reload by design);
 *  - the REFRESH token is kept in sessionStorage (`jk:refresh`, this tab only, gone when the tab closes) and is
 *    exchanged for a fresh access token with POST /v1/auth/refresh (the API rotates it on every use);
 *  - logout clears every `jk:` key in sessionStorage AND localStorage. Nothing auth-related ever touches localStorage.
 */
let memAccess: { token: string; expiresAt: number } | null = null;
let refreshing: Promise<string | null> | null = null;

export const session = {
  dropAccessToken(): void {
    memAccess = null;
  },
  getAccessToken(): string | null {
    if (memAccess && memAccess.expiresAt - 15_000 > Date.now()) return memAccess.token;
    memAccess = null;
    return null;
  },
  hasSession(): boolean {
    return !!this.getAccessToken() || !!ss()?.getItem(KEY_REFRESH);
  },
  save(tokens: Tokens): void {
    memAccess = { token: tokens.accessToken, expiresAt: new Date(tokens.accessTokenExpiresAt).getTime() };
    if (tokens.refreshToken) ss()?.setItem(KEY_REFRESH, tokens.refreshToken);
  },
  /** Access token from memory, or refreshed from the tab-scoped refresh token (single-flight). */
  async ensureAccessToken(): Promise<string | null> {
    const t = this.getAccessToken();
    if (t) return t;
    const rt = ss()?.getItem(KEY_REFRESH);
    if (!rt) return null;
    refreshing ??= (async () => {
      try {
        const res = await rawRefresh(rt);
        session.save(res);
        return res.accessToken;
      } catch (e) {
        // Refresh token expired/revoked/reused: drop the session keys (preferences stay until logout).
        if (e instanceof ApiError && e.kind === 'http') {
          memAccess = null;
          ss()?.removeItem(KEY_REFRESH);
        }
        return null;
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  },
  /** Remove every JastipKita key (`jk:*`) from sessionStorage and localStorage, and the in-memory token. */
  clear(): void {
    memAccess = null;
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

async function rawRefresh(refreshToken: string): Promise<Tokens> {
  const res = await api<{ tokens: Tokens }>('/v1/auth/refresh', { body: { refreshToken }, auth: false });
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
