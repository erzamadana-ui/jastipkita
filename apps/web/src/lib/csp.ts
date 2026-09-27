/**
 * Content-Security-Policy for the static site (SEC-14, docs/security/review-2026-09.md).
 * GitHub Pages cannot send response headers, so the policy is delivered as <meta http-equiv> in <head>.
 * Limits of the meta form: `frame-ancestors`, `report-uri`/`report-to` and `sandbox` are ignored by browsers —
 * clickjacking protection needs a real header (host/CDN) — see README "Security".
 *
 * Inline code policy: no inline event handlers, no inline style attributes/elements (utility classes instead),
 * external module scripts only; the single inline <script> (theme bootstrap, must run before first paint) is
 * allowed by its SHA-256 hash. scripts/postbuild.mjs re-verifies every built page.
 */
import { createHash } from 'node:crypto';
import { CONFIG } from '../config.ts';

export function sha256Source(code: string): string {
  return `'sha256-${createHash('sha256').update(code, 'utf8').digest('base64')}'`;
}

function apiOrigin(): string {
  try {
    return new URL(CONFIG.apiBaseUrl).origin;
  } catch {
    return '';
  }
}

export function buildCsp(inlineScripts: string[]): string {
  const google = CONFIG.enableGoogleLogin && CONFIG.googleClientId ? 'https://accounts.google.com' : '';
  const api = apiOrigin();
  const directives: Array<[string, string[]]> = [
    ['default-src', ["'self'"]],
    ['script-src', ["'self'", ...inlineScripts.map(sha256Source), ...(google ? [`${google}/gsi/client`] : [])]],
    ['style-src', ["'self'", ...(google ? [`${google}/gsi/style`] : [])]],
    ['img-src', ["'self'", 'data:', 'https:']],
    ['font-src', ["'self'"]],
    ['connect-src', ["'self'", ...(api ? [api] : []), ...(google ? [`${google}/gsi/`] : [])]],
    ['frame-src', google ? [`${google}/gsi/`] : ["'none'"]],
    ['manifest-src', ["'self'"]],
    ['worker-src', ["'none'"]],
    ['object-src', ["'none'"]],
    ['base-uri', ["'self'"]],
    ['form-action', ["'self'"]],
  ];
  return directives.map(([k, v]) => `${k} ${v.join(' ')}`).join('; ');
}
