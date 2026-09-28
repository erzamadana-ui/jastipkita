/**
 * Admin · Disputes (§6, §15.3): queue with SLA, assign, request evidence, review, resolve, appeal handling, close.
 *
 * Resolution (UNDER_REVIEW → RESOLVED, core RESOLUTION guard) executes the money side in the SAME DB transaction:
 *   REFUND_FULL / RETURN_AND_REFUND → refunds.requestRefund(everything still in escrow, remainder NONE) → REFUND_PENDING
 *   REFUND_PARTIAL                  → refunds.requestRefund(amount, remainder TRAVELER) → REFUND_PENDING → COMPLETED
 *   NO_REFUND / OTHER               → DISPUTED → BUYER_CONFIRMED (ADMIN) → completion (payout) after commit
 * and emits `dispute.resolved`. Pre-delivery NO_REFUND/OTHER releases escrow before the buyer received the item, so it
 * needs an explicit `releaseBeforeDelivery: true` (§4 has no DISPUTED → <previous status> edge).
 * Re-resolution after an appeal only records the decision when the transaction already left DISPUTED
 * (execution MANUAL_FOLLOW_UP if the outcome changed) — money that moved is never silently reversed.
 */
import { appealDeadline, canTransition, disputeFsm, type DisputeResolution, type DisputeStatus } from '@jastipkita/core';
import type { TxSql } from '../../../db/sql';
import { AppError, Errors } from '../../../lib/errors';
import { fileContentUrl } from '../../../lib/openapi';
import { emitEvent } from '../../../services/outbox';
import * as drepo from '../../disputes/repository';
import { transactionBuckets } from '../../ledger/service';
import { processRefunds, refundViews, requestRefund } from '../../refunds/service';
import { completeTransaction } from '../../transactions/completion';
import { loadTx, transitionTx } from '../../transactions/common';
import { type AdminCtx, adminAudit, decodeKey, encodeKey, inAdminTx, iso, maskName, num, parseCsv, permissionsOf } from '../common';

const STATUSES = ['OPEN', 'EVIDENCE_COLLECTION', 'UNDER_REVIEW', 'RESOLVED', 'APPEALED', 'CLOSED'] as const;
const REFUNDING = new Set<DisputeResolution>(['REFUND_FULL', 'REFUND_PARTIAL', 'RETURN_AND_REFUND']);

function slaState(d: { status: string; sla_due_at: Date | null; sla_breach: string | null }, now: Date) {
  if (d.status === 'RESOLVED' || d.status === 'CLOSED') return 'DONE';
  if (d.sla_breach || (d.sla_due_at && d.sla_due_at < now)) return 'BREACHED';
  if (d.sla_due_at && d.sla_due_at.getTime() - now.getTime() < 24 * 3600_000) return 'DUE_SOON';
  return 'ON_TRACK';
}

export async function disputeQueue(ctx: AdminCtx, q: { status?: string | undefined; assignee?: string | undefined; sla?: 'BREACHED' | 'DUE_SOON' | undefined; limit: number; cursor?: string | undefined }) {
  const db = ctx.deps.sql;
  const statuses = parseCsv(q.status, STATUSES, 'status') ?? ['OPEN', 'EVIDENCE_COLLECTION', 'UNDER_REVIEW', 'APPEALED', 'RESOLVED'];
  const cursor = decodeKey(q.cursor);
  const now = ctx.deps.clock.now();
  const assignee = q.assignee === 'me' ? ctx.auth.userId : q.assignee;
  const r = await db<Record<string, unknown>[]>`
    SELECT d.id, d.number, d.transaction_id, d.type, d.status, d.opened_by_role, d.requested_resolution, d.resolution, d.assignee_id,
           d.evidence_due_at, d.sla_due_at, d.sla_breach, d.created_at, d.resolved_at, d.appealed_at, t.number AS tx_number, t.status AS tx_status, t.total_idr
      FROM disputes d JOIN transactions t ON t.id = d.transaction_id
     WHERE d.status = ANY(${statuses}::text[])
       ${assignee === 'none' ? db`AND d.assignee_id IS NULL` : assignee ? db`AND d.assignee_id = ${assignee}` : db``}
       ${q.sla === 'BREACHED' ? db`AND (d.sla_breach IS NOT NULL OR d.sla_due_at < ${now}) AND d.status NOT IN ('RESOLVED','CLOSED')` : db``}
       ${q.sla === 'DUE_SOON' ? db`AND d.sla_due_at BETWEEN ${now} AND ${new Date(now.getTime() + 24 * 3600_000)} AND d.status NOT IN ('RESOLVED','CLOSED')` : db``}
       ${cursor ? db`AND (d.created_at, d.id) > (${cursor.t}::timestamptz, ${cursor.id}::uuid)` : db``}
     ORDER BY d.created_at, d.id LIMIT ${q.limit + 1}`;
  const more = r.length > q.limit;
  const data = r.slice(0, q.limit).map((d) => ({
    id: String(d.id),
    number: String(d.number),
    transactionId: String(d.transaction_id),
    transactionNumber: String(d.tx_number),
    transactionStatus: String(d.tx_status),
    totalIdr: d.total_idr === null ? null : num(d.total_idr),
    type: String(d.type),
    status: String(d.status),
    openedByRole: String(d.opened_by_role),
    requestedResolution: (d.requested_resolution as string | null) ?? null,
    resolution: (d.resolution as string | null) ?? null,
    assigneeId: (d.assignee_id as string | null) ?? null,
    evidenceDueAt: iso(d.evidence_due_at as Date | null),
    slaDueAt: iso(d.sla_due_at as Date | null),
    slaState: slaState(d as never, now),
    createdAt: iso(d.created_at as Date)!,
  }));
  const last = data[data.length - 1];
  return { data, nextCursor: more && last ? encodeKey({ t: last.createdAt, id: last.id }) : null };
}

async function getDispute(db: Parameters<typeof drepo.getDispute>[0], id: string, forUpdate = false) {
  const d = await drepo.getDispute(db, id, forUpdate);
  if (!d) throw Errors.notFound('Dispute', 'DISPUTE_NOT_FOUND');
  return d;
}

export async function disputeDetail(ctx: AdminCtx, id: string) {
  const db = ctx.deps.sql;
  const d = await getDispute(db, id);
  const now = ctx.deps.clock.now();
  const sla = await ctx.deps.config.get('dispute.sla');
  const [extra] = await db<{ assignee_id: string | null; resolved_by: string | null }[]>`SELECT assignee_id, resolved_by FROM disputes WHERE id = ${id}`;
  const evidence = await drepo.evidenceOf(db, id);
  const events = await drepo.eventsOf(db, id);
  const parties = await db<{ id: string; display_name: string | null; trust_score: number }[]>`
    SELECT id, display_name, trust_score FROM users WHERE id IN ${db([d.buyer_id, ...(d.traveler_id ? [d.traveler_id] : [])])}`;
  const [conv] = await db<{ id: string }[]>`SELECT id FROM conversations WHERE transaction_id = ${d.transaction_id}`;
  const held = await transactionBuckets(db, d.transaction_id);
  const escrowIdr = held.PRODUCT_FUND + held.CUSTOMS_RESERVE + held.CLEARING;
  // exactly what resolve() would refund for REFUND_FULL (and the exclusive upper bound for REFUND_PARTIAL)
  const refundCapIdr = await refundableIdr(db as unknown as TxSql, d.transaction_id);
  const preStatus = await drepo.preDisputeStatus(db, d.transaction_id);
  const allowed: string[] = [];
  if (['OPEN', 'UNDER_REVIEW'].includes(d.status)) allowed.push('REQUEST_EVIDENCE');
  if (d.status === 'EVIDENCE_COLLECTION') allowed.push('REQUEST_EVIDENCE', 'START_REVIEW');
  if (['OPEN', 'APPEALED'].includes(d.status)) allowed.push('START_REVIEW');
  if (d.status === 'UNDER_REVIEW') allowed.push('RESOLVE');
  if (['RESOLVED', 'OPEN', 'EVIDENCE_COLLECTION'].includes(d.status)) allowed.push('CLOSE');
  const party = (uid: string | null) => {
    const p = parties.find((x) => x.id === uid);
    return p ? { id: p.id, displayName: maskName(p.display_name), trustScore: p.trust_score } : null;
  };
  return {
    id: d.id,
    number: d.number,
    type: d.type,
    status: d.status,
    version: d.version,
    description: d.description,
    openedBy: d.opened_by,
    openedByRole: d.opened_by_role,
    requestedResolution: d.requested_resolution,
    resolution: d.resolution,
    resolutionAmountIdr: d.resolution_amount_idr === null ? null : num(d.resolution_amount_idr),
    resolutionNote: d.resolution_note,
    assigneeId: extra?.assignee_id ?? null,
    resolvedBy: extra?.resolved_by ?? null,
    evidenceDueAt: iso(d.evidence_due_at),
    slaDueAt: iso(d.sla_due_at),
    slaBreach: d.sla_breach,
    slaState: slaState(d, now),
    resolvedAt: iso(d.resolved_at),
    appealedAt: iso(d.appealed_at),
    appealDeadline: d.resolved_at && !d.appealed_at ? appealDeadline(d.resolved_at, sla).toISOString() : null,
    closedAt: iso(d.closed_at),
    transaction: { id: d.transaction_id, number: d.tx_number, status: d.tx_status, preDisputeStatus: preStatus, escrowHeldIdr: escrowIdr, refundableIdr: refundCapIdr },
    buyer: party(d.buyer_id),
    traveler: party(d.traveler_id),
    conversationId: conv?.id ?? null,
    evidence: evidence.map((e) => ({
      id: e.id,
      party: e.party,
      type: e.type,
      fileId: e.file_id,
      fileUrlEndpoint: e.file_id ? `${ctx.deps.env.API_BASE_URL.replace(/\/+$/, '')}/v1/files/${e.file_id}/url` : null,
      contentUrl: e.file_id ? fileContentUrl(ctx.deps.env.API_BASE_URL, e.file_id) : null,
      messageId: e.message_id,
      note: e.note,
      submittedBy: e.submitted_by,
      createdAt: iso(e.created_at)!,
    })),
    timeline: events.map((e) => ({ from: e.from_status, to: e.to_status, actorType: e.actor_type, at: iso(e.created_at)! })),
    refunds: await refundViews(db, d.transaction_id),
    allowedActions: [...new Set(allowed)],
  };
}

export async function assignDispute(ctx: AdminCtx, id: string, assigneeId?: string) {
  const target = assigneeId ?? ctx.auth.userId;
  if (!(await permissionsOf(ctx.deps.sql, target)).has('disputes.manage')) {
    throw Errors.unprocessable('ASSIGNEE_NOT_ALLOWED', 'Penanggung jawab harus memiliki izin disputes.manage');
  }
  await inAdminTx(ctx, async (tx) => {
    const d = await getDispute(tx, id, true);
    if (d.status === 'CLOSED') throw Errors.unprocessable('DISPUTE_CLOSED', 'Dispute sudah ditutup');
    const [prev] = await tx<{ assignee_id: string | null }[]>`SELECT assignee_id FROM disputes WHERE id = ${id}`;
    await tx`UPDATE disputes SET assignee_id = ${target} WHERE id = ${id}`;
    await adminAudit(tx, ctx, { action: 'disputes.assigned', entityType: 'dispute', entityId: id, before: { assigneeId: prev?.assignee_id ?? null }, after: { assigneeId: target } });
  });
  return { id, assigneeId: target };
}

export async function requestEvidence(ctx: AdminCtx, id: string, input: { note: string; dueHours: number }) {
  const now = ctx.deps.clock.now();
  const due = new Date(now.getTime() + input.dueHours * 3600_000);
  await inAdminTx(ctx, async (tx) => {
    const d = await getDispute(tx, id, true);
    if (d.status !== 'EVIDENCE_COLLECTION') {
      const check = disputeFsm.canTransition(d.status as DisputeStatus, 'EVIDENCE_COLLECTION', 'ADMIN', {});
      if (!check.ok) throw new AppError(422, 'DISPUTE_TRANSITION_NOT_ALLOWED', 'Permintaan bukti tidak tersedia pada status ini', { status: d.status });
      await drepo.transitionDispute(tx, id, d.version, 'EVIDENCE_COLLECTION', 'ADMIN', ctx.auth.userId, input.note, { evidenceDueAt: due.toISOString() });
    }
    await tx`UPDATE disputes SET evidence_due_at = ${due}, assignee_id = coalesce(assignee_id, ${ctx.auth.userId}) WHERE id = ${id}`;
    await tx`INSERT INTO dispute_evidence (dispute_id, submitted_by, party, type, note) VALUES (${id}, ${ctx.auth.userId}, 'ADMIN', 'OTHER', ${`Permintaan bukti: ${input.note}`})`;
    await adminAudit(tx, ctx, { action: 'disputes.evidence_requested', entityType: 'dispute', entityId: id, before: { status: d.status }, after: { status: 'EVIDENCE_COLLECTION', evidenceDueAt: due.toISOString() }, meta: { note: input.note } });
  });
  return { id, status: 'EVIDENCE_COLLECTION', evidenceDueAt: due.toISOString() };
}

export async function startReview(ctx: AdminCtx, id: string, input: { closeEvidenceWindow?: boolean | undefined; note?: string | undefined }) {
  const now = ctx.deps.clock.now();
  const sla = await ctx.deps.config.get('dispute.sla');
  await inAdminTx(ctx, async (tx) => {
    const d = await getDispute(tx, id, true);
    const windowClosed = !d.evidence_due_at || d.evidence_due_at <= now || !!input.closeEvidenceWindow;
    const check = disputeFsm.canTransition(d.status as DisputeStatus, 'UNDER_REVIEW', 'ADMIN', { evidenceWindowClosed: windowClosed });
    if (!check.ok) {
      throw new AppError(422, check.code === 'EVIDENCE_WINDOW_OPEN' ? 'EVIDENCE_WINDOW_OPEN' : 'DISPUTE_TRANSITION_NOT_ALLOWED', check.code === 'EVIDENCE_WINDOW_OPEN' ? 'Masa bukti masih berjalan; kirim closeEvidenceWindow: true untuk menutupnya lebih awal' : 'Review tidak tersedia pada status ini', { status: d.status });
    }
    if (d.status === 'EVIDENCE_COLLECTION' && input.closeEvidenceWindow && d.evidence_due_at && d.evidence_due_at > now) {
      await tx`UPDATE disputes SET evidence_due_at = ${now} WHERE id = ${id}`;
    }
    await drepo.transitionDispute(tx, id, d.version, 'UNDER_REVIEW', 'ADMIN', ctx.auth.userId, input.note ?? 'review started', {});
    if (d.status === 'APPEALED') await tx`UPDATE disputes SET sla_due_at = ${new Date(now.getTime() + sla.reviewHours * 3600_000)} WHERE id = ${id} AND sla_due_at IS NULL`;
    await tx`UPDATE disputes SET assignee_id = coalesce(assignee_id, ${ctx.auth.userId}) WHERE id = ${id}`;
    await adminAudit(tx, ctx, { action: 'disputes.review_started', entityType: 'dispute', entityId: id, before: { status: d.status }, after: { status: 'UNDER_REVIEW' }, meta: { closedEvidenceWindowEarly: !!input.closeEvidenceWindow } });
  });
  return { id, status: 'UNDER_REVIEW' };
}

export interface ResolveInput {
  resolution: DisputeResolution;
  amountIdr?: number | undefined;
  note: string;
  releaseBeforeDelivery?: boolean | undefined;
}

async function refundableIdr(tx: TxSql, transactionId: string): Promise<number> {
  const held = await transactionBuckets(tx, transactionId);
  const [p] = await tx<{ cap: number }[]>`
    SELECT coalesce(sum(p.amount_idr - coalesce((SELECT sum(r.amount_idr) FROM refunds r WHERE r.payment_id = p.id AND r.status NOT IN ('REJECTED','CANCELLED','FAILED')), 0)), 0)::bigint AS cap
      FROM payments p WHERE p.transaction_id = ${transactionId} AND p.status IN ('SECURED','PARTIALLY_REFUNDED')`;
  return Math.max(0, Math.min(held.PRODUCT_FUND + held.CUSTOMS_RESERVE + held.CLEARING, num(p?.cap)));
}

export async function resolveDispute(ctx: AdminCtx, id: string, input: ResolveInput) {
  const now = ctx.deps.clock.now();
  const sla = await ctx.deps.config.get('dispute.sla');
  const out = await inAdminTx(ctx, async (tx) => {
    const d = await getDispute(tx, id, true);
    if (d.status !== 'UNDER_REVIEW') throw Errors.unprocessable('DISPUTE_NOT_UNDER_REVIEW', 'Resolusi hanya untuk dispute UNDER_REVIEW', { status: d.status });
    const txRow = await loadTx(tx, d.transaction_id, { forUpdate: true });
    if (!txRow) throw Errors.notFound('Transaksi', 'TRANSACTION_NOT_FOUND');
    const refunding = REFUNDING.has(input.resolution);
    const execute = txRow.status === 'DISPUTED';
    const preStatus = await drepo.preDisputeStatus(tx, d.transaction_id);
    let amount: number | null = null;
    if (input.resolution === 'REFUND_PARTIAL' && (!input.amountIdr || input.amountIdr <= 0)) {
      throw Errors.validation({ issues: [{ path: 'amountIdr', message: 'REFUND_PARTIAL membutuhkan amountIdr > 0' }] });
    }
    if (refunding) {
      if (execute) {
        const cap = await refundableIdr(tx, d.transaction_id);
        if (input.resolution === 'REFUND_PARTIAL') {
          if (!input.amountIdr || input.amountIdr <= 0) throw Errors.validation({ issues: [{ path: 'amountIdr', message: 'REFUND_PARTIAL membutuhkan amountIdr > 0' }] });
          if (input.amountIdr >= cap) throw Errors.unprocessable('PARTIAL_AMOUNT_TOO_LARGE', 'Nominal refund parsial harus lebih kecil dari dana yang ditahan; gunakan REFUND_FULL', { refundableIdr: cap });
          amount = input.amountIdr;
        } else {
          if (cap <= 0) throw Errors.unprocessable('NOTHING_TO_REFUND', 'Tidak ada dana yang masih ditahan untuk transaksi ini');
          amount = cap;
        }
      } else {
        amount = input.amountIdr ?? null;
      }
    } else if (execute && preStatus !== 'DELIVERED' && !input.releaseBeforeDelivery) {
      throw Errors.unprocessable('PRE_DELIVERY_RELEASE_CONFIRMATION_REQUIRED', 'Barang belum diterima pembeli: resolusi tanpa refund akan merilis dana ke traveler. Kirim releaseBeforeDelivery: true bila disengaja.', { preDisputeStatus: preStatus });
    }
    await tx`UPDATE disputes SET resolution = ${input.resolution}, resolution_amount_idr = ${amount}, resolution_note = ${input.note},
                    assignee_id = coalesce(assignee_id, ${ctx.auth.userId}) WHERE id = ${id}`;
    const check = disputeFsm.canTransition('UNDER_REVIEW', 'RESOLVED', 'ADMIN', { resolutionRecorded: true });
    if (!check.ok) throw new AppError(422, check.code, check.message);
    const dr = await drepo.transitionDispute(tx, id, d.version, 'RESOLVED', 'ADMIN', ctx.auth.userId, input.note, { resolution: input.resolution, amountIdr: amount });

    let execution: { status: 'REFUND_REQUESTED' | 'BUYER_CONFIRMED' | 'ALREADY_EXECUTED' | 'MANUAL_FOLLOW_UP'; refundIds?: string[]; reason?: string };
    if (execute && refunding) {
      const rows = await requestRefund(ctx.deps, tx, d.transaction_id, {
        amountIdr: amount!,
        reasonCode: 'DISPUTE_RESOLUTION',
        reasonNote: `${d.number}: ${input.note}`.slice(0, 500),
        requestedBy: ctx.auth.userId,
        actorType: 'ADMIN',
        remainderTo: input.resolution === 'REFUND_PARTIAL' ? 'TRAVELER' : 'NONE',
        disputeResolution: input.resolution,
        idempotencyKey: `dispute:${id}:v${dr.version}`,
      });
      execution = { status: 'REFUND_REQUESTED', refundIds: rows.map((r) => r.id) };
    } else if (execute) {
      const g = canTransition('DISPUTED', 'BUYER_CONFIRMED', 'ADMIN', { disputeResolution: input.resolution });
      if (!g.ok) throw new AppError(422, g.code, g.message);
      await transitionTx(tx, txRow, 'BUYER_CONFIRMED', 'ADMIN', ctx.auth.userId, `dispute ${d.number} resolved ${input.resolution}`, { disputeId: id, resolution: input.resolution });
      execution = { status: 'BUYER_CONFIRMED' };
    } else {
      const prevRefunding = d.resolution ? REFUNDING.has(d.resolution as DisputeResolution) : null;
      execution =
        prevRefunding !== null && prevRefunding === refunding && d.resolution === input.resolution
          ? { status: 'ALREADY_EXECUTED' }
          : { status: 'MANUAL_FOLLOW_UP', reason: `Transaksi sudah ${txRow.status}; hasil banding berbeda dari eksekusi awal — tindak lanjuti lewat refund admin / tiket keuangan.` };
    }
    const resolvedAt = now;
    await emitEvent(tx, 'dispute', id, 'dispute.resolved', {
      disputeId: id,
      number: d.number,
      transactionId: d.transaction_id,
      buyerId: d.buyer_id,
      travelerId: d.traveler_id,
      resolution: input.resolution,
      resolutionAmountIdr: amount,
      appealDeadline: appealDeadline(resolvedAt, sla).toISOString(),
      execution: execution.status,
    });
    await adminAudit(tx, ctx, {
      action: 'disputes.resolved',
      entityType: 'dispute',
      entityId: id,
      before: { status: 'UNDER_REVIEW', resolution: d.resolution },
      after: { status: 'RESOLVED', resolution: input.resolution, resolutionAmountIdr: amount },
      meta: { transactionId: d.transaction_id, execution: execution.status, appeal: !!d.appealed_at, note: input.note },
    });
    return { transactionId: d.transaction_id, execution, amount };
  });
  if (out.execution.status === 'REFUND_REQUESTED') await processRefunds(ctx.deps, { transactionId: out.transactionId });
  if (out.execution.status === 'BUYER_CONFIRMED') {
    const c = await completeTransaction(ctx.deps, out.transactionId);
    if (!c.completed) ctx.deps.logger.warn('admin.dispute_completion_pending', { transactionId: out.transactionId, reason: c.reason });
  }
  const fresh = await loadTx(ctx.deps.sql, out.transactionId);
  return { id, status: 'RESOLVED', resolution: input.resolution, resolutionAmountIdr: out.amount, execution: out.execution, transactionStatus: fresh?.status ?? null, refunds: await refundViews(ctx.deps.sql, out.transactionId) };
}

export async function closeDispute(ctx: AdminCtx, id: string, note: string) {
  const out = await inAdminTx(ctx, async (tx) => {
    const d = await getDispute(tx, id, true);
    const check = disputeFsm.canTransition(d.status as DisputeStatus, 'CLOSED', 'ADMIN', {});
    if (!check.ok) throw Errors.unprocessable('DISPUTE_TRANSITION_NOT_ALLOWED', 'Dispute tidak dapat ditutup pada status ini', { status: d.status });
    let follow: 'NONE' | 'BUYER_CONFIRMED' = 'NONE';
    if (d.status !== 'RESOLVED') {
      // closing as invalid/withdrawn: only a delivered item can resume (no-refund settlement); otherwise resolve instead
      const t = await loadTx(tx, d.transaction_id, { forUpdate: true });
      if (t?.status === 'DISPUTED') {
        const pre = await drepo.preDisputeStatus(tx, d.transaction_id);
        if (pre !== 'DELIVERED') throw Errors.unprocessable('RESOLUTION_REQUIRED', 'Transaksi masih DISPUTED dan barang belum diterima: selesaikan dengan resolusi, bukan ditutup', { preDisputeStatus: pre });
        await transitionTx(tx, t, 'BUYER_CONFIRMED', 'ADMIN', ctx.auth.userId, `dispute ${d.number} closed as invalid`, { disputeId: id, resolution: 'OTHER' });
        follow = 'BUYER_CONFIRMED';
      }
    }
    await drepo.transitionDispute(tx, id, d.version, 'CLOSED', 'ADMIN', ctx.auth.userId, note, {});
    await adminAudit(tx, ctx, { action: 'disputes.closed', entityType: 'dispute', entityId: id, before: { status: d.status }, after: { status: 'CLOSED' }, meta: { note, transactionFollowUp: follow } });
    return { transactionId: d.transaction_id, follow };
  });
  if (out.follow === 'BUYER_CONFIRMED') await completeTransaction(ctx.deps, out.transactionId);
  return { id, status: 'CLOSED', transactionFollowUp: out.follow };
}
