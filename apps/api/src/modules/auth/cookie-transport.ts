/**
 * Opt-in "cookie transport" for refresh tokens (SEC-14 — the public web shares the origin antarkitaindonesia.com
 * with other AntarKita pages, so the refresh token must be out of JavaScript reach).
 *
 * A client that sends `X-JK-Token-Transport: cookie` on POST /v1/auth/{otp/verify,google,apple,refresh,logout}:
 *   - receives the refresh token ONLY as the cookie `jk_rt` (HttpOnly; Secure; SameSite=Strict; Path=/v1/auth;
 *     Max-Age = REFRESH_TOKEN_TTL_DAYS; no Domain → host-only on the API host) — the JSON `tokens.refreshToken` is omitted;
 *   - may call /v1/auth/refresh and /v1/auth/logout without a body: the token is read from the cookie;
 *   - must send an `Origin` in the web allow-list (WEB_BASE_URL's origin + CORS_ORIGINS) — anything else is
 *     403 ORIGIN_NOT_ALLOWED before the cookie is read or set.
 * CSRF: SameSite=Strict (never sent cross-site) + the custom header (a cross-origin request must pass a CORS
 * preflight, which only allow-listed origins pass) + the Origin check above. Without the header the cookie is
 * ignored entirely, so mobile/admin (body transport, the default) are unaffected.
 *
 * Secure is omitted only when APP_ENV is development/test (plain http://localhost); staging/production always set it.
 */
import { z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { AppEnv } from '../../context';
import type { Env } from '../../env';
import { Errors } from '../../lib/errors';

export const TOKEN_TRANSPORT_HEADER = 'X-JK-Token-Transport';
export const REFRESH_COOKIE_NAME = 'jk_rt';
export const REFRESH_COOKIE_PATH = '/v1/auth';

export type TokenTransport = 'cookie' | 'body';

/** OpenAPI declaration of the opt-in header (lower-case, as Hono validates headers). */
export const TokenTransportHeaders = z.object({
  'x-jk-token-transport': z
    .enum(['cookie', 'body'])
    .optional()
    .openapi({
      description:
        '`cookie` (web): the refresh token is set as the HttpOnly cookie `jk_rt` (Secure; SameSite=Strict; Path=/v1/auth) and omitted from the JSON body; ' +
        'refresh/logout read it from the cookie. Requires an allow-listed `Origin` (403 ORIGIN_NOT_ALLOWED). Default `body` (mobile, admin).',
    }),
});

export function tokenTransport(c: Context<AppEnv>): TokenTransport {
  return c.req.header(TOKEN_TRANSPORT_HEADER)?.trim().toLowerCase() === 'cookie' ? 'cookie' : 'body';
}

/** Browser Origin headers never contain a path: https://antarkitaindonesia.com/jastipkita → https://antarkitaindonesia.com */
export function toOrigin(u: string): string {
  try {
    return new URL(u).origin;
  } catch {
    return u;
  }
}

const originCache = new WeakMap<object, ReadonlySet<string>>();

/**
 * Web origins allowed to make credentialed requests (CORS `Access-Control-Allow-Credentials`) and to use the refresh
 * cookie: the origin of WEB_BASE_URL plus CORS_ORIGINS. Never `*` or `null` (sandboxed iframes, file://).
 */
export function webCredentialOrigins(env: Pick<Env, 'WEB_BASE_URL' | 'CORS_ORIGINS'>): ReadonlySet<string> {
  const hit = originCache.get(env);
  if (hit) return hit;
  const set = new Set(
    [env.WEB_BASE_URL, ...env.CORS_ORIGINS]
      .map(toOrigin)
      .filter((o) => /^https?:\/\/[^/*\s]+$/i.test(o)),
  );
  originCache.set(env, set);
  return set;
}

/** Cookie transport is only honoured for an allow-listed browser Origin (CSRF defence in depth). */
export function assertCookieOrigin(c: Context<AppEnv>): void {
  const deps = c.get('deps');
  const origin = c.req.header('origin');
  if (origin && webCredentialOrigins(deps.env).has(origin)) return;
  deps.logger.warn('auth.cookie_transport_origin_rejected', { path: c.req.path, origin: origin ?? null, requestId: c.get('requestId') });
  throw Errors.forbidden('Asal permintaan tidak diizinkan untuk sesi web', 'ORIGIN_NOT_ALLOWED', { header: TOKEN_TRANSPORT_HEADER });
}

function cookieAttributes(env: Env) {
  return {
    httpOnly: true,
    // development/test run on plain http://localhost; every other environment requires HTTPS.
    secure: !(env.APP_ENV === 'development' || env.APP_ENV === 'test'),
    sameSite: 'Strict' as const,
    path: REFRESH_COOKIE_PATH,
  };
}

export function setRefreshCookie(c: Context<AppEnv>, refreshToken: string): void {
  const env = c.get('deps').env;
  setCookie(c, REFRESH_COOKIE_NAME, refreshToken, { ...cookieAttributes(env), maxAge: env.REFRESH_TOKEN_TTL_DAYS * 86400 });
}

export function clearRefreshCookie(c: Context<AppEnv>): void {
  setCookie(c, REFRESH_COOKIE_NAME, '', { ...cookieAttributes(c.get('deps').env), maxAge: 0, expires: new Date(0) });
}

/** The refresh token from the cookie (same length bounds as the JSON field), or undefined. */
export function readRefreshCookie(c: Context<AppEnv>): string | undefined {
  const v = getCookie(c, REFRESH_COOKIE_NAME);
  return v && v.length >= 20 && v.length <= 200 ? v : undefined;
}

/** Responses carrying tokens must never be cached (RFC 6749 §5.1). */
export function noStore(c: Context<AppEnv>): void {
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
}

/** Cookie transport: moves the refresh token from the JSON body into the HttpOnly cookie. Body transport: unchanged. */
export function deliverTokens<T extends { refreshToken: string }>(c: Context<AppEnv>, transport: TokenTransport, tokens: T): Omit<T, 'refreshToken'> & { refreshToken?: string } {
  noStore(c);
  if (transport !== 'cookie') return tokens;
  setRefreshCookie(c, tokens.refreshToken);
  const { refreshToken: _moved, ...rest } = tokens;
  return rest;
}
