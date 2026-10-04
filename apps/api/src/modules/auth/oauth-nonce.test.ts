/**
 * SEC-15: OAuth nonce — required per provider (OAUTH_REQUIRE_NONCE, default APPLE) and single use once verified.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../../../test/helpers';
import { loadEnv } from '../../env';
import { appleSignIn, CONSENTS, installOAuthTestKeys, type OAuthTestKeys } from './test-support';

let t: TestContext;
let keys: OAuthTestKeys;
let strict: TestContext;
let strictKeys: OAuthTestKeys;
beforeAll(async () => {
  t = await createTestContext();
  keys = await installOAuthTestKeys(t);
  strict = await createTestContext({ env: { OAUTH_REQUIRE_NONCE: 'google, apple' } });
  strictKeys = await installOAuthTestKeys(strict);
});
afterAll(async () => {
  await t.close();
  await strict.close();
});

const post = (ctx: TestContext, path: string, body: Record<string, unknown>) => ctx.request('POST', path, { body });
const failures = async (ctx: TestContext, reason: string) =>
  (await ctx.adminSql<{ n: number }[]>`SELECT count(*)::int AS n FROM security_events WHERE type = 'LOGIN_FAILED' AND meta->>'reason' = ${reason}`)[0]!.n;

describe('OAUTH_REQUIRE_NONCE (default: APPLE)', () => {
  it('defaults to APPLE: an Apple sign-in without rawNonce/nonce → 401 OAUTH_NONCE_REQUIRED, nothing created', async () => {
    expect(t.env.OAUTH_REQUIRE_NONCE).toEqual(['APPLE']);
    const identityToken = await keys.sign('APPLE', { sub: 'apple-nn-1', email: 'nn1@privaterelay.appleid.com', email_verified: 'true' });
    const res = await post(t, '/v1/auth/apple', { identityToken, consents: CONSENTS });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatchObject({ code: 'OAUTH_NONCE_REQUIRED', details: { provider: 'APPLE' } });
    expect(await failures(t, 'NONCE_REQUIRED')).toBe(1);
    const [u] = await t.adminSql`SELECT id FROM users WHERE email = 'nn1@privaterelay.appleid.com'`;
    expect(u).toBeUndefined();
    // a token WITH a nonce claim is rejected too when the request carries no nonce (cannot be checked)
    const withClaim = await keys.sign('APPLE', { sub: 'apple-nn-1', nonce: 'f'.repeat(64) });
    expect((await post(t, '/v1/auth/apple', { identityToken: withClaim, consents: CONSENTS })).body.error.code).toBe('OAUTH_NONCE_REQUIRED');
  });

  it('Google stays optional by default (mobile does not send a nonce yet)', async () => {
    const idToken = await keys.sign('GOOGLE', { sub: 'google-nn-1', email: `gnn1-${Date.now()}@gmail.com`, email_verified: true });
    expect((await post(t, '/v1/auth/google', { idToken, consents: CONSENTS })).status).toBe(200);
    // without a nonce the token is not single use (cached mobile tokens keep working)
    expect((await post(t, '/v1/auth/google', { idToken })).status).toBe(200);
  });

  it('GOOGLE,APPLE: Google without nonce → OAUTH_NONCE_REQUIRED; claim missing/mismatch → NONCE_MISMATCH; matching → 200', async () => {
    expect(strict.env.OAUTH_REQUIRE_NONCE).toEqual(['GOOGLE', 'APPLE']);
    const email = `gnn2-${Date.now()}@gmail.com`;
    const nonce = 'gis-nonce-0123456789abcdef';
    const noClaim = await strictKeys.sign('GOOGLE', { sub: 'google-nn-2', email, email_verified: true });
    const missing = await post(strict, '/v1/auth/google', { idToken: noClaim, consents: CONSENTS });
    expect(missing.status).toBe(401);
    expect(missing.body.error).toMatchObject({ code: 'OAUTH_NONCE_REQUIRED', details: { provider: 'GOOGLE' } });
    const noClaimWithNonce = await post(strict, '/v1/auth/google', { idToken: noClaim, nonce, consents: CONSENTS });
    expect(noClaimWithNonce.body.error).toMatchObject({ code: 'OAUTH_TOKEN_INVALID', details: { reason: 'NONCE_MISMATCH' } });
    const withClaim = await strictKeys.sign('GOOGLE', { sub: 'google-nn-2', email, email_verified: true, nonce });
    expect((await post(strict, '/v1/auth/google', { idToken: withClaim, nonce: 'gis-nonce-ffffffffffffffff', consents: CONSENTS })).body.error.details.reason).toBe('NONCE_MISMATCH');
    expect((await post(strict, '/v1/auth/google', { idToken: withClaim, nonce, consents: CONSENTS })).status).toBe(200);
    // Apple keeps working with rawNonce
    expect((await post(strict, '/v1/auth/apple', { ...(await appleSignIn(strictKeys, { sub: 'apple-nn-2' })), consents: CONSENTS })).status).toBe(200);
  });
});

describe('verified nonce = single-use ID token', () => {
  it('Apple: replaying a used identity token → 401 NONCE_REUSED (security event), a fresh one works', async () => {
    const signIn = await appleSignIn(keys, { sub: 'apple-su-1', email: 'su1@privaterelay.appleid.com', email_verified: 'true' });
    const first = await post(t, '/v1/auth/apple', { ...signIn, consents: CONSENTS });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const replay = await post(t, '/v1/auth/apple', { ...signIn });
    expect(replay.status).toBe(401);
    expect(replay.body.error).toMatchObject({ code: 'OAUTH_TOKEN_INVALID', details: { reason: 'NONCE_REUSED' } });
    const [ev] = await t.adminSql<{ severity: string }[]>`SELECT severity FROM security_events WHERE type = 'LOGIN_FAILED' AND meta->>'reason' = 'NONCE_REUSED' LIMIT 1`;
    expect(ev?.severity).toBe('MEDIUM');
    const sessions = await t.adminSql<{ n: number }[]>`SELECT count(DISTINCT family_id)::int AS n FROM refresh_tokens WHERE user_id = ${first.body.user.id}`;
    expect(sessions[0]!.n).toBe(1);
    const fresh = await post(t, '/v1/auth/apple', await appleSignIn(keys, { sub: 'apple-su-1' }));
    expect(fresh.status).toBe(200);
    expect(fresh.body.user.id).toBe(first.body.user.id);
    const [row] = await t.adminSql<{ n: number }[]>`SELECT count(*)::int AS n FROM oauth_nonce_uses WHERE provider = 'APPLE'`;
    expect(row!.n).toBeGreaterThanOrEqual(2);
  });

  it('a CONSENT_REQUIRED round-trip does not consume the nonce; the successful retry does', async () => {
    const signIn = await appleSignIn(keys, { sub: 'apple-su-2', email: 'su2@privaterelay.appleid.com', email_verified: 'true' });
    const needConsent = await post(t, '/v1/auth/apple', { ...signIn });
    expect(needConsent.status).toBe(422);
    expect(needConsent.body.error.code).toBe('CONSENT_REQUIRED');
    expect((await post(t, '/v1/auth/apple', { ...signIn, consents: CONSENTS })).status).toBe(200);
    expect((await post(t, '/v1/auth/apple', { ...signIn, consents: CONSENTS })).body.error.details.reason).toBe('NONCE_REUSED');
  });

  it('Google with a nonce is single use too', async () => {
    const nonce = 'gis-nonce-single-use-000001';
    const idToken = await keys.sign('GOOGLE', { sub: 'google-su-1', email: `gsu1-${Date.now()}@gmail.com`, email_verified: true, nonce });
    expect((await post(t, '/v1/auth/google', { idToken, nonce, consents: CONSENTS })).status).toBe(200);
    expect((await post(t, '/v1/auth/google', { idToken, nonce })).body.error.details.reason).toBe('NONCE_REUSED');
  });

  it('concurrent replays: exactly one sign-in succeeds and only one account is created', async () => {
    const signIn = await appleSignIn(keys, { sub: 'apple-su-race', email: 'race@privaterelay.appleid.com', email_verified: 'true' });
    const results = await Promise.all(Array.from({ length: 4 }, () => post(t, '/v1/auth/apple', { ...signIn, consents: CONSENTS })));
    expect(results.map((r) => r.status).sort()).toEqual([200, 401, 401, 401]);
    for (const r of results.filter((x) => x.status === 401)) expect(r.body.error.details.reason).toBe('NONCE_REUSED');
    const [n] = await t.adminSql<{ n: number }[]>`SELECT count(*)::int AS n FROM auth_identities WHERE provider = 'APPLE' AND provider_subject = 'apple-su-race'`;
    expect(n!.n).toBe(1);
  });

  it('expired rows are purged on later sign-ins', async () => {
    await t.adminSql`INSERT INTO oauth_nonce_uses (provider, nonce_hash, expires_at) VALUES ('APPLE', ${Buffer.alloc(32, 9)}, ${new Date(t.clock.now().getTime() - 3600_000)})`;
    expect((await post(t, '/v1/auth/apple', await appleSignIn(keys, { sub: 'apple-su-1' }))).status).toBe(200);
    const [left] = await t.adminSql<{ n: number }[]>`SELECT count(*)::int AS n FROM oauth_nonce_uses WHERE nonce_hash = ${Buffer.alloc(32, 9)}`;
    expect(left!.n).toBe(0);
  });
});

describe('OAUTH_REQUIRE_NONCE env validation', () => {
  const base = {
    DATABASE_URL: 'postgres://x@localhost/jk',
    JWT_SECRET: 'p'.repeat(48),
    DATA_ENCRYPTION_KEYS: `k1:${Buffer.alloc(32, 7).toString('base64')}`,
    HMAC_PEPPER: 'q'.repeat(48),
  };
  it('parses csv (case-insensitive, de-duplicated), empty = APPLE, none = []', () => {
    expect(loadEnv(base).OAUTH_REQUIRE_NONCE).toEqual(['APPLE']);
    expect(loadEnv({ ...base, OAUTH_REQUIRE_NONCE: '' }).OAUTH_REQUIRE_NONCE).toEqual(['APPLE']);
    expect(loadEnv({ ...base, OAUTH_REQUIRE_NONCE: 'none' }).OAUTH_REQUIRE_NONCE).toEqual([]);
    expect(loadEnv({ ...base, OAUTH_REQUIRE_NONCE: ' google ,APPLE,google' }).OAUTH_REQUIRE_NONCE).toEqual(['GOOGLE', 'APPLE']);
    for (const bad of ['facebook', 'GOOGLE;APPLE', 'APPLE,', 'none,APPLE']) {
      expect(() => loadEnv({ ...base, OAUTH_REQUIRE_NONCE: bad }), bad).toThrow(/OAUTH_REQUIRE_NONCE/);
    }
  });
  it('production must keep APPLE', () => {
    const prod = {
      ...base,
      APP_ENV: 'production',
      DATABASE_URL: 'postgres://x@db.example/jk?sslmode=require',
      PAYMENT_PROVIDER: 'xendit',
      XENDIT_SECRET_KEY: 'xnd_development_abc',
      XENDIT_WEBHOOK_TOKEN: 'tok',
      EMAIL_PROVIDER: 'resend',
      SMS_PROVIDER: 'twilio',
      STORAGE_PROVIDER: 's3',
      S3_ENDPOINT: 'https://r2.example',
      S3_BUCKET: 'b',
      S3_ACCESS_KEY_ID: 'a',
      S3_SECRET_ACCESS_KEY: 's',
      MALWARE_SCAN_PROVIDER: 'clamav-http',
      CLAMAV_HTTP_URL: 'https://clamd.internal.example/scan',
      KYC_PROVIDER: 'manual',
    };
    expect(loadEnv(prod).OAUTH_REQUIRE_NONCE).toEqual(['APPLE']);
    expect(loadEnv({ ...prod, OAUTH_REQUIRE_NONCE: 'GOOGLE,APPLE' }).OAUTH_REQUIRE_NONCE).toEqual(['GOOGLE', 'APPLE']);
    expect(() => loadEnv({ ...prod, OAUTH_REQUIRE_NONCE: 'none' })).toThrow(/production requires APPLE/);
    expect(() => loadEnv({ ...prod, OAUTH_REQUIRE_NONCE: 'GOOGLE' })).toThrow(/production requires APPLE/);
  });
});
