/**
 * Admin · Refund approvals & payouts.
 *   Refunds (§15.6): approval queue (PENDING_APPROVAL); approve/reject via refunds/service (approveRefund /
 *   rejectRefund) with maker-checker approver ≠ requester (checked here → 403, and by the core FSM + DB CHECK).
 *   Payouts (§15.7): list, hold (reason, holder recorded), release (ON_HOLD → SCHEDULED, approver recorded and ≠
 *   holder), retry FAILED → SCHEDULED. Releasing clears transactions.payout_hold_reason when no risk review is open.
 */
import { payoutFsm } from '@jastipkita/core';
import { AppError, Errors } from '../../../lib/errors';
import { emitEvent } from '../../../services/outbox';
import { approveRefund, processRefunds, rejectRefund } from '../../refunds/service';
import { type AdminCtx, adminAudit, decodeKey, encodeKey, inAdminTx, iso, makerChecker, maskName, num, parseCsv } from '../common';

const REFUND_STATUSES = ['REQUESTED', 'PENDING_APPROVAL', 'APPROVED', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'REJECTED', 'CANCELLED'] as const;
const PAYOUT_STATUSES = ['SCHEDULED', 'ON_HOLD', 'PROCESSING', 'PAID', 'FAILED', 'CANCELLED'] as const;

export async function listRefunds(ctx: AdminCtx, q: { status?: string | undefined; limit: number; cursor?: string | undefined }) {
  const db = ctx.deps.sql;
  const statuses = parseCsv(q.status, REFUND_STATUSES, 'status') ?? ['PENDING_APPROVAL'];
  const cursor = decodeKey(q.cursor);
  const now = ctx.deps.clock.now();
  const r = await db<Record<string, unknown>[]>`
    SELECT r.id, r.number, r.transaction_id, r.payment_id, r.reason_code, r.reason_note, r.amount_idr, r.type, r.status, r.requested_by,
           r.approved_by, r.failure_reason, r.attempts, r.breakdown->>'method' AS method, r.created_at, t.number AS tx_number, t.status AS tx_status,
           p.channel, p.provider_env
      FROM refunds r JOIN transactions t ON t.id = r.transaction_id JOIN payments p ON p.id = r.payment_id
     WHERE r.status = ANY(${statuses}::text[])
       ${cursor ? db`AND (r.created_at, r.id) > (${cursor.t}::timestamptz, ${cursor.id}::uuid)` : db``}
     ORDER BY r.created_at, r.id LIMIT ${q.limit + 1}`;
  const more = r.length > q.limit;
  const data = r.slice(0, q.limit).map((x) => ({
    id: String(x.id),
    number: String(x.number),
    transactionId: String(x.transaction_id),
    transactionNumber: String(x.tx_number),
    transactionStatus: String(x.tx_status),
    paymentId: String(x.payment_id),
    channel: (x.channel as string | null) ?? null,
    sandbox: x.provider_env !== 'LIVE',
    reasonCode: String(x.reason_code),
    reasonNote: (x.reason_note as string | null) ?? null,
    amountIdr: num(x.amount_idr),
    type: String(x.type),
    status: String(x.status),
    method: (x.method as string | null) ?? 'PROVIDER_REFUND',
    requestedBy: (x.requested_by as string | null) ?? null,
    approvedBy: (x.approved_by as string | null) ?? null,
    canApprove: x.status === 'PENDING_APPROVAL' && x.requested_by !== ctx.auth.userId,
    failureReason: (x.failure_reason as string | null) ?? null,
    attempts: num(x.attempts),
    waitingHours: Math.round(((now.getTime() - (x.created_at as Date).getTime()) / 3600_000) * 10) / 10,
    createdAt: iso(x.created_at as Date)!,
  }));
  const last = data[data.length - 1];
  return { data, nextCursor: more && last ? encodeKey({ t: last.createdAt, id: last.id }) : null };
}

async function refundHead(ctx: AdminCtx, id: string) {
  const [r] = await ctx.deps.sql<{ id: string; transaction_id: string; requested_by: string | null; status: string; amount_idr: number }[]>`
    SELECT id, transaction_id, requested_by, status, amount_idr FROM refunds WHERE id = ${id}`;
  if (!r) throw Errors.notFound('Refund', 'REFUND_NOT_FOUND');
  return r;
}

export async function approveRefundAdmin(ctx: AdminCtx, id: string) {
  const r = await refundHead(ctx, id);
  makerChecker(r.requested_by, ctx.auth.userId, 'Refund harus disetujui oleh admin yang berbeda dari pengaju (maker-checker)');
  if (r.status !== 'PENDING_APPROVAL') throw Errors.unprocessable('REFUND_NOT_PENDING_APPROVAL', 'Refund tidak menunggu persetujuan', { status: r.status });
  const row = await approveRefund(ctx.deps, id, ctx.auth.userId);
  const processed = await processRefunds(ctx.deps, { transactionId: r.transaction_id });
  const [fresh] = await ctx.deps.sql<{ status: string }[]>`SELECT status FROM refunds WHERE id = ${id}`;
  return { id, status: fresh?.status ?? row.status, approvedBy: ctx.auth.userId, processed };
}

export async function rejectRefundAdmin(ctx: AdminCtx, id: string, reason: string) {
  const r = await refundHead(ctx, id);
  const row = await rejectRefund(ctx.deps, id, ctx.auth.userId, reason);
  const [open] = await ctx.deps.sql<{ tx_status: string; open: number }[]>`
    SELECT t.status AS tx_status, (SELECT count(*) FROM refunds x WHERE x.transaction_id = t.id AND x.status IN ('REQUESTED','PENDING_APPROVAL','APPROVED','PROCESSING','FAILED'))::int AS open
      FROM transactions t WHERE t.id = ${r.transaction_id}`;
  return {
    id,
    status: row.status,
    transactionFollowUp: open?.tx_status === 'REFUND_PENDING' && open.open === 0 ? 'REVIEW_REQUIRED' : 'NONE',
    note: open?.tx_status === 'REFUND_PENDING' && open.open === 0 ? 'Transaksi REFUND_PENDING tanpa refund aktif; ajukan refund baru atau tindak lanjuti.' : null,
  };
}

// ------------------------------------------------------------------ payouts

export async function listPayouts(ctx: AdminCtx, q: { status?: string | undefined; travelerId?: string | undefined; limit: number; cursor?: string | undefined }) {
  const db = ctx.deps.sql;
  const statuses = parseCsv(q.status, PAYOUT_STATUSES, 'status');
  const cursor = decodeKey(q.cursor);
  const r = await db<Record<string, unknown>[]>`
    SELECT p.id, p.number, p.traveler_id, p.transaction_id, p.amount_idr, p.fee_idr, p.net_idr, p.status, p.hold_reason, p.held_by, p.held_at,
           p.released_by, p.released_at, p.approved_by, p.scheduled_for, p.paid_at, p.provider, p.provider_env, p.failure_reason, p.attempts, p.created_at,
           a.bank_code, a.account_mask, a.verification_status, t.number AS tx_number, t.payout_hold_reason, u.display_name
      FROM payouts p JOIN payout_accounts a ON a.id = p.payout_account_id JOIN users u ON u.id = p.traveler_id
      LEFT JOIN transactions t ON t.id = p.transaction_id
     WHERE true
       ${statuses ? db`AND p.status = ANY(${statuses}::text[])` : db``}
       ${q.travelerId ? db`AND p.traveler_id = ${q.travelerId}` : db``}
       ${cursor ? db`AND (p.created_at, p.id) < (${cursor.t}::timestamptz, ${cursor.id}::uuid)` : db``}
     ORDER BY p.created_at DESC, p.id DESC LIMIT ${q.limit + 1}`;
  const more = r.length > q.limit;
  const data = r.slice(0, q.limit).map((p) => ({
    id: String(p.id),
    number: String(p.number),
    travelerId: String(p.traveler_id),
    travelerDisplayName: maskName(p.display_name as string | null),
    transactionId: (p.transaction_id as string | null) ?? null,
    transactionNumber: (p.tx_number as string | null) ?? null,
    amountIdr: num(p.amount_idr),
    feeIdr: num(p.fee_idr),
    netIdr: num(p.net_idr),
    status: String(p.status),
    holdReason: (p.hold_reason as string | null) ?? null,
    heldBy: (p.held_by as string | null) ?? null,
    heldAt: iso(p.held_at as Date | null),
    releasedBy: (p.released_by as string | null) ?? null,
    releasedAt: iso(p.released_at as Date | null),
    transactionHoldReason: (p.payout_hold_reason as string | null) ?? null,
    scheduledFor: iso(p.scheduled_for as Date),
    paidAt: iso(p.paid_at as Date | null),
    provider: String(p.provider),
    sandbox: p.provider_env !== 'LIVE',
    failureReason: (p.failure_reason as string | null) ?? null,
    attempts: num(p.attempts),
    destination: { bankCode: String(p.bank_code), accountMask: String(p.account_mask), verificationStatus: String(p.verification_status) },
    canRelease: p.status === 'ON_HOLD' && p.held_by !== ctx.auth.userId,
    createdAt: iso(p.created_at as Date)!,
  }));
  const last = data[data.length - 1];
  return { data, nextCursor: more && last ? encodeKey({ t: last.createdAt, id: last.id }) : null };
}

interface PayoutLock {
  id: string;
  number: string;
  status: 'SCHEDULED' | 'ON_HOLD' | 'PROCESSING' | 'PAID' | 'FAILED' | 'CANCELLED';
  traveler_id: string;
  transaction_id: string | null;
  amount_idr: number;
  hold_reason: string | null;
  held_by: string | null;
  scheduled_for: Date;
}

export async function holdPayout(ctx: AdminCtx, id: string, reason: string) {
  const now = ctx.deps.clock.now();
  await inAdminTx(ctx, async (tx) => {
    const [p] = await tx<PayoutLock[]>`SELECT id, number, status, traveler_id, transaction_id, amount_idr, hold_reason, held_by, scheduled_for FROM payouts WHERE id = ${id} FOR UPDATE`;
    if (!p) throw Errors.notFound('Payout', 'PAYOUT_NOT_FOUND');
    const check = payoutFsm.canTransition(p.status, 'ON_HOLD', 'ADMIN', { reason });
    if (!check.ok) throw new AppError(422, 'PAYOUT_TRANSITION_NOT_ALLOWED', 'Payout tidak dapat ditahan pada status ini', { status: p.status, reason: check.code });
    await tx`UPDATE payouts SET status = 'ON_HOLD', hold_reason = ${`ADMIN_HOLD: ${reason}`.slice(0, 500)}, held_by = ${ctx.auth.userId}, held_at = ${now},
                    released_by = NULL, released_at = NULL WHERE id = ${id}`;
    await emitEvent(tx, 'payout', id, 'payout.on_hold', { payoutId: id, payoutNumber: p.number, travelerId: p.traveler_id, transactionId: p.transaction_id, amountIdr: num(p.amount_idr), reason: 'ADMIN_HOLD' });
    await adminAudit(tx, ctx, { action: 'payouts.held', entityType: 'payout', entityId: id, before: { status: p.status }, after: { status: 'ON_HOLD' }, meta: { reason } });
  });
  return { id, status: 'ON_HOLD', heldBy: ctx.auth.userId };
}

export async function releasePayout(ctx: AdminCtx, id: string, note: string) {
  const now = ctx.deps.clock.now();
  const out = await inAdminTx(ctx, async (tx) => {
    const [p] = await tx<PayoutLock[]>`SELECT id, number, status, traveler_id, transaction_id, amount_idr, hold_reason, held_by, scheduled_for FROM payouts WHERE id = ${id} FOR UPDATE`;
    if (!p) throw Errors.notFound('Payout', 'PAYOUT_NOT_FOUND');
    makerChecker(p.held_by, ctx.auth.userId, 'Pelepasan hold harus oleh admin yang berbeda dari yang menahan (maker-checker)');
    const check = payoutFsm.canTransition(p.status, 'SCHEDULED', 'ADMIN', { holdReleasedBy: ctx.auth.userId });
    if (!check.ok) throw new AppError(422, 'PAYOUT_TRANSITION_NOT_ALLOWED', 'Payout tidak sedang ditahan', { status: p.status, reason: check.code });
    let clearedTxHold = false;
    const warnings: string[] = [];
    if (p.transaction_id) {
      const reviews = await tx<{ id: string }[]>`
        SELECT rv.id FROM risk_reviews rv
         WHERE rv.status IN ('OPEN','IN_REVIEW')
           AND ((rv.subject_type = 'TRANSACTION' AND rv.subject_id = ${p.transaction_id})
             OR (rv.subject_type = 'PAYMENT' AND rv.subject_id IN (SELECT id FROM payments WHERE transaction_id = ${p.transaction_id}))
             OR (rv.subject_type = 'PURCHASE_PROOF' AND rv.subject_id IN (SELECT id FROM purchase_proofs WHERE transaction_id = ${p.transaction_id})))`;
      if (reviews.length) throw Errors.unprocessable('RISK_REVIEW_OPEN', 'Selesaikan review risiko transaksi ini terlebih dahulu', { reviewIds: reviews.map((x) => x.id) });
      const [t] = await tx<{ payout_hold_reason: string | null }[]>`SELECT payout_hold_reason FROM transactions WHERE id = ${p.transaction_id} FOR UPDATE`;
      if (t?.payout_hold_reason) {
        await tx`UPDATE transactions SET payout_hold_reason = NULL WHERE id = ${p.transaction_id}`;
        clearedTxHold = true;
      }
      const [dispute] = await tx`SELECT 1 FROM disputes WHERE transaction_id = ${p.transaction_id} AND status <> 'CLOSED'`;
      if (dispute) warnings.push('DISPUTE_NOT_CLOSED: processor akan menahan kembali sampai dispute ditutup');
    }
    const scheduledFor = p.scheduled_for > now ? p.scheduled_for : now;
    await tx`UPDATE payouts SET status = 'SCHEDULED', hold_reason = NULL, approved_by = ${ctx.auth.userId}, released_by = ${ctx.auth.userId},
                    released_at = ${now}, scheduled_for = ${scheduledFor} WHERE id = ${id}`;
    await emitEvent(tx, 'payout', id, 'payout.scheduled', { payoutId: id, payoutNumber: p.number, travelerId: p.traveler_id, transactionId: p.transaction_id, amountIdr: num(p.amount_idr), scheduledFor: scheduledFor.toISOString(), kind: 'HOLD_RELEASED' });
    await adminAudit(tx, ctx, {
      action: 'payouts.released',
      entityType: 'payout',
      entityId: id,
      before: { status: 'ON_HOLD', holdReason: p.hold_reason, heldBy: p.held_by },
      after: { status: 'SCHEDULED', releasedBy: ctx.auth.userId },
      meta: { note, clearedTransactionHold: clearedTxHold },
    });
    return { clearedTxHold, warnings };
  });
  return { id, status: 'SCHEDULED', releasedBy: ctx.auth.userId, clearedTransactionHold: out.clearedTxHold, warnings: out.warnings };
}

export async function retryPayout(ctx: AdminCtx, id: string, note: string) {
  const now = ctx.deps.clock.now();
  await inAdminTx(ctx, async (tx) => {
    const [p] = await tx<PayoutLock[]>`SELECT id, number, status, traveler_id, transaction_id, amount_idr, hold_reason, held_by, scheduled_for FROM payouts WHERE id = ${id} FOR UPDATE`;
    if (!p) throw Errors.notFound('Payout', 'PAYOUT_NOT_FOUND');
    const check = payoutFsm.canTransition(p.status, 'SCHEDULED', 'ADMIN', {});
    if (p.status !== 'FAILED' || !check.ok) throw Errors.unprocessable('PAYOUT_NOT_FAILED', 'Hanya payout FAILED yang dapat dicoba ulang', { status: p.status });
    await tx`UPDATE payouts SET status = 'SCHEDULED', scheduled_for = ${now}, attempts = 0 WHERE id = ${id}`;
    await adminAudit(tx, ctx, { action: 'payouts.retried', entityType: 'payout', entityId: id, before: { status: 'FAILED' }, after: { status: 'SCHEDULED' }, meta: { note } });
  });
  return { id, status: 'SCHEDULED' };
}

// ------------------------------------------------------------------ refund destinations (SEC-12)

const DESTINATION_STATUSES = ['PENDING_REVIEW', 'VALID', 'REJECTED'] as const;

/** Refund destinations whose bank holder name differs from the buyer's verified identity (default PENDING_REVIEW). */
export async function listRefundDestinations(ctx: AdminCtx, q: { status?: string | undefined }) {
  const statuses = parseCsv(q.status, DESTINATION_STATUSES, 'status') ?? ['PENDING_REVIEW'];
  const rows = await ctx.deps.sql<
    { id: string; refund_id: string; buyer_id: string; bank_code: string; account_mask: string; validation_status: string; name_match: string | null; created_at: Date; amount_idr: string; refund_number: string | null; transaction_id: string; display_name: string | null }[]
  >`
    SELECT d.id, d.refund_id, d.buyer_id, d.bank_code, d.account_mask, d.validation_status, d.name_match, d.created_at,
           r.amount_idr, r.number AS refund_number, r.transaction_id, u.display_name
      FROM refund_destinations d JOIN refunds r ON r.id = d.refund_id JOIN users u ON u.id = d.buyer_id
     WHERE d.validation_status = ANY(${statuses as string[]}::text[])
     ORDER BY d.created_at LIMIT 200`;
  return {
    data: rows.map((d) => ({
      id: d.id,
      refundId: d.refund_id,
      refundNumber: d.refund_number,
      transactionId: d.transaction_id,
      buyerId: d.buyer_id,
      buyerDisplayName: maskName(d.display_name),
      bankCode: d.bank_code,
      accountMask: d.account_mask,
      validationStatus: d.validation_status,
      nameMatch: d.name_match,
      amountIdr: num(d.amount_idr),
      createdAt: iso(d.created_at),
      canReview: d.buyer_id !== ctx.auth.userId,
    })),
    nextCursor: null,
  };
}

/**
 * Manual review of a PENDING_REVIEW refund destination: APPROVE → VALID (refund processing resumes right away),
 * REJECT → REJECTED (buyer is asked again; a new destination needs a new step-up OTP). Reviewer ≠ buyer.
 */
export async function reviewRefundDestination(ctx: AdminCtx, id: string, input: { decision: 'APPROVE' | 'REJECT'; note: string }) {
  const now = ctx.deps.clock.now();
  const out = await inAdminTx(ctx, async (tx) => {
    const [d] = await tx<{ id: string; refund_id: string; buyer_id: string; validation_status: string }[]>`
      SELECT id, refund_id, buyer_id, validation_status FROM refund_destinations WHERE id = ${id} FOR UPDATE`;
    if (!d) throw Errors.notFound('Rekening refund', 'REFUND_DESTINATION_NOT_FOUND');
    makerChecker(d.buyer_id, ctx.auth.userId, 'Tidak dapat meninjau rekening refund milik sendiri');
    if (d.validation_status !== 'PENDING_REVIEW') {
      throw Errors.conflict('REFUND_DESTINATION_NOT_PENDING', 'Rekening refund tidak sedang menunggu review', { status: d.validation_status });
    }
    const status = input.decision === 'APPROVE' ? 'VALID' : 'REJECTED';
    await tx`UPDATE refund_destinations SET validation_status = ${status}, validated_at = ${status === 'VALID' ? now : null},
                    reviewed_by = ${ctx.auth.userId}, reviewed_at = ${now}, review_note = ${input.note} WHERE id = ${d.id}`;
    const [r] = await tx<{ transaction_id: string; status: string; amount_idr: string }[]>`
      SELECT transaction_id, status, amount_idr FROM refunds WHERE id = ${d.refund_id}`;
    if (status === 'VALID' && r?.status === 'FAILED') await tx`UPDATE refunds SET attempts = 0 WHERE id = ${d.refund_id}`;
    await emitEvent(tx, 'refund', d.refund_id, status === 'VALID' ? 'refund.destination_set' : 'refund.destination_required', {
      refundId: d.refund_id,
      transactionId: r?.transaction_id ?? null,
      buyerId: d.buyer_id,
      validationStatus: status,
      ...(status === 'REJECTED' ? { amountIdr: num(r?.amount_idr ?? 0), rejected: true } : {}),
    });
    await adminAudit(tx, ctx, {
      action: 'refund.destination_reviewed',
      entityType: 'refund',
      entityId: d.refund_id,
      before: { validationStatus: d.validation_status },
      after: { validationStatus: status },
      meta: { destinationId: d.id, note: input.note },
    });
    return { id: d.id, refundId: d.refund_id, transactionId: r?.transaction_id ?? null, validationStatus: status };
  });
  if (out.validationStatus === 'VALID' && out.transactionId) await processRefunds(ctx.deps, { transactionId: out.transactionId });
  return { id: out.id, refundId: out.refundId, validationStatus: out.validationStatus };
}
