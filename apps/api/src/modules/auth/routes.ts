import { createRoute, z } from '@hono/zod-openapi';
import type { Context, MiddlewareHandler } from 'hono';
import type { App, AppEnv } from '../../context';
import { AppError, Errors } from '../../lib/errors';
import { bearer, createRouter, errorResponses, jsonBody, jsonContent } from '../../lib/openapi';
import { getAuth, optionalAuth, requireAdminRole, requireAuth } from '../../middleware/auth';
import { rateLimit } from '../../middleware/rate-limit';
import { OkSchema } from '../me/schemas';
import { requestMeta } from './common';
import {
  assertCookieOrigin,
  clearRefreshCookie,
  deliverTokens,
  readRefreshCookie,
  tokenTransport,
  TokenTransportHeaders,
  type TokenTransport,
} from './cookie-transport';
import {
  AppleBody,
  GoogleBody,
  LoginResponse,
  LogoutBody,
  MfaCodeBody,
  MfaConfirmResponse,
  MfaEnrollResponse,
  MfaVerifyBody,
  MfaVerifyResponse,
  OtpRequestBody,
  OtpRequestResponse,
  OtpVerifyBody,
  OtpVerifyResponse,
  RefreshBody,
  RefreshResponse,
  SessionSchema,
} from './schemas';
import * as svc from './service';

const tags = ['Auth'];

const COOKIE_NOTE =
  ' Web: send `X-JK-Token-Transport: cookie` (credentialed fetch from an allow-listed Origin) to receive the refresh token only as the HttpOnly cookie `jk_rt` (omitted from the body).';

/** Cookie transport (SEC-14): the Origin is checked BEFORE any side effect (OTP consumption, account creation). */
function transportOf(c: Context<AppEnv>): TokenTransport {
  const transport = tokenTransport(c);
  if (transport === 'cookie') assertCookieOrigin(c);
  return transport;
}

/** Logout: a bearer token is verified strictly when present (as before); without one, a refresh token may identify the session. */
const bearerIfPresent: MiddlewareHandler<AppEnv> = (c, next) => (c.req.header('authorization') ? requireAuth(c, next) : next());

const optionalJsonBody = <T extends z.ZodTypeAny>(schema: T) => ({
  body: { content: { 'application/json': { schema } }, required: false },
});

export function registerAuth(app: App) {
  const r = createRouter();

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/auth/otp/request',
      tags,
      summary: 'Request a one-time code (SMS / WhatsApp / e-mail)',
      description:
        'LOGIN is public and doubles as sign-up (no account enumeration: the response is identical whether or not an account exists). ' +
        'VERIFY_PHONE / VERIFY_EMAIL require a bearer token. SENSITIVE_ACTION (bearer; `action` + `targetId` required) is a step-up for ' +
        'refund destinations and payout accounts: sent only to the verified phone / e-mail, valid 10 min, single use, bound to action + target. Limits: 60 s resend cooldown, 5/hour and 10/day per destination, 20/hour per IP.',
      middleware: [rateLimit({ name: 'auth.otp.request', limit: 30, windowSec: 60, key: 'ip' }), optionalAuth] as const,
      request: jsonBody(OtpRequestBody),
      responses: { 200: jsonContent(OtpRequestResponse), ...errorResponses },
    }),
    async (c) => {
      const body = c.req.valid('json');
      const res = await svc.requestOtp(c.get('deps'), body, { auth: c.get('auth'), req: await requestMeta(c) });
      return c.json(res, 200);
    },
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/auth/otp/verify',
      tags,
      summary: 'Verify a one-time code',
      description:
        'LOGIN → {tokens, user, isNewUser}; a new account requires `consents` (TOS + PRIVACY). VERIFY_PHONE (bearer auth) raises the account to level 2; ' +
        'VERIFY_EMAIL (bearer auth) sets the transaction e-mail. 5 wrong attempts lock the challenge.' +
        COOKIE_NOTE,
      middleware: [rateLimit({ name: 'auth.otp.verify', limit: 60, windowSec: 60, key: 'ip' }), optionalAuth] as const,
      request: { headers: TokenTransportHeaders, ...jsonBody(OtpVerifyBody) },
      responses: { 200: jsonContent(OtpVerifyResponse), ...errorResponses },
    }),
    async (c) => {
      const transport = transportOf(c);
      const body = c.req.valid('json');
      const res = await svc.verifyOtp(c.get('deps'), body, { auth: c.get('auth'), req: await requestMeta(c) });
      if (!res.tokens) return c.json(res, 200);
      return c.json({ ...res, tokens: deliverTokens(c, transport, res.tokens) }, 200);
    },
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/auth/google',
      tags,
      summary: 'Sign in with Google (ID token)',
      description:
        'Verifies the ID token against Google JWKS (iss accounts.google.com, aud ∈ GOOGLE_CLIENT_IDS, email_verified). Links to an existing account with the same verified e-mail. ' +
        '`nonce` is checked when sent (required when GOOGLE ∈ OAUTH_REQUIRE_NONCE → 401 OAUTH_NONCE_REQUIRED); a verified nonce makes the token single use.' +
        COOKIE_NOTE,
      middleware: [rateLimit({ name: 'auth.oauth', limit: 30, windowSec: 60, key: 'ip' })] as const,
      request: { headers: TokenTransportHeaders, ...jsonBody(GoogleBody) },
      responses: { 200: jsonContent(LoginResponse), ...errorResponses },
    }),
    async (c) => {
      const transport = transportOf(c);
      const b = c.req.valid('json');
      const res = await svc.oauthLogin(c.get('deps'), 'GOOGLE', { ...b, token: b.idToken }, { req: await requestMeta(c) });
      return c.json({ ...res, tokens: deliverTokens(c, transport, res.tokens) }, 200);
    },
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/auth/apple',
      tags,
      summary: 'Sign in with Apple (identity token)',
      description:
        'Verifies against Apple JWKS (iss https://appleid.apple.com, aud ∈ APPLE_CLIENT_IDS). Private-relay e-mails are accepted; `fullName` is only sent by Apple on first authorization. ' +
        'A nonce is REQUIRED by default (`rawNonce`, or the legacy hashed `nonce`; OAUTH_REQUIRE_NONCE) → 401 OAUTH_NONCE_REQUIRED; the verified nonce makes the token single use.' +
        COOKIE_NOTE,
      middleware: [rateLimit({ name: 'auth.oauth', limit: 30, windowSec: 60, key: 'ip' })] as const,
      request: { headers: TokenTransportHeaders, ...jsonBody(AppleBody) },
      responses: { 200: jsonContent(LoginResponse), ...errorResponses },
    }),
    async (c) => {
      const transport = transportOf(c);
      const b = c.req.valid('json');
      const res = await svc.oauthLogin(c.get('deps'), 'APPLE', { ...b, token: b.identityToken }, { req: await requestMeta(c) });
      return c.json({ ...res, tokens: deliverTokens(c, transport, res.tokens) }, 200);
    },
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/auth/refresh',
      tags,
      summary: 'Rotate the refresh token',
      description:
        'Refresh tokens are single-use. Re-using a rotated token revokes the whole session family (theft detection). ' +
        'Cookie transport (`X-JK-Token-Transport: cookie`, allow-listed Origin): the body may be empty — the `jk_rt` cookie is used, rotated and re-set; ' +
        'no cookie → 401 REFRESH_MISSING; a failed refresh also clears the cookie.',
      middleware: [rateLimit({ name: 'auth.refresh', limit: 60, windowSec: 60, key: 'ip' })] as const,
      request: { headers: TokenTransportHeaders, ...optionalJsonBody(RefreshBody) },
      responses: { 200: jsonContent(RefreshResponse), ...errorResponses },
    }),
    async (c) => {
      const transport = transportOf(c);
      const fromBody = c.req.valid('json').refreshToken;
      const token = fromBody ?? (transport === 'cookie' ? readRefreshCookie(c) : undefined);
      if (!token) {
        if (transport !== 'cookie') throw Errors.validation({ issues: [{ path: 'refreshToken', code: 'invalid_type', message: 'Required' }] });
        clearRefreshCookie(c);
        throw Errors.unauthorized('Sesi tidak ditemukan, silakan masuk kembali', 'REFRESH_MISSING');
      }
      let res: Awaited<ReturnType<typeof svc.refresh>>;
      try {
        res = await svc.refresh(c.get('deps'), token, await requestMeta(c));
      } catch (err) {
        // the cookie is useless after an invalid/revoked/expired refresh or an inactive account: drop it
        if (transport === 'cookie' && err instanceof AppError && (err.status === 401 || err.status === 403)) clearRefreshCookie(c);
        throw err;
      }
      return c.json({ tokens: deliverTokens(c, transport, res.tokens) }, 200);
    },
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/auth/logout',
      tags,
      summary: 'Log out (revoke the current session)',
      description:
        'Revokes the bearer token\'s session and/or the session of the presented refresh token (`refreshToken` in the body, or the `jk_rt` cookie with ' +
        '`X-JK-Token-Transport: cookie` + allow-listed Origin). Cookie transport always clears the cookie. Without any credential → 401. Idempotent for a refresh token whose session already ended.',
      security: [...bearer, {}],
      middleware: [bearerIfPresent] as const,
      request: { headers: TokenTransportHeaders, ...optionalJsonBody(LogoutBody) },
      responses: { 200: jsonContent(OkSchema), ...errorResponses },
    }),
    async (c) => {
      const transport = transportOf(c);
      if (transport === 'cookie') clearRefreshCookie(c);
      const auth = c.get('auth');
      const refreshToken = c.req.valid('json').refreshToken ?? (transport === 'cookie' ? readRefreshCookie(c) : undefined);
      if (!auth && !refreshToken) throw Errors.unauthorized();
      await svc.logout(c.get('deps'), { auth, refreshToken }, await requestMeta(c));
      return c.json({ ok: true as const }, 200);
    },
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/auth/sessions',
      tags,
      summary: 'List active sessions',
      security: bearer,
      middleware: [requireAuth] as const,
      responses: { 200: jsonContent(z.object({ data: z.array(SessionSchema) })), ...errorResponses },
    }),
    async (c) => c.json({ data: await svc.sessions(c.get('deps'), getAuth(c)) }, 200),
  );

  r.openapi(
    createRoute({
      method: 'delete',
      path: '/v1/auth/sessions/{id}',
      tags,
      summary: 'Revoke a session',
      security: bearer,
      middleware: [requireAuth] as const,
      request: { params: z.object({ id: z.string().uuid() }) },
      responses: { 200: jsonContent(OkSchema), ...errorResponses },
    }),
    async (c) => {
      await svc.revokeUserSession(c.get('deps'), getAuth(c), c.req.valid('param').id, await requestMeta(c));
      return c.json({ ok: true as const }, 200);
    },
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/auth/mfa/totp/enroll',
      tags,
      summary: 'Start TOTP enrollment (admins)',
      description: 'Returns the secret ONCE (stored encrypted). Confirm with a code to activate.',
      security: bearer,
      // role only: an admin must be able to enroll BEFORE the session can be MFA-verified (SEC-01)
      middleware: [requireAuth, requireAdminRole, rateLimit({ name: 'auth.mfa.enroll', limit: 10, windowSec: 3600, key: 'user' })] as const,
      responses: { 200: jsonContent(MfaEnrollResponse), ...errorResponses },
    }),
    async (c) => c.json(await svc.mfaEnroll(c.get('deps'), getAuth(c), await requestMeta(c)), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/auth/mfa/totp/confirm',
      tags,
      summary: 'Confirm TOTP enrollment',
      description: 'Activates the factor, returns one-time recovery codes and a step-up access token (mfa_at).',
      security: bearer,
      middleware: [requireAuth, rateLimit({ name: 'auth.mfa', limit: 20, windowSec: 60, key: 'user' })] as const,
      request: jsonBody(MfaCodeBody),
      responses: { 200: jsonContent(MfaConfirmResponse), ...errorResponses },
    }),
    async (c) => c.json(await svc.mfaConfirm(c.get('deps'), getAuth(c), c.req.valid('json').code, await requestMeta(c)), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/auth/mfa/verify',
      tags,
      summary: 'MFA step-up',
      description: 'Verifies a TOTP code (replay-protected) or a recovery code; returns a new access token carrying `mfa_at` for the same session.',
      security: bearer,
      middleware: [requireAuth, rateLimit({ name: 'auth.mfa', limit: 20, windowSec: 60, key: 'user' })] as const,
      request: jsonBody(MfaVerifyBody),
      responses: { 200: jsonContent(MfaVerifyResponse), ...errorResponses },
    }),
    async (c) => c.json(await svc.mfaVerify(c.get('deps'), getAuth(c), c.req.valid('json'), await requestMeta(c)), 200),
  );

  app.route('/', r);
}
