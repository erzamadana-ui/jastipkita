/**
 * Helpers shared by the identity module group (auth, me, files, kyc, privacy).
 * Local to the group on purpose: shared files (lib/, middleware/, services/) are owned elsewhere.
 */
import type { Context, MiddlewareHandler } from 'hono';
import { jwtVerify } from 'jose';
import type { AppDeps, AppEnv, AuthContext } from '../../context';
import type { Db } from '../../db/sql';
import { Errors } from '../../lib/errors';

/** Security constants (not business config: changing them is a security review, not an Admin toggle). */
export const SECURITY = {
  OTP_TTL_SEC: 300,
  OTP_MAX_ATTEMPTS: 5,
  OTP_RESEND_COOLDOWN_SEC: 60,
  OTP_MAX_PER_DESTINATION_HOUR: 5,
  OTP_MAX_PER_DESTINATION_DAY: 10,
  OTP_MAX_PER_IP_HOUR: 20,
  MFA_MAX_FAILURES: 5,
  MFA_FAILURE_WINDOW_SEC: 900,
  MFA_RECOVERY_CODES: 10,
  DELETION_GRACE_DAYS: 14,
  UPLOAD_URL_TTL_SEC: 900,
  DOWNLOAD_URL_TTL_SEC: 300,
  EXPORT_RETENTION_DAYS: 7,
} as const;

export const buf = (b: Uint8Array): Buffer => Buffer.from(b.buffer, b.byteOffset, b.byteLength);
export const u8 = (b: Buffer | Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(b) as Uint8Array<ArrayBuffer>;
export const iso = (d: Date | string | null | undefined): string | null =>
  d === null || d === undefined ? null : d instanceof Date ? d.toISOString() : new Date(d).toISOString();

export interface RequestMeta {
  ip: string | null;
  ipHash: Uint8Array | null;
  userAgent: string | null;
}

export async function requestMeta(c: Context<AppEnv>): Promise<RequestMeta> {
  const deps = c.get('deps');
  const ip = c.get('ip') ?? null;
  return {
    ip,
    ipHash: ip ? await deps.crypto.hashIdentifier('ip', ip) : null,
    userAgent: c.req.header('user-agent')?.slice(0, 400) ?? null,
  };
}

export type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

/** Appends to security_events (append-only). Never put raw PII in meta. */
export async function securityEvent(
  deps: AppDeps,
  db: Db,
  e: { userId?: string | null; type: string; severity?: Severity; deviceId?: string | null; meta?: Record<string, unknown>; req?: RequestMeta | null },
): Promise<void> {
  await db`
    INSERT INTO security_events (user_id, type, severity, device_id, ip_hash, user_agent, meta, created_at)
    VALUES (${e.userId ?? null}, ${e.type}, ${e.severity ?? 'LOW'}, ${e.deviceId ?? null},
            ${e.req?.ipHash ? buf(e.req.ipHash) : null}, ${e.req?.userAgent ?? null},
            ${db.json((e.meta ?? {}) as never)}, ${deps.clock.now()})`;
}

// ------------------------------------------------------------------ normalization
const E164 = /^\+[1-9][0-9]{6,14}$/;

/** Normalizes Indonesian-friendly phone input to E.164 (08xx → +628xx, 628xx → +628xx). Returns null if invalid. */
export function normalizePhone(input: string): string | null {
  let s = input.trim().replace(/[\s\-().]/g, '');
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  else if (s.startsWith('0')) s = `+62${s.slice(1)}`;
  else if (/^62\d/.test(s)) s = `+${s}`;
  return E164.test(s) ? s : null;
}

const EMAIL = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;
export function normalizeEmail(input: string): string | null {
  const s = input.trim().toLowerCase();
  return s.length <= 254 && EMAIL.test(s) ? s : null;
}

export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return '***';
  return `${local.slice(0, 1)}***@${domain}`;
}

export function maskPhone(phone: string): string {
  return `${phone.slice(0, 4)}****${phone.slice(-3)}`;
}

// ------------------------------------------------------------------ auth for PENDING_DELETION accounts
interface Claims {
  sub: string;
  sid: string;
  typ: string;
  mfa_at?: number;
}

/**
 * Like requireAuth, but also admits accounts in PENDING_DELETION so that they can see their privacy
 * requests and cancel the deletion during the grace period. Every other endpoint uses the shared
 * requireAuth (ACTIVE only). A suspended or deleted account is still rejected.
 */
export const requireAuthAllowPendingDeletion: MiddlewareHandler<AppEnv> = async (c, next) => {
  const deps = c.get('deps');
  const h = c.req.header('authorization');
  if (!h?.startsWith('Bearer ')) throw Errors.unauthorized();
  let claims: Claims;
  try {
    const { payload } = await jwtVerify(h.slice(7), new TextEncoder().encode(deps.env.JWT_SECRET), {
      issuer: deps.env.JWT_ISSUER,
      audience: deps.env.JWT_AUDIENCE,
      algorithms: ['HS256'],
      currentDate: deps.clock.now(),
    });
    claims = payload as unknown as Claims;
  } catch {
    throw Errors.unauthorized('Token tidak valid atau kedaluwarsa', 'TOKEN_INVALID');
  }
  if (claims.typ !== 'access' || typeof claims.sub !== 'string' || typeof claims.sid !== 'string') {
    throw Errors.unauthorized('Token tidak valid atau kedaluwarsa', 'TOKEN_INVALID');
  }
  const [u] = await deps.sql<{ id: string; status: AuthContext['status']; kyc_level: number; active_mode: AuthContext['activeMode'] }[]>`
    SELECT u.id, u.status, u.kyc_level, u.active_mode FROM users u
     WHERE u.id = ${claims.sub}
       AND EXISTS (SELECT 1 FROM refresh_tokens rt WHERE rt.family_id = ${claims.sid} AND rt.user_id = u.id AND rt.revoked_at IS NULL)`;
  if (!u) throw Errors.unauthorized('Sesi berakhir, silakan masuk kembali', 'SESSION_REVOKED');
  if (u.status === 'SUSPENDED') throw Errors.forbidden('Akun ditangguhkan', 'ACCOUNT_SUSPENDED');
  if (u.status !== 'ACTIVE' && u.status !== 'PENDING_DELETION') throw Errors.forbidden('Akun tidak aktif', 'ACCOUNT_INACTIVE');
  const roles = await deps.sql<{ role_code: string }[]>`SELECT role_code FROM user_roles WHERE user_id = ${u.id} AND revoked_at IS NULL`;
  c.set('auth', {
    userId: u.id,
    sessionId: claims.sid,
    status: u.status,
    kycLevel: u.kyc_level,
    activeMode: u.active_mode,
    roles: roles.map((r) => r.role_code),
    mfaAt: typeof claims.mfa_at === 'number' ? claims.mfa_at : null,
  });
  await next();
};

/** Permission lookup usable from services (the shared hasPermission needs a Context). */
export async function userHasPermission(deps: AppDeps, userId: string, permission: string): Promise<boolean> {
  const [row] = await deps.sql<{ ok: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_code = ur.role_code
                    WHERE ur.user_id = ${userId} AND ur.revoked_at IS NULL AND rp.permission_code = ${permission}) AS ok`;
  return !!row?.ok;
}

/** Maps a caught error to an AppError-ish outcome after a transaction that must COMMIT side effects. */
export type Outcome<T> = { ok: true; value: T } | { ok: false; error: Error };
