import type { AppDeps, AuthContext } from '../../context';
import type { TxSql } from '../../db/sql';
import { Errors } from '../../lib/errors';
import { fileContentUrl } from '../../lib/openapi';
import { decodeCursor, encodeCursor } from '../../lib/pagination';
import { emitEvent } from '../../services/outbox';
import { CHAT_SAFETY_TIP } from '../notifications/templates/labels';
import { publicName, truncate } from '../notifications/templates/format';
import { moderateText } from './moderation';
import * as repo from './repository';
import type { MESSAGE_TYPES } from './schemas';

type MessageType = (typeof MESSAGE_TYPES)[number];

const HIDDEN_TEXT = 'Pesan disembunyikan oleh moderator.';
const PUBLIC_META_KEYS = ['requestId', 'productName', 'productUrl', 'purchaseProofId', 'merchantName', 'status', 'from', 'safetyTipFor'];

function visibleBody(m: repo.MessageRow): string | null {
  if (m.moderation_status === 'HIDDEN') return HIDDEN_TEXT;
  if (m.moderation_status === 'FLAGGED') return typeof m.meta?.maskedBody === 'string' ? (m.meta.maskedBody as string) : null;
  return m.body;
}

export function messageDto(m: repo.MessageRow, viewerId: string, apiBaseUrl: string) {
  const meta: Record<string, unknown> = {};
  for (const k of PUBLIC_META_KEYS) if (m.meta && k in m.meta) meta[k] = m.meta[k];
  return {
    id: m.id,
    conversationId: m.conversation_id,
    type: m.type as MessageType,
    senderId: m.sender_id,
    mine: m.sender_id === viewerId,
    body: visibleBody(m),
    attachments:
      m.moderation_status === 'HIDDEN'
        ? []
        : ((m.attachments ?? []) as { fileId: string; mime: string }[]).map((a) => ({ fileId: a.fileId, mime: a.mime, contentUrl: fileContentUrl(apiBaseUrl, a.fileId) })),
    meta,
    moderation: {
      status: m.moderation_status as 'CLEAN' | 'FLAGGED' | 'HIDDEN',
      reasons: m.moderation_reason ? m.moderation_reason.split(',') : [],
    },
    createdAt: m.created_at.toISOString(),
  };
}

/** Participants only; anyone else gets 404 (no existence leak). Admin access lives in the admin group. */
async function participantConversation(deps: AppDeps, auth: AuthContext, id: string) {
  const c = await repo.getConversation(deps.sql, id);
  if (!c || (c.buyer_id !== auth.userId && c.traveler_id !== auth.userId)) throw Errors.notFound('Percakapan', 'CONVERSATION_NOT_FOUND');
  return c;
}

function preview(type: string | null, body: string | null, moderation: string | null, meta: Record<string, unknown> | null): string {
  if (!type) return '';
  if (moderation === 'HIDDEN') return HIDDEN_TEXT;
  if (type === 'IMAGE') return '📷 Foto';
  if (type === 'PRODUCT') return '🛍️ Info produk';
  if (type === 'RECEIPT') return '🧾 Bukti pembelian';
  const text = moderation === 'FLAGGED' ? String(meta?.maskedBody ?? '') : (body ?? '');
  return truncate(text, 120);
}

function parseCursor(raw: string | undefined) {
  const cursor = decodeCursor(raw);
  if (raw && (!cursor || Number.isNaN(Date.parse(cursor.t)) || !/^[0-9a-f-]{36}$/i.test(cursor.id))) {
    throw Errors.badRequest('CURSOR_INVALID', 'Cursor tidak valid');
  }
  return cursor;
}

function conversationDto(r: repo.ConversationListRow, userId: string) {
  const iAmBuyer = r.buyer_id === userId;
  return {
    id: r.id,
    status: r.status as 'OPEN' | 'LOCKED' | 'ARCHIVED',
    myRole: iAmBuyer ? ('BUYER' as const) : ('TRAVELER' as const),
    counterpart: iAmBuyer
      ? { id: r.traveler_id, name: publicName(r.traveler_name, 'Traveler'), role: 'TRAVELER' as const }
      : { id: r.buyer_id, name: publicName(r.buyer_name, 'Penitip'), role: 'BUYER' as const },
    transaction: r.transaction_id ? { id: r.transaction_id, number: r.tx_number!, status: r.tx_status!, productName: r.product_name } : null,
    lastMessage: r.last_id
      ? { id: r.last_id, type: r.last_type!, preview: preview(r.last_type, r.last_body, r.last_moderation, r.last_meta), senderId: r.last_sender, createdAt: r.last_created_at!.toISOString() }
      : null,
    unreadCount: r.unread,
    lastMessageAt: r.last_message_at?.toISOString() ?? null,
    createdAt: r.created_at.toISOString(),
  };
}

export async function listConversations(deps: AppDeps, auth: AuthContext, q: { limit: number; cursor?: string | undefined }) {
  const cursor = parseCursor(q.cursor);
  const rows = await repo.listConversations(deps.sql, auth.userId, { cursor, limit: q.limit + 1 });
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    data: page.map((r) => conversationDto(r, auth.userId)),
    nextCursor: rows.length > q.limit && last ? encodeCursor({ t: last.sort_at, id: last.id }) : null,
  };
}

/** GET /conversations/{id} — participants only (404 otherwise, no existence leak). */
export async function getConversation(deps: AppDeps, auth: AuthContext, id: string) {
  const [row] = await repo.listConversations(deps.sql, auth.userId, { cursor: null, limit: 1, onlyId: id });
  if (!row) throw Errors.notFound('Percakapan', 'CONVERSATION_NOT_FOUND');
  return conversationDto(row, auth.userId);
}

/**
 * GET /transactions/{id}/conversation — the conversation of a transaction for its parties. Normally created by the
 * outbox handler at MATCHED; created here (idempotently, same rules) when missing. Transactions that never reached
 * MATCHED have no traveler conversation → 409 CONVERSATION_NOT_AVAILABLE.
 */
export async function conversationForTransaction(deps: AppDeps, auth: AuthContext, transactionId: string) {
  const [t] = await deps.sql<{ buyer_id: string; traveler_id: string | null; matched: boolean }[]>`
    SELECT t.buyer_id, t.traveler_id,
           EXISTS (SELECT 1 FROM transaction_events e WHERE e.transaction_id = t.id AND e.to_status = 'MATCHED') AS matched
      FROM transactions t WHERE t.id = ${transactionId}`;
  if (!t || (t.buyer_id !== auth.userId && t.traveler_id !== auth.userId)) throw Errors.notFound('Transaksi', 'TRANSACTION_NOT_FOUND');
  let conv = await repo.getConversationByTransaction(deps.sql, transactionId);
  let created = false;
  if (!conv) {
    if (!t.traveler_id || !t.matched) {
      throw Errors.conflict('CONVERSATION_NOT_AVAILABLE', 'Percakapan tersedia setelah traveler dan penitip cocok (MATCHED)');
    }
    conv = await deps.sql.begin(async (q) => repo.ensureTransactionConversation(q as unknown as TxSql, transactionId));
    created = true;
  }
  if (!conv) throw Errors.conflict('CONVERSATION_NOT_AVAILABLE', 'Percakapan tersedia setelah traveler dan penitip cocok (MATCHED)');
  return { conversationId: conv.id, transactionId, created, conversation: await getConversation(deps, auth, conv.id) };
}

export async function listMessages(deps: AppDeps, auth: AuthContext, conversationId: string, q: { limit: number; cursor?: string | undefined }) {
  await participantConversation(deps, auth, conversationId);
  const cursor = parseCursor(q.cursor);
  const rows = await repo.listMessages(deps.sql, conversationId, { cursor, limit: q.limit + 1 });
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    data: page.map((m) => messageDto(m, auth.userId, deps.env.API_BASE_URL)),
    nextCursor: rows.length > q.limit && last ? encodeCursor({ t: last.cursor_t, id: last.id }) : null,
  };
}

export interface SendInput {
  type: MessageType;
  body?: string | undefined;
  fileIds?: string[] | undefined;
  requestId?: string | undefined;
  purchaseProofId?: string | undefined;
}

export async function sendMessage(deps: AppDeps, auth: AuthContext, conversationId: string, input: SendInput) {
  const conv = await participantConversation(deps, auth, conversationId);
  if (input.type === 'SYSTEM' || input.type === 'STATUS') {
    throw Errors.forbidden('Pesan sistem hanya dikirim oleh JastipKita', 'MESSAGE_TYPE_SYSTEM_ONLY');
  }
  if (conv.status !== 'OPEN') throw Errors.conflict('CONVERSATION_LOCKED', 'Percakapan ini sudah ditutup');
  const senderIsTraveler = conv.traveler_id === auth.userId;
  const recipientId = senderIsTraveler ? conv.buyer_id : conv.traveler_id;
  const body = input.body?.trim() ? input.body.trim() : null;
  let attachments: { fileId: string; mime: string }[] = [];
  const meta: Record<string, unknown> = {};

  switch (input.type) {
    case 'TEXT':
      if (!body) throw Errors.validation({ issues: [{ path: 'body', message: 'Pesan tidak boleh kosong' }] });
      break;
    case 'IMAGE': {
      const ids = [...new Set(input.fileIds ?? [])];
      if (ids.length === 0) throw Errors.validation({ issues: [{ path: 'fileIds', message: 'Minimal satu foto' }] });
      const files = await repo.chatFiles(deps.sql, ids);
      for (const id of ids) {
        const f = files.find((x) => x.id === id);
        if (!f || f.owner_id !== auth.userId || f.deleted_at) throw Errors.unprocessable('FILE_NOT_ALLOWED', 'File tidak ditemukan atau bukan milikmu', { fileId: id });
        if (f.purpose !== 'CHAT') throw Errors.unprocessable('FILE_PURPOSE_INVALID', 'File harus diunggah dengan purpose CHAT', { fileId: id });
        if (f.scan_status !== 'CLEAN') throw Errors.unprocessable('FILE_NOT_READY', 'File belum selesai diperiksa', { fileId: id });
        if (!f.mime.startsWith('image/')) throw Errors.unprocessable('FILE_NOT_IMAGE', 'Hanya gambar yang bisa dikirim', { fileId: id });
      }
      attachments = ids.map((id) => ({ fileId: id, mime: files.find((f) => f.id === id)!.mime }));
      break;
    }
    case 'PRODUCT': {
      const [r] = await deps.sql<{ id: string; product_name: string; product_url: string | null }[]>`
        SELECT r.id, r.product_name, r.product_url FROM requests r
         WHERE r.id = ${input.requestId ?? null}::uuid
           AND (r.id = ${conv.request_id}::uuid OR r.id = (SELECT request_id FROM transactions WHERE id = ${conv.transaction_id}::uuid))`;
      if (!r) throw Errors.unprocessable('PRODUCT_REFERENCE_INVALID', 'Produk bukan bagian dari percakapan ini');
      Object.assign(meta, { requestId: r.id, productName: r.product_name, productUrl: r.product_url });
      break;
    }
    case 'RECEIPT': {
      if (!senderIsTraveler) throw Errors.forbidden('Hanya traveler yang bisa membagikan bukti pembelian', 'RECEIPT_TRAVELER_ONLY');
      const [p] = await deps.sql<{ id: string; merchant_name: string }[]>`
        SELECT id, merchant_name FROM purchase_proofs WHERE id = ${input.purchaseProofId ?? null}::uuid AND transaction_id = ${conv.transaction_id}::uuid`;
      if (!p) throw Errors.unprocessable('RECEIPT_REFERENCE_INVALID', 'Bukti pembelian bukan milik transaksi ini');
      Object.assign(meta, { purchaseProofId: p.id, merchantName: p.merchant_name });
      break;
    }
  }

  const mod = body ? moderateText(body) : { flagged: false, reasons: [], masked: '' };
  if (mod.flagged) meta.maskedBody = mod.masked;

  const row = await deps.sql.begin(async (t) => {
    const tx = t as unknown as TxSql;
    const msg = await repo.insertMessage(tx, {
      conversationId,
      senderId: auth.userId,
      type: input.type,
      body,
      attachments,
      meta,
      moderationStatus: mod.flagged ? 'FLAGGED' : 'CLEAN',
      moderationReason: mod.flagged ? mod.reasons.join(',') : null,
    });
    if (mod.flagged) {
      await repo.insertSystemMessage(tx, conversationId, 'SYSTEM', CHAT_SAFETY_TIP, { safetyTipFor: msg.id, sourceEventId: `moderation:${msg.id}` });
    }
    await emitEvent(tx, 'conversation', conversationId, 'chat.message_created', {
      conversationId,
      messageId: msg.id,
      senderId: auth.userId,
      recipientId,
      type: input.type,
      flagged: mod.flagged,
    });
    return msg;
  });
  return messageDto(row, auth.userId, deps.env.API_BASE_URL);
}

export async function markRead(deps: AppDeps, auth: AuthContext, conversationId: string, messageId?: string) {
  await participantConversation(deps, auth, conversationId);
  let target = messageId ?? null;
  if (target) {
    const [m] = await deps.sql<{ id: string }[]>`SELECT id FROM messages WHERE id = ${target} AND conversation_id = ${conversationId}`;
    if (!m) throw Errors.notFound('Pesan', 'MESSAGE_NOT_FOUND');
  } else {
    target = await repo.latestMessageId(deps.sql, conversationId);
  }
  const r = await repo.upsertRead(deps.sql, conversationId, auth.userId, target, deps.clock.now());
  const [u] = await deps.sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM messages m
      LEFT JOIN messages lrm ON lrm.id = ${r.last_read_message_id}::uuid
     WHERE m.conversation_id = ${conversationId} AND m.deleted_at IS NULL AND m.sender_id IS DISTINCT FROM ${auth.userId}
       AND (lrm.id IS NULL OR (m.created_at, m.id) > (lrm.created_at, lrm.id))`;
  return { conversationId, lastReadMessageId: r.last_read_message_id, lastReadAt: r.last_read_at.toISOString(), unreadCount: u?.n ?? 0 };
}
