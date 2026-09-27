import { SignJWT } from 'jose';
import type { AppDeps } from '../context';
import type { Db } from '../db/sql';
import { randomToken, sha256 } from '../lib/crypto';
import { Errors } from '../lib/errors';

export interface IssuedSession {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
  sessionId: string;
}

export async function signAccessToken(deps: AppDeps, userId: string, sessionId: string, mfaAt?: number | null): Promise<{ token: string; expiresAt: Date }> {
  const now = deps.clock.now();
  const exp = new Date(now.getTime() + deps.env.ACCESS_TOKEN_TTL_SEC * 1000);
  const jwt = new SignJWT({ sid: sessionId, typ: 'access', ...(mfaAt ? { mfa_at: mfaAt } : {}) })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(userId)
    .setIssuer(deps.env.JWT_ISSUER)
    .setAudience(deps.env.JWT_AUDIENCE)
    .setIssuedAt(Math.floor(now.getTime() / 1000))
    .setExpirationTime(Math.floor(exp.getTime() / 1000))
    .setJti(randomToken(12));
  return { token: await jwt.sign(new TextEncoder().encode(deps.env.JWT_SECRET)), expiresAt: exp };
}

/**
 * Creates a new session (refresh-token family) for the user and returns tokens.
 * Refresh tokens are opaque 256-bit random strings; only their SHA-256 is stored.
 */
export async function issueSession(
  deps: AppDeps,
  db: Db,
  userId: string,
  meta: { deviceId?: string | null; ipHash?: Uint8Array | null; userAgent?: string | null; mfaAt?: number | null } = {},
): Promise<IssuedSession> {
  const now = deps.clock.now();
  const familyId = crypto.randomUUID();
  const refresh = randomToken(32);
  const refreshExp = new Date(now.getTime() + deps.env.REFRESH_TOKEN_TTL_DAYS * 86400_000);
  await db`
    INSERT INTO refresh_tokens (user_id, family_id, token_hash, device_id, created_at, expires_at, ip_hash, user_agent)
    VALUES (${userId}, ${familyId}, ${Buffer.from(await sha256(refresh))}, ${meta.deviceId ?? null}, ${now}, ${refreshExp},
            ${meta.ipHash ? Buffer.from(meta.ipHash) : null}, ${meta.userAgent?.slice(0, 400) ?? null})`;
  const access = await signAccessToken(deps, userId, familyId, meta.mfaAt ?? null);
  return {
    accessToken: access.token,
    accessTokenExpiresAt: access.expiresAt.toISOString(),
    refreshToken: refresh,
    refreshTokenExpiresAt: refreshExp.toISOString(),
    sessionId: familyId,
  };
}

/**
 * Rotates a refresh token. Reuse of an already-rotated token revokes the WHOLE family
 * (token theft detection) and records a security event.
 */
export async function rotateRefreshToken(deps: AppDeps, refreshToken: string, meta: { ipHash?: Uint8Array | null; userAgent?: string | null } = {}): Promise<IssuedSession & { userId: string }> {
  const hash = Buffer.from(await sha256(refreshToken));
  const now = deps.clock.now();
  type Outcome =
    | { ok: true; session: IssuedSession & { userId: string } }
    | { ok: false; code: 'REFRESH_INVALID' | 'REFRESH_REVOKED' | 'REFRESH_EXPIRED' | 'ACCOUNT_INACTIVE' };
  // Revocations must COMMIT even when the caller gets an error, so failures are returned, not thrown.
  const outcome = (await deps.sql.begin(async (tx) => {
    const [row] = await tx<{ id: string; user_id: string; family_id: string; expires_at: Date; revoked_at: Date | null; revoked_reason: string | null; device_id: string | null; reuse_detected_at: Date | null }[]>`
      SELECT id, user_id, family_id, expires_at, revoked_at, revoked_reason, device_id, reuse_detected_at FROM refresh_tokens WHERE token_hash = ${hash} FOR UPDATE`;
    if (!row) return { ok: false, code: 'REFRESH_INVALID' } as Outcome;
    if (row.revoked_at) {
      if (row.revoked_reason === 'ROTATED' && !row.reuse_detected_at) {
        await tx`UPDATE refresh_tokens SET revoked_at = ${now}, revoked_reason = 'REUSE_DETECTED', reuse_detected_at = ${now}
                  WHERE family_id = ${row.family_id} AND revoked_at IS NULL`;
        await tx`UPDATE refresh_tokens SET reuse_detected_at = ${now} WHERE id = ${row.id}`;
        await tx`INSERT INTO security_events (user_id, type, severity, meta)
                 VALUES (${row.user_id}, 'REFRESH_TOKEN_REUSE', 'HIGH', ${tx.json({ familyId: row.family_id } as never)})`;
      }
      return { ok: false, code: 'REFRESH_REVOKED' } as Outcome;
    }
    if (row.expires_at <= now) return { ok: false, code: 'REFRESH_EXPIRED' } as Outcome;
    const [user] = await tx<{ status: string }[]>`SELECT status FROM users WHERE id = ${row.user_id}`;
    if (!user || user.status !== 'ACTIVE') return { ok: false, code: 'ACCOUNT_INACTIVE' } as Outcome;

    const next = randomToken(32);
    const exp = new Date(now.getTime() + deps.env.REFRESH_TOKEN_TTL_DAYS * 86400_000);
    const [ins] = await tx<{ id: string }[]>`
      INSERT INTO refresh_tokens (user_id, family_id, token_hash, device_id, created_at, expires_at, ip_hash, user_agent)
      VALUES (${row.user_id}, ${row.family_id}, ${Buffer.from(await sha256(next))}, ${row.device_id}, ${now}, ${exp},
              ${meta.ipHash ? Buffer.from(meta.ipHash) : null}, ${meta.userAgent?.slice(0, 400) ?? null})
      RETURNING id`;
    await tx`UPDATE refresh_tokens SET revoked_at = ${now}, revoked_reason = 'ROTATED', replaced_by = ${ins!.id} WHERE id = ${row.id}`;
    const access = await signAccessToken(deps, row.user_id, row.family_id);
    return {
      ok: true,
      session: {
        userId: row.user_id,
        accessToken: access.token,
        accessTokenExpiresAt: access.expiresAt.toISOString(),
        refreshToken: next,
        refreshTokenExpiresAt: exp.toISOString(),
        sessionId: row.family_id,
      },
    } as Outcome;
  })) as Outcome;
  if (outcome.ok) return outcome.session;
  if (outcome.code === 'ACCOUNT_INACTIVE') throw Errors.forbidden('Akun tidak aktif', 'ACCOUNT_INACTIVE');
  const msg = outcome.code === 'REFRESH_EXPIRED' ? 'Sesi kedaluwarsa' : outcome.code === 'REFRESH_INVALID' ? 'Refresh token tidak valid' : 'Sesi berakhir, silakan masuk kembali';
  throw Errors.unauthorized(msg, outcome.code);
}

export async function revokeSession(db: Db, sessionId: string, reason: 'LOGOUT' | 'ADMIN' | 'ACCOUNT_DELETED' | 'PASSWORD_CHANGED', now: Date): Promise<void> {
  await db`UPDATE refresh_tokens SET revoked_at = ${now}, revoked_reason = ${reason} WHERE family_id = ${sessionId} AND revoked_at IS NULL`;
}
