/**
 * Admin · Support tickets & chat moderation.
 * Tickets (support.tickets.manage): queue with SLA (`support.sla` config hours by priority), assign, reply (public →
 * support.ticket_updated to the user; internal notes never reach the user), status/priority changes, SLA view.
 * Chat moderation (chat.moderate): flagged-message queue (masked text), reveal original text (audited), hide/unhide,
 * and reading a conversation ONLY when its transaction has an open dispute or an open support ticket (legal/privacy
 * scope, passed explicitly as disputeId/ticketId and audited).
 */
import type { TxSql } from '../../../db/sql';
import { Errors } from '../../../lib/errors';
import { emitEvent } from '../../../services/outbox';
import { type AdminCtx, adminAudit, decodeKey, encodeKey, inAdminTx, iso, maskName, parseCsv, permissionsOf } from '../common';

const TICKET_STATUSES = ['OPEN', 'PENDING_USER', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'] as const;
const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;

interface TicketRow {
  id: string;
  number: string;
  user_id: string | null;
  category: string;
  channel: string;
  subject: string;
  status: string;
  priority: string;
  transaction_id: string | null;
  dispute_id: string | null;
  assignee_id: string | null;
  sla_due_at: Date | null;
  first_response_at: Date | null;
  resolved_at: Date | null;
  closed_at: Date | null;
  created_at: Date;
  updated_at: Date;
  display_name?: string | null;
}

function slaState(t: TicketRow, now: Date) {
  if (t.first_response_at) return 'RESPONDED';
  if (['RESOLVED', 'CLOSED'].includes(t.status)) return 'DONE';
  if (t.sla_due_at && t.sla_due_at < now) return 'BREACHED';
  if (t.sla_due_at && t.sla_due_at.getTime() - now.getTime() < 4 * 3600_000) return 'DUE_SOON';
  return 'ON_TRACK';
}

function ticketDto(t: TicketRow, now: Date) {
  return {
    id: t.id,
    number: t.number,
    userId: t.user_id,
    userDisplayName: maskName(t.display_name ?? null),
    category: t.category,
    channel: t.channel,
    subject: t.subject,
    status: t.status,
    priority: t.priority,
    transactionId: t.transaction_id,
    disputeId: t.dispute_id,
    assigneeId: t.assignee_id,
    slaDueAt: iso(t.sla_due_at),
    slaState: slaState(t, now),
    firstResponseAt: iso(t.first_response_at),
    resolvedAt: iso(t.resolved_at),
    closedAt: iso(t.closed_at),
    createdAt: iso(t.created_at)!,
    updatedAt: iso(t.updated_at)!,
  };
}

export async function ticketQueue(ctx: AdminCtx, q: { status?: string | undefined; priority?: string | undefined; assignee?: string | undefined; sla?: 'BREACHED' | 'DUE_SOON' | undefined; limit: number; cursor?: string | undefined }) {
  const db = ctx.deps.sql;
  const statuses = parseCsv(q.status, TICKET_STATUSES, 'status') ?? ['OPEN', 'PENDING_USER', 'IN_PROGRESS'];
  const priorities = parseCsv(q.priority, PRIORITIES, 'priority');
  const cursor = decodeKey(q.cursor);
  const now = ctx.deps.clock.now();
  const assignee = q.assignee === 'me' ? ctx.auth.userId : q.assignee;
  const r = await db<TicketRow[]>`
    SELECT t.*, u.display_name FROM support_tickets t LEFT JOIN users u ON u.id = t.user_id
     WHERE t.status = ANY(${statuses}::text[])
       ${priorities ? db`AND t.priority = ANY(${priorities}::text[])` : db``}
       ${assignee === 'none' ? db`AND t.assignee_id IS NULL` : assignee ? db`AND t.assignee_id = ${assignee}` : db``}
       ${q.sla === 'BREACHED' ? db`AND t.first_response_at IS NULL AND t.sla_due_at < ${now}` : db``}
       ${q.sla === 'DUE_SOON' ? db`AND t.first_response_at IS NULL AND t.sla_due_at BETWEEN ${now} AND ${new Date(now.getTime() + 4 * 3600_000)}` : db``}
       ${cursor ? db`AND (t.created_at, t.id) > (${cursor.t}::timestamptz, ${cursor.id}::uuid)` : db``}
     ORDER BY t.created_at, t.id LIMIT ${q.limit + 1}`;
  const more = r.length > q.limit;
  const data = r.slice(0, q.limit).map((t) => ticketDto(t, now));
  const last = data[data.length - 1];
  return { data, nextCursor: more && last ? encodeKey({ t: last.createdAt, id: last.id }) : null };
}

async function lockTicket(tx: TxSql, id: string): Promise<TicketRow> {
  const [t] = await tx<TicketRow[]>`SELECT * FROM support_tickets WHERE id = ${id} FOR UPDATE`;
  if (!t) throw Errors.notFound('Tiket', 'TICKET_NOT_FOUND');
  return t;
}

export async function ticketDetail(ctx: AdminCtx, id: string) {
  const db = ctx.deps.sql;
  const [t] = await db<TicketRow[]>`SELECT t.*, u.display_name FROM support_tickets t LEFT JOIN users u ON u.id = t.user_id WHERE t.id = ${id}`;
  if (!t) throw Errors.notFound('Tiket', 'TICKET_NOT_FOUND');
  const msgs = await db<{ id: string; author_id: string | null; author_type: string; body: string; attachments: unknown; internal_note: boolean; created_at: Date }[]>`
    SELECT id, author_id, author_type, body, attachments, internal_note, created_at FROM ticket_messages WHERE ticket_id = ${id} ORDER BY created_at, id`;
  const [tx] = t.transaction_id ? await db<{ number: string; status: string }[]>`SELECT number, status FROM transactions WHERE id = ${t.transaction_id}` : [];
  const [conv] = t.transaction_id ? await db<{ id: string }[]>`SELECT id FROM conversations WHERE transaction_id = ${t.transaction_id}` : [];
  return {
    ...ticketDto(t, ctx.deps.clock.now()),
    transaction: tx ? { id: t.transaction_id, number: tx.number, status: tx.status } : null,
    conversationId: conv?.id ?? null,
    messages: msgs.map((m) => ({ id: m.id, authorId: m.author_id, authorType: m.author_type, body: m.body, attachments: m.attachments, internal: m.internal_note, createdAt: iso(m.created_at)! })),
  };
}

export async function assignTicket(ctx: AdminCtx, id: string, assigneeId?: string) {
  const target = assigneeId ?? ctx.auth.userId;
  if (!(await permissionsOf(ctx.deps.sql, target)).has('support.tickets.manage')) throw Errors.unprocessable('ASSIGNEE_NOT_ALLOWED', 'Penanggung jawab harus memiliki izin support.tickets.manage');
  await inAdminTx(ctx, async (tx) => {
    const t = await lockTicket(tx, id);
    await tx`UPDATE support_tickets SET assignee_id = ${target}, status = CASE WHEN status = 'OPEN' THEN 'IN_PROGRESS' ELSE status END WHERE id = ${id}`;
    await adminAudit(tx, ctx, { action: 'support.ticket_assigned', entityType: 'support_ticket', entityId: id, before: { assigneeId: t.assignee_id }, after: { assigneeId: target } });
  });
  return { id, assigneeId: target };
}

function milestones(status: string, now: Date) {
  return {
    resolved: status === 'RESOLVED' ? now : null,
    closed: status === 'CLOSED' ? now : null,
  };
}

export async function replyTicket(ctx: AdminCtx, id: string, input: { body: string; internal: boolean; status?: (typeof TICKET_STATUSES)[number] | undefined }) {
  const now = ctx.deps.clock.now();
  const out = await inAdminTx(ctx, async (tx) => {
    const t = await lockTicket(tx, id);
    if (t.status === 'CLOSED') throw Errors.unprocessable('TICKET_CLOSED', 'Tiket sudah ditutup');
    const [m] = await tx<{ id: string }[]>`
      INSERT INTO ticket_messages (ticket_id, author_id, author_type, body, internal_note, created_at)
      VALUES (${id}, ${ctx.auth.userId}, 'AGENT', ${input.body}, ${input.internal}, ${now}) RETURNING id`;
    const status = input.status ?? (input.internal ? t.status : 'PENDING_USER');
    const ms = milestones(status, now);
    await tx`UPDATE support_tickets
                SET status = ${status},
                    first_response_at = CASE WHEN ${!input.internal} AND first_response_at IS NULL THEN ${now}::timestamptz ELSE first_response_at END,
                    assignee_id = coalesce(assignee_id, ${ctx.auth.userId}),
                    resolved_at = coalesce(${ms.resolved}::timestamptz, resolved_at),
                    closed_at = coalesce(${ms.closed}::timestamptz, closed_at)
              WHERE id = ${id}`;
    if (!input.internal || status !== t.status) {
      await emitEvent(tx, 'support_ticket', id, 'support.ticket_updated', { ticketId: id, userId: t.user_id, status, actorType: 'AGENT', action: input.internal ? 'STATUS_CHANGED' : 'REPLIED' });
    }
    await adminAudit(tx, ctx, { action: input.internal ? 'support.ticket_note_added' : 'support.ticket_replied', entityType: 'support_ticket', entityId: id, before: { status: t.status }, after: { status }, meta: { messageId: m!.id, internal: input.internal } });
    return { messageId: m!.id, status };
  });
  return { id, ...out };
}

export async function updateTicket(ctx: AdminCtx, id: string, input: { status?: (typeof TICKET_STATUSES)[number] | undefined; priority?: (typeof PRIORITIES)[number] | undefined; note?: string | undefined }) {
  if (!input.status && !input.priority) throw Errors.validation({ issues: [{ path: '', message: 'status atau priority wajib' }] });
  const now = ctx.deps.clock.now();
  const sla = await ctx.deps.config.get('support.sla');
  const out = await inAdminTx(ctx, async (tx) => {
    const t = await lockTicket(tx, id);
    if (t.status === 'CLOSED' && input.status !== 'OPEN') throw Errors.unprocessable('TICKET_CLOSED', 'Tiket sudah ditutup');
    const status = input.status ?? t.status;
    const priority = input.priority ?? t.priority;
    const ms = milestones(status, now);
    const slaDue = !t.first_response_at && priority !== t.priority ? new Date(t.created_at.getTime() + (sla.hoursByPriority[priority as (typeof PRIORITIES)[number]] ?? 24) * 3600_000) : null;
    await tx`UPDATE support_tickets
                SET status = ${status}, priority = ${priority},
                    sla_due_at = coalesce(${slaDue}::timestamptz, sla_due_at),
                    resolved_at = coalesce(${ms.resolved}::timestamptz, resolved_at),
                    closed_at = coalesce(${ms.closed}::timestamptz, closed_at)
              WHERE id = ${id}`;
    if (status !== t.status) await emitEvent(tx, 'support_ticket', id, 'support.ticket_updated', { ticketId: id, userId: t.user_id, status, actorType: 'AGENT', action: 'STATUS_CHANGED' });
    await adminAudit(tx, ctx, { action: 'support.ticket_updated', entityType: 'support_ticket', entityId: id, before: { status: t.status, priority: t.priority }, after: { status, priority }, meta: { note: input.note ?? null } });
    return { status, priority, slaDueAt: iso(slaDue ?? t.sla_due_at) };
  });
  return { id, ...out };
}

export async function slaView(ctx: AdminCtx) {
  const db = ctx.deps.sql;
  const now = ctx.deps.clock.now();
  const sla = await ctx.deps.config.get('support.sla');
  const rows = await db<{ priority: string; open: number; waiting: number; breached: number; due_soon: number }[]>`
    SELECT priority, count(*)::int AS open,
           count(*) FILTER (WHERE first_response_at IS NULL)::int AS waiting,
           count(*) FILTER (WHERE first_response_at IS NULL AND sla_due_at < ${now})::int AS breached,
           count(*) FILTER (WHERE first_response_at IS NULL AND sla_due_at BETWEEN ${now} AND ${new Date(now.getTime() + 4 * 3600_000)})::int AS due_soon
      FROM support_tickets WHERE status NOT IN ('RESOLVED','CLOSED') GROUP BY priority`;
  const [frt] = await db<{ n: number; median_h: number | null; met: number }[]>`
    SELECT count(*)::int AS n,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (first_response_at - created_at)) / 3600) AS median_h,
           count(*) FILTER (WHERE first_response_at <= sla_due_at)::int AS met
      FROM support_tickets WHERE first_response_at IS NOT NULL AND created_at >= ${new Date(now.getTime() - 30 * 86400_000)}`;
  return {
    hoursByPriority: sla.hoursByPriority,
    definition: 'SLA = batas respons pertama agen (sla_due_at = dibuat + jam per prioritas dari config support.sla). BREACHED = belum ada respons publik dan batas sudah lewat.',
    byPriority: PRIORITIES.map((p) => {
      const r = rows.find((x) => x.priority === p);
      return { priority: p, slaHours: sla.hoursByPriority[p], open: r?.open ?? 0, awaitingFirstResponse: r?.waiting ?? 0, breached: r?.breached ?? 0, dueWithin4h: r?.due_soon ?? 0 };
    }),
    last30Days: {
      responded: frt?.n ?? 0,
      medianFirstResponseHours: frt?.median_h === null || frt?.median_h === undefined ? null : Math.round(Number(frt.median_h) * 10) / 10,
      slaMetRatio: frt && frt.n > 0 ? Math.round((frt.met / frt.n) * 10000) / 10000 : null,
      dataQuality: !frt || frt.n < 30 ? `Sampel kecil (n=${frt?.n ?? 0}).` : null,
    },
  };
}

// ------------------------------------------------------------------ chat moderation

interface MessageRow {
  id: string;
  conversation_id: string;
  sender_id: string | null;
  type: string;
  body: string | null;
  attachments: unknown;
  meta: Record<string, unknown>;
  moderation_status: string;
  moderation_reason: string | null;
  moderated_by: string | null;
  moderated_at: Date | null;
  created_at: Date;
  deleted_at: Date | null;
  tx_number?: string | null;
  transaction_id?: string | null;
  sender_name?: string | null;
}

function maskedMessage(m: MessageRow) {
  return {
    id: m.id,
    conversationId: m.conversation_id,
    transactionId: m.transaction_id ?? null,
    transactionNumber: m.tx_number ?? null,
    senderId: m.sender_id,
    senderDisplayName: maskName(m.sender_name ?? null),
    type: m.type,
    maskedBody: m.moderation_status === 'HIDDEN' ? String(m.meta?.hiddenMaskedBody ?? m.meta?.maskedBody ?? '[disembunyikan]') : typeof m.meta?.maskedBody === 'string' ? (m.meta.maskedBody as string) : null,
    moderationStatus: m.moderation_status,
    reasons: m.moderation_reason ? m.moderation_reason.split(',') : [],
    moderatedBy: m.moderated_by,
    moderatedAt: iso(m.moderated_at),
    createdAt: iso(m.created_at)!,
  };
}

export async function flaggedQueue(ctx: AdminCtx, q: { status?: string | undefined; limit: number; cursor?: string | undefined }) {
  const db = ctx.deps.sql;
  const statuses = parseCsv(q.status, ['FLAGGED', 'HIDDEN'] as const, 'status') ?? ['FLAGGED'];
  const cursor = decodeKey(q.cursor);
  const r = await db<MessageRow[]>`
    SELECT m.*, c.transaction_id, t.number AS tx_number, u.display_name AS sender_name
      FROM messages m JOIN conversations c ON c.id = m.conversation_id
      LEFT JOIN transactions t ON t.id = c.transaction_id LEFT JOIN users u ON u.id = m.sender_id
     WHERE m.moderation_status = ANY(${statuses}::text[]) AND m.deleted_at IS NULL
       ${cursor ? db`AND (m.created_at, m.id) > (${cursor.t}::timestamptz, ${cursor.id}::uuid)` : db``}
     ORDER BY m.created_at, m.id LIMIT ${q.limit + 1}`;
  const more = r.length > q.limit;
  const data = r.slice(0, q.limit).map(maskedMessage);
  const last = data[data.length - 1];
  return { data, nextCursor: more && last ? encodeKey({ t: last.createdAt, id: last.id }) : null };
}

async function lockMessage(tx: TxSql, id: string): Promise<MessageRow> {
  const [m] = await tx<MessageRow[]>`SELECT * FROM messages WHERE id = ${id} FOR UPDATE`;
  if (!m) throw Errors.notFound('Pesan', 'MESSAGE_NOT_FOUND');
  return m;
}

export async function revealMessage(ctx: AdminCtx, id: string, reason: string) {
  const m = await inAdminTx(ctx, async (tx) => {
    const row = await lockMessage(tx, id);
    if (row.moderation_status === 'CLEAN') throw Errors.unprocessable('MESSAGE_NOT_MODERATED', 'Hanya pesan FLAGGED/HIDDEN yang dapat dibuka dari antrean moderasi; gunakan akses percakapan terkait dispute/tiket');
    await adminAudit(tx, ctx, { action: 'chat.message_revealed', entityType: 'message', entityId: id, meta: { reason, conversationId: row.conversation_id, moderationStatus: row.moderation_status } });
    return row;
  });
  return { id, body: m.body, attachments: m.attachments, moderationStatus: m.moderation_status, reasons: m.moderation_reason ? m.moderation_reason.split(',') : [], revealedAt: ctx.deps.clock.now().toISOString() };
}

export async function hideMessage(ctx: AdminCtx, id: string, reason: string) {
  const now = ctx.deps.clock.now();
  await inAdminTx(ctx, async (tx) => {
    const m = await lockMessage(tx, id);
    if (m.moderation_status === 'HIDDEN') throw Errors.conflict('MESSAGE_ALREADY_HIDDEN', 'Pesan sudah disembunyikan');
    if (m.type === 'SYSTEM' || m.type === 'STATUS') throw Errors.unprocessable('MESSAGE_SYSTEM', 'Pesan sistem tidak dapat disembunyikan');
    const meta = { ...(m.meta ?? {}), moderation: { previousStatus: m.moderation_status, previousReason: m.moderation_reason, hiddenReason: reason, hiddenBy: ctx.auth.userId, hiddenAt: now.toISOString() } };
    await tx`UPDATE messages SET moderation_status = 'HIDDEN', moderation_reason = ${m.moderation_reason ?? 'ADMIN_HIDDEN'}, moderated_by = ${ctx.auth.userId},
                    moderated_at = ${now}, meta = ${tx.json(meta as never)} WHERE id = ${id}`;
    await adminAudit(tx, ctx, { action: 'chat.message_hidden', entityType: 'message', entityId: id, before: { moderationStatus: m.moderation_status }, after: { moderationStatus: 'HIDDEN' }, meta: { reason } });
  });
  return { id, moderationStatus: 'HIDDEN' };
}

export async function unhideMessage(ctx: AdminCtx, id: string, reason: string) {
  const now = ctx.deps.clock.now();
  const status = await inAdminTx(ctx, async (tx) => {
    const m = await lockMessage(tx, id);
    if (m.moderation_status !== 'HIDDEN') throw Errors.unprocessable('MESSAGE_NOT_HIDDEN', 'Pesan tidak sedang disembunyikan');
    const prev = (m.meta?.moderation as { previousStatus?: string; previousReason?: string | null } | undefined) ?? {};
    const to = prev.previousStatus === 'FLAGGED' ? 'FLAGGED' : 'CLEAN';
    const meta = { ...(m.meta ?? {}), moderation: { ...(m.meta?.moderation as object), unhiddenBy: ctx.auth.userId, unhiddenAt: now.toISOString(), unhideReason: reason } };
    await tx`UPDATE messages SET moderation_status = ${to}, moderation_reason = ${to === 'FLAGGED' ? (prev.previousReason ?? m.moderation_reason) : null},
                    moderated_by = ${ctx.auth.userId}, moderated_at = ${now}, meta = ${tx.json(meta as never)} WHERE id = ${id}`;
    await adminAudit(tx, ctx, { action: 'chat.message_unhidden', entityType: 'message', entityId: id, before: { moderationStatus: 'HIDDEN' }, after: { moderationStatus: to }, meta: { reason } });
    return to;
  });
  return { id, moderationStatus: status };
}

/** Moderator view of a conversation — only with an OPEN dispute or OPEN ticket on its transaction (audited). */
export async function readConversation(ctx: AdminCtx, conversationId: string, q: { disputeId?: string | undefined; ticketId?: string | undefined; reason: string; limit: number }) {
  const db = ctx.deps.sql;
  if (!q.disputeId && !q.ticketId) throw Errors.forbidden('Akses percakapan hanya dengan dasar dispute atau tiket yang masih terbuka', 'CHAT_ACCESS_SCOPE_REQUIRED');
  const [c] = await db<{ id: string; transaction_id: string | null; request_id: string | null }[]>`SELECT id, transaction_id, request_id FROM conversations WHERE id = ${conversationId}`;
  if (!c) throw Errors.notFound('Percakapan', 'CONVERSATION_NOT_FOUND');
  let basis: { type: 'DISPUTE' | 'TICKET'; id: string } | null = null;
  if (q.disputeId) {
    const [d] = await db<{ id: string }[]>`SELECT id FROM disputes WHERE id = ${q.disputeId} AND transaction_id = ${c.transaction_id} AND status <> 'CLOSED'`;
    if (d) basis = { type: 'DISPUTE', id: d.id };
  }
  if (!basis && q.ticketId) {
    const [t] = await db<{ id: string }[]>`
      SELECT t.id FROM support_tickets t
       WHERE t.id = ${q.ticketId} AND t.status NOT IN ('RESOLVED','CLOSED')
         AND (t.transaction_id = ${c.transaction_id} OR t.dispute_id IN (SELECT id FROM disputes WHERE transaction_id = ${c.transaction_id}))`;
    if (t) basis = { type: 'TICKET', id: t.id };
  }
  if (!basis) throw Errors.forbidden('Percakapan ini tidak terkait dispute/tiket terbuka yang Anda sebutkan', 'CHAT_ACCESS_OUT_OF_SCOPE');
  const msgs = await db<MessageRow[]>`
    SELECT m.*, u.display_name AS sender_name FROM messages m LEFT JOIN users u ON u.id = m.sender_id
     WHERE m.conversation_id = ${conversationId} ORDER BY m.created_at DESC, m.id DESC LIMIT ${q.limit}`;
  await inAdminTx(ctx, async (tx) => {
    await adminAudit(tx, ctx, { action: 'chat.conversation_viewed', entityType: 'conversation', entityId: conversationId, meta: { basis, reason: q.reason, messages: msgs.length } });
  });
  return {
    conversationId,
    transactionId: c.transaction_id,
    basis,
    data: msgs.map((m) => ({
      id: m.id,
      senderId: m.sender_id,
      senderDisplayName: maskName(m.sender_name ?? null),
      type: m.type,
      body: m.deleted_at ? null : m.body,
      attachments: m.attachments,
      moderationStatus: m.moderation_status,
      reasons: m.moderation_reason ? m.moderation_reason.split(',') : [],
      deleted: !!m.deleted_at,
      createdAt: iso(m.created_at)!,
    })),
  };
}
