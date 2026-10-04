import type { AppDeps, AuthContext } from '../../context';
import type { TxSql } from '../../db/sql';
import { Errors } from '../../lib/errors';
import { decodeCursor, encodeCursor } from '../../lib/pagination';
import { emitEvent } from '../../services/outbox';
import { truncate } from '../notifications/templates/format';
import { ESCALATION, LEGAL_BASIS, publishedChannels } from './complaint-info';
import * as repo from './repository';
import type { FAQ_CATEGORIES, TICKET_CATEGORIES, TICKET_PRIORITIES, TICKET_STATUSES, USER_TICKET_PRIORITIES } from './schemas';

type TicketCategory = (typeof TICKET_CATEGORIES)[number];
type TicketPriority = (typeof TICKET_PRIORITIES)[number];

/** Categories that default to priority HIGH (COMPLAINT: consumer complaint channel, Permendag 19/2026). */
const HIGH_PRIORITY: ReadonlySet<TicketCategory> = new Set<TicketCategory>(['COMPLAINT', 'DISPUTE', 'REFUND', 'PAYMENT']);

/** Default priority of a user-filed ticket. URGENT is set by agents only. */
export function defaultPriority(category: TicketCategory): TicketPriority {
  return HIGH_PRIORITY.has(category) ? 'HIGH' : 'NORMAL';
}

type FaqCategory = (typeof FAQ_CATEGORIES)[number];

function excerpt(md: string): string {
  return truncate(md.replace(/[*_`#>[\]()]/g, '').replace(/\s+/g, ' '), 200);
}

export async function listFaq(deps: AppDeps, q: { locale: 'id' | 'en'; category?: FaqCategory | undefined; q?: string | undefined; limit: number }) {
  const rows = await repo.listFaq(deps.sql, q);
  return {
    data: rows.map((r) => ({
      slug: r.slug,
      locale: r.locale as 'id' | 'en',
      category: r.category as FaqCategory,
      question: r.question,
      excerpt: excerpt(r.answer_md),
      tags: r.tags,
      score: q.q ? Math.round(Number(r.score ?? 0) * 1000) / 1000 : null,
    })),
  };
}

export async function faqArticle(deps: AppDeps, slug: string, locale: 'id' | 'en') {
  const r = await repo.faqBySlug(deps.sql, slug, locale);
  if (!r) throw Errors.notFound('Artikel FAQ', 'FAQ_NOT_FOUND');
  return { slug: r.slug, locale: r.locale as 'id' | 'en', category: r.category as FaqCategory, question: r.question, answerMd: r.answer_md, tags: r.tags, updatedAt: r.updated_at.toISOString() };
}

function ticketDto(t: repo.TicketRow) {
  return {
    id: t.id,
    number: t.number,
    category: t.category as TicketCategory,
    subject: t.subject,
    status: t.status as (typeof TICKET_STATUSES)[number],
    priority: t.priority as TicketPriority,
    transactionId: t.transaction_id,
    disputeId: t.dispute_id,
    slaDueAt: t.sla_due_at?.toISOString() ?? null,
    firstResponseAt: t.first_response_at?.toISOString() ?? null,
    resolvedAt: t.resolved_at?.toISOString() ?? null,
    createdAt: t.created_at.toISOString(),
    updatedAt: t.updated_at.toISOString(),
  };
}

async function attachments(deps: AppDeps, userId: string, fileIds: string[] | undefined) {
  const ids = [...new Set(fileIds ?? [])];
  if (ids.length === 0) return [];
  const files = await deps.sql<{ id: string; mime: string }[]>`
    SELECT id, mime FROM files WHERE id = ANY(${deps.sql.array(ids)}::uuid[]) AND owner_id = ${userId} AND deleted_at IS NULL
       AND scan_status <> 'INFECTED' AND purpose IN ('EVIDENCE','CHAT','RECEIPT','PRODUCT_PHOTO','DELIVERY_PROOF')`;
  if (files.length !== ids.length) throw Errors.unprocessable('ATTACHMENT_NOT_ALLOWED', 'Lampiran tidak ditemukan atau bukan milikmu');
  return files.map((f) => ({ fileId: f.id, mime: f.mime }));
}

export async function createTicket(
  deps: AppDeps,
  auth: AuthContext,
  input: {
    category: TicketCategory;
    subject: string;
    message: string;
    transactionId?: string | undefined;
    disputeId?: string | undefined;
    fileIds?: string[] | undefined;
    priority?: (typeof USER_TICKET_PRIORITIES)[number] | undefined;
  },
) {
  let transactionId = input.transactionId ?? null;
  if (transactionId) {
    const [t] = await deps.sql`SELECT 1 FROM transactions WHERE id = ${transactionId} AND (buyer_id = ${auth.userId} OR traveler_id = ${auth.userId})`;
    if (!t) throw Errors.unprocessable('TRANSACTION_NOT_LINKABLE', 'Transaksi bukan milikmu');
  }
  const disputeId = input.disputeId ?? null;
  if (disputeId) {
    const [d] = await deps.sql<{ transaction_id: string }[]>`
      SELECT d.transaction_id FROM disputes d JOIN transactions t ON t.id = d.transaction_id
       WHERE d.id = ${disputeId} AND (t.buyer_id = ${auth.userId} OR t.traveler_id = ${auth.userId})`;
    if (!d) throw Errors.unprocessable('DISPUTE_NOT_LINKABLE', 'Dispute bukan milikmu');
    transactionId = transactionId ?? d.transaction_id;
  }
  const files = await attachments(deps, auth.userId, input.fileIds);
  const priority: TicketPriority = input.priority ?? defaultPriority(input.category);
  // first-response SLA from versioned config (maker-checker in admin), same source as the admin queue
  const sla = await deps.config.get('support.sla');
  const now = deps.clock.now();
  const slaDueAt = new Date(now.getTime() + sla.hoursByPriority[priority] * 3600_000);
  const ticket = await deps.sql.begin(async (tq) => {
    const tx = tq as unknown as TxSql;
    const t = await repo.insertTicket(tx, { userId: auth.userId, category: input.category, subject: input.subject, priority, transactionId, disputeId, slaDueAt, now });
    await repo.insertTicketMessage(tx, { ticketId: t.id, authorId: auth.userId, body: input.message, attachments: files, now });
    await emitEvent(tx, 'support_ticket', t.id, 'support.ticket_updated', { ticketId: t.id, userId: auth.userId, status: t.status, actorType: 'USER', action: 'CREATED', priority, category: input.category });
    return t;
  });
  return getTicket(deps, auth, ticket.id);
}

/**
 * Public consumer-complaint information (L12): JastipKita channels (env), first-response SLA by priority (config
 * `support.sla`), the government escalation channel and the legal basis. No personal data; cacheable.
 */
export async function complaintInfo(deps: Pick<AppDeps, 'config' | 'env'>) {
  const sla = await deps.config.get('support.sla');
  const complaintPriority = defaultPriority('COMPLAINT');
  return {
    channels: publishedChannels(deps.env),
    sla: {
      basis: 'FIRST_RESPONSE' as const,
      complaintPriority,
      complaintFirstResponseHours: sla.hoursByPriority[complaintPriority],
      hoursByPriority: { URGENT: sla.hoursByPriority.URGENT, HIGH: sla.hoursByPriority.HIGH, NORMAL: sla.hoursByPriority.NORMAL, LOW: sla.hoursByPriority.LOW },
      configKey: 'support.sla' as const,
      // business-config.defaults.json flags support.sla as an operational assumption until reviewed after soft launch
      isAssumption: true,
    },
    escalation: {
      authority: ESCALATION.authority,
      unit: ESCALATION.unit,
      ministry: ESCALATION.ministry,
      whatsapp: { ...ESCALATION.whatsapp },
      email: ESCALATION.email,
      phone: { ...ESCALATION.phone },
      website: ESCALATION.website,
      verification: { status: ESCALATION.verification.status, accessedAt: ESCALATION.verification.accessedAt, sources: [...ESCALATION.verification.sources] },
      outOfCourt: ESCALATION.outOfCourt,
    },
    disputeFlow: {
      endpoint: '/v1/transactions/{id}/disputes' as const,
      note: 'Masalah pada transaksi yang sudah dibayar (barang tidak sesuai, tidak diterima, rusak) diselesaikan lewat dispute di halaman transaksi; dana tetap ditahan SafePay selama dispute berjalan.',
    },
    legalBasis: [...LEGAL_BASIS],
  };
}

export async function listTickets(deps: AppDeps, auth: AuthContext, q: { limit: number; cursor?: string | undefined; status?: string | undefined }) {
  const cursor = decodeCursor(q.cursor);
  if (q.cursor && (!cursor || Number.isNaN(Date.parse(cursor.t)))) throw Errors.badRequest('CURSOR_INVALID', 'Cursor tidak valid');
  const rows = await repo.ticketsOfUser(deps.sql, auth.userId, { status: q.status, cursor, limit: q.limit + 1 });
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return { data: page.map(ticketDto), nextCursor: rows.length > q.limit && last ? encodeCursor({ t: last.cursor_t!, id: last.id }) : null };
}

export async function getTicket(deps: AppDeps, auth: AuthContext, id: string) {
  const t = await repo.ticketOfUser(deps.sql, id, auth.userId);
  if (!t) throw Errors.notFound('Tiket', 'TICKET_NOT_FOUND');
  const msgs = await repo.publicMessages(deps.sql, t.id);
  return {
    ...ticketDto(t),
    messages: msgs.map((m) => ({
      id: m.id,
      authorType: m.author_type as 'USER' | 'AGENT' | 'SYSTEM',
      mine: m.author_id === auth.userId,
      body: m.body,
      attachments: (m.attachments ?? []) as { fileId: string; mime: string }[],
      createdAt: m.created_at.toISOString(),
    })),
  };
}

export async function addMessage(deps: AppDeps, auth: AuthContext, id: string, input: { body: string; fileIds?: string[] | undefined }) {
  const files = await attachments(deps, auth.userId, input.fileIds);
  const now = deps.clock.now();
  await deps.sql.begin(async (tq) => {
    const tx = tq as unknown as TxSql;
    const t = await repo.ticketOfUser(tx, id, auth.userId, true);
    if (!t) throw Errors.notFound('Tiket', 'TICKET_NOT_FOUND');
    if (t.status === 'CLOSED') throw Errors.unprocessable('TICKET_CLOSED', 'Tiket sudah ditutup. Buat tiket baru bila masih butuh bantuan.');
    await repo.insertTicketMessage(tx, { ticketId: t.id, authorId: auth.userId, body: input.body, attachments: files, now });
    // the user replied: waiting-for-user and resolved tickets go back to the agent queue
    const next = t.status === 'PENDING_USER' || t.status === 'RESOLVED' ? 'OPEN' : t.status;
    if (next !== t.status) await repo.setStatus(tx, t.id, next);
    await emitEvent(tx, 'support_ticket', t.id, 'support.ticket_updated', { ticketId: t.id, userId: auth.userId, status: next, actorType: 'USER', action: 'USER_REPLIED' });
  });
  return getTicket(deps, auth, id);
}
