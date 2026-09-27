import {
  appealDeadline,
  canOpenDispute,
  canTransition,
  computeSla,
  disputeFsm,
  type DisputeResolution,
  type DisputeStatus,
  type DisputeType,
  type TransactionStatus,
} from '@jastipkita/core';
import type { AppDeps, AuthContext } from '../../context';
import type { TxSql } from '../../db/sql';
import { AppError, Errors } from '../../lib/errors';
import { decodeCursor, encodeCursor } from '../../lib/pagination';
import { audit } from '../../services/audit';
import { emitEvent } from '../../services/outbox';
import * as repo from './repository';
import type { EVIDENCE_TYPES } from './schemas';

type Role = 'BUYER' | 'TRAVELER';
const EVIDENCE_OPEN_STATUSES = new Set(['OPEN', 'EVIDENCE_COLLECTION', 'APPEALED']);
const FILE_EVIDENCE = new Set(['PHOTO', 'VIDEO', 'RECEIPT', 'DELIVERY_PROOF']);

function roleOf(d: { buyer_id: string; traveler_id: string | null }, userId: string): Role | null {
  if (d.buyer_id === userId) return 'BUYER';
  if (d.traveler_id === userId) return 'TRAVELER';
  return null;
}

async function participantDispute(deps: AppDeps, auth: AuthContext, id: string) {
  const d = await repo.getDispute(deps.sql, id);
  const role = d ? roleOf(d, auth.userId) : null;
  if (!d || !role) throw Errors.notFound('Dispute', 'DISPUTE_NOT_FOUND');
  return { d, role };
}

function allowedActions(d: repo.DisputeRow, userId: string, now: Date, appealWindowHours: number) {
  const out: ('ADD_EVIDENCE' | 'APPEAL' | 'WITHDRAW')[] = [];
  if (EVIDENCE_OPEN_STATUSES.has(d.status) && !(d.status === 'EVIDENCE_COLLECTION' && d.evidence_due_at && d.evidence_due_at < now)) out.push('ADD_EVIDENCE');
  if (d.status === 'RESOLVED' && !d.appealed_at && d.resolved_at && appealDeadline(d.resolved_at, { appealWindowHours }) > now) out.push('APPEAL');
  if ((d.status === 'OPEN' || d.status === 'EVIDENCE_COLLECTION') && d.opened_by === userId) out.push('WITHDRAW');
  return out;
}

async function summaryDto(deps: AppDeps, d: repo.DisputeRow, userId: string) {
  const sla = await deps.config.get('dispute.sla');
  const now = deps.clock.now();
  return {
    id: d.id,
    number: d.number,
    transactionId: d.transaction_id,
    transactionNumber: d.tx_number,
    transactionStatus: d.tx_status,
    type: d.type as DisputeType,
    status: d.status as DisputeStatus,
    description: d.description,
    requestedResolution: (d.requested_resolution as DisputeResolution | null) ?? null,
    resolution: (d.resolution as DisputeResolution | null) ?? null,
    resolutionAmountIdr: d.resolution_amount_idr === null ? null : Number(d.resolution_amount_idr),
    resolutionNote: d.resolution_note,
    openedByRole: d.opened_by_role,
    openedByMe: d.opened_by === userId,
    myRole: roleOf(d, userId) ?? ('BUYER' as Role),
    evidenceDueAt: d.evidence_due_at?.toISOString() ?? null,
    slaDueAt: d.sla_due_at?.toISOString() ?? null,
    resolvedAt: d.resolved_at?.toISOString() ?? null,
    appealDeadline: d.resolved_at && !d.appealed_at ? appealDeadline(d.resolved_at, sla).toISOString() : null,
    closedAt: d.closed_at?.toISOString() ?? null,
    allowedActions: allowedActions(d, userId, now, sla.appealWindowHours),
    createdAt: d.created_at.toISOString(),
  };
}

function evidenceDto(e: Awaited<ReturnType<typeof repo.evidenceOf>>[number], userId: string) {
  return {
    id: e.id,
    party: e.party as 'BUYER' | 'TRAVELER' | 'ADMIN' | 'SYSTEM',
    type: e.type as (typeof EVIDENCE_TYPES)[number],
    fileId: e.file_id,
    messageId: e.message_id,
    note: e.note,
    mine: e.submitted_by === userId,
    createdAt: e.created_at.toISOString(),
  };
}

async function detailDto(deps: AppDeps, d: repo.DisputeRow, userId: string) {
  const [evidence, events] = await Promise.all([repo.evidenceOf(deps.sql, d.id), repo.eventsOf(deps.sql, d.id)]);
  return {
    ...(await summaryDto(deps, d, userId)),
    evidence: evidence.map((e) => evidenceDto(e, userId)),
    timeline: events.map((e) => ({ from: e.from_status, to: e.to_status, actorType: e.actor_type, at: e.created_at.toISOString() })),
  };
}

export async function openDispute(
  deps: AppDeps,
  auth: AuthContext,
  transactionId: string,
  input: { type: string; description: string; requestedResolution?: string | undefined },
) {
  const t = await repo.transactionForDispute(deps.sql, transactionId);
  const role = t ? roleOf(t, auth.userId) : null;
  if (!t || !role) throw Errors.notFound('Transaksi', 'TRANSACTION_NOT_FOUND');
  const sla = await deps.config.get('dispute.sla');
  const now = deps.clock.now();
  const check = canOpenDispute(t.status as TransactionStatus, t.delivered_at, now, sla);
  if (!check.ok) {
    const msg = check.code === 'DISPUTE_WINDOW_CLOSED' ? `Batas waktu dispute (${sla.openWindowHoursAfterDelivery} jam setelah barang diterima) sudah lewat` : 'Dispute tidak bisa dibuka pada status transaksi ini';
    throw Errors.unprocessable(check.code, msg, { transactionStatus: t.status });
  }
  const guard = canTransition(t.status as TransactionStatus, 'DISPUTED', role, { withinDisputeWindow: true });
  if (!guard.ok) throw Errors.unprocessable(guard.code, guard.message);
  const existing = await repo.openDisputeFor(deps.sql, transactionId);
  if (existing) throw Errors.conflict('DISPUTE_ALREADY_OPEN', `Transaksi ini sudah punya dispute aktif (${existing.number})`, { disputeId: existing.id });
  const s = computeSla(now, sla);

  const id = await deps.sql
    .begin(async (tq) => {
      const tx = tq as unknown as TxSql;
      const cur = await repo.transactionForDispute(tx, transactionId, true);
      if (!cur || cur.status !== t.status) throw Errors.conflict('VERSION_CONFLICT', 'Status transaksi berubah, muat ulang lalu coba lagi');
      const d = await repo.insertDispute(tx, {
        transactionId,
        openedBy: auth.userId,
        role,
        type: input.type,
        description: input.description,
        requestedResolution: input.requestedResolution ?? null,
        evidenceDueAt: s.evidenceDueAt,
        slaDueAt: s.reviewDueAt,
        now,
      });
      await repo.transitionTransaction(tx, transactionId, cur.version, 'DISPUTED', role, auth.userId, 'dispute opened', { disputeId: d.id, disputeNumber: d.number });
      // case accepted immediately: the evidence window starts now (the SLA job closes it)
      await repo.transitionDispute(tx, d.id, d.version, 'EVIDENCE_COLLECTION', 'SYSTEM', null, 'evidence window started', { evidenceDueAt: s.evidenceDueAt.toISOString() });
      await emitEvent(tx, 'dispute', d.id, 'dispute.opened', {
        disputeId: d.id,
        number: d.number,
        transactionId,
        buyerId: cur.buyer_id,
        travelerId: cur.traveler_id,
        openedBy: auth.userId,
        openedByRole: role,
        type: input.type,
      });
      await audit(tx, {
        actorType: role,
        actorId: auth.userId,
        action: 'dispute.opened',
        entityType: 'dispute',
        entityId: d.id,
        after: { status: 'EVIDENCE_COLLECTION', type: input.type, requestedResolution: input.requestedResolution ?? null },
        meta: { transactionId, number: d.number, fromStatus: t.status },
      });
      return d.id;
    })
    .catch((err: unknown) => {
      if ((err as { code?: string; constraint_name?: string }).code === '23505') throw Errors.conflict('DISPUTE_ALREADY_OPEN', 'Transaksi ini sudah punya dispute aktif');
      throw err;
    });
  return detailDto(deps, (await repo.getDispute(deps.sql, id))!, auth.userId);
}

export async function listMine(deps: AppDeps, auth: AuthContext, q: { limit: number; cursor?: string | undefined; status?: string | undefined }) {
  const cursor = decodeCursor(q.cursor);
  if (q.cursor && (!cursor || Number.isNaN(Date.parse(cursor.t)))) throw Errors.badRequest('CURSOR_INVALID', 'Cursor tidak valid');
  const rows = await repo.listMine(deps.sql, auth.userId, { status: q.status, cursor, limit: q.limit + 1 });
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    data: await Promise.all(page.map((d) => summaryDto(deps, d, auth.userId))),
    nextCursor: rows.length > q.limit && last ? encodeCursor({ t: last.cursor_t, id: last.id }) : null,
  };
}

export async function getDetail(deps: AppDeps, auth: AuthContext, id: string) {
  const { d } = await participantDispute(deps, auth, id);
  return detailDto(deps, d, auth.userId);
}

export async function addEvidence(
  deps: AppDeps,
  auth: AuthContext,
  id: string,
  input: { type: (typeof EVIDENCE_TYPES)[number]; fileId?: string | undefined; messageId?: string | undefined; note?: string | undefined },
) {
  const { d, role } = await participantDispute(deps, auth, id);
  const now = deps.clock.now();
  if (!EVIDENCE_OPEN_STATUSES.has(d.status) || (d.status === 'EVIDENCE_COLLECTION' && d.evidence_due_at && d.evidence_due_at < now)) {
    throw Errors.unprocessable('EVIDENCE_WINDOW_CLOSED', 'Masa pengumpulan bukti sudah berakhir', { status: d.status });
  }
  if (FILE_EVIDENCE.has(input.type) && !input.fileId) throw Errors.validation({ issues: [{ path: 'fileId', message: `Bukti ${input.type} membutuhkan file` }] });
  if (input.type === 'CHAT' && !input.messageId) throw Errors.validation({ issues: [{ path: 'messageId', message: 'Bukti CHAT membutuhkan messageId' }] });
  if (input.fileId && !(await repo.referencableFile(deps.sql, input.fileId, auth.userId, d.transaction_id))) {
    throw Errors.unprocessable('EVIDENCE_FILE_NOT_ALLOWED', 'File tidak bisa dijadikan bukti (bukan milikmu atau bukan bagian dari transaksi ini)');
  }
  if (input.messageId && !(await repo.conversationMessage(deps.sql, input.messageId, d.transaction_id))) {
    throw Errors.unprocessable('EVIDENCE_MESSAGE_NOT_ALLOWED', 'Pesan bukan bagian dari chat transaksi ini');
  }
  const row = await deps.sql.begin(async (tq) => {
    const tx = tq as unknown as TxSql;
    const e = await repo.insertEvidence(tx, {
      disputeId: d.id,
      submittedBy: auth.userId,
      party: role,
      type: input.type,
      fileId: input.fileId ?? null,
      messageId: input.messageId ?? null,
      note: input.note ?? null,
    });
    await emitEvent(tx, 'dispute', d.id, 'dispute.evidence_added', {
      disputeId: d.id,
      transactionId: d.transaction_id,
      buyerId: d.buyer_id,
      travelerId: d.traveler_id,
      submittedBy: auth.userId,
      evidenceId: e.id,
      type: input.type,
    });
    return e;
  });
  return evidenceDto(row, auth.userId);
}

export async function evidenceFileUrl(deps: AppDeps, auth: AuthContext, id: string, evidenceId: string) {
  const { d } = await participantDispute(deps, auth, id);
  const [f] = await deps.sql<{ storage_key: string }[]>`
    SELECT f.storage_key FROM dispute_evidence e JOIN files f ON f.id = e.file_id
     WHERE e.id = ${evidenceId} AND e.dispute_id = ${d.id} AND f.deleted_at IS NULL AND f.scan_status <> 'INFECTED'`;
  if (!f) throw Errors.notFound('Bukti', 'EVIDENCE_FILE_NOT_FOUND');
  const expiresSec = 300;
  const url = await deps.providers.storage.presignDownload({ key: f.storage_key, expiresSec });
  return { url, expiresAt: new Date(deps.clock.now().getTime() + expiresSec * 1000).toISOString() };
}

export async function appeal(deps: AppDeps, auth: AuthContext, id: string, reason: string) {
  const { d, role } = await participantDispute(deps, auth, id);
  const sla = await deps.config.get('dispute.sla');
  const now = deps.clock.now();
  const within = !!d.resolved_at && appealDeadline(d.resolved_at, sla) > now;
  const check = disputeFsm.canTransition(d.status as DisputeStatus, 'APPEALED', role, { withinAppealWindow: within, alreadyAppealed: !!d.appealed_at });
  if (!check.ok) {
    const status = check.code === 'INVALID_TRANSITION' || check.code === 'TERMINAL_STATUS' ? 422 : 422;
    throw new AppError(status, check.code === 'INVALID_TRANSITION' ? 'DISPUTE_NOT_RESOLVED' : check.code, check.code === 'APPEAL_WINDOW_CLOSED' ? 'Batas waktu banding sudah lewat' : check.code === 'APPEAL_ALREADY_USED' ? 'Banding hanya bisa diajukan sekali' : 'Banding hanya untuk dispute yang sudah diputuskan');
  }
  await deps.sql.begin(async (tq) => {
    const tx = tq as unknown as TxSql;
    const cur = await repo.getDispute(tx, d.id, true);
    await repo.transitionDispute(tx, d.id, cur!.version, 'APPEALED', role, auth.userId, reason);
    // new review window for the appeal; clears a breach flag from the first review
    await tx`UPDATE disputes SET sla_due_at = ${new Date(now.getTime() + sla.reviewHours * 3600_000)}, sla_breach = NULL, sla_breached_at = NULL WHERE id = ${d.id}`;
    await emitEvent(tx, 'dispute', d.id, 'dispute.appealed', { disputeId: d.id, transactionId: d.transaction_id, buyerId: d.buyer_id, travelerId: d.traveler_id, appealedBy: auth.userId });
    await audit(tx, { actorType: role, actorId: auth.userId, action: 'dispute.appealed', entityType: 'dispute', entityId: d.id, before: { status: 'RESOLVED' }, after: { status: 'APPEALED' }, meta: { number: d.number } });
  });
  return detailDto(deps, (await repo.getDispute(deps.sql, d.id))!, auth.userId);
}

export async function withdraw(deps: AppDeps, auth: AuthContext, id: string, reason?: string) {
  const { d, role } = await participantDispute(deps, auth, id);
  if (d.opened_by !== auth.userId) throw Errors.forbidden('Hanya pembuka dispute yang bisa menariknya', 'NOT_DISPUTE_OPENER');
  if (d.status !== 'OPEN' && d.status !== 'EVIDENCE_COLLECTION') {
    throw Errors.unprocessable('DISPUTE_NOT_WITHDRAWABLE', 'Dispute yang sedang ditinjau atau sudah diputuskan tidak bisa ditarik', { status: d.status });
  }
  let followUp: 'BUYER_CONFIRMED' | 'ADMIN_REQUIRED' = 'ADMIN_REQUIRED';
  await deps.sql.begin(async (tq) => {
    const tx = tq as unknown as TxSql;
    const cur = await repo.getDispute(tx, d.id, true);
    await repo.transitionDispute(tx, d.id, cur!.version, 'CLOSED', role, auth.userId, reason ?? 'withdrawn by opener', { withdrawn: true });
    const t = await repo.transactionForDispute(tx, d.transaction_id, true);
    const before = await repo.preDisputeStatus(tx, d.transaction_id);
    // §4 has no DISPUTED → <previous> edge. A buyer withdrawing on a delivered item = no-refund settlement.
    if (t?.status === 'DISPUTED' && before === 'DELIVERED' && role === 'BUYER' && canTransition('DISPUTED', 'BUYER_CONFIRMED', 'SYSTEM', { disputeResolution: 'OTHER' }).ok) {
      await repo.transitionTransaction(tx, t.id, t.version, 'BUYER_CONFIRMED', 'SYSTEM', null, 'dispute withdrawn by buyer', { disputeId: d.id });
      followUp = 'BUYER_CONFIRMED';
    }
    await audit(tx, {
      actorType: role,
      actorId: auth.userId,
      action: 'dispute.withdrawn',
      entityType: 'dispute',
      entityId: d.id,
      before: { status: d.status },
      after: { status: 'CLOSED' },
      meta: { number: d.number, transactionFollowUp: followUp },
    });
  });
  return { ...(await detailDto(deps, (await repo.getDispute(deps.sql, d.id))!, auth.userId)), transactionFollowUp: followUp };
}
