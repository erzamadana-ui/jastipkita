/**
 * Tiny browser client for the public JastipKita API (docs/api/openapi.json). No dependencies.
 * - Every call has a timeout; network/CORS failures surface as ApiError{ kind: 'network' } so pages can
 *   fall back to static data ("layanan segera hadir") instead of spinning forever.
 * - Access tokens live in sessionStorage only (cleared when the tab closes). Refresh tokens are NOT stored
 *   on the web; the visitor signs in again in a new session.
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
}

export async function api<T>(path: string, opts: RequestOpts = {}): Promise<T> {
  const url = new URL(`${API_BASE}${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const headers: Record<string, string> = { accept: 'application/json', ...(opts.headers ?? {}) };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.auth) {
    const token = session.getAccessToken();
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

export const session = {
  getAccessToken(): string | null {
    const raw = ss()?.getItem('jk-session');
    if (!raw) return null;
    try {
      const s = JSON.parse(raw) as { accessToken: string; accessTokenExpiresAt: string };
      if (new Date(s.accessTokenExpiresAt).getTime() <= Date.now()) {
        ss()?.removeItem('jk-session');
        return null;
      }
      return s.accessToken;
    } catch {
      return null;
    }
  },
  save(tokens: { accessToken: string; accessTokenExpiresAt: string }): void {
    ss()?.setItem('jk-session', JSON.stringify({ accessToken: tokens.accessToken, accessTokenExpiresAt: tokens.accessTokenExpiresAt }));
  },
  clear(): void {
    ss()?.removeItem('jk-session');
  },
  /** Per-tab device id for DeviceInput.fingerprint (only its HMAC is stored server-side). */
  deviceId(): string {
    const store = ss();
    let id = store?.getItem('jk-device') ?? null;
    if (!id) {
      id = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}-web`;
      store?.setItem('jk-device', id);
    }
    return id;
  },
};

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
