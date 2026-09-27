/**
 * Admin · Risk & trust.
 * Risk reviews (risk.read / risk.review): queue (OPEN/IN_REVIEW) with assessment reasons & signals, assign (→ IN_REVIEW),
 * resolve CLEARED / CONFIRMED_FRAUD (+ optional suspension, needs users.suspend) → emits `risk.review_resolved`
 * {reviewId, subjectType, subjectId, userId, outcome, status}. Payout effects:
 *   CLEARED on a TRANSACTION/PAYMENT/PURCHASE_PROOF subject clears transactions.payout_hold_reason when no other review
 *   on that transaction is open; CONFIRMED_FRAUD sets payout_hold_reason = CONFIRMED_FRAUD (transaction subjects) or
 *   puts the user's SCHEDULED payouts ON_HOLD (USER subject) — a closed review must never silently release money.
 * Trust score overrides (trust.override.request → trust.override.approve): maker-checker in trust_score_overrides
 * (approver ≠ requester ≠ subject, DB guard), applied with apply_trust_score_override() (history + audit).
 */
import type { Db } from '../../../db/sql';
import { Errors } from '../../../lib/errors';
import { emitEvent } from '../../../services/outbox';
import { type AdminCtx, adminAudit, decodeKey, encodeKey, hasRole, inAdminTx, iso, maskName, parseCsv, permissionsOf } from '../common';
import { suspendUser } from '../users/service';

const REVIEW_STATUSES = ['OPEN', 'IN_REVIEW', 'CLEARED', 'CONFIRMED_FRAUD'] as const;
const SUBJECTS = ['USER', 'TRANSACTION', 'PAYMENT', 'REFERRAL', 'REFUND', 'PURCHASE_PROOF', 'TRIP'] as const;

interface ReviewRow {
  id: string;
  assessment_id: string;
  subject_type: string;
  subject_id: string;
  status: string;
  assignee_id: string | null;
  notes: string | null;
  resolved_by: string | null;
  resolved_at: Date | null;
  created_at: Date;
  score: number;
  decision: string;
  reasons: unknown;
  signals: unknown;
  rules_version: string;
}

function reviewDto(r: ReviewRow) {
  return {
    id: r.id,
    subjectType: r.subject_type,
    subjectId: r.subject_id,
    status: r.status,
    assigneeId: r.assignee_id,
    notes: r.notes,
    resolvedBy: r.resolved_by,
    resolvedAt: iso(r.resolved_at),
    createdAt: iso(r.created_at)!,
    assessment: { id: r.assessment_id, score: r.score, decision: r.decision, reasons: r.reasons, signals: r.signals, rulesVersion: r.rules_version },
  };
}

const REVIEW_SELECT = (db: AdminCtx['deps']['sql']) => db`
  SELECT rv.id, rv.assessment_id, rv.subject_type, rv.subject_id, rv.status, rv.assignee_id, rv.notes, rv.resolved_by, rv.resolved_at, rv.created_at,
         a.score, a.decision, a.reasons, a.signals, a.rules_version
    FROM risk_reviews rv JOIN risk_assessments a ON a.id = rv.assessment_id`;

export async function reviewQueue(ctx: AdminCtx, q: { status?: string | undefined; subjectType?: string | undefined; assignee?: string | undefined; limit: number; cursor?: string | undefined }) {
  const db = ctx.deps.sql;
  const statuses = parseCsv(q.status, REVIEW_STATUSES, 'status') ?? ['OPEN', 'IN_REVIEW'];
  const subjects = parseCsv(q.subjectType, SUBJECTS, 'subjectType');
  const cursor = decodeKey(q.cursor);
  const assignee = q.assignee === 'me' ? ctx.auth.userId : q.assignee;
  const r = await db<ReviewRow[]>`
    ${REVIEW_SELECT(db)}
     WHERE rv.status = ANY(${statuses}::text[])
       ${subjects ? db`AND rv.subject_type = ANY(${subjects}::text[])` : db``}
       ${assignee === 'none' ? db`AND rv.assignee_id IS NULL` : assignee ? db`AND rv.assignee_id = ${assignee}` : db``}
       ${cursor ? db`AND (rv.created_at, rv.id) > (${cursor.t}::timestamptz, ${cursor.id}::uuid)` : db``}
     ORDER BY rv.created_at, rv.id LIMIT ${q.limit + 1}`;
  const more = r.length > q.limit;
  const data = r.slice(0, q.limit).map(reviewDto);
  const last = data[data.length - 1];
  return { data, nextCursor: more && last ? encodeKey({ t: last.createdAt, id: last.id }) : null };
}

async function loadReview(db: AdminCtx['deps']['sql'], id: string, forUpdate = false): Promise<ReviewRow> {
  const [r] = await db<ReviewRow[]>`${REVIEW_SELECT(db)} WHERE rv.id = ${id} ${forUpdate ? db`FOR UPDATE OF rv` : db``}`;
  if (!r) throw Errors.notFound('Review risiko', 'RISK_REVIEW_NOT_FOUND');
  return r;
}

/** The user a review is about (null for TRANSACTION: both parties are listed in userIds). */
export async function reviewUsers(db: Db, subjectType: string, subjectId: string): Promise<{ userId: string | null; userIds: string[]; transactionId: string | null }> {
  switch (subjectType) {
    case 'USER':
      return { userId: subjectId, userIds: [subjectId], transactionId: null };
    case 'TRANSACTION': {
      const [t] = await db<{ buyer_id: string; traveler_id: string | null }[]>`SELECT buyer_id, traveler_id FROM transactions WHERE id = ${subjectId}`;
      return { userId: null, userIds: t ? [t.buyer_id, ...(t.traveler_id ? [t.traveler_id] : [])] : [], transactionId: t ? subjectId : null };
    }
    case 'PAYMENT': {
      const [p] = await db<{ buyer_id: string; transaction_id: string }[]>`SELECT t.buyer_id, p.transaction_id FROM payments p JOIN transactions t ON t.id = p.transaction_id WHERE p.id = ${subjectId}`;
      return { userId: p?.buyer_id ?? null, userIds: p ? [p.buyer_id] : [], transactionId: p?.transaction_id ?? null };
    }
    case 'REFUND': {
      const [p] = await db<{ buyer_id: string; transaction_id: string }[]>`SELECT t.buyer_id, r.transaction_id FROM refunds r JOIN transactions t ON t.id = r.transaction_id WHERE r.id = ${subjectId}`;
      return { userId: p?.buyer_id ?? null, userIds: p ? [p.buyer_id] : [], transactionId: p?.transaction_id ?? null };
    }
    case 'PURCHASE_PROOF': {
      const [p] = await db<{ traveler_id: string; transaction_id: string }[]>`SELECT traveler_id, transaction_id FROM purchase_proofs WHERE id = ${subjectId}`;
      return { userId: p?.traveler_id ?? null, userIds: p ? [p.traveler_id] : [], transactionId: p?.transaction_id ?? null };
    }
    case 'TRIP': {
      const [p] = await db<{ traveler_id: string }[]>`SELECT traveler_id FROM trips WHERE id = ${subjectId}`;
      return { userId: p?.traveler_id ?? null, userIds: p ? [p.traveler_id] : [], transactionId: null };
    }
    case 'REFERRAL': {
      const [p] = await db<{ referee_id: string; referrer_id: string }[]>`SELECT referee_id, referrer_id FROM referrals WHERE id = ${subjectId}`;
      return { userId: p?.referee_id ?? null, userIds: p ? [p.referee_id, p.referrer_id] : [], transactionId: null };
    }
    default:
      return { userId: null, userIds: [], transactionId: null };
  }
}

export async function reviewDetail(ctx: AdminCtx, id: string) {
  const db = ctx.deps.sql;
  const r = await loadReview(db, id);
  const history = await db<{ id: string; score: number; decision: string; reasons: unknown; rules_version: string; created_at: Date }[]>`
    SELECT id, score, decision, reasons, rules_version, created_at FROM risk_assessments
     WHERE subject_type = ${r.subject_type} AND subject_id = ${r.subject_id} ORDER BY created_at DESC LIMIT 20`;
  const who = await reviewUsers(db, r.subject_type, r.subject_id);
  const users = who.userIds.length
    ? await db<{ id: string; display_name: string | null; status: string; kyc_level: number; trust_score: number }[]>`
        SELECT id, display_name, status, kyc_level, trust_score FROM users WHERE id IN ${db(who.userIds)}`
    : [];
  return {
    ...reviewDto(r),
    subject: { type: r.subject_type, id: r.subject_id, transactionId: who.transactionId, userId: who.userId },
    users: users.map((u) => ({ id: u.id, displayName: maskName(u.display_name), status: u.status, kycLevel: u.kyc_level, trustScore: u.trust_score })),
    assessmentHistory: history.map((h) => ({ id: h.id, score: h.score, decision: h.decision, reasons: h.reasons, rulesVersion: h.rules_version, createdAt: iso(h.created_at)! })),
    allowedActions: ['OPEN', 'IN_REVIEW'].includes(r.status) ? ['ASSIGN', 'RESOLVE'] : [],
  };
}

export async function assignReview(ctx: AdminCtx, id: string, assigneeId?: string) {
  const target = assigneeId ?? ctx.auth.userId;
  if (!(await permissionsOf(ctx.deps.sql, target)).has('risk.review')) throw Errors.unprocessable('ASSIGNEE_NOT_ALLOWED', 'Penanggung jawab harus memiliki izin risk.review');
  await inAdminTx(ctx, async (tx) => {
    const [r] = await tx<{ status: string; assignee_id: string | null }[]>`SELECT status, assignee_id FROM risk_reviews WHERE id = ${id} FOR UPDATE`;
    if (!r) throw Errors.notFound('Review risiko', 'RISK_REVIEW_NOT_FOUND');
    if (!['OPEN', 'IN_REVIEW'].includes(r.status)) throw Errors.unprocessable('RISK_REVIEW_CLOSED', 'Review sudah diselesaikan', { status: r.status });
    await tx`UPDATE risk_reviews SET status = 'IN_REVIEW', assignee_id = ${target} WHERE id = ${id}`;
    await adminAudit(tx, ctx, { action: 'risk.review_assigned', entityType: 'risk_review', entityId: id, before: { status: r.status, assigneeId: r.assignee_id }, after: { status: 'IN_REVIEW', assigneeId: target } });
  });
  return { id, status: 'IN_REVIEW', assigneeId: target };
}

export async function resolveReview(ctx: AdminCtx, id: string, input: { outcome: 'CLEARED' | 'CONFIRMED_FRAUD'; notes: string; suspendUser?: boolean | undefined }) {
  if (input.suspendUser) {
    if (input.outcome !== 'CONFIRMED_FRAUD') throw Errors.validation({ issues: [{ path: 'suspendUser', message: 'hanya untuk CONFIRMED_FRAUD' }] });
    if (!(await permissionsOf(ctx.deps.sql, ctx.auth.userId)).has('users.suspend')) throw Errors.forbidden('Izin users.suspend diperlukan untuk menangguhkan akun', 'PERMISSION_DENIED', { missing: ['users.suspend'] });
  }
  const now = ctx.deps.clock.now();
  const out = await inAdminTx(ctx, async (tx) => {
    const [r] = await tx<{ status: string; subject_type: string; subject_id: string; assignee_id: string | null }[]>`
      SELECT status, subject_type, subject_id, assignee_id FROM risk_reviews WHERE id = ${id} FOR UPDATE`;
    if (!r) throw Errors.notFound('Review risiko', 'RISK_REVIEW_NOT_FOUND');
    if (!['OPEN', 'IN_REVIEW'].includes(r.status)) throw Errors.unprocessable('RISK_REVIEW_CLOSED', 'Review sudah diselesaikan', { status: r.status });
    await tx`UPDATE risk_reviews SET status = ${input.outcome}, notes = ${input.notes}, resolved_by = ${ctx.auth.userId}, resolved_at = ${now},
                    assignee_id = coalesce(assignee_id, ${ctx.auth.userId}) WHERE id = ${id}`;
    const who = await reviewUsers(tx, r.subject_type, r.subject_id);
    const effects: string[] = [];
    if (who.transactionId) {
      if (input.outcome === 'CLEARED') {
        const [open] = await tx<{ n: number }[]>`
          SELECT count(*)::int AS n FROM risk_reviews rv
           WHERE rv.status IN ('OPEN','IN_REVIEW') AND rv.id <> ${id}
             AND ((rv.subject_type = 'TRANSACTION' AND rv.subject_id = ${who.transactionId})
               OR (rv.subject_type = 'PAYMENT' AND rv.subject_id IN (SELECT id FROM payments WHERE transaction_id = ${who.transactionId}))
               OR (rv.subject_type = 'PURCHASE_PROOF' AND rv.subject_id IN (SELECT id FROM purchase_proofs WHERE transaction_id = ${who.transactionId})))`;
        const [t] = await tx<{ payout_hold_reason: string | null }[]>`SELECT payout_hold_reason FROM transactions WHERE id = ${who.transactionId} FOR UPDATE`;
        if ((open?.n ?? 0) === 0 && t?.payout_hold_reason && t.payout_hold_reason !== 'CONFIRMED_FRAUD') {
          await tx`UPDATE transactions SET payout_hold_reason = NULL WHERE id = ${who.transactionId}`;
          effects.push('TRANSACTION_PAYOUT_HOLD_CLEARED');
        }
      } else {
        await tx`UPDATE transactions SET payout_hold_reason = 'CONFIRMED_FRAUD' WHERE id = ${who.transactionId}`;
        const held = await tx`UPDATE payouts SET status = 'ON_HOLD', hold_reason = 'CONFIRMED_FRAUD', held_by = ${ctx.auth.userId}, held_at = ${now}, released_by = NULL, released_at = NULL
                               WHERE transaction_id = ${who.transactionId} AND status = 'SCHEDULED' RETURNING id`;
        effects.push('TRANSACTION_PAYOUT_HOLD_SET', ...held.map((h) => `PAYOUT_HELD:${h.id}`));
      }
    }
    if (r.subject_type === 'USER' && input.outcome === 'CONFIRMED_FRAUD') {
      const held = await tx`UPDATE payouts SET status = 'ON_HOLD', hold_reason = 'CONFIRMED_FRAUD', held_by = ${ctx.auth.userId}, held_at = ${now}, released_by = NULL, released_at = NULL
                             WHERE traveler_id = ${r.subject_id} AND status = 'SCHEDULED' RETURNING id`;
      effects.push(...held.map((h) => `PAYOUT_HELD:${h.id}`));
    }
    await emitEvent(tx, 'risk_review', id, 'risk.review_resolved', {
      reviewId: id,
      subjectType: r.subject_type,
      subjectId: r.subject_id,
      userId: who.userId,
      userIds: who.userIds,
      outcome: input.outcome,
      status: input.outcome,
    });
    await adminAudit(tx, ctx, { action: 'risk.review_resolved', entityType: 'risk_review', entityId: id, before: { status: r.status }, after: { status: input.outcome }, meta: { subjectType: r.subject_type, subjectId: r.subject_id, effects, notes: input.notes } });
    return { who, effects };
  });
  let suspension: unknown = null;
  if (input.suspendUser && out.who.userId) {
    try {
      suspension = await suspendUser(ctx, out.who.userId, `Fraud terkonfirmasi (review ${id}): ${input.notes}`.slice(0, 1000));
    } catch (err) {
      suspension = { error: err instanceof Error ? err.message : String(err) };
    }
  }
  return { id, status: input.outcome, userId: out.who.userId, effects: out.effects, suspension };
}

// ------------------------------------------------------------------ trust overrides

interface OverrideRow {
  id: string;
  user_id: string;
  previous_score: number;
  new_score: number;
  reason: string;
  valid_until: Date | null;
  requested_by: string;
  approved_by: string | null;
  rejected_by: string | null;
  status: string;
  decision_note: string | null;
  decided_at: Date | null;
  applied_at: Date | null;
  expires_at: Date;
  created_at: Date;
}

function overrideDto(o: OverrideRow, viewer: string) {
  return {
    id: o.id,
    userId: o.user_id,
    previousScore: o.previous_score,
    newScore: o.new_score,
    reason: o.reason,
    validUntil: iso(o.valid_until),
    requestedBy: o.requested_by,
    approvedBy: o.approved_by,
    rejectedBy: o.rejected_by,
    status: o.status,
    decisionNote: o.decision_note,
    decidedAt: iso(o.decided_at),
    appliedAt: iso(o.applied_at),
    expiresAt: iso(o.expires_at)!,
    createdAt: iso(o.created_at)!,
    canApprove: o.status === 'PENDING' && o.requested_by !== viewer && o.user_id !== viewer,
  };
}

export async function listOverrides(ctx: AdminCtx, status?: string) {
  const r = await ctx.deps.sql<OverrideRow[]>`
    SELECT * FROM trust_score_overrides ${status ? ctx.deps.sql`WHERE status = ${status}` : ctx.deps.sql``} ORDER BY created_at DESC LIMIT 200`;
  return { data: r.map((o) => overrideDto(o, ctx.auth.userId)), nextCursor: null };
}

export async function requestOverride(ctx: AdminCtx, input: { userId: string; newScore: number; reason: string; validUntil?: string | undefined }) {
  if (input.userId === ctx.auth.userId) throw Errors.forbidden('Tidak dapat mengubah Trust Score sendiri', 'MAKER_CHECKER_VIOLATION');
  const row = await inAdminTx(ctx, async (tx) => {
    const [u] = await tx<{ trust_score: number; ts: number | null }[]>`
      SELECT u.trust_score, (SELECT score FROM trust_scores WHERE user_id = u.id) AS ts FROM users u WHERE u.id = ${input.userId}`;
    if (!u) throw Errors.notFound('Pengguna', 'USER_NOT_FOUND');
    const [pending] = await tx<{ id: string }[]>`SELECT id FROM trust_score_overrides WHERE user_id = ${input.userId} AND status = 'PENDING'`;
    if (pending) throw Errors.conflict('TRUST_OVERRIDE_PENDING', 'Sudah ada override yang menunggu persetujuan', { id: pending.id });
    const previous = u.ts ?? u.trust_score;
    const [o] = await tx<OverrideRow[]>`
      INSERT INTO trust_score_overrides (user_id, previous_score, new_score, reason, valid_until, requested_by, expires_at)
      VALUES (${input.userId}, ${previous}, ${input.newScore}, ${input.reason}, ${input.validUntil ? new Date(input.validUntil) : null}, ${ctx.auth.userId},
              ${new Date(ctx.deps.clock.now().getTime() + 72 * 3600_000)})
      RETURNING *`;
    await adminAudit(tx, ctx, { action: 'trust.override_requested', entityType: 'user', entityId: input.userId, before: { score: previous }, after: { requestedScore: input.newScore, status: 'PENDING' }, meta: { overrideId: o!.id, reason: input.reason, validUntil: input.validUntil ?? null } });
    return o!;
  });
  return overrideDto(row, ctx.auth.userId);
}

export async function approveOverride(ctx: AdminCtx, id: string, note?: string) {
  const now = ctx.deps.clock.now();
  const out = await inAdminTx(ctx, async (tx) => {
    const [o] = await tx<OverrideRow[]>`SELECT * FROM trust_score_overrides WHERE id = ${id} FOR UPDATE`;
    if (!o) throw Errors.notFound('Override', 'TRUST_OVERRIDE_NOT_FOUND');
    if (o.requested_by === ctx.auth.userId || o.user_id === ctx.auth.userId) {
      throw Errors.forbidden('Penyetuju harus berbeda dari pengaju dan pemilik skor', 'MAKER_CHECKER_VIOLATION');
    }
    if (o.status !== 'PENDING') throw Errors.unprocessable('TRUST_OVERRIDE_NOT_PENDING', 'Override tidak menunggu persetujuan', { status: o.status });
    if (o.expires_at <= now) throw Errors.unprocessable('TRUST_OVERRIDE_EXPIRED', 'Override sudah kedaluwarsa (72 jam)');
    await tx`UPDATE trust_score_overrides SET status = 'APPROVED', approved_by = ${ctx.auth.userId}, decision_note = ${note ?? null}, decided_at = ${now} WHERE id = ${id}`;
    const [ts] = await tx<{ score: number }[]>`SELECT score FROM apply_trust_score_override(${id}, ${ctx.auth.userId})`;
    await adminAudit(tx, ctx, { action: 'trust.override_approved', entityType: 'user', entityId: o.user_id, before: { score: o.previous_score }, after: { score: ts!.score }, meta: { overrideId: id, requestedBy: o.requested_by, note: note ?? null } });
    return { userId: o.user_id, score: ts!.score };
  });
  return { id, status: 'APPLIED', ...out };
}

export async function rejectOverride(ctx: AdminCtx, id: string, note: string) {
  const now = ctx.deps.clock.now();
  await inAdminTx(ctx, async (tx) => {
    const [o] = await tx<OverrideRow[]>`SELECT * FROM trust_score_overrides WHERE id = ${id} FOR UPDATE`;
    if (!o) throw Errors.notFound('Override', 'TRUST_OVERRIDE_NOT_FOUND');
    if (o.status !== 'PENDING') throw Errors.unprocessable('TRUST_OVERRIDE_NOT_PENDING', 'Override tidak menunggu persetujuan', { status: o.status });
    await tx`UPDATE trust_score_overrides SET status = 'REJECTED', rejected_by = ${ctx.auth.userId}, decision_note = ${note}, decided_at = ${now} WHERE id = ${id}`;
    await adminAudit(tx, ctx, { action: 'trust.override_rejected', entityType: 'user', entityId: o.user_id, meta: { overrideId: id, note } });
  });
  return { id, status: 'REJECTED' };
}

export function isSuperAdmin(ctx: AdminCtx): boolean {
  return hasRole(ctx.auth, 'SUPER_ADMIN');
}
