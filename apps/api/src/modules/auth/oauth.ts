/**
 * Google Sign-In & Sign in with Apple ID-token verification (RS256 via the providers' JWKS).
 * The JWKS resolver is injectable per AppDeps so tests can use a locally generated key pair
 * (jose generateKeyPair + exportJWK + createLocalJWKSet) without network access.
 */
import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import type { AppDeps } from '../../context';
import { sha256Hex, timingSafeEqualStr } from '../../lib/crypto';

export type OAuthProvider = 'GOOGLE' | 'APPLE';

export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
export const APPLE_JWKS_URL = 'https://appleid.apple.com/auth/keys';
/** Google documents both forms of the issuer. */
export const GOOGLE_ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];
export const APPLE_ISSUER = 'https://appleid.apple.com';

export interface OAuthKeyResolvers {
  google: JWTVerifyGetKey;
  apple: JWTVerifyGetKey;
}

const overrides = new WeakMap<AppDeps, Partial<OAuthKeyResolvers>>();
let remoteGoogle: JWTVerifyGetKey | null = null;
let remoteApple: JWTVerifyGetKey | null = null;

/** Injects JWKS resolvers (tests, or a custom cache in Workers). */
export function configureOAuthKeys(deps: AppDeps, resolvers: Partial<OAuthKeyResolvers>): void {
  overrides.set(deps, { ...(overrides.get(deps) ?? {}), ...resolvers });
}

function resolver(deps: AppDeps, provider: OAuthProvider): JWTVerifyGetKey {
  const o = overrides.get(deps);
  if (provider === 'GOOGLE') {
    if (o?.google) return o.google;
    remoteGoogle ??= createRemoteJWKSet(new URL(GOOGLE_JWKS_URL), { cooldownDuration: 30_000, cacheMaxAge: 6 * 3600_000 });
    return remoteGoogle;
  }
  if (o?.apple) return o.apple;
  remoteApple ??= createRemoteJWKSet(new URL(APPLE_JWKS_URL), { cooldownDuration: 30_000, cacheMaxAge: 6 * 3600_000 });
  return remoteApple;
}

export interface VerifiedIdentity {
  provider: OAuthProvider;
  subject: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  isPrivateRelayEmail: boolean;
}

export type OAuthFailure =
  | 'NOT_CONFIGURED'
  | 'TOKEN_EXPIRED'
  | 'AUDIENCE_MISMATCH'
  | 'ISSUER_MISMATCH'
  | 'SIGNATURE_INVALID'
  | 'NONCE_MISMATCH'
  | 'CLAIMS_INVALID'
  | 'KEYS_UNAVAILABLE';

export class OAuthVerificationError extends Error {
  constructor(public readonly reason: OAuthFailure) {
    super(reason);
    this.name = 'OAuthVerificationError';
  }
}

const truthy = (v: unknown) => v === true || v === 'true';

export interface NonceCheck {
  /** Expected `nonce` claim, compared verbatim (Google; Apple clients that send the already-hashed value). */
  nonce?: string | undefined;
  /**
   * Sign in with Apple: the raw nonce the app generated. Apple puts SHA-256(rawNonce) as lowercase hex into the
   * identity token's `nonce` claim; the claim must be present and equal (constant-time).
   */
  rawNonce?: string | undefined;
}

/** SHA-256 hex (lowercase) of the raw nonce — what Apple embeds in the identity token `nonce` claim. */
export async function appleNonceClaim(rawNonce: string): Promise<string> {
  return sha256Hex(rawNonce);
}

export async function verifyIdToken(deps: AppDeps, provider: OAuthProvider, token: string, check: NonceCheck = {}): Promise<VerifiedIdentity> {
  const { nonce, rawNonce } = check;
  const audiences = provider === 'GOOGLE' ? deps.env.GOOGLE_CLIENT_IDS : deps.env.APPLE_CLIENT_IDS;
  if (!audiences.length) throw new OAuthVerificationError('NOT_CONFIGURED');
  let payload: JWTPayload;
  try {
    const res = await jwtVerify(token, resolver(deps, provider), {
      issuer: provider === 'GOOGLE' ? GOOGLE_ISSUERS : APPLE_ISSUER,
      audience: audiences,
      algorithms: ['RS256'],
      currentDate: deps.clock.now(),
      clockTolerance: 60,
      requiredClaims: ['sub', 'iat', 'exp'],
    });
    payload = res.payload;
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) throw new OAuthVerificationError('TOKEN_EXPIRED');
    if (err instanceof joseErrors.JWTClaimValidationFailed) {
      if (err.claim === 'aud') throw new OAuthVerificationError('AUDIENCE_MISMATCH');
      if (err.claim === 'iss') throw new OAuthVerificationError('ISSUER_MISMATCH');
      throw new OAuthVerificationError('CLAIMS_INVALID');
    }
    if (err instanceof joseErrors.JWKSTimeout || err instanceof joseErrors.JWKSInvalid) throw new OAuthVerificationError('KEYS_UNAVAILABLE');
    throw new OAuthVerificationError('SIGNATURE_INVALID');
  }
  if (typeof payload.sub !== 'string' || !payload.sub) throw new OAuthVerificationError('CLAIMS_INVALID');
  const claim = typeof payload.nonce === 'string' ? payload.nonce : null;
  if (rawNonce !== undefined) {
    const expected = await appleNonceClaim(rawNonce);
    if (claim === null || !timingSafeEqualStr(claim.toLowerCase(), expected)) throw new OAuthVerificationError('NONCE_MISMATCH');
    if (nonce !== undefined && !timingSafeEqualStr(nonce.toLowerCase(), expected)) throw new OAuthVerificationError('NONCE_MISMATCH');
  } else if (nonce !== undefined && (claim === null || !timingSafeEqualStr(claim, nonce))) {
    throw new OAuthVerificationError('NONCE_MISMATCH');
  }
  const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : null;
  return {
    provider,
    subject: payload.sub,
    email,
    emailVerified: !!email && truthy(payload.email_verified),
    name: typeof payload.name === 'string' ? payload.name.slice(0, 80) : null,
    isPrivateRelayEmail: truthy(payload.is_private_email) || (email?.endsWith('@privaterelay.appleid.com') ?? false),
  };
}
