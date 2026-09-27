import type { Context, MiddlewareHandler } from 'hono';
import { jwtVerify } from 'jose';
import type { AppEnv, AuthContext } from '../context';
import { Errors } from '../lib/errors';

export interface AccessTokenClaims {
  sub: string;
  sid: string;
  /** epoch seconds of MFA verification in this session (admins) */
  mfa_at?: number;
  typ: 'access';
}

const permCache = new Map<string, { at: number; perms: Set<string>; roles: string[] }>();
const PERM_TTL_MS = 60_000;

export async function verifyAccessToken(c: Context<AppEnv>, token: string): Promise<AccessTokenClaims | null> {
  const { env } = c.get('deps');
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(env.JWT_SECRET), {
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
      algorithms: ['HS256'],
      currentDate: c.get('deps').clock.now(),
    });
    if (payload.typ !== 'access' || typeof payload.sub !== 'string' || typeof payload.sid !== 'string') return null;
    return payload as unknown as AccessTokenClaims;
  } catch {
    return null;
  }
}

export async function loadAuth(c: Context<AppEnv>, claims: AccessTokenClaims): Promise<AuthContext | null> {
  const { sql } = c.get('deps');
  const rows = await sql<{ id: string; status: AuthContext['status']; kyc_level: number; active_mode: AuthContext['activeMode'] }[]>`
    SELECT u.id, u.status, u.kyc_level, u.active_mode
      FROM users u
     WHERE u.id = ${claims.sub}
       AND EXISTS (SELECT 1 FROM refresh_tokens rt WHERE rt.family_id = ${claims.sid} AND rt.user_id = u.id AND rt.revoked_at IS NULL)`;
  const u = rows[0];
  if (!u) return null;
  const roles = await rolesFor(c, u.id);
  return {
    userId: u.id,
    sessionId: claims.sid,
    status: u.status,
    kycLevel: u.kyc_level,
    activeMode: u.active_mode,
    roles: roles.roles,
    mfaAt: typeof claims.mfa_at === 'number' ? claims.mfa_at : null,
  };
}

async function rolesFor(c: Context<AppEnv>, userId: string) {
  const now = Date.now();
  const hit = permCache.get(userId);
  if (hit && now - hit.at < PERM_TTL_MS) return hit;
  const { sql } = c.get('deps');
  const rows = await sql<{ role_code: string; permission_code: string | null }[]>`
    SELECT ur.role_code, rp.permission_code
      FROM user_roles ur
      LEFT JOIN role_permissions rp ON rp.role_code = ur.role_code
     WHERE ur.user_id = ${userId} AND ur.revoked_at IS NULL`;
  const roles = [...new Set(rows.map((r) => r.role_code))];
  const perms = new Set(rows.map((r) => r.permission_code).filter((p): p is string => !!p));
  const entry = { at: now, perms, roles };
  permCache.set(userId, entry);
  return entry;
}

export function clearPermissionCache(userId?: string) {
  if (userId) permCache.delete(userId);
  else permCache.clear();
}

/** Parses the bearer token if present; never fails the request. */
export const optionalAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const h = c.req.header('authorization');
  if (h?.startsWith('Bearer ')) {
    const claims = await verifyAccessToken(c, h.slice(7));
    if (claims) {
      const auth = await loadAuth(c, claims);
      if (auth && auth.status === 'ACTIVE') c.set('auth', auth);
    }
  }
  await next();
};

/** Builds an auth guard that admits the given account statuses (default: ACTIVE only). */
export function requireAuthWith(allowed: AuthContext['status'][] = ['ACTIVE']): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const h = c.req.header('authorization');
    if (!h?.startsWith('Bearer ')) throw Errors.unauthorized();
    const claims = await verifyAccessToken(c, h.slice(7));
    if (!claims) throw Errors.unauthorized('Token tidak valid atau kedaluwarsa', 'TOKEN_INVALID');
    const auth = await loadAuth(c, claims);
    if (!auth) throw Errors.unauthorized('Sesi berakhir, silakan masuk kembali', 'SESSION_REVOKED');
    if (!allowed.includes(auth.status)) {
      if (auth.status === 'SUSPENDED') throw Errors.forbidden('Akun ditangguhkan', 'ACCOUNT_SUSPENDED');
      throw Errors.forbidden('Akun tidak aktif', 'ACCOUNT_INACTIVE');
    }
    c.set('auth', auth);
    await next();
  };
}

/** Requires a valid access token for an ACTIVE user. */
export const requireAuth: MiddlewareHandler<AppEnv> = requireAuthWith(['ACTIVE']);

/** Also admits accounts in PENDING_DELETION (so they can cancel deletion / export data). */
export const requireAuthAllowPendingDeletion: MiddlewareHandler<AppEnv> = requireAuthWith(['ACTIVE', 'PENDING_DELETION']);

export function getAuth(c: Context<AppEnv>): AuthContext {
  const a = c.get('auth');
  if (!a) throw Errors.unauthorized();
  return a;
}

/** Requires KYC level ≥ n (docs/00-domain-model.md §2). */
export function requireKycLevel(level: number): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const a = getAuth(c);
    if (a.kycLevel < level) throw Errors.kycRequired(level, a.kycLevel);
    await next();
  };
}

/** RBAC: requires ALL listed permissions. Admin routes also get least-privilege checks per action. */
export function requirePermission(...permissions: string[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const a = getAuth(c);
    const { perms } = await rolesFor(c, a.userId);
    const missing = permissions.filter((p) => !perms.has(p));
    if (missing.length) throw Errors.forbidden('Izin tidak cukup', 'PERMISSION_DENIED', { missing });
    await next();
  };
}

export async function hasPermission(c: Context<AppEnv>, permission: string): Promise<boolean> {
  const a = c.get('auth');
  if (!a) return false;
  const { perms } = await rolesFor(c, a.userId);
  return perms.has(permission);
}

/** Admin step-up: requires an MFA verification within ADMIN_MFA_STEP_UP_SEC in this session. */
export const requireRecentMfa: MiddlewareHandler<AppEnv> = async (c, next) => {
  const a = getAuth(c);
  const { env, clock } = c.get('deps');
  const nowSec = Math.floor(clock.now().getTime() / 1000);
  if (!a.mfaAt || nowSec - a.mfaAt > env.ADMIN_MFA_STEP_UP_SEC) throw Errors.mfaRequired();
  await next();
};

/** Any admin role (used on /v1/admin/* in addition to per-route permissions). */
export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const a = getAuth(c);
  if (a.roles.length === 0) throw Errors.forbidden('Khusus admin', 'ADMIN_ONLY');
  await next();
};
