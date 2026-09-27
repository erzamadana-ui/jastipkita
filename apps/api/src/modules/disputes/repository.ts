import type { Db, TxSql } from '../../db/sql';
import type { Cursor } from '../../lib/pagination';

export interface DisputeRow {
  id: string;
  number: string;
  transaction_id: string;
  opened_by: string;
  opened_by_role: 'BUYER' | 'TRAVELER' | 'ADMIN';
  type: string;
  status: string;
  description: string;
  requested_resolution: string | null;
  resolution: string | null;
  resolution_amount_idr: number | null;
  resolution_note: string | null;
  evidence_due_at: Date | null;
  sla_due_at: Date | null;
  resolved_at: Date | null;
  appealed_at: Date | null;
  closed_at: Date | null;
  sla_breach: string | null;
  version: number;
  created_at: Date;
  tx_number: string;
  tx_status: string;
  buyer_id: string;
  traveler_id: string | null;
  cursor_t: string;
}

const SELECT = (db: Db) => db`
  SELECT d.id, d.number, d.transaction_id, d.opened_by, d.opened_by_role, d.type, d.status, d.description,
         d.requested_resolution, d.resolution, d.resolution_amount_idr, d.resolution_note, d.evidence_due_at, d.sla_due_at,
         d.resolved_at, d.appealed_at, d.closed_at, d.sla_breach, d.version, d.created_at,
         t.number AS tx_number, t.status AS tx_status, t.buyer_id, t.traveler_id,
         to_char(d.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_t
    FROM disputes d JOIN transactions t ON t.id = d.transaction_id`;

export async function getDispute(db: Db, id: string, forUpdate = false): Promise<DisputeRow | null> {
  const [d] = await db<DisputeRow[]>`${SELECT(db)} WHERE d.id = ${id} ${forUpdate ? db`FOR UPDATE OF d` : db``}`;
  return d ?? null;
}

export function listMine(db: Db, userId: string, opts: { status?: string | undefined; cursor: Cursor | null; limit: number }) {
  return db<DisputeRow[]>`
    ${SELECT(db)}
     WHERE (t.buyer_id = ${userId} OR t.traveler_id = ${userId})
       ${opts.status ? db`AND d.status = ${opts.status}` : db``}
       ${opts.cursor ? db`AND (d.created_at, d.id) < (${opts.cursor.t}::timestamptz, ${opts.cursor.id}::uuid)` : db``}
     ORDER BY d.created_at DESC, d.id DESC
     LIMIT ${opts.limit}`;
}

export async function openDisputeFor(db: Db, txId: string) {
  const [d] = await db<{ id: string; number: string }[]>`SELECT id, number FROM disputes WHERE transaction_id = ${txId} AND status <> 'CLOSED'`;
  return d ?? null;
}

export async function transactionForDispute(db: Db, txId: string, forUpdate = false) {
  const [t] = await db<{ id: string; number: string; status: string; version: number; buyer_id: string; traveler_id: string | null; delivered_at: Date | null }[]>`
    SELECT id, number, status, version, buyer_id, traveler_id, delivered_at FROM transactions WHERE id = ${txId} ${forUpdate ? db`FOR UPDATE` : db``}`;
  return t ?? null;
}

export async function insertDispute(
  tx: TxSql,
  d: { transactionId: string; openedBy: string; role: string; type: string; description: string; requestedResolution: string | null; evidenceDueAt: Date; slaDueAt: Date; now: Date },
) {
  const [row] = await tx<{ id: string; number: string; version: number }[]>`
    INSERT INTO disputes (transaction_id, opened_by, opened_by_role, type, description, requested_resolution, evidence_due_at, sla_due_at, created_at)
    VALUES (${d.transactionId}, ${d.openedBy}, ${d.role}, ${d.type}, ${d.description}, ${d.requestedResolution}, ${d.evidenceDueAt}, ${d.slaDueAt}, ${d.now})
    RETURNING id, number, version`;
  return row!;
}

export async function transitionDispute(tx: Db, id: string, version: number, to: string, actorType: string, actorId: string | null, reason: string | null, meta: Record<string, unknown> = {}) {
  const [row] = await tx<{ version: number; status: string }[]>`
    SELECT version, status FROM transition_dispute(${id}, ${version}, ${to}, ${actorType}, ${actorId}, ${reason}, ${tx.json(meta as never)})`;
  return row!;
}

export async function transitionTransaction(tx: Db, id: string, version: number, to: string, actorType: string, actorId: string | null, reason: string | null, meta: Record<string, unknown> = {}) {
  const [row] = await tx<{ version: number; status: string }[]>`
    SELECT version, status FROM transition_transaction(${id}, ${version}, ${to}, ${actorType}, ${actorId}, ${reason}, ${tx.json(meta as never)})`;
  return row!;
}

export function evidenceOf(db: Db, disputeId: string) {
  return db<{ id: string; party: string; type: string; file_id: string | null; message_id: string | null; note: string | null; submitted_by: string | null; created_at: Date }[]>`
    SELECT id, party, type, file_id, message_id, note, submitted_by, created_at FROM dispute_evidence WHERE dispute_id = ${disputeId} ORDER BY created_at, id`;
}

export function eventsOf(db: Db, disputeId: string) {
  return db<{ from_status: string | null; to_status: string; actor_type: string; created_at: Date }[]>`
    SELECT from_status, to_status, actor_type, created_at FROM dispute_events WHERE dispute_id = ${disputeId} ORDER BY id`;
}

export async function insertEvidence(
  tx: TxSql,
  e: { disputeId: string; submittedBy: string; party: string; type: string; fileId: string | null; messageId: string | null; note: string | null },
) {
  const [row] = await tx<{ id: string; party: string; type: string; file_id: string | null; message_id: string | null; note: string | null; submitted_by: string; created_at: Date }[]>`
    INSERT INTO dispute_evidence (dispute_id, submitted_by, party, type, file_id, message_id, note, created_at)
    VALUES (${e.disputeId}, ${e.submittedBy}, ${e.party}, ${e.type}, ${e.fileId}, ${e.messageId}, ${e.note}, clock_timestamp())
    RETURNING id, party, type, file_id, message_id, note, submitted_by, created_at`;
  return row!;
}

/**
 * Files a party may cite: their own uploads (evidence-type purposes), or any file attached to this
 * transaction's purchase proof, delivery, customs declaration or price confirmation (both parties).
 */
export async function referencableFile(db: Db, fileId: string, userId: string, txId: string) {
  const [f] = await db<{ id: string; storage_key: string; mime: string }[]>`
    SELECT f.id, f.storage_key, f.mime FROM files f
     WHERE f.id = ${fileId} AND f.deleted_at IS NULL AND f.scan_status <> 'INFECTED'
       AND (
         (f.owner_id = ${userId} AND f.purpose IN ('EVIDENCE','CHAT','RECEIPT','PRODUCT_PHOTO','DELIVERY_PROOF'))
         OR EXISTS (SELECT 1 FROM purchase_proofs pp WHERE pp.transaction_id = ${txId}
                     AND (pp.receipt_file_id = f.id OR pp.video_file_id = f.id OR f.id = ANY (pp.product_photo_file_ids)))
         OR EXISTS (SELECT 1 FROM deliveries dl WHERE dl.transaction_id = ${txId} AND f.id = ANY (dl.proof_file_ids))
         OR EXISTS (SELECT 1 FROM customs_declarations cd WHERE cd.transaction_id = ${txId} AND cd.receipt_file_id = f.id)
         OR EXISTS (SELECT 1 FROM price_confirmations pc WHERE pc.transaction_id = ${txId} AND pc.receipt_file_id = f.id)
       )`;
  return f ?? null;
}

export async function conversationMessage(db: Db, messageId: string, txId: string) {
  const [m] = await db<{ id: string }[]>`
    SELECT m.id FROM messages m JOIN conversations c ON c.id = m.conversation_id
     WHERE m.id = ${messageId} AND c.transaction_id = ${txId} AND m.deleted_at IS NULL`;
  return m ?? null;
}

/** Status the transaction had right before it became DISPUTED (latest such event). */
export async function preDisputeStatus(db: Db, txId: string): Promise<string | null> {
  const [e] = await db<{ from_status: string | null }[]>`
    SELECT from_status FROM transaction_events WHERE transaction_id = ${txId} AND to_status = 'DISPUTED' ORDER BY id DESC LIMIT 1`;
  return e?.from_status ?? null;
}
