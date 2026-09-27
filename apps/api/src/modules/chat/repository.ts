import type { Db, TxSql } from '../../db/sql';
import type { Cursor } from '../../lib/pagination';

export interface ConversationRow {
  id: string;
  transaction_id: string | null;
  request_id: string | null;
  buyer_id: string;
  traveler_id: string;
  status: string;
  last_message_at: Date | null;
  created_at: Date;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  sender_id: string | null;
  type: string;
  body: string | null;
  attachments: unknown[];
  meta: Record<string, unknown>;
  moderation_status: string;
  moderation_reason: string | null;
  created_at: Date;
}

export async function getConversation(db: Db, id: string): Promise<ConversationRow | null> {
  const [c] = await db<ConversationRow[]>`
    SELECT id, transaction_id, request_id, buyer_id, traveler_id, status, last_message_at, created_at FROM conversations WHERE id = ${id}`;
  return c ?? null;
}

export async function getConversationByTransaction(db: Db, transactionId: string): Promise<ConversationRow | null> {
  const [c] = await db<ConversationRow[]>`
    SELECT id, transaction_id, request_id, buyer_id, traveler_id, status, last_message_at, created_at FROM conversations WHERE transaction_id = ${transactionId}`;
  return c ?? null;
}

/**
 * One conversation per transaction (participants buyer & traveler). A pre-match conversation for the
 * same (request, traveler) — e.g. offer negotiation — is adopted instead of creating a second one.
 */
export async function ensureTransactionConversation(tx: TxSql, transactionId: string): Promise<ConversationRow | null> {
  const [t] = await tx<{ id: string; request_id: string; buyer_id: string; traveler_id: string | null }[]>`
    SELECT id, request_id, buyer_id, traveler_id FROM transactions WHERE id = ${transactionId}`;
  if (!t?.traveler_id) return null;
  const existing = await getConversationByTransaction(tx, transactionId);
  if (existing) return existing;
  const [adopted] = await tx<{ id: string }[]>`
    UPDATE conversations SET transaction_id = ${t.id}
     WHERE request_id = ${t.request_id} AND traveler_id = ${t.traveler_id} AND transaction_id IS NULL
    RETURNING id`;
  if (!adopted) {
    await tx`
      INSERT INTO conversations (transaction_id, request_id, buyer_id, traveler_id)
      VALUES (${t.id}, ${t.request_id}, ${t.buyer_id}, ${t.traveler_id})
      ON CONFLICT (transaction_id) WHERE transaction_id IS NOT NULL DO NOTHING`;
  }
  return getConversationByTransaction(tx, transactionId);
}

export async function insertSystemMessage(
  db: Db,
  conversationId: string,
  type: 'SYSTEM' | 'STATUS',
  body: string,
  meta: Record<string, unknown>,
): Promise<string | null> {
  const [m] = await db<{ id: string }[]>`
    INSERT INTO messages (conversation_id, sender_id, type, body, meta, created_at)
    VALUES (${conversationId}, NULL, ${type}, ${body}, ${db.json(meta as never)}, clock_timestamp())
    ON CONFLICT (conversation_id, (meta->>'sourceEventId')) WHERE meta ? 'sourceEventId' DO NOTHING
    RETURNING id`;
  return m?.id ?? null;
}

export async function insertMessage(
  tx: TxSql,
  m: { conversationId: string; senderId: string; type: string; body: string | null; attachments: unknown[]; meta: Record<string, unknown>; moderationStatus: string; moderationReason: string | null },
): Promise<MessageRow> {
  const [row] = await tx<MessageRow[]>`
    INSERT INTO messages (conversation_id, sender_id, type, body, attachments, meta, moderation_status, moderation_reason, created_at)
    VALUES (${m.conversationId}, ${m.senderId}, ${m.type}, ${m.body}, ${tx.json(m.attachments as never)}, ${tx.json(m.meta as never)},
            ${m.moderationStatus}, ${m.moderationReason}, clock_timestamp())
    RETURNING id, conversation_id, sender_id, type, body, attachments, meta, moderation_status, moderation_reason, created_at`;
  return row!;
}

export type ConversationListRow = Awaited<ReturnType<typeof listConversations>>[number];

/** Conversations of `userId` (participant), newest activity first; `onlyId` narrows to one conversation. */
export function listConversations(db: Db, userId: string, opts: { cursor: Cursor | null; limit: number; onlyId?: string }) {
  return db<
    (ConversationRow & {
      sort_at: string;
      tx_number: string | null;
      tx_status: string | null;
      product_name: string | null;
      buyer_name: string | null;
      traveler_name: string | null;
      unread: number;
      last_id: string | null;
      last_type: string | null;
      last_body: string | null;
      last_meta: Record<string, unknown> | null;
      last_moderation: string | null;
      last_sender: string | null;
      last_created_at: Date | null;
    })[]
  >`
    SELECT c.id, c.transaction_id, c.request_id, c.buyer_id, c.traveler_id, c.status, c.last_message_at, c.created_at,
           to_char(coalesce(c.last_message_at, c.created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sort_at,
           t.number AS tx_number, t.status AS tx_status, r.product_name,
           bu.display_name AS buyer_name, tu.display_name AS traveler_name,
           (SELECT count(*)::int FROM messages m
             WHERE m.conversation_id = c.id AND m.deleted_at IS NULL AND m.sender_id IS DISTINCT FROM ${userId}
               AND (lrm.id IS NULL OR (m.created_at, m.id) > (lrm.created_at, lrm.id))) AS unread,
           lm.id AS last_id, lm.type AS last_type, lm.body AS last_body, lm.meta AS last_meta,
           lm.moderation_status AS last_moderation, lm.sender_id AS last_sender, lm.created_at AS last_created_at
      FROM conversations c
      LEFT JOIN transactions t ON t.id = c.transaction_id
      LEFT JOIN requests r ON r.id = coalesce(t.request_id, c.request_id)
      JOIN users bu ON bu.id = c.buyer_id
      JOIN users tu ON tu.id = c.traveler_id
      LEFT JOIN message_reads mr ON mr.conversation_id = c.id AND mr.user_id = ${userId}
      LEFT JOIN messages lrm ON lrm.id = mr.last_read_message_id
      LEFT JOIN LATERAL (
        SELECT id, type, body, meta, moderation_status, sender_id, created_at FROM messages
         WHERE conversation_id = c.id AND deleted_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 1) lm ON true
     WHERE (c.buyer_id = ${userId} OR c.traveler_id = ${userId})
       ${opts.onlyId ? db`AND c.id = ${opts.onlyId}::uuid` : db``}
       ${opts.cursor ? db`AND (coalesce(c.last_message_at, c.created_at), c.id) < (${opts.cursor.t}::timestamptz, ${opts.cursor.id}::uuid)` : db``}
     ORDER BY coalesce(c.last_message_at, c.created_at) DESC, c.id DESC
     LIMIT ${opts.limit}`;
}

/** Cursor timestamps are µs-precise text: JS Dates truncate to ms and would skip rows created within the same ms. */
export function listMessages(db: Db, conversationId: string, opts: { cursor: Cursor | null; limit: number }) {
  return db<(MessageRow & { cursor_t: string })[]>`
    SELECT id, conversation_id, sender_id, type, body, attachments, meta, moderation_status, moderation_reason, created_at,
           to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_t
      FROM messages
     WHERE conversation_id = ${conversationId} AND deleted_at IS NULL
       ${opts.cursor ? db`AND (created_at, id) < (${opts.cursor.t}::timestamptz, ${opts.cursor.id}::uuid)` : db``}
     ORDER BY created_at DESC, id DESC
     LIMIT ${opts.limit}`;
}

export async function latestMessageId(db: Db, conversationId: string): Promise<string | null> {
  const [m] = await db<{ id: string }[]>`
    SELECT id FROM messages WHERE conversation_id = ${conversationId} AND deleted_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 1`;
  return m?.id ?? null;
}

export async function upsertRead(db: Db, conversationId: string, userId: string, messageId: string | null, now: Date) {
  const [r] = await db<{ last_read_message_id: string | null; last_read_at: Date }[]>`
    INSERT INTO message_reads (conversation_id, user_id, last_read_message_id, last_read_at)
    VALUES (${conversationId}, ${userId}, ${messageId}, ${now})
    ON CONFLICT (conversation_id, user_id) DO UPDATE
       SET last_read_message_id = EXCLUDED.last_read_message_id, last_read_at = EXCLUDED.last_read_at
    RETURNING last_read_message_id, last_read_at`;
  return r!;
}

export function chatFiles(db: Db, ids: string[]) {
  return db<{ id: string; owner_id: string | null; purpose: string; mime: string; scan_status: string; deleted_at: Date | null; size_bytes: number }[]>`
    SELECT id, owner_id, purpose, mime, scan_status, deleted_at, size_bytes FROM files WHERE id = ANY(${db.array(ids)}::uuid[])`;
}
