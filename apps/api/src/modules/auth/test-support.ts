/** Test helpers for the identity module group (not a test file itself). */
import { exportJWK, generateKeyPair, createLocalJWKSet, SignJWT, type JWK } from 'jose';
import type { TestContext } from '../../../test/helpers';
import { configureOAuthKeys } from './oauth';

export const CONSENTS = [
  { type: 'TOS' as const, version: '0.1-template', granted: true },
  { type: 'PRIVACY' as const, version: '0.1-template', granted: true },
];

let phoneSeq = 0;
export function randomPhone(): string {
  phoneSeq++;
  return `+62813${String(Math.floor(Math.random() * 1e5)).padStart(5, '0')}${String(phoneSeq % 100).padStart(2, '0')}`;
}

export async function otpRequest(t: TestContext, body: Record<string, unknown>, opts: { token?: string; ip?: string } = {}) {
  return t.request('POST', '/v1/auth/otp/request', {
    body,
    ...(opts.token ? { token: opts.token } : {}),
    headers: { 'x-forwarded-for': opts.ip ?? '203.0.113.10' },
  });
}

export async function otpVerify(t: TestContext, body: Record<string, unknown>, opts: { token?: string; ip?: string } = {}) {
  return t.request('POST', '/v1/auth/otp/verify', {
    body,
    ...(opts.token ? { token: opts.token } : {}),
    headers: { 'x-forwarded-for': opts.ip ?? '203.0.113.10' },
  });
}

/** Full phone OTP sign-up/login. Returns the verify response body. */
export async function phoneLogin(t: TestContext, phone = randomPhone(), extra: Record<string, unknown> = {}, ip?: string) {
  const req = await otpRequest(t, { channel: 'SMS', destination: phone, purpose: 'LOGIN' }, ip ? { ip } : {});
  if (req.status !== 200) throw new Error(`otp request failed ${req.status} ${JSON.stringify(req.body)}`);
  const ver = await otpVerify(t, { challengeId: req.body.challengeId, code: req.body.devCode, consents: CONSENTS, ...extra }, ip ? { ip } : {});
  if (ver.status !== 200) throw new Error(`otp verify failed ${ver.status} ${JSON.stringify(ver.body)}`);
  return { ...ver.body, phone } as { tokens: { accessToken: string; refreshToken: string; sessionId: string }; user: any; isNewUser: boolean; phone: string };
}

// ------------------------------------------------------------------ OAuth test keys
export interface OAuthTestKeys {
  sign: (provider: 'GOOGLE' | 'APPLE', claims: Record<string, unknown>, opts?: { expSec?: number; aud?: string; iss?: string; kid?: string }) => Promise<string>;
}

export async function installOAuthTestKeys(t: TestContext): Promise<OAuthTestKeys> {
  const google = await generateKeyPair('RS256', { extractable: true });
  const apple = await generateKeyPair('RS256', { extractable: true });
  const gJwk: JWK = { ...(await exportJWK(google.publicKey)), kid: 'g1', alg: 'RS256', use: 'sig' };
  const aJwk: JWK = { ...(await exportJWK(apple.publicKey)), kid: 'a1', alg: 'RS256', use: 'sig' };
  configureOAuthKeys(t.deps, { google: createLocalJWKSet({ keys: [gJwk] }), apple: createLocalJWKSet({ keys: [aJwk] }) });
  return {
    async sign(provider, claims, opts = {}) {
      const now = Math.floor(t.clock.now().getTime() / 1000);
      const key = provider === 'GOOGLE' ? google.privateKey : apple.privateKey;
      return new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: opts.kid ?? (provider === 'GOOGLE' ? 'g1' : 'a1') })
        .setIssuer(opts.iss ?? (provider === 'GOOGLE' ? 'https://accounts.google.com' : 'https://appleid.apple.com'))
        .setAudience(opts.aud ?? (provider === 'GOOGLE' ? 'test-google-client-id' : 'id.jastipkita.app'))
        .setIssuedAt(now - 10)
        .setExpirationTime(now + (opts.expSec ?? 600))
        .sign(key);
    },
  };
}

/** Recursively collects keys and string values of a JSON value. */
export function scanJson(v: unknown, keys: Set<string> = new Set(), strings: string[] = []) {
  if (Array.isArray(v)) v.forEach((x) => scanJson(x, keys, strings));
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      keys.add(k);
      scanJson(x, keys, strings);
    }
  } else if (typeof v === 'string') strings.push(v);
  return { keys, strings };
}

// ------------------------------------------------------------------ file fixtures
export const JPEG = (n = 64, seed = 7) =>
  new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, ...Array.from({ length: n }, (_, i) => (i * seed) % 251)]);

/** Upload + complete through the public API (memory storage dev route). Returns the file id. */
export async function uploadFile(t: TestContext, token: string, purpose: string, contentType: string, bytes: Uint8Array): Promise<string> {
  const c = await t.request('POST', '/v1/files/uploads', { token, body: { purpose, contentType, sizeBytes: bytes.length } });
  if (c.status !== 201) throw new Error(`upload create failed ${c.status} ${JSON.stringify(c.body)}`);
  const u = new URL(c.body.upload.url);
  const put = await t.app.request(u.pathname + u.search, { method: 'PUT', headers: c.body.upload.headers, body: new Uint8Array(bytes) });
  if (put.status !== 200) throw new Error(`upload PUT failed ${put.status}`);
  const done = await t.request('POST', `/v1/files/${c.body.fileId}/complete`, { token });
  if (done.status !== 200) throw new Error(`upload complete failed ${done.status} ${JSON.stringify(done.body)}`);
  return c.body.fileId as string;
}
