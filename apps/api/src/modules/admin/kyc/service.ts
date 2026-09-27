/**
 * Admin · KYC review (§15.4): queue, detail (document metadata + authenticated streaming via the identity files
 * route GET /v1/files/{id}/content — access requires kyc.review and every view is audited there), approve/reject
 * through the core kycSubmissionFsm guards, level recompute (identity's recomputeKycLevel), kyc.approved/rejected
 * events. Payout-account verification override (VERIFIED / FAILED, reason required).
 */
import { kycSubmissionFsm } from '@jastipkita/core';
import type { Db } from '../../../db/sql';
import { AppError, Errors } from '../../../lib/errors';
import { emitEvent } from '../../../services/outbox';
import { recomputeKycLevel } from '../../kyc/level';
import { type AdminCtx, adminAudit, decodeKey, encodeKey, inAdminTx, iso, maskName, numOrNull, parseCsv } from '../common';

const STATUSES = ['PENDING', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'EXPIRED'] as const;

interface SubmissionRow {
  id: string;
  user_id: string;
  target_level: number;
  id_type: string | null;
  status: (typeof STATUSES)[number];
  provider: string;
  provider_env: string;
  provider_result: Record<string, unknown>;
  liveness_score: string | null;
  face_match_score: string | null;
  risk_flags: unknown;
  submitted_at: Date | null;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  decision_reason: string | null;
  rejection_code: string | null;
  created_at: Date;
  display_name?: string | null;
  kyc_level?: number;
}

function summary(s: SubmissionRow, now: Date) {
  return {
    id: s.id,
    userId: s.user_id,
    userDisplayName: maskName(s.display_name ?? null),
    userKycLevel: s.kyc_level ?? null,
    targetLevel: s.target_level,
    idType: s.id_type,
    status: s.status,
    provider: s.provider,
    providerEnv: s.provider_env,
    livenessScore: numOrNull(s.liveness_score),
    faceMatchScore: numOrNull(s.face_match_score),
    riskFlags: s.risk_flags,
    providerResult: s.provider_result,
    submittedAt: iso(s.submitted_at ?? s.created_at)!,
    waitingHours: Math.round(((now.getTime() - (s.submitted_at ?? s.created_at).getTime()) / 3600_000) * 10) / 10,
    reviewedBy: s.reviewed_by,
    reviewedAt: iso(s.reviewed_at),
    decisionReason: s.decision_reason,
    rejectionCode: s.rejection_code,
  };
}

export async function kycQueue(ctx: AdminCtx, q: { status?: string | undefined; limit: number; cursor?: string | undefined }) {
  const db = ctx.deps.sql;
  const statuses = parseCsv(q.status, STATUSES, 'status') ?? ['PENDING', 'IN_REVIEW'];
  const cursor = decodeKey(q.cursor);
  const r = await db<SubmissionRow[]>`
    SELECT s.*, u.display_name, u.kyc_level FROM kyc_submissions s JOIN users u ON u.id = s.user_id
     WHERE s.status = ANY(${statuses}::text[])
       ${cursor ? db`AND (s.created_at, s.id) > (${cursor.t}::timestamptz, ${cursor.id}::uuid)` : db``}
     ORDER BY s.created_at, s.id LIMIT ${q.limit + 1}`;
  const now = ctx.deps.clock.now();
  const more = r.length > q.limit;
  const data = r.slice(0, q.limit);
  const last = data[data.length - 1];
  return { data: data.map((s) => summary(s, now)), nextCursor: more && last ? encodeKey({ t: last.created_at.toISOString(), id: last.id }) : null };
}

async function loadSubmission(db: Db, id: string, forUpdate = false): Promise<SubmissionRow> {
  const [s] = forUpdate
    ? await db<SubmissionRow[]>`SELECT * FROM kyc_submissions WHERE id = ${id} FOR UPDATE`
    : await db<SubmissionRow[]>`SELECT s.*, u.display_name, u.kyc_level FROM kyc_submissions s JOIN users u ON u.id = s.user_id WHERE s.id = ${id}`;
  if (!s) throw Errors.notFound('Pengajuan KYC', 'KYC_SUBMISSION_NOT_FOUND');
  return s;
}

export async function kycDetail(ctx: AdminCtx, id: string) {
  const db = ctx.deps.sql;
  const s = await loadSubmission(db, id);
  const docs = await db<{ id: string; type: string; side: string; status: string; file_id: string | null; mime: string | null; size_bytes: number | null; scan_status: string | null; purged_at: Date | null }[]>`
    SELECT d.id, d.type, d.side, d.status, d.file_id, f.mime, f.size_bytes, f.scan_status, d.purged_at
      FROM kyc_documents d LEFT JOIN files f ON f.id = d.file_id WHERE d.submission_id = ${id} ORDER BY d.created_at, d.id`;
  const [rec] = await db<{ id: string; id_type: string; nationality: string | null; id_number_enc: Buffer; full_name_enc: Buffer; verified_at: Date | null }[]>`
    SELECT id, id_type, nationality, id_number_enc, full_name_enc, verified_at FROM identity_records WHERE user_id = ${s.user_id}`;
  let identity: Record<string, unknown> | null = null;
  if (rec) {
    let last4: string | null = null;
    let name: string | null = null;
    try {
      const n = await ctx.deps.crypto.decryptString(new Uint8Array(rec.id_number_enc), `identity_records.id_number:${rec.id}`);
      last4 = n.slice(-4);
      name = maskName(await ctx.deps.crypto.decryptString(new Uint8Array(rec.full_name_enc), `identity_records.full_name:${rec.id}`));
    } catch {
      last4 = null;
    }
    identity = { idType: rec.id_type, nationality: rec.nationality, idNumberMasked: last4 ? `••••••••${last4}` : null, fullNameMasked: name, verifiedAt: iso(rec.verified_at) };
  }
  const history = await db<{ id: string; status: string; created_at: Date; decision_reason: string | null }[]>`
    SELECT id, status, created_at, decision_reason FROM kyc_submissions WHERE user_id = ${s.user_id} AND id <> ${id} ORDER BY created_at DESC LIMIT 10`;
  const [flags] = await db<{ phone: boolean; dup_events: number }[]>`
    SELECT (u.phone_verified_at IS NOT NULL) AS phone,
           (SELECT count(*) FROM security_events WHERE user_id = u.id AND type = 'KYC_DUPLICATE_IDENTITY')::int AS dup_events
      FROM users u WHERE u.id = ${s.user_id}`;
  await inAdminTx(ctx, async (tx) => {
    await adminAudit(tx, ctx, { action: 'kyc.submission_viewed', entityType: 'kyc_submission', entityId: id, meta: { userId: s.user_id } });
  });
  return {
    ...summary(s, ctx.deps.clock.now()),
    documents: docs.map((d) => ({
      id: d.id,
      type: d.type,
      side: d.side,
      status: d.status,
      fileId: d.file_id,
      mime: d.mime,
      sizeBytes: d.size_bytes,
      scanStatus: d.scan_status,
      purged: !!d.purged_at,
      content: d.file_id ? { url: `${ctx.deps.env.API_BASE_URL}/v1/files/${d.file_id}/content`, method: 'GET', requiresAuth: true, audited: true } : null,
    })),
    identity,
    checks: { phoneVerified: !!flags?.phone, duplicateIdentityEvents: flags?.dup_events ?? 0, notDuplicate: true },
    previousSubmissions: history.map((h) => ({ id: h.id, status: h.status, createdAt: iso(h.created_at)!, decisionReason: h.decision_reason })),
    allowedActions: s.status === 'PENDING' || s.status === 'IN_REVIEW' ? ['APPROVE', 'REJECT'] : [],
  };
}

function fsmError(code: string, message: string): AppError {
  return new AppError(422, code, message);
}

export async function approveKyc(ctx: AdminCtx, id: string, input: { livenessPassed: boolean; documentMatches: boolean; note?: string | undefined }) {
  const now = ctx.deps.clock.now();
  const out = await inAdminTx(ctx, async (tx) => {
    const s = await loadSubmission(tx, id, true);
    if (s.user_id === ctx.auth.userId) throw Errors.forbidden('Tidak dapat meninjau KYC milik sendiri', 'MAKER_CHECKER_VIOLATION');
    let status = s.status;
    if (status === 'PENDING') {
      kycSubmissionFsm.assertTransition('PENDING', 'IN_REVIEW', 'ADMIN', {});
      await tx`UPDATE kyc_submissions SET status = 'IN_REVIEW' WHERE id = ${id}`;
      status = 'IN_REVIEW';
    }
    const [dup] = await tx<{ n: number }[]>`
      SELECT count(*)::int AS n FROM identity_records a JOIN identity_records b ON a.id_number_hash = b.id_number_hash AND a.user_id <> b.user_id
       WHERE a.user_id = ${s.user_id}`;
    const check = kycSubmissionFsm.canTransition(status, 'APPROVED', 'ADMIN', {
      livenessPassed: input.livenessPassed,
      documentMatches: input.documentMatches,
      notDuplicate: (dup?.n ?? 0) === 0,
    });
    if (!check.ok) throw fsmError(check.code === 'INVALID_TRANSITION' ? 'KYC_NOT_REVIEWABLE' : check.code, check.code === 'INVALID_TRANSITION' ? 'Pengajuan ini tidak dapat disetujui pada status saat ini' : `Pemeriksaan KYC belum lolos: ${check.message}`);
    await tx`UPDATE kyc_submissions SET status = 'APPROVED', reviewed_by = ${ctx.auth.userId}, reviewed_at = ${now},
                    decision_reason = ${input.note ?? 'APPROVED_BY_ADMIN'} WHERE id = ${id}`;
    await tx`UPDATE identity_records SET verified_at = ${now} WHERE user_id = ${s.user_id}`;
    await tx`UPDATE kyc_documents SET status = 'ACCEPTED' WHERE submission_id = ${id} AND status = 'PENDING'`;
    await emitEvent(tx, 'kyc_submission', id, 'kyc.approved', { userId: s.user_id, submissionId: id, targetLevel: s.target_level, reviewedBy: 'ADMIN' });
    const level = await recomputeKycLevel(ctx.deps, tx, s.user_id, 'kyc.approved.admin');
    await adminAudit(tx, ctx, {
      action: 'kyc.approved',
      entityType: 'kyc_submission',
      entityId: id,
      before: { status: s.status },
      after: { status: 'APPROVED' },
      meta: { userId: s.user_id, checks: { livenessPassed: input.livenessPassed, documentMatches: input.documentMatches }, note: input.note ?? null, level: { from: level.from, to: level.to } },
    });
    return { userId: s.user_id, kycLevel: level.to };
  });
  return { id, status: 'APPROVED', ...out };
}

export async function rejectKyc(ctx: AdminCtx, id: string, input: { reason: string; code?: string | undefined }) {
  const now = ctx.deps.clock.now();
  const code = input.code ?? 'REJECTED_BY_ADMIN';
  await inAdminTx(ctx, async (tx) => {
    const s = await loadSubmission(tx, id, true);
    if (s.user_id === ctx.auth.userId) throw Errors.forbidden('Tidak dapat meninjau KYC milik sendiri', 'MAKER_CHECKER_VIOLATION');
    let status = s.status;
    if (status === 'PENDING') {
      kycSubmissionFsm.assertTransition('PENDING', 'IN_REVIEW', 'ADMIN', {});
      await tx`UPDATE kyc_submissions SET status = 'IN_REVIEW' WHERE id = ${id}`;
      status = 'IN_REVIEW';
    }
    const check = kycSubmissionFsm.canTransition(status, 'REJECTED', 'ADMIN', { reason: input.reason });
    if (!check.ok) throw fsmError('KYC_NOT_REVIEWABLE', 'Pengajuan ini tidak dapat ditolak pada status saat ini');
    await tx`UPDATE kyc_submissions SET status = 'REJECTED', reviewed_by = ${ctx.auth.userId}, reviewed_at = ${now},
                    decision_reason = ${input.reason.slice(0, 500)}, rejection_code = ${code.slice(0, 60)} WHERE id = ${id}`;
    await tx`UPDATE kyc_documents SET status = 'REJECTED' WHERE submission_id = ${id} AND status = 'PENDING'`;
    await emitEvent(tx, 'kyc_submission', id, 'kyc.rejected', { userId: s.user_id, submissionId: id, targetLevel: s.target_level, reason: input.reason.slice(0, 300) });
    await adminAudit(tx, ctx, { action: 'kyc.rejected', entityType: 'kyc_submission', entityId: id, before: { status: s.status }, after: { status: 'REJECTED', rejectionCode: code }, meta: { userId: s.user_id, reason: input.reason } });
  });
  return { id, status: 'REJECTED', rejectionCode: code };
}

export async function payoutAccountQueue(ctx: AdminCtx) {
  const r = await ctx.deps.sql<{ id: string; user_id: string; bank_code: string; account_mask: string; verification_status: string; created_at: Date; display_name: string | null }[]>`
    SELECT pa.id, pa.user_id, pa.bank_code, pa.account_mask, pa.verification_status, pa.created_at, u.display_name
      FROM payout_accounts pa JOIN users u ON u.id = pa.user_id
     WHERE pa.disabled_at IS NULL AND pa.verification_status IN ('UNVERIFIED','PENDING','FAILED','NAME_MISMATCH')
     ORDER BY pa.created_at LIMIT 200`;
  return {
    data: r.map((p) => ({ id: p.id, userId: p.user_id, userDisplayName: maskName(p.display_name), bankCode: p.bank_code, accountMask: p.account_mask, verificationStatus: p.verification_status, createdAt: iso(p.created_at)! })),
    nextCursor: null,
  };
}

export async function overridePayoutAccount(ctx: AdminCtx, id: string, input: { status: 'VERIFIED' | 'FAILED'; reason: string }) {
  const now = ctx.deps.clock.now();
  const out = await inAdminTx(ctx, async (tx) => {
    const [p] = await tx<{ id: string; user_id: string; verification_status: string; disabled_at: Date | null; account_number_enc: Buffer | null }[]>`
      SELECT id, user_id, verification_status, disabled_at, account_number_enc FROM payout_accounts WHERE id = ${id} FOR UPDATE`;
    if (!p) throw Errors.notFound('Rekening payout', 'PAYOUT_ACCOUNT_NOT_FOUND');
    if (p.disabled_at || !p.account_number_enc) throw Errors.unprocessable('PAYOUT_ACCOUNT_DISABLED', 'Rekening sudah dinonaktifkan');
    if (p.user_id === ctx.auth.userId) throw Errors.forbidden('Tidak dapat memverifikasi rekening sendiri', 'MAKER_CHECKER_VIOLATION');
    if (p.verification_status === input.status) throw Errors.conflict('NO_CHANGE', `Rekening sudah ${input.status}`);
    let level: { from: number; to: number } | null = null;
    if (input.status === 'VERIFIED') {
      const [def] = await tx`SELECT 1 FROM payout_accounts WHERE user_id = ${p.user_id} AND is_default AND disabled_at IS NULL AND id <> ${id}`;
      await tx`UPDATE payout_accounts SET verification_status = 'VERIFIED', verified_at = ${now}, verification_ref = ${`ADMIN_OVERRIDE:${ctx.auth.userId}`},
                      is_default = ${!def} WHERE id = ${id}`;
      await emitEvent(tx, 'payout_account', id, 'payout_account.verified', { userId: p.user_id, payoutAccountId: id, source: 'ADMIN_OVERRIDE' });
      const l = await recomputeKycLevel(ctx.deps, tx, p.user_id, 'payout_account.verified.admin');
      level = { from: l.from, to: l.to };
    } else {
      await tx`UPDATE payout_accounts SET verification_status = 'FAILED', verified_at = NULL, is_default = false, verification_ref = ${`ADMIN_OVERRIDE:${ctx.auth.userId}`} WHERE id = ${id}`;
    }
    await adminAudit(tx, ctx, {
      action: 'kyc.payout_account_override',
      entityType: 'payout_account',
      entityId: id,
      before: { verificationStatus: p.verification_status },
      after: { verificationStatus: input.status },
      meta: { userId: p.user_id, reason: input.reason, level },
    });
    return { userId: p.user_id, level };
  });
  return { id, verificationStatus: input.status, ...out };
}
