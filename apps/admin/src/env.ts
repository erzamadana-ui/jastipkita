/**
 * Build-time public configuration (see apps/admin/.env.example). Everything here ends up in the bundle —
 * never secrets. Names are fixed by DevOps: VITE_API_BASE_URL, VITE_APP_ENV, VITE_BASE_PATH.
 */
export type AppEnv = 'development' | 'staging' | 'production';

function trimSlash(s: string): string {
  return s.replace(/\/+$/, '');
}

const rawEnv = (import.meta.env.VITE_APP_ENV ?? 'development') as string;

export const ENV = {
  apiBaseUrl: trimSlash((import.meta.env.VITE_API_BASE_URL as string | undefined) ?? 'http://localhost:8787'),
  appEnv: (['development', 'staging', 'production'].includes(rawEnv) ? rawEnv : 'development') as AppEnv,
  basePath: ((import.meta.env.VITE_BASE_PATH as string | undefined) ?? '/').trim() || '/',
  /**
   * Fallback step-up window (ADMIN_MFA_STEP_UP_SEC default 900 s) until `/v1/me.adminMfaPolicy` is loaded; the
   * server's MFA_REQUIRED answer stays the truth either way (step-up + retry).
   */
  mfaWindowSec: 900,
} as const;

/** Router basename without trailing slash ("" for "/"). */
export const ROUTER_BASENAME = ENV.basePath === '/' ? '' : trimSlash(ENV.basePath.startsWith('/') ? ENV.basePath : `/${ENV.basePath}`);
