import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../../../test/helpers';
import { appleNonceClaim } from './oauth';
import { CONSENTS, installOAuthTestKeys, type OAuthTestKeys } from './test-support';

let t: TestContext;
let keys: OAuthTestKeys;
beforeAll(async () => {
  t = await createTestContext();
  keys = await installOAuthTestKeys(t);
});
afterAll(async () => {
  await t.close();
});

const apple = (body: Record<string, unknown>) => t.request('POST', '/v1/auth/apple', { body });
const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');

describe('Sign in with Apple — rawNonce', () => {
  it('token nonce claim = SHA-256 hex of rawNonce → accepted', async () => {
    const rawNonce = 'q7Vn2kP0-Xr8sT1u_Lm4Zc9Hd3Fb6Gy5';
    expect(await appleNonceClaim(rawNonce)).toBe(sha256hex(rawNonce));
    const identityToken = await keys.sign('APPLE', { sub: 'apple-nonce-1', email: 'n1@privaterelay.appleid.com', email_verified: 'true', nonce: sha256hex(rawNonce) });
    const res = await apple({ identityToken, rawNonce, consents: CONSENTS });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.isNewUser).toBe(true);
    // the (already hashed) legacy `nonce` field may accompany it when it is the same hash (fresh token: nonces are single use)
    const raw2 = 'r8Wm3lQ1-Ys9tU2v_Mn5Ad0Je4Gc7Hz6';
    const tok2 = await keys.sign('APPLE', { sub: 'apple-nonce-1', email: 'n1@privaterelay.appleid.com', email_verified: 'true', nonce: sha256hex(raw2) });
    const again = await apple({ identityToken: tok2, rawNonce: raw2, nonce: sha256hex(raw2) });
    expect(again.status).toBe(200);
    expect(again.body.isNewUser).toBe(false);
  });

  it('rejects a mismatching, missing or raw (unhashed) nonce claim with NONCE_MISMATCH', async () => {
    const rawNonce = 'a'.repeat(32);
    const cases = [
      { nonce: sha256hex('b'.repeat(32)) }, // another nonce
      {}, // no nonce claim at all
      { nonce: rawNonce }, // claim not hashed
    ];
    for (const extra of cases) {
      const identityToken = await keys.sign('APPLE', { sub: 'apple-nonce-2', email: 'n2@privaterelay.appleid.com', email_verified: 'true', ...extra });
      const res = await apple({ identityToken, rawNonce, consents: CONSENTS });
      expect(res.status, JSON.stringify(extra)).toBe(401);
      expect(res.body.error).toMatchObject({ code: 'OAUTH_TOKEN_INVALID', details: { reason: 'NONCE_MISMATCH' } });
    }
    // rawNonce together with a different legacy nonce value
    const tok = await keys.sign('APPLE', { sub: 'apple-nonce-3', nonce: sha256hex(rawNonce) });
    const conflict = await apple({ identityToken: tok, rawNonce, nonce: sha256hex('zzz'), consents: CONSENTS });
    expect(conflict.body.error?.details?.reason).toBe('NONCE_MISMATCH');
    const [u] = await t.adminSql`SELECT id FROM users WHERE email = 'n2@privaterelay.appleid.com'`;
    expect(u).toBeUndefined();
    // too short a raw nonce is a validation error
    expect((await apple({ identityToken: tok, rawNonce: 'short' })).status).toBe(400);
  });

  it('without rawNonce the legacy verbatim `nonce` check is unchanged', async () => {
    const tok = await keys.sign('APPLE', { sub: 'apple-nonce-4', nonce: 'plain-nonce-value' });
    expect((await apple({ identityToken: tok, nonce: 'other', consents: CONSENTS })).body.error.details.reason).toBe('NONCE_MISMATCH');
    expect((await apple({ identityToken: tok, nonce: 'plain-nonce-value', consents: CONSENTS })).status).toBe(200);
  });
});
