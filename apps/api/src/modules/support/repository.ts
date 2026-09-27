import type { Db, TxSql } from '../../db/sql';

export interface FaqRow {
  slug: string;
  locale: string;
  category: string;
  question: string;
  answer_md: string;
  tags: string[];
  sort_order: number;
  updated_at: Date;
  score?: number;
}

/** Published FAQ in `locale`, falling back to the Indonesian article for slugs without a translation. */
export function listFaq(db: Db, opts: { locale: string; category?: string | undefined; q?: string | undefined; limit: number }) {
  const q = opts.q?.trim().toLowerCase();
  // LIKE pattern with %, _ and \ escaped (default LIKE escape character is backslash)
  const like = q ? `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%` : '';
  return db<FaqRow[]>`
    WITH localized AS (
      SELECT DISTINCT ON (slug) slug, locale, category, question, answer_md, tags, sort_order, updated_at, search_text
        FROM faq_articles
       WHERE status = 'PUBLISHED' AND locale IN (${opts.locale}, 'id')
         ${opts.category ? db`AND category = ${opts.category}` : db``}
       ORDER BY slug, (locale = ${opts.locale}) DESC)
    SELECT slug, locale, category, question, answer_md, tags, sort_order, updated_at,
           ${
             q
               ? db`(0.6 * word_similarity(${q}, lower(question)) + 0.4 * word_similarity(${q}, lower(search_text))
                     + CASE WHEN lower(question) LIKE ${like} THEN 0.5 ELSE 0 END)`
               : db`0`
           }::float8 AS score
      FROM localized
     ${
       q
         ? db`WHERE lower(search_text) LIKE ${like} OR word_similarity(${q}, lower(search_text)) >= 0.35
                  OR EXISTS (SELECT 1 FROM unnest(tags) tg WHERE lower(tg) = ${q})`
         : db``
     }
     ORDER BY ${q ? db`score DESC,` : db``} sort_order, slug
     LIMIT ${opts.limit}`;
}

export async function faqBySlug(db: Db, slug: string, locale: string): Promise<FaqRow | null> {
  const [r] = await db<FaqRow[]>`
    SELECT slug, locale, category, question, answer_md, tags, sort_order, updated_at FROM faq_articles
     WHERE slug = ${slug} AND status = 'PUBLISHED' AND locale IN (${locale}, 'id')
     ORDER BY (locale = ${locale}) DESC LIMIT 1`;
  return r ?? null;
}

export interface TicketRow {
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
  sla_due_at: Date | null;
  first_response_at: Date | null;
  resolved_at: Date | null;
  closed_at: Date | null;
  created_at: Date;
  updated_at: Date;
  cursor_t?: string;
}

export async function insertTicket(
  tx: TxSql,
  t: { userId: string; category: string; subject: string; priority: string; transactionId: string | null; disputeId: string | null; slaDueAt: Date; now: Date },
): Promise<TicketRow> {
  const [row] = await tx<TicketRow[]>`
    INSERT INTO support_tickets (user_id, category, channel, subject, priority, transaction_id, dispute_id, sla_due_at, created_at)
    VALUES (${t.userId}, ${t.category}, 'APP', ${t.subject}, ${t.priority}, ${t.transactionId}, ${t.disputeId}, ${t.slaDueAt}, ${t.now})
    RETURNING *`;
  return row!;
}

export async function insertTicketMessage(tx: TxSql, m: { ticketId: string; authorId: string; body: string; attachments: unknown[]; now: Date }) {
  const [row] = await tx<{ id: string; created_at: Date }[]>`
    INSERT INTO ticket_messages (ticket_id, author_id, author_type, body, attachments, created_at)
    VALUES (${m.ticketId}, ${m.authorId}, 'USER', ${m.body}, ${tx.json(m.attachments as never)}, clock_timestamp())
    RETURNING id, created_at`;
  return row!;
}

export async function ticketOfUser(db: Db, id: string, userId: string, forUpdate = false): Promise<TicketRow | null> {
  const [t] = await db<TicketRow[]>`SELECT * FROM support_tickets WHERE id = ${id} AND user_id = ${userId} ${forUpdate ? db`FOR UPDATE` : db``}`;
  return t ?? null;
}

export function ticketsOfUser(db: Db, userId: string, opts: { status?: string | undefined; cursor: { t: string; id: string } | null; limit: number }) {
  return db<TicketRow[]>`
    SELECT *, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_t FROM support_tickets
     WHERE user_id = ${userId}
       ${opts.status ? db`AND status = ${opts.status}` : db``}
       ${opts.cursor ? db`AND (created_at, id) < (${opts.cursor.t}::timestamptz, ${opts.cursor.id}::uuid)` : db``}
     ORDER BY created_at DESC, id DESC LIMIT ${opts.limit}`;
}

export function publicMessages(db: Db, ticketId: string) {
  return db<{ id: string; author_type: string; author_id: string | null; body: string; attachments: unknown[]; created_at: Date }[]>`
    SELECT id, author_type, author_id, body, attachments, created_at FROM ticket_messages
     WHERE ticket_id = ${ticketId} AND NOT internal_note ORDER BY created_at, id`;
}

export async function setStatus(tx: TxSql, id: string, status: string) {
  await tx`UPDATE support_tickets SET status = ${status}, resolved_at = CASE WHEN ${status} = 'OPEN' THEN NULL ELSE resolved_at END WHERE id = ${id}`;
}
