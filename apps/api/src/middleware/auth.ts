import type { Context, MiddlewareHandler } from 'hono';
import { jwtVerify } from 'jose';
import type { AppEnv, AuthContext } from '../context';
import { AppError, Errors } from '../lib/errors';

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
  const rows = await sql<{ id: string; status: AuthContext['status']; kyc_level: number; active_mode: AuthContext['activeMode']; session_mfa_at: Date | null }[]>`
    SELECT u.id, u.status, u.kyc_level, u.active_mode, s.session_mfa_at
      FROM users u
      JOIN LATERAL (SELECT count(*) AS n, max(rt.mfa_verified_at) AS session_mfa_at
                      FROM refresh_tokens rt
                     WHERE rt.family_id = ${claims.sid} AND rt.user_id = u.id AND rt.revoked_at IS NULL) s ON s.n > 0
     WHERE u.id = ${claims.sub}`;
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
    sessionMfaAt: u.session_mfa_at ? Math.floor(new Date(u.session_mfa_at).getTime() / 1000) : null,
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

/** Marker on middleware returned by requirePermission (lets tests enumerate every route's declared permissions). */
export const REQUIRED_PERMISSIONS = Symbol.for('jastipkita.requiredPermissions');

/** RBAC: requires ALL listed permissions. Admin routes also get least-privilege checks per action. */
export function requirePermission(...permissions: string[]): MiddlewareHandler<AppEnv> {
  if (permissions.length === 0) throw new Error('requirePermission() needs at least one permission');
  const mw: MiddlewareHandler<AppEnv> = async (c, next) => {
    const a = getAuth(c);
    const { perms } = await rolesFor(c, a.userId);
    const missing = permissions.filter((p) => !perms.has(p));
    if (missing.length) throw Errors.forbidden('Izin tidak cukup', 'PERMISSION_DENIED', { missing });
    await next();
  };
  Object.defineProperty(mw, REQUIRED_PERMISSIONS, { value: Object.freeze([...permissions]) });
  return mw;
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

/**
 * SEC-01: true when the session has passed MFA (TOTP / recovery code) within ADMIN_SESSION_MFA_MAX_AGE_SEC —
 * either the access token's `mfa_at` (step-up) or the session family's server-side `mfa_verified_at`
 * (survives refresh). A future timestamp (clock skew / forged row) never counts.
 */
export function hasSessionMfa(auth: AuthContext, env: { ADMIN_SESSION_MFA_MAX_AGE_SEC: number }, now: Date): boolean {
  const nowSec = Math.floor(now.getTime() / 1000);
  const at = Math.max(auth.mfaAt ?? 0, auth.sessionMfaAt ?? 0);
  return at > 0 && at <= nowSec + 60 && nowSec - at <= env.ADMIN_SESSION_MFA_MAX_AGE_SEC;
}

/** Any admin role — WITHOUT the session-MFA requirement. Only for MFA enrollment itself. */
export const requireAdminRole: MiddlewareHandler<AppEnv> = async (c, next) => {
  const a = getAuth(c);
  if (a.roles.length === 0) throw Errors.forbidden('Khusus admin', 'ADMIN_ONLY');
  await next();
};

/**
 * Any admin role AND an MFA-verified session (used on /v1/admin/* in addition to per-route permissions).
 * The admin SPA's login-time TOTP gate is only a UI convenience; this is the server-side control (SEC-01).
 * Error code MFA_REQUIRED (details.scope = SESSION) makes the SPA run its TOTP step-up and retry.
 */
export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const a = getAuth(c);
  if (a.roles.length === 0) throw Errors.forbidden('Khusus admin', 'ADMIN_ONLY');
  const { env, clock } = c.get('deps');
  if (!hasSessionMfa(a, env, clock.now())) {
    throw new AppError(403, 'MFA_REQUIRED', 'Verifikasi MFA diperlukan untuk sesi admin', { scope: 'SESSION' });
  }
  await next();
};
