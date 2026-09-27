/**
 * Admin · Users & RBAC.
 *   - search/detail return MASKED PII (e-mail r***@x.com, phone +6281****567, name "Budi S."); the full values only
 *     via POST /users/{id}/reveal-contact (users.read + MFA, audited `users.pii_revealed` + security event)
 *   - suspend / reactivate / force logout (sessions revoked, audited, security events)
 *   - role grants: non-privileged roles directly (rbac.manage + MFA); SUPER_ADMIN / FINANCE_SUPER_ADMIN through a
 *     maker-checker request approved by ANOTHER active SUPER_ADMIN with fresh MFA (admin_role_requests + DB guard)
 */
import type { TxSql } from '../../../db/sql';
import { clearPermissionCache } from '../../../middleware/auth';
import { AppError, Errors } from '../../../lib/errors';
import { LEVEL_CODES } from '../../kyc/level';
import {
  type AdminCtx,
  adminAudit,
  decodeKey,
  hasRole,
  inAdminTx,
  iso,
  maskEmail,
  maskName,
  maskPhone,
  mfaDate,
  num,
  page,
  PRIVILEGED_ROLES,
  securityEventRow,
} from '../common';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface UserRow {
  id: string;
  email: string | null;
  phone_e164: string | null;
  display_name: string | null;
  status: string;
  kyc_level: number;
  active_mode: string;
  trust_score: number;
  referral_code: string;
  created_at: Date;
  last_login_at: Date | null;
  suspended_at: Date | null;
  suspension_reason: string | null;
  deleted_at: Date | null;
  roles: string[] | null;
}

function maskedUser(u: UserRow) {
  return {
    id: u.id,
    email: maskEmail(u.email),
    phone: maskPhone(u.phone_e164),
    displayName: maskName(u.display_name),
    status: u.status,
    kycLevel: u.kyc_level,
    kycLevelCode: LEVEL_CODES[u.kyc_level] ?? null,
    activeMode: u.active_mode,
    trustScore: u.trust_score,
    roles: u.roles ?? [],
    createdAt: iso(u.created_at)!,
    lastLoginAt: iso(u.last_login_at),
    piiMasked: true as const,
  };
}

export interface UserSearch {
  q?: string | undefined;
  status?: 'ACTIVE' | 'SUSPENDED' | 'PENDING_DELETION' | 'DELETED' | undefined;
  role?: string | undefined;
  kycLevel?: number | undefined;
  limit: number;
  cursor?: string | undefined;
}

export async function searchUsers(ctx: AdminCtx, q: UserSearch) {
  const db = ctx.deps.sql;
  const cursor = decodeKey(q.cursor);
  const term = q.q?.trim() ?? '';
  let filter = db``;
  if (term) {
    if (UUID_RE.test(term)) filter = db`AND u.id = ${term}::uuid`;
    else if (term.includes('@')) filter = db`AND u.email ILIKE ${term.replace(/[%_]/g, '') + '%'}`;
    else if (/^[+0-9][0-9 ()-]{5,}$/.test(term)) {
      const digits = term.replace(/[^0-9]/g, '').replace(/^0/, '62');
      filter = db`AND u.phone_e164 LIKE ${'+' + digits + '%'}`;
    } else {
      const like = `%${term.replace(/[%_]/g, '')}%`;
      filter = db`AND (u.display_name ILIKE ${like} OR u.referral_code = ${term.toUpperCase()})`;
    }
  }
  const rowsRaw = await db<UserRow[]>`
    SELECT u.id, u.email, u.phone_e164, u.display_name, u.status, u.kyc_level, u.active_mode, u.trust_score, u.referral_code,
           u.created_at, u.last_login_at, u.suspended_at, u.suspension_reason, u.deleted_at,
           (SELECT array_agg(ur.role_code ORDER BY ur.role_code) FROM user_roles ur WHERE ur.user_id = u.id AND ur.revoked_at IS NULL) AS roles
      FROM users u
     WHERE true ${filter}
       ${q.status ? db`AND u.status = ${q.status}` : db``}
       ${q.kycLevel ? db`AND u.kyc_level = ${q.kycLevel}` : db``}
       ${q.role ? db`AND EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id AND ur.role_code = ${q.role} AND ur.revoked_at IS NULL)` : db``}
       ${cursor ? db`AND (u.created_at, u.id) < (${cursor.t}::timestamptz, ${cursor.id}::uuid)` : db``}
     ORDER BY u.created_at DESC, u.id DESC LIMIT ${q.limit + 1}`;
  const p = page(rowsRaw, q.limit, (x) => x.created_at);
  return { data: p.data.map(maskedUser), nextCursor: p.nextCursor };
}

async function loadUser(ctx: AdminCtx, id: string, forUpdate = false): Promise<UserRow> {
  const db = ctx.deps.sql;
  const [u] = forUpdate
    ? await db<UserRow[]>`SELECT u.*, NULL::text[] AS roles FROM users u WHERE u.id = ${id} FOR UPDATE`
    : await db<UserRow[]>`
        SELECT u.id, u.email, u.phone_e164, u.display_name, u.status, u.kyc_level, u.active_mode, u.trust_score, u.referral_code,
               u.created_at, u.last_login_at, u.suspended_at, u.suspension_reason, u.deleted_at,
               (SELECT array_agg(ur.role_code ORDER BY ur.role_code) FROM user_roles ur WHERE ur.user_id = u.id AND ur.revoked_at IS NULL) AS roles
          FROM users u WHERE u.id = ${id}`;
  if (!u) throw Errors.notFound('Pengguna', 'USER_NOT_FOUND');
  return u;
}

export async function userDetail(ctx: AdminCtx, id: string) {
  const db = ctx.deps.sql;
  const u = await loadUser(ctx, id);
  const [trust] = await db<{ score: number; components: unknown; computed_at: Date; override_id: string | null }[]>`
    SELECT score, components, computed_at, override_id FROM trust_scores WHERE user_id = ${id}`;
  const trustHistory = await db<{ score: number; previous_score: number | null; source: string; created_at: Date }[]>`
    SELECT score, previous_score, source, created_at FROM trust_score_history WHERE user_id = ${id} ORDER BY id DESC LIMIT 10`;
  const roles = await db<{ role_code: string; granted_at: Date; granted_by: string | null; reason: string | null }[]>`
    SELECT role_code, granted_at, granted_by, reason FROM user_roles WHERE user_id = ${id} AND revoked_at IS NULL ORDER BY role_code`;
  const kyc = await db<{ id: string; status: string; target_level: number; id_type: string | null; created_at: Date; reviewed_at: Date | null; decision_reason: string | null }[]>`
    SELECT id, status, target_level, id_type, created_at, reviewed_at, decision_reason FROM kyc_submissions WHERE user_id = ${id} ORDER BY created_at DESC LIMIT 5`;
  const payoutAccounts = await db<{ id: string; bank_code: string; account_mask: string; verification_status: string; is_default: boolean; disabled_at: Date | null }[]>`
    SELECT id, bank_code, account_mask, verification_status, is_default, disabled_at FROM payout_accounts WHERE user_id = ${id} ORDER BY created_at DESC`;
  const risk = await db<{ id: string; score: number; decision: string; reasons: unknown; rules_version: string; created_at: Date }[]>`
    SELECT id, score, decision, reasons, rules_version, created_at FROM risk_assessments
     WHERE subject_type = 'USER' AND subject_id = ${id} ORDER BY created_at DESC LIMIT 10`;
  const [openReviews] = await db<{ n: number }[]>`
    SELECT count(*)::int AS n FROM risk_reviews WHERE subject_type = 'USER' AND subject_id = ${id} AND status IN ('OPEN','IN_REVIEW')`;
  const txs = await db<{ role: string; status: string; n: number; total: number }[]>`
    SELECT 'BUYER' AS role, status, count(*)::int AS n, coalesce(sum(total_idr), 0)::bigint AS total FROM transactions WHERE buyer_id = ${id} GROUP BY status
    UNION ALL
    SELECT 'TRAVELER', status, count(*)::int, coalesce(sum(total_idr), 0)::bigint FROM transactions WHERE traveler_id = ${id} GROUP BY status`;
  const [devices] = await db<{ n: number }[]>`SELECT count(*)::int AS n FROM user_devices WHERE user_id = ${id} AND revoked_at IS NULL`;
  const sessions = await db<{ family_id: string; created_at: Date; expires_at: Date; platform: string | null; app_version: string | null }[]>`
    SELECT rt.family_id, rt.created_at, rt.expires_at, d.platform, d.app_version
      FROM refresh_tokens rt LEFT JOIN devices d ON d.id = rt.device_id
     WHERE rt.user_id = ${id} AND rt.revoked_at IS NULL AND rt.expires_at > ${ctx.deps.clock.now()}
     ORDER BY rt.created_at DESC LIMIT 20`;
  const [disputes] = await db<{ n: number }[]>`
    SELECT count(*)::int AS n FROM disputes d JOIN transactions t ON t.id = d.transaction_id
     WHERE d.status <> 'CLOSED' AND (t.buyer_id = ${id} OR t.traveler_id = ${id})`;
  const [sec] = await db<{ n: number; high: number }[]>`
    SELECT count(*)::int AS n, count(*) FILTER (WHERE severity IN ('HIGH','CRITICAL'))::int AS high FROM security_events
     WHERE user_id = ${id} AND created_at >= ${new Date(ctx.deps.clock.now().getTime() - 30 * 86400_000)}`;
  const summarize = (role: string) => {
    const r = txs.filter((x) => x.role === role);
    return {
      total: r.reduce((s, x) => s + x.n, 0),
      completed: r.filter((x) => x.status === 'COMPLETED').reduce((s, x) => s + x.n, 0),
      completedValueIdr: r.filter((x) => x.status === 'COMPLETED').reduce((s, x) => s + num(x.total), 0),
      byStatus: Object.fromEntries(r.map((x) => [x.status, x.n])),
    };
  };
  return {
    ...maskedUser({ ...u, roles: roles.map((r) => r.role_code) }),
    referralCode: u.referral_code,
    suspendedAt: iso(u.suspended_at),
    suspensionReason: u.suspension_reason,
    deletedAt: iso(u.deleted_at),
    roleGrants: roles.map((r) => ({ roleCode: r.role_code, grantedAt: iso(r.granted_at)!, grantedBy: r.granted_by, reason: r.reason })),
    trust: {
      score: trust?.score ?? u.trust_score,
      components: trust?.components ?? null,
      computedAt: iso(trust?.computed_at),
      overrideId: trust?.override_id ?? null,
      history: trustHistory.map((h) => ({ score: h.score, previousScore: h.previous_score, source: h.source, at: iso(h.created_at)! })),
    },
    kyc: {
      level: u.kyc_level,
      levelCode: LEVEL_CODES[u.kyc_level] ?? null,
      submissions: kyc.map((k) => ({ id: k.id, status: k.status, targetLevel: k.target_level, idType: k.id_type, createdAt: iso(k.created_at)!, reviewedAt: iso(k.reviewed_at), decisionReason: k.decision_reason })),
      payoutAccounts: payoutAccounts.map((p) => ({ id: p.id, bankCode: p.bank_code, accountMask: p.account_mask, verificationStatus: p.verification_status, isDefault: p.is_default, disabled: !!p.disabled_at })),
    },
    risk: {
      openReviews: openReviews?.n ?? 0,
      assessments: risk.map((r) => ({ id: r.id, score: r.score, decision: r.decision, reasons: r.reasons, rulesVersion: r.rules_version, createdAt: iso(r.created_at)! })),
    },
    transactions: { asBuyer: summarize('BUYER'), asTraveler: summarize('TRAVELER') },
    devices: { count: devices?.n ?? 0 },
    sessions: sessions.map((s) => ({ sessionId: s.family_id, createdAt: iso(s.created_at)!, expiresAt: iso(s.expires_at)!, platform: s.platform, appVersion: s.app_version })),
    disputes: { open: disputes?.n ?? 0 },
    security: { events30d: sec?.n ?? 0, highOrCritical30d: sec?.high ?? 0 },
  };
}

/** Full contact data (audited). Requires users.read + fresh MFA at the route. */
export async function revealContact(ctx: AdminCtx, id: string, reason: string) {
  const u = await loadUser(ctx, id);
  await inAdminTx(ctx, async (tx) => {
    await securityEventRow(tx, ctx.deps, { userId: ctx.auth.userId, type: 'ADMIN_PII_REVEALED', severity: 'MEDIUM', req: ctx.req, meta: { subjectUserId: id, fields: ['email', 'phone', 'displayName'] } });
    await adminAudit(tx, ctx, { action: 'users.pii_revealed', entityType: 'user', entityId: id, meta: { reason, fields: ['email', 'phone', 'displayName'] } });
  });
  return { id: u.id, email: u.email, phone: u.phone_e164, displayName: u.display_name, revealedAt: ctx.deps.clock.now().toISOString() };
}

async function revokeAllSessions(tx: TxSql, userId: string, now: Date): Promise<number> {
  const r = await tx`UPDATE refresh_tokens SET revoked_at = ${now}, revoked_reason = 'ADMIN' WHERE user_id = ${userId} AND revoked_at IS NULL RETURNING family_id`;
  return new Set(r.map((x) => x.family_id)).size;
}

export async function suspendUser(ctx: AdminCtx, id: string, reason: string) {
  if (id === ctx.auth.userId) throw Errors.unprocessable('CANNOT_SUSPEND_SELF', 'Tidak dapat menangguhkan akun sendiri');
  const now = ctx.deps.clock.now();
  const out = await inAdminTx(ctx, async (tx) => {
    const [u] = await tx<{ status: string }[]>`SELECT status FROM users WHERE id = ${id} FOR UPDATE`;
    if (!u) throw Errors.notFound('Pengguna', 'USER_NOT_FOUND');
    if (u.status !== 'ACTIVE') throw Errors.unprocessable('USER_NOT_ACTIVE', 'Hanya akun ACTIVE yang dapat ditangguhkan', { status: u.status });
    const [adm] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM user_roles WHERE user_id = ${id} AND revoked_at IS NULL AND role_code = 'SUPER_ADMIN'`;
    if ((adm?.n ?? 0) > 0 && !hasRole(ctx.auth, 'SUPER_ADMIN')) throw Errors.forbidden('Menangguhkan SUPER_ADMIN hanya oleh SUPER_ADMIN', 'ROLE_REQUIRED');
    await tx`UPDATE users SET status = 'SUSPENDED', suspended_at = ${now}, suspension_reason = ${reason} WHERE id = ${id}`;
    const sessions = await revokeAllSessions(tx, id, now);
    const [open] = await tx<{ n: number }[]>`
      SELECT count(*)::int AS n FROM transactions WHERE (buyer_id = ${id} OR traveler_id = ${id}) AND status NOT IN ('COMPLETED','CANCELLED','REFUNDED')`;
    await securityEventRow(tx, ctx.deps, { userId: id, type: 'ACCOUNT_SUSPENDED', severity: 'HIGH', req: ctx.req, meta: { by: ctx.auth.userId } });
    await adminAudit(tx, ctx, { action: 'users.suspended', entityType: 'user', entityId: id, before: { status: 'ACTIVE' }, after: { status: 'SUSPENDED' }, meta: { reason, sessionsRevoked: sessions } });
    return { sessionsRevoked: sessions, openTransactions: open?.n ?? 0 };
  });
  clearPermissionCache(id);
  return { id, status: 'SUSPENDED', ...out, warning: out.openTransactions > 0 ? 'Pengguna masih memiliki transaksi terbuka; tangani lewat menu Transaksi/Dispute.' : null };
}

export async function reactivateUser(ctx: AdminCtx, id: string, reason: string) {
  await inAdminTx(ctx, async (tx) => {
    const [u] = await tx<{ status: string; suspension_reason: string | null }[]>`SELECT status, suspension_reason FROM users WHERE id = ${id} FOR UPDATE`;
    if (!u) throw Errors.notFound('Pengguna', 'USER_NOT_FOUND');
    if (u.status !== 'SUSPENDED') throw Errors.unprocessable('USER_NOT_SUSPENDED', 'Akun tidak sedang ditangguhkan', { status: u.status });
    await tx`UPDATE users SET status = 'ACTIVE', suspended_at = NULL, suspension_reason = NULL WHERE id = ${id}`;
    await securityEventRow(tx, ctx.deps, { userId: id, type: 'ACCOUNT_REACTIVATED', severity: 'MEDIUM', req: ctx.req, meta: { by: ctx.auth.userId } });
    await adminAudit(tx, ctx, { action: 'users.reactivated', entityType: 'user', entityId: id, before: { status: 'SUSPENDED' }, after: { status: 'ACTIVE' }, meta: { reason } });
  });
  clearPermissionCache(id);
  return { id, status: 'ACTIVE' };
}

export async function forceLogout(ctx: AdminCtx, id: string, reason: string) {
  const now = ctx.deps.clock.now();
  const sessions = await inAdminTx(ctx, async (tx) => {
    const [u] = await tx<{ id: string }[]>`SELECT id FROM users WHERE id = ${id}`;
    if (!u) throw Errors.notFound('Pengguna', 'USER_NOT_FOUND');
    const n = await revokeAllSessions(tx, id, now);
    await securityEventRow(tx, ctx.deps, { userId: id, type: 'SESSION_REVOKED', severity: 'MEDIUM', req: ctx.req, meta: { by: ctx.auth.userId, scope: 'ALL', admin: true } });
    await adminAudit(tx, ctx, { action: 'users.force_logout', entityType: 'user', entityId: id, meta: { reason, sessionsRevoked: n } });
    return n;
  });
  return { id, sessionsRevoked: sessions };
}

// ------------------------------------------------------------------ RBAC

export async function listRoles(ctx: AdminCtx) {
  const db = ctx.deps.sql;
  const roles = await db<{ code: string; name: string; description: string | null; perms: string[] | null; holders: number }[]>`
    SELECT r.code, r.name, r.description,
           (SELECT array_agg(rp.permission_code ORDER BY rp.permission_code) FROM role_permissions rp WHERE rp.role_code = r.code) AS perms,
           (SELECT count(*) FROM user_roles ur WHERE ur.role_code = r.code AND ur.revoked_at IS NULL)::int AS holders
      FROM roles r ORDER BY r.code`;
  const perms = await db<{ code: string; description: string; is_sensitive: boolean }[]>`SELECT code, description, is_sensitive FROM permissions ORDER BY code`;
  return {
    roles: roles.map((r) => ({ code: r.code, name: r.name, description: r.description, permissions: r.perms ?? [], holders: r.holders, privileged: (PRIVILEGED_ROLES as readonly string[]).includes(r.code) })),
    permissions: perms.map((p) => ({ code: p.code, description: p.description, sensitive: p.is_sensitive })),
  };
}

export async function grantRole(ctx: AdminCtx, userId: string, roleCode: string, reason: string) {
  if (userId === ctx.auth.userId) throw Errors.forbidden('Tidak dapat memberi peran kepada diri sendiri', 'MAKER_CHECKER_VIOLATION');
  const db = ctx.deps.sql;
  const [role] = await db<{ code: string }[]>`SELECT code FROM roles WHERE code = ${roleCode}`;
  if (!role) throw Errors.notFound('Peran', 'ROLE_NOT_FOUND');
  const u = await loadUser(ctx, userId);
  if (u.status !== 'ACTIVE') throw Errors.unprocessable('USER_NOT_ACTIVE', 'Peran hanya untuk akun ACTIVE', { status: u.status });
  if ((u.roles ?? []).includes(roleCode)) throw Errors.conflict('ROLE_ALREADY_GRANTED', 'Pengguna sudah memiliki peran ini');
  const privileged = (PRIVILEGED_ROLES as readonly string[]).includes(roleCode);
  if (privileged) {
    const req = await inAdminTx(ctx, async (tx) => {
      const [pending] = await tx<{ id: string }[]>`SELECT id FROM admin_role_requests WHERE user_id = ${userId} AND role_code = ${roleCode} AND status = 'PENDING'`;
      if (pending) throw Errors.conflict('ROLE_REQUEST_PENDING', 'Sudah ada permintaan yang menunggu persetujuan', { requestId: pending.id });
      const [r] = await tx<{ id: string; expires_at: Date }[]>`
        INSERT INTO admin_role_requests (user_id, role_code, reason, requested_by, requester_mfa_at, expires_at)
        VALUES (${userId}, ${roleCode}, ${reason}, ${ctx.auth.userId}, ${mfaDate(ctx.auth)}, ${new Date(ctx.deps.clock.now().getTime() + 72 * 3600_000)})
        RETURNING id, expires_at`;
      await adminAudit(tx, ctx, { action: 'rbac.role_grant_requested', entityType: 'user', entityId: userId, after: { roleCode, status: 'PENDING' }, meta: { requestId: r!.id, reason } });
      return r!;
    });
    return { status: 'PENDING_APPROVAL' as const, requestId: req.id, roleCode, userId, expiresAt: iso(req.expires_at)!, message: 'Peran istimewa memerlukan persetujuan SUPER_ADMIN lain (maker-checker).' };
  }
  await inAdminTx(ctx, async (tx) => {
    await tx`INSERT INTO user_roles (user_id, role_code, granted_by, reason) VALUES (${userId}, ${roleCode}, ${ctx.auth.userId}, ${reason})`;
    await securityEventRow(tx, ctx.deps, { userId, type: 'ROLE_GRANTED', severity: 'MEDIUM', req: ctx.req, meta: { roleCode, by: ctx.auth.userId } });
    await adminAudit(tx, ctx, { action: 'rbac.role_granted', entityType: 'user', entityId: userId, before: { roles: u.roles ?? [] }, after: { roles: [...(u.roles ?? []), roleCode].sort() }, meta: { roleCode, reason } });
  });
  clearPermissionCache(userId);
  return { status: 'GRANTED' as const, requestId: null, roleCode, userId, expiresAt: null, message: 'Peran diberikan.' };
}

export async function revokeRole(ctx: AdminCtx, userId: string, roleCode: string, reason: string) {
  const now = ctx.deps.clock.now();
  await inAdminTx(ctx, async (tx) => {
    const [g] = await tx<{ id: string }[]>`SELECT id FROM user_roles WHERE user_id = ${userId} AND role_code = ${roleCode} AND revoked_at IS NULL FOR UPDATE`;
    if (!g) throw Errors.notFound('Peran aktif', 'ROLE_GRANT_NOT_FOUND');
    if (roleCode === 'SUPER_ADMIN') {
      if (userId === ctx.auth.userId) throw Errors.unprocessable('CANNOT_REVOKE_OWN_SUPER_ADMIN', 'Tidak dapat mencabut SUPER_ADMIN milik sendiri');
      await tx`SELECT pg_advisory_xact_lock(hashtextextended('rbac:super_admin', 0))`;
      const [n] = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM user_roles ur JOIN users u ON u.id = ur.user_id
         WHERE ur.role_code = 'SUPER_ADMIN' AND ur.revoked_at IS NULL AND u.status = 'ACTIVE'`;
      if ((n?.n ?? 0) <= 1) throw Errors.unprocessable('LAST_SUPER_ADMIN', 'Tidak dapat mencabut SUPER_ADMIN terakhir');
    }
    await tx`UPDATE user_roles SET revoked_at = GREATEST(${now}::timestamptz, granted_at), revoked_by = ${ctx.auth.userId}, reason = ${reason} WHERE id = ${g.id}`;
    await securityEventRow(tx, ctx.deps, { userId, type: 'ROLE_REVOKED', severity: 'MEDIUM', req: ctx.req, meta: { roleCode, by: ctx.auth.userId } });
    await adminAudit(tx, ctx, { action: 'rbac.role_revoked', entityType: 'user', entityId: userId, before: { roleCode }, after: { roleCode: null }, meta: { reason } });
  });
  clearPermissionCache(userId);
  return { userId, roleCode, revoked: true };
}

interface RoleRequestRow {
  id: string;
  user_id: string;
  role_code: string;
  reason: string;
  requested_by: string;
  approved_by: string | null;
  rejected_by: string | null;
  status: string;
  decision_note: string | null;
  decided_at: Date | null;
  expires_at: Date;
  created_at: Date;
}

function roleRequestDto(r: RoleRequestRow) {
  return {
    id: r.id,
    userId: r.user_id,
    roleCode: r.role_code,
    reason: r.reason,
    requestedBy: r.requested_by,
    approvedBy: r.approved_by,
    rejectedBy: r.rejected_by,
    status: r.status,
    decisionNote: r.decision_note,
    decidedAt: iso(r.decided_at),
    expiresAt: iso(r.expires_at)!,
    createdAt: iso(r.created_at)!,
  };
}

export async function listRoleRequests(ctx: AdminCtx, status?: string) {
  const rowsRaw = await ctx.deps.sql<RoleRequestRow[]>`
    SELECT * FROM admin_role_requests ${status ? ctx.deps.sql`WHERE status = ${status}` : ctx.deps.sql``} ORDER BY created_at DESC LIMIT 200`;
  return { data: rowsRaw.map(roleRequestDto) };
}

export async function approveRoleRequest(ctx: AdminCtx, id: string, note: string | undefined) {
  if (!hasRole(ctx.auth, 'SUPER_ADMIN')) throw Errors.forbidden('Persetujuan peran istimewa hanya oleh SUPER_ADMIN', 'ROLE_REQUIRED', { required: 'SUPER_ADMIN' });
  const now = ctx.deps.clock.now();
  const out = await inAdminTx(ctx, async (tx) => {
    const [r] = await tx<RoleRequestRow[]>`SELECT * FROM admin_role_requests WHERE id = ${id} FOR UPDATE`;
    if (!r) throw Errors.notFound('Permintaan peran', 'ROLE_REQUEST_NOT_FOUND');
    if (r.status !== 'PENDING') throw Errors.unprocessable('ROLE_REQUEST_NOT_PENDING', 'Permintaan sudah diputuskan', { status: r.status });
    if (r.requested_by === ctx.auth.userId || r.user_id === ctx.auth.userId) {
      throw Errors.forbidden('Penyetuju harus berbeda dari pengaju dan penerima peran', 'MAKER_CHECKER_VIOLATION');
    }
    if (r.expires_at <= now) throw Errors.unprocessable('ROLE_REQUEST_EXPIRED', 'Permintaan sudah kedaluwarsa');
    await tx`UPDATE admin_role_requests SET status = 'APPLIED', approved_by = ${ctx.auth.userId}, approver_mfa_at = ${mfaDate(ctx.auth)},
                    decision_note = ${note ?? null}, decided_at = ${now} WHERE id = ${id}`;
    const [exists] = await tx`SELECT 1 FROM user_roles WHERE user_id = ${r.user_id} AND role_code = ${r.role_code} AND revoked_at IS NULL`;
    if (!exists) {
      await tx`INSERT INTO user_roles (user_id, role_code, granted_by, reason) VALUES (${r.user_id}, ${r.role_code}, ${ctx.auth.userId}, ${`${r.reason} [request ${r.id}]`})`;
    }
    await securityEventRow(tx, ctx.deps, { userId: r.user_id, type: 'ROLE_GRANTED', severity: 'HIGH', req: ctx.req, meta: { roleCode: r.role_code, requestedBy: r.requested_by, approvedBy: ctx.auth.userId } });
    await adminAudit(tx, ctx, { action: 'rbac.privileged_role_granted', entityType: 'user', entityId: r.user_id, after: { roleCode: r.role_code }, meta: { requestId: id, requestedBy: r.requested_by, note: note ?? null } });
    return r;
  });
  clearPermissionCache(out.user_id);
  return { id, status: 'APPLIED', userId: out.user_id, roleCode: out.role_code };
}

export async function rejectRoleRequest(ctx: AdminCtx, id: string, note: string) {
  const now = ctx.deps.clock.now();
  const status = await inAdminTx(ctx, async (tx) => {
    const [r] = await tx<RoleRequestRow[]>`SELECT * FROM admin_role_requests WHERE id = ${id} FOR UPDATE`;
    if (!r) throw Errors.notFound('Permintaan peran', 'ROLE_REQUEST_NOT_FOUND');
    if (r.status !== 'PENDING') throw Errors.unprocessable('ROLE_REQUEST_NOT_PENDING', 'Permintaan sudah diputuskan', { status: r.status });
    const self = r.requested_by === ctx.auth.userId;
    await tx`UPDATE admin_role_requests SET status = ${self ? 'CANCELLED' : 'REJECTED'}, rejected_by = ${ctx.auth.userId}, decision_note = ${note}, decided_at = ${now} WHERE id = ${id}`;
    await adminAudit(tx, ctx, { action: self ? 'rbac.role_request_cancelled' : 'rbac.role_request_rejected', entityType: 'user', entityId: r.user_id, meta: { requestId: id, roleCode: r.role_code, note } });
    return self ? 'CANCELLED' : 'REJECTED';
  });
  return { id, status };
}

export function assertValidRole(code: string): void {
  if (!/^[A-Z][A-Z_]*$/.test(code)) throw new AppError(400, 'VALIDATION_ERROR', 'Kode peran tidak valid');
}
