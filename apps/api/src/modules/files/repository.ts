import type { Db } from '../../db/sql';
import { buf, iso } from '../auth/common';
import type { FilePurpose } from './policy';

export interface FileRow {
  id: string;
  owner_id: string | null;
  purpose: FilePurpose;
  storage_provider: string;
  bucket: string;
  storage_key: string;
  mime: string;
  size_bytes: number;
  sha256: Buffer | null;
  declared_sha256: Buffer | null;
  encrypted: boolean;
  enc_key_id: string | null;
  scan_status: 'PENDING' | 'CLEAN' | 'INFECTED' | 'FAILED';
  upload_expires_at: Date | null;
  completed_at: Date | null;
  deleted_at: Date | null;
  retention_until: Date | null;
  created_at: Date;
}

export async function getFile(db: Db, id: string): Promise<FileRow | undefined> {
  const [f] = await db<FileRow[]>`
    SELECT id, owner_id, purpose, storage_provider, bucket, storage_key, mime, size_bytes, sha256, declared_sha256, encrypted,
           enc_key_id, scan_status, upload_expires_at, completed_at, deleted_at, retention_until, created_at
      FROM files WHERE id = ${id}`;
  return f;
}

export async function insertFile(
  db: Db,
  f: {
    id: string;
    ownerId: string | null;
    purpose: FilePurpose;
    storageProvider: string;
    bucket: string;
    storageKey: string;
    mime: string;
    sizeBytes: number;
    declaredSha256: Uint8Array | null;
    encrypted: boolean;
    encKeyId: string | null;
    uploadExpiresAt: Date | null;
    now: Date;
    // server-generated files are complete on insert
    completed?: { sha256: Uint8Array; engine: string; retentionUntil: Date | null };
  },
) {
  await db`
    INSERT INTO files (id, owner_id, purpose, storage_provider, bucket, storage_key, mime, size_bytes, declared_sha256, sha256,
                       encrypted, enc_key_id, scan_status, scanned_at, scan_engine, upload_expires_at, completed_at, retention_until, created_at)
    VALUES (${f.id}, ${f.ownerId}, ${f.purpose}, ${f.storageProvider}, ${f.bucket}, ${f.storageKey}, ${f.mime}, ${f.sizeBytes},
            ${f.declaredSha256 ? buf(f.declaredSha256) : null}, ${f.completed ? buf(f.completed.sha256) : null},
            ${f.encrypted}, ${f.encKeyId}, ${f.completed ? 'CLEAN' : 'PENDING'}, ${f.completed ? f.now : null}, ${f.completed?.engine ?? null},
            ${f.uploadExpiresAt}, ${f.completed ? f.now : null}, ${f.completed?.retentionUntil ?? null}, ${f.now})`;
}

export function fileStatus(f: Pick<FileRow, 'scan_status' | 'completed_at' | 'deleted_at'>) {
  if (f.scan_status === 'INFECTED') return 'INFECTED' as const;
  if (f.deleted_at) return f.completed_at ? ('DELETED' as const) : ('REJECTED' as const);
  if (f.completed_at && f.scan_status === 'CLEAN') return 'READY' as const;
  if (f.scan_status === 'FAILED') return 'REJECTED' as const;
  return 'PENDING_UPLOAD' as const;
}

export function toFileDto(f: FileRow) {
  return {
    id: f.id,
    purpose: f.purpose,
    contentType: f.mime,
    sizeBytes: f.size_bytes,
    status: fileStatus(f),
    encrypted: f.encrypted,
    createdAt: iso(f.created_at)!,
    completedAt: iso(f.completed_at),
  };
}

/**
 * True when `userId` is a counterparty that may see the file: a party of the transaction the file is
 * attached to (purchase proof, customs receipt, delivery proof, dispute evidence), a participant of the
 * conversation it was sent in, or — for request photos — the buyer, travelers who offered/are matched,
 * and any traveler while the request is OPEN (public request board).
 */
export async function isCounterparty(db: Db, fileId: string, userId: string): Promise<boolean> {
  const [r] = await db<{ ok: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM purchase_proofs pp JOIN transactions t ON t.id = pp.transaction_id
       WHERE (pp.receipt_file_id = ${fileId} OR ${fileId}::uuid = ANY (pp.product_photo_file_ids) OR pp.video_file_id = ${fileId})
         AND ${userId}::uuid IN (t.buyer_id, t.traveler_id)
      UNION ALL
      SELECT 1 FROM customs_declarations cd JOIN transactions t ON t.id = cd.transaction_id
       WHERE cd.receipt_file_id = ${fileId} AND ${userId}::uuid IN (t.buyer_id, t.traveler_id)
      UNION ALL
      SELECT 1 FROM deliveries d JOIN transactions t ON t.id = d.transaction_id
       WHERE ${fileId}::uuid = ANY (d.proof_file_ids) AND ${userId}::uuid IN (t.buyer_id, t.traveler_id)
      UNION ALL
      SELECT 1 FROM messages m JOIN conversations cv ON cv.id = m.conversation_id
       WHERE m.attachments @> jsonb_build_array(jsonb_build_object('fileId', ${fileId}::text))
         AND ${userId}::uuid IN (cv.buyer_id, cv.traveler_id)
      UNION ALL
      SELECT 1 FROM dispute_evidence de JOIN disputes d ON d.id = de.dispute_id JOIN transactions t ON t.id = d.transaction_id
       WHERE de.file_id = ${fileId} AND ${userId}::uuid IN (t.buyer_id, t.traveler_id)
      UNION ALL
      SELECT 1 FROM request_images ri JOIN requests rq ON rq.id = ri.request_id
       WHERE ri.file_id = ${fileId}
         AND (rq.buyer_id = ${userId} OR rq.status = 'OPEN'
              OR EXISTS (SELECT 1 FROM offers o WHERE o.request_id = rq.id AND o.traveler_id = ${userId})
              OR EXISTS (SELECT 1 FROM transactions t WHERE t.request_id = rq.id AND t.traveler_id = ${userId}))
    ) AS ok`;
  return !!r?.ok;
}
