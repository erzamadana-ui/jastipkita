import { createRoute, z } from '@hono/zod-openapi';
import type { App } from '../../context';
import { bearer, createRouter, errorResponses, jsonBody, jsonContent } from '../../lib/openapi';
import { getAuth, optionalAuth, requireAdminRole, requireAuth } from '../../middleware/auth';
import { rateLimit } from '../../middleware/rate-limit';
import { OkSchema } from '../me/schemas';
import { requestMeta } from './common';
import {
  AppleBody,
  GoogleBody,
  LoginResponse,
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
        'VERIFY_EMAIL (bearer auth) sets the transaction e-mail. 5 wrong attempts lock the challenge.',
      middleware: [rateLimit({ name: 'auth.otp.verify', limit: 60, windowSec: 60, key: 'ip' }), optionalAuth] as const,
      request: jsonBody(OtpVerifyBody),
      responses: { 200: jsonContent(OtpVerifyResponse), ...errorResponses },
    }),
    async (c) => {
      const body = c.req.valid('json');
      const res = await svc.verifyOtp(c.get('deps'), body, { auth: c.get('auth'), req: await requestMeta(c) });
      return c.json(res, 200);
    },
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/auth/google',
      tags,
      summary: 'Sign in with Google (ID token)',
      description: 'Verifies the ID token against Google JWKS (iss accounts.google.com, aud ∈ GOOGLE_CLIENT_IDS, email_verified). Links to an existing account with the same verified e-mail.',
      middleware: [rateLimit({ name: 'auth.oauth', limit: 30, windowSec: 60, key: 'ip' })] as const,
      request: jsonBody(GoogleBody),
      responses: { 200: jsonContent(LoginResponse), ...errorResponses },
    }),
    async (c) => {
      const b = c.req.valid('json');
      const res = await svc.oauthLogin(c.get('deps'), 'GOOGLE', { ...b, token: b.idToken }, { req: await requestMeta(c) });
      return c.json(res, 200);
    },
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/auth/apple',
      tags,
      summary: 'Sign in with Apple (identity token)',
      description: 'Verifies against Apple JWKS (iss https://appleid.apple.com, aud ∈ APPLE_CLIENT_IDS). Private-relay e-mails are accepted; `fullName` is only sent by Apple on first authorization.',
      middleware: [rateLimit({ name: 'auth.oauth', limit: 30, windowSec: 60, key: 'ip' })] as const,
      request: jsonBody(AppleBody),
      responses: { 200: jsonContent(LoginResponse), ...errorResponses },
    }),
    async (c) => {
      const b = c.req.valid('json');
      const res = await svc.oauthLogin(c.get('deps'), 'APPLE', { ...b, token: b.identityToken }, { req: await requestMeta(c) });
      return c.json(res, 200);
    },
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/auth/refresh',
      tags,
      summary: 'Rotate the refresh token',
      description: 'Refresh tokens are single-use. Re-using a rotated token revokes the whole session family (theft detection).',
      middleware: [rateLimit({ name: 'auth.refresh', limit: 60, windowSec: 60, key: 'ip' })] as const,
      request: jsonBody(RefreshBody),
      responses: { 200: jsonContent(RefreshResponse), ...errorResponses },
    }),
    async (c) => {
      const res = await svc.refresh(c.get('deps'), c.req.valid('json').refreshToken, await requestMeta(c));
      return c.json(res, 200);
    },
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/auth/logout',
      tags,
      summary: 'Log out (revoke the current session)',
      security: bearer,
      middleware: [requireAuth] as const,
      responses: { 200: jsonContent(OkSchema), ...errorResponses },
    }),
    async (c) => {
      await svc.logout(c.get('deps'), getAuth(c), await requestMeta(c));
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
