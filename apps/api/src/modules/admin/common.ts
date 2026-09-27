/**
 * Shared helpers for the admin module group (/v1/admin/*):
 *   - adminGuard(perms, {mfa, idempotent}) → requireAuth + requireAdmin + requirePermission(...) [+ requireRecentMfa]
 *     [+ requireIdempotency] — the only way admin routes declare access (least privilege per route)
 *   - adminCtx(c) → { deps, auth, requestId, req } for services
 *   - inAdminTx(deps, ctx, fn) → DB transaction with jk.actor_type/actor_id/request_id set (trigger-written rows
 *     such as refund_events and audit request ids carry the admin)
 *   - adminAudit(db, ctx, …) → audit row (actor ADMIN, roles + request id in meta). Call it LAST in the transaction.
 *   - PII masking, keyset pagination, common zod schemas.
 */
import { z } from '@hono/zod-openapi';
import type { Context, MiddlewareHandler } from 'hono';
import type { AppDeps, AppEnv, AuthContext } from '../../context';
import { camel, type Db, type TxSql } from '../../db/sql';
import { base64UrlDecode, base64UrlEncode } from '../../lib/crypto';
import { AppError, Errors } from '../../lib/errors';
import { getAuth, requireAdmin, requireAuth, requirePermission, requireRecentMfa } from '../../middleware/auth';
import { requireIdempotency } from '../../middleware/idempotency';
import { audit } from '../../services/audit';
import { requestMeta, type RequestMeta } from '../auth/common';

export interface AdminCtx {
  deps: AppDeps;
  auth: AuthContext;
  requestId: string;
  req: RequestMeta;
}

export interface GuardOptions {
  /** Sensitive write: MFA step-up within ADMIN_MFA_STEP_UP_SEC (403 MFA_REQUIRED). */
  mfa?: boolean;
  /** Financial write: Idempotency-Key header (stored response replayed). */
  idempotent?: boolean;
}

/** Middleware chain for an admin route. ALL listed permissions are required. */
export function adminGuard(permissions: readonly string[], opts: GuardOptions = {}): MiddlewareHandler<AppEnv>[] {
  const chain: MiddlewareHandler<AppEnv>[] = [requireAuth, requireAdmin, requirePermission(...permissions)];
  if (opts.mfa) chain.push(requireRecentMfa);
  if (opts.idempotent) chain.push(requireIdempotency);
  return chain;
}

export async function adminCtx(c: Context<AppEnv>): Promise<AdminCtx> {
  return { deps: c.get('deps'), auth: getAuth(c), requestId: c.get('requestId'), req: await requestMeta(c) };
}

/** MFA timestamp (epoch seconds in the access token) as a Date, for DB maker-checker guards. */
export function mfaDate(auth: AuthContext): Date {
  if (!auth.mfaAt) throw Errors.mfaRequired();
  return new Date(auth.mfaAt * 1000);
}

export async function setAdminDbContext(db: Db, ctx: Pick<AdminCtx, 'auth' | 'requestId'>): Promise<void> {
  await db`SELECT set_config('jk.actor_type', 'ADMIN', true), set_config('jk.actor_id', ${ctx.auth.userId}, true),
                  set_config('jk.request_id', ${ctx.requestId}, true)`;
}

/** Runs `fn` in a DB transaction tagged with the admin actor and request id. */
export async function inAdminTx<T>(ctx: AdminCtx, fn: (tx: TxSql) => Promise<T>): Promise<T> {
  return ctx.deps.sql.begin(async (tq) => {
    const tx = tq as unknown as TxSql;
    await setAdminDbContext(tx, ctx);
    return fn(tx);
  }) as Promise<T>;
}

export async function adminAudit(
  db: Db,
  ctx: Pick<AdminCtx, 'auth' | 'requestId'>,
  e: { action: string; entityType: string; entityId: string | null; before?: unknown; after?: unknown; meta?: Record<string, unknown> },
): Promise<void> {
  await audit(db, {
    actorType: 'ADMIN',
    actorId: ctx.auth.userId,
    action: e.action,
    entityType: e.entityType,
    entityId: e.entityId,
    ...(e.before !== undefined ? { before: e.before } : {}),
    ...(e.after !== undefined ? { after: e.after } : {}),
    meta: { ...(e.meta ?? {}), actorRoles: ctx.auth.roles, requestId: ctx.requestId },
  });
}

export async function securityEventRow(
  db: Db,
  deps: AppDeps,
  e: { userId?: string | null; type: string; severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'; meta?: Record<string, unknown>; req?: RequestMeta | null },
): Promise<void> {
  await db`
    INSERT INTO security_events (user_id, type, severity, ip_hash, user_agent, meta, created_at)
    VALUES (${e.userId ?? null}, ${e.type}, ${e.severity}, ${e.req?.ipHash ? Buffer.from(e.req.ipHash) : null},
            ${e.req?.userAgent ?? null}, ${db.json((e.meta ?? {}) as never)}, ${deps.clock.now()})`;
}

// ------------------------------------------------------------------ roles

export const PRIVILEGED_ROLES = ['SUPER_ADMIN', 'FINANCE_SUPER_ADMIN'] as const;

export function hasRole(auth: AuthContext, role: string): boolean {
  return auth.roles.includes(role);
}

export function requireRole(auth: AuthContext, role: string, message?: string): void {
  if (!hasRole(auth, role)) throw Errors.forbidden(message ?? `Khusus peran ${role}`, 'ROLE_REQUIRED', { required: role });
}

export async function permissionsOf(db: Db, userId: string): Promise<Set<string>> {
  const rows = await db<{ permission_code: string }[]>`
    SELECT DISTINCT rp.permission_code FROM user_roles ur JOIN role_permissions rp ON rp.role_code = ur.role_code
     WHERE ur.user_id = ${userId} AND ur.revoked_at IS NULL`;
  return new Set(rows.map((r) => r.permission_code));
}

export function makerChecker(requestedBy: string | null | undefined, approver: string, message = 'Persetujuan harus oleh admin yang berbeda dari pengaju'): void {
  if (requestedBy && requestedBy === approver) throw Errors.forbidden(message, 'MAKER_CHECKER_VIOLATION');
}

// ------------------------------------------------------------------ masking

export function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const [local, domain] = email.split('@');
  if (!local || !domain) return '***';
  return `${local.slice(0, 1)}***@${domain}`;
}

export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  if (phone.length <= 7) return '****';
  return `${phone.slice(0, 5)}****${phone.slice(-3)}`;
}

/** "Budi Santoso" → "Budi S." (public name; full names only via the audited reveal endpoint). */
export function maskName(name: string | null | undefined): string | null {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length === 1) return `${parts[0]!.slice(0, 1)}***`;
  return `${parts[0]!.slice(0, 40)} ${parts[parts.length - 1]!.charAt(0).toUpperCase()}.`;
}

export function maskHost(host: string | null | undefined): string | null {
  if (!host) return null;
  const labels = host.split('.');
  const head = labels[0] ?? '';
  const masked = `${head.slice(0, 2)}***`;
  return labels.length > 2 ? `${masked}.${labels.slice(-2).join('.')}` : masked;
}

// ------------------------------------------------------------------ misc

export function iso(v: Date | string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

export function num(v: unknown): number {
  if (v === null || v === undefined) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function rows<T>(r: readonly Record<string, unknown>[]): T[] {
  return r.map((x) => camel<T>(x));
}

export function notFound(entity: string, code: string): AppError {
  return Errors.notFound(entity, code);
}

// ------------------------------------------------------------------ keyset pagination

export interface KeyCursor {
  t: string;
  id: string;
}

export function encodeKey(c: KeyCursor): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(c)));
}

export function decodeKey(s: string | undefined): KeyCursor | null {
  if (!s) return null;
  try {
    const v = JSON.parse(new TextDecoder().decode(base64UrlDecode(s))) as KeyCursor;
    if (typeof v.t !== 'string' || typeof v.id !== 'string' || Number.isNaN(Date.parse(v.t))) throw new Error('bad');
    return v;
  } catch {
    throw Errors.badRequest('CURSOR_INVALID', 'Cursor tidak valid');
  }
}

/** Slices `limit + 1` rows into a page; cursor from (createdAt, id) of the last row. */
export function page<T extends { id: string }>(items: T[], limit: number, key: (x: T) => Date | string): { data: T[]; nextCursor: string | null } {
  const more = items.length > limit;
  const data = more ? items.slice(0, limit) : items;
  const last = data[data.length - 1];
  return { data, nextCursor: more && last ? encodeKey({ t: iso(key(last))!, id: last.id }) : null };
}

// ------------------------------------------------------------------ schemas

export const IdParam = z.object({
  id: z.string().uuid().openapi({ param: { name: 'id', in: 'path' }, example: '0b7f6d7e-5a3b-4a51-9c61-6f2d1c0e9a11' }),
});

export const ReasonBody = z.object({ reason: z.string().trim().min(5).max(1000).openapi({ description: 'Wajib — dicatat di audit log', example: 'Verifikasi manual oleh tim Risk' }) });

export const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(500).optional(),
});

export const AdminLoose = z.looseObject({}).openapi('AdminResult');
export const AdminPage = z.object({ data: z.array(z.looseObject({})), nextCursor: z.string().nullable() }).openapi('AdminPage');

/** Parses `A,B` query values against an allowlist (400 VALIDATION_ERROR on unknown values). */
export function parseCsv<T extends string>(raw: string | undefined, allowed: readonly T[], field: string): T[] | null {
  if (!raw) return null;
  const parts = raw.split(',').map((x) => x.trim()).filter(Boolean);
  const bad = parts.filter((p) => !(allowed as readonly string[]).includes(p));
  if (bad.length) throw Errors.validation({ issues: [{ path: field, code: 'invalid_value', message: `unknown value(s): ${bad.join(',')}` }] });
  return parts as T[];
}

export const StatusCsvQuery = z.string().max(300).optional().openapi({ description: 'Comma-separated statuses' });
