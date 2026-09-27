/**
 * Outbox: conversation per transaction (created when the transaction reaches MATCHED) and a STATUS
 * message (Indonesian) for every status change afterwards. Idempotent: one conversation per
 * transaction (unique index) and one status message per (conversation, source outbox event).
 */
import type { TxSql } from '../../db/sql';
import { CHAT_STATUS_TEXT } from '../notifications/templates/labels';
import { pid, pstr, type EventPart } from '../notifications/util';
import { ensureTransactionConversation, insertSystemMessage } from './repository';

export const chatOnTransactionStatus: EventPart = async function chatStatus(deps, ev) {
  const txId = pid(ev.payload, 'transactionId');
  const to = pstr(ev.payload, 'to');
  if (!txId || !to) return;
  await deps.sql.begin(async (t) => {
    const tx = t as unknown as TxSql;
    // Created at MATCHED; later events (or a replay after a failed MATCHED handler) also ensure it exists.
    const conv = await ensureTransactionConversation(tx, txId);
    if (!conv) return; // no traveler yet (e.g. REQUEST_CREATED → CANCELLED)
    const template = CHAT_STATUS_TEXT[to as keyof typeof CHAT_STATUS_TEXT];
    if (!template) return;
    const number = pstr(ev.payload, 'number') ?? '';
    await insertSystemMessage(tx, conv.id, 'STATUS', template.replace('{number}', number), {
      sourceEventId: ev.eventId,
      status: to,
      from: pstr(ev.payload, 'from') ?? null,
    });
  });
};
