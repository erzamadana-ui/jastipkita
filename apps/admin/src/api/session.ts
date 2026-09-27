/**
 * Admin session tokens.
 *
 *  - Access token (JWT, 15 min): MEMORY ONLY. Never written to any storage, so a page reload drops it and the app
 *    refreshes it with the refresh token.
 *  - Refresh token (opaque, rotated on every use): sessionStorage ONLY — it survives a reload of this tab but ends
 *    with the tab. Trade-off (README §Security): sessionStorage is readable by script running on the admin origin, so
 *    an XSS could steal it; mitigations are the strict CSP (no inline / third-party script), no user HTML rendering,
 *    refresh-token rotation with reuse detection on the API (a stolen+used token revokes the whole family), and
 *    MFA step-up (≤ 15 min) for every sensitive write, which a stolen refresh token alone cannot satisfy.
 *    An httpOnly cookie would be stronger against XSS but the API is bearer-only and cross-origin (no cookie auth).
 *  - MFA freshness: `mfa_at` (epoch seconds) from the step-up response / JWT claim. Refreshing drops it (API rule).
 */
import type { components } from './schema';

export type Tokens = components['schemas']['Tokens'];

const RT_KEY = 'jk_admin_rt';

export interface SessionSnapshot {
  authenticated: boolean;
  hasRefreshToken: boolean;
  accessExpiresAt: number | null;
  /** epoch seconds of the last TOTP step-up for THIS access token, null when none */
  mfaAt: number | null;
  sessionId: string | null;
  /** why the last session ended (shown on the login screen) */
  endReason: 'LOGOUT' | 'EXPIRED' | null;
}

interface AccessState {
  token: string;
  expiresAt: number;
  mfaAt: number | null;
  sessionId: string | null;
}

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

/** Decodes a JWT payload without verifying it (display/expiry hints only — the API is the authority). */
export function decodeJwt(token: string): Record<string, unknown> | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
    return JSON.parse(atob(b64)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export class SessionStore {
  private access: AccessState | null = null;
  private listeners = new Set<() => void>();
  private endReason: SessionSnapshot['endReason'] = null;
  private snap: SessionSnapshot = { authenticated: false, hasRefreshToken: false, accessExpiresAt: null, mfaAt: null, sessionId: null, endReason: null };

  constructor() {
    this.recompute();
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): SessionSnapshot => this.snap;

  private recompute() {
    const rt = this.getRefreshToken();
    this.snap = {
      authenticated: !!this.access || !!rt,
      hasRefreshToken: !!rt,
      accessExpiresAt: this.access?.expiresAt ?? null,
      mfaAt: this.access?.mfaAt ?? null,
      sessionId: this.access?.sessionId ?? null,
      endReason: this.endReason,
    };
    for (const l of this.listeners) l();
  }

  getAccessToken(): string | null {
    return this.access?.token ?? null;
  }

  /** True when there is no usable access token (missing or expiring within `skewMs`). */
  accessNeedsRefresh(now = Date.now(), skewMs = 20_000): boolean {
    return !this.access || this.access.expiresAt - skewMs <= now;
  }

  getRefreshToken(): string | null {
    try {
      return storage()?.getItem(RT_KEY) ?? null;
    } catch {
      return null;
    }
  }

  /** Login / refresh result: new access token (no MFA claim unless present) + rotated refresh token. */
  setTokens(t: Pick<Tokens, 'accessToken' | 'accessTokenExpiresAt' | 'refreshToken' | 'sessionId'>) {
    const claims = decodeJwt(t.accessToken);
    const mfa = typeof claims?.mfa_at === 'number' ? claims.mfa_at : null;
    this.access = { token: t.accessToken, expiresAt: Date.parse(t.accessTokenExpiresAt), mfaAt: mfa, sessionId: t.sessionId ?? null };
    this.endReason = null;
    try {
      storage()?.setItem(RT_KEY, t.refreshToken);
    } catch {
      /* storage unavailable: session lasts until the access token expires */
    }
    this.recompute();
  }

  /** MFA step-up / enrolment confirm: new access token for the SAME session; refresh token unchanged. */
  setAccessToken(token: string, expiresAtIso: string, mfaAt?: number | null) {
    const claims = decodeJwt(token);
    const mfa = mfaAt ?? (typeof claims?.mfa_at === 'number' ? claims.mfa_at : null);
    this.access = { token, expiresAt: Date.parse(expiresAtIso), mfaAt: mfa, sessionId: this.access?.sessionId ?? null };
    this.recompute();
  }

  clear(reason: 'LOGOUT' | 'EXPIRED' = 'LOGOUT') {
    this.access = null;
    this.endReason = reason;
    try {
      storage()?.removeItem(RT_KEY);
    } catch {
      /* ignore */
    }
    this.recompute();
  }
}

export const session = new SessionStore();

/** Seconds of MFA freshness left (0 when stale/none). */
export function mfaSecondsLeft(mfaAt: number | null, windowSec: number, nowMs = Date.now()): number {
  if (!mfaAt) return 0;
  return Math.max(0, Math.floor(mfaAt + windowSec - nowMs / 1000));
}
