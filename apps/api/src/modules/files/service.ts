/**
 * Direct-to-storage uploads:
 *   1. POST /files/uploads     → files row (PENDING) + presigned PUT (content-type signed, size capped)
 *   2. client PUTs the bytes to object storage
 *   3. POST /files/{id}/complete → fetch object, size check, magic bytes vs declared type, SHA-256
 *      (vs declared), malware scan (INFECTED → object deleted + security event), and for KYC / TRIP_DOC
 *      AES-256-GCM envelope encryption with the plaintext staging object deleted.
 * Downloads: short-lived presigned GET for plain files; encrypted files are streamed by the API after
 * authorization (KYC → permission kyc.review only).
 */
import type { AppDeps, AuthContext } from '../../context';
import { bytesToHex, hexToBytes, sha256 } from '../../lib/crypto';
import { AppError, Errors } from '../../lib/errors';
import { audit } from '../../services/audit';
import { SECURITY, securityEvent, u8, userHasPermission, type RequestMeta } from '../auth/common';
import { encryptObject, decryptObject } from './envelope';
import { COUNTERPARTY_PURPOSES, extensionFor, isEncryptedPurpose, maxBytesFor, PURPOSE_POLICY, sniffContentType, type AllowedType, type FilePurpose, type UploadPurpose } from './policy';
import * as repo from './repository';

export function storageProviderCode(deps: AppDeps): string {
  if (deps.providers.storage.mode === 'MOCK') return 'MOCK';
  return (deps.env.S3_ENDPOINT ?? '').includes('r2.cloudflarestorage.com') ? 'R2' : 'S3';
}
export const storageBucket = (deps: AppDeps) => (deps.providers.storage.mode === 'MOCK' ? 'default' : (deps.env.S3_BUCKET ?? 'default'));

function objectKey(purpose: FilePurpose, fileId: string, now: Date, kind: 'plain' | 'staging' | 'enc', type: string) {
  const p = purpose.toLowerCase();
  const ym = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  if (kind === 'staging') return `staging/${p}/${fileId}`;
  if (kind === 'enc') return `${p}/enc/${ym}/${fileId}.jke`;
  return `${p}/${ym}/${fileId}.${extensionFor(type)}`;
}

export async function createUpload(
  deps: AppDeps,
  auth: AuthContext,
  input: { purpose: UploadPurpose; contentType: AllowedType; sizeBytes: number; sha256?: string | undefined },
) {
  const policy = PURPOSE_POLICY[input.purpose];
  if (!policy.types.includes(input.contentType)) {
    throw Errors.unprocessable('FILE_TYPE_NOT_ALLOWED', 'Jenis file tidak diizinkan untuk keperluan ini', {
      purpose: input.purpose,
      allowed: policy.types,
    });
  }
  const maxBytes = maxBytesFor(input.contentType);
  if (input.sizeBytes > maxBytes) {
    throw Errors.unprocessable('FILE_TOO_LARGE', `Ukuran file maksimal ${Math.round(maxBytes / 1024 / 1024)} MB`, { maxBytes });
  }
  const now = deps.clock.now();
  const id = crypto.randomUUID();
  const key = objectKey(input.purpose, id, now, policy.encrypted ? 'staging' : 'plain', input.contentType);
  const upload = await deps.providers.storage.presignUpload({ key, contentType: input.contentType, maxBytes: input.sizeBytes, expiresSec: SECURITY.UPLOAD_URL_TTL_SEC });
  await repo.insertFile(deps.sql, {
    id,
    ownerId: auth.userId,
    purpose: input.purpose,
    storageProvider: storageProviderCode(deps),
    bucket: storageBucket(deps),
    storageKey: key,
    mime: input.contentType,
    sizeBytes: input.sizeBytes,
    declaredSha256: input.sha256 ? hexToBytes(input.sha256) : null,
    // KYC / TRIP_DOC rows are flagged encrypted from the start (DB invariant); the staging object is
    // never downloadable and is replaced by the envelope-encrypted object on complete.
    encrypted: policy.encrypted,
    encKeyId: policy.encrypted ? deps.crypto.activeKeyId : null,
    uploadExpiresAt: new Date(now.getTime() + SECURITY.UPLOAD_URL_TTL_SEC * 1000),
    now,
  });
  return {
    fileId: id,
    upload: { url: upload.url, method: 'PUT' as const, headers: upload.headers },
    expiresAt: upload.expiresAt.toISOString(),
    maxBytes: input.sizeBytes,
  };
}

async function reject(deps: AppDeps, f: repo.FileRow, scan: 'FAILED' | 'INFECTED', extra: { engine?: string; signature?: string } = {}) {
  try {
    await deps.providers.storage.delete(f.storage_key);
  } catch (err) {
    deps.logger.error('files.delete_failed', { fileId: f.id, error: err instanceof Error ? err.message : String(err) });
  }
  const now = deps.clock.now();
  await deps.sql`UPDATE files SET scan_status = ${scan}, scanned_at = ${now}, deleted_at = ${now},
                        scan_engine = ${extra.engine ?? null}, scan_signature = ${extra.signature ?? null}
                  WHERE id = ${f.id} AND completed_at IS NULL`;
}

export async function completeUpload(deps: AppDeps, auth: AuthContext, fileId: string, req: RequestMeta) {
  const f = await repo.getFile(deps.sql, fileId);
  if (!f || f.owner_id !== auth.userId) throw Errors.notFound('File', 'FILE_NOT_FOUND');
  if (f.completed_at) return repo.toFileDto(f); // idempotent
  if (f.deleted_at || f.scan_status !== 'PENDING') throw Errors.conflict('FILE_REJECTED', 'File ini sudah ditolak, unggah ulang');
  const now = deps.clock.now();
  if (f.upload_expires_at && f.upload_expires_at.getTime() + 3600_000 < now.getTime()) {
    await reject(deps, f, 'FAILED');
    throw Errors.conflict('UPLOAD_EXPIRED', 'Waktu unggah sudah habis, silakan unggah ulang');
  }
  const obj = await deps.providers.storage.get(f.storage_key);
  if (!obj) throw Errors.conflict('UPLOAD_MISSING', 'File belum diunggah ke penyimpanan');
  const body = obj.body;
  const policy = PURPOSE_POLICY[f.purpose as UploadPurpose];

  if (body.length === 0 || body.length > f.size_bytes || body.length > maxBytesFor(f.mime as AllowedType)) {
    await reject(deps, f, 'FAILED');
    throw Errors.unprocessable('FILE_SIZE_MISMATCH', 'Ukuran file tidak sesuai dengan yang dideklarasikan', { declared: f.size_bytes, actual: body.length });
  }
  const sniffed = sniffContentType(body);
  if (sniffed !== f.mime) {
    await reject(deps, f, 'FAILED');
    await securityEvent(deps, deps.sql, { userId: auth.userId, type: 'UPLOAD_TYPE_MISMATCH', severity: 'MEDIUM', req, meta: { fileId, declared: f.mime, detected: sniffed } });
    throw Errors.unprocessable('FILE_TYPE_MISMATCH', 'Isi file tidak sesuai dengan jenis file yang dideklarasikan', { declared: f.mime, detected: sniffed });
  }
  const digest = await sha256(u8(body));
  if (f.declared_sha256 && bytesToHex(new Uint8Array(f.declared_sha256)) !== bytesToHex(digest)) {
    await reject(deps, f, 'FAILED');
    throw Errors.unprocessable('FILE_CHECKSUM_MISMATCH', 'Checksum file tidak cocok');
  }

  let scan: Awaited<ReturnType<AppDeps['providers']['malware']['scan']>>;
  try {
    scan = await deps.providers.malware.scan({ key: f.storage_key, body, contentType: f.mime });
  } catch (err) {
    deps.logger.error('files.scan_error', { fileId, error: err instanceof Error ? err.message : String(err) });
    scan = { status: 'FAILED', engine: 'unavailable' };
  }
  if (scan.status === 'INFECTED') {
    await reject(deps, f, 'INFECTED', { engine: scan.engine, ...(scan.signature ? { signature: scan.signature.slice(0, 200) } : {}) });
    await securityEvent(deps, deps.sql, {
      userId: auth.userId,
      type: 'MALWARE_UPLOAD',
      severity: 'HIGH',
      req,
      meta: { fileId, purpose: f.purpose, engine: scan.engine, signature: scan.signature ?? null },
    });
    throw Errors.unprocessable('FILE_INFECTED', 'File terdeteksi berbahaya dan telah dihapus');
  }
  if (scan.status !== 'CLEAN') {
    // fail closed but retryable: the object stays in staging, status stays PENDING
    throw new AppError(503, 'MALWARE_SCAN_UNAVAILABLE', 'Pemindaian file sedang tidak tersedia, coba lagi sebentar lagi');
  }

  let storageKey = f.storage_key;
  if (policy.encrypted) {
    const blob = await encryptObject(deps, f.id, body);
    storageKey = objectKey(f.purpose, f.id, now, 'enc', f.mime);
    await deps.providers.storage.put(storageKey, blob, 'application/octet-stream');
    await deps.providers.storage.delete(f.storage_key); // no plaintext copy remains
  }
  const [updated] = await deps.sql<repo.FileRow[]>`
    UPDATE files
       SET storage_key = ${storageKey}, size_bytes = ${body.length}, sha256 = ${Buffer.from(digest)},
           scan_status = 'CLEAN', scanned_at = ${now}, scan_engine = ${scan.engine}, completed_at = ${now},
           enc_key_id = ${policy.encrypted ? deps.crypto.activeKeyId : null}
     WHERE id = ${f.id} AND completed_at IS NULL AND deleted_at IS NULL
     RETURNING id, owner_id, purpose, storage_provider, bucket, storage_key, mime, size_bytes, sha256, declared_sha256, encrypted,
               enc_key_id, scan_status, upload_expires_at, completed_at, deleted_at, retention_until, created_at`;
  if (!updated) throw Errors.conflict('FILE_ALREADY_COMPLETED', 'File sudah diproses');
  return repo.toFileDto(updated);
}

export async function getFileMeta(deps: AppDeps, auth: AuthContext, fileId: string) {
  const f = await repo.getFile(deps.sql, fileId);
  if (!f) throw Errors.notFound('File', 'FILE_NOT_FOUND');
  // metadata (status, type, size) is visible to the owner even for KYC; content is not
  if (f.owner_id !== auth.userId) await authorizeView(deps, auth, f);
  return repo.toFileDto(f);
}

/**
 * Who may view a file:
 *   KYC            — reviewers with kyc.review only (not even the owner: limits damage of a stolen session)
 *   TRIP_DOC       — owner, reviewers with trips.verify
 *   EXPORT         — owner only
 *   AVATAR         — any signed-in user (public profile photo)
 *   RECEIPT, PRODUCT_PHOTO, DELIVERY_PROOF, CHAT, EVIDENCE — owner, transaction/conversation counterparties,
 *                    staff with disputes.manage (all) or transactions.read (not CHAT/EVIDENCE)
 */
async function authorizeView(deps: AppDeps, auth: AuthContext, f: repo.FileRow): Promise<'OWNER' | 'COUNTERPARTY' | 'STAFF' | 'PUBLIC'> {
  const deny = () => Errors.forbidden('Anda tidak memiliki akses ke file ini', 'FILE_ACCESS_DENIED');
  const isOwner = f.owner_id === auth.userId;
  switch (f.purpose) {
    case 'KYC':
      if (await userHasPermission(deps, auth.userId, 'kyc.review')) return 'STAFF';
      throw deny();
    case 'TRIP_DOC':
      if (isOwner) return 'OWNER';
      if (await userHasPermission(deps, auth.userId, 'trips.verify')) return 'STAFF';
      throw deny();
    case 'EXPORT':
      if (isOwner) return 'OWNER';
      throw deny();
    case 'AVATAR':
      return isOwner ? 'OWNER' : 'PUBLIC';
    default:
      if (isOwner) return 'OWNER';
      if (COUNTERPARTY_PURPOSES.includes(f.purpose) && (await repo.isCounterparty(deps.sql, f.id, auth.userId))) return 'COUNTERPARTY';
      if (await userHasPermission(deps, auth.userId, 'disputes.manage')) return 'STAFF';
      if (f.purpose !== 'CHAT' && f.purpose !== 'EVIDENCE' && (await userHasPermission(deps, auth.userId, 'transactions.read'))) return 'STAFF';
      throw deny();
  }
}

function assertReady(f: repo.FileRow) {
  if (repo.fileStatus(f) !== 'READY') throw Errors.conflict('FILE_NOT_READY', 'File belum siap atau sudah dihapus', { status: repo.fileStatus(f) });
}

export async function downloadUrl(deps: AppDeps, auth: AuthContext, fileId: string) {
  const f = await repo.getFile(deps.sql, fileId);
  if (!f) throw Errors.notFound('File', 'FILE_NOT_FOUND');
  await authorizeView(deps, auth, f);
  assertReady(f);
  if (f.encrypted || isEncryptedPurpose(f.purpose)) {
    return { url: `${deps.env.API_BASE_URL}/v1/files/${f.id}/content`, method: 'GET' as const, requiresAuth: true, expiresAt: null };
  }
  const url = await deps.providers.storage.presignDownload({
    key: f.storage_key,
    expiresSec: SECURITY.DOWNLOAD_URL_TTL_SEC,
    filename: `${f.purpose.toLowerCase()}-${f.id.slice(0, 8)}.${extensionFor(f.mime)}`,
  });
  return {
    url,
    method: 'GET' as const,
    requiresAuth: false,
    expiresAt: new Date(deps.clock.now().getTime() + SECURITY.DOWNLOAD_URL_TTL_SEC * 1000).toISOString(),
  };
}

/** Streams (and decrypts) a file through the API. KYC access is audited. */
export async function streamContent(deps: AppDeps, auth: AuthContext, fileId: string, req: RequestMeta) {
  const f = await repo.getFile(deps.sql, fileId);
  if (!f) throw Errors.notFound('File', 'FILE_NOT_FOUND');
  const role = await authorizeView(deps, auth, f);
  assertReady(f);
  const obj = await deps.providers.storage.get(f.storage_key);
  if (!obj) throw Errors.notFound('File', 'FILE_NOT_FOUND');
  const body = f.encrypted ? await decryptObject(deps, f.id, obj.body) : obj.body;
  if (f.purpose === 'KYC' || (f.purpose === 'TRIP_DOC' && role === 'STAFF')) {
    await deps.sql.begin(async (tx) => {
      await securityEvent(deps, tx, { userId: auth.userId, type: 'SENSITIVE_FILE_VIEWED', severity: 'MEDIUM', req, meta: { fileId: f.id, purpose: f.purpose } });
      await audit(tx, {
        actorType: 'ADMIN',
        actorId: auth.userId,
        action: f.purpose === 'KYC' ? 'kyc.document_viewed' : 'trips.document_viewed',
        entityType: 'file',
        entityId: f.id,
        meta: { ownerId: f.owner_id },
      });
    });
  }
  return {
    body,
    contentType: f.mime,
    filename: `${f.purpose.toLowerCase()}-${f.id.slice(0, 8)}.${extensionFor(f.mime)}`,
    attachment: f.purpose === 'EXPORT' || f.mime === 'application/pdf',
  };
}

/** Server-side file creation (privacy exports). Stored envelope-encrypted, complete on insert. */
export async function storeServerFile(
  deps: AppDeps,
  db: import('../../db/sql').Db,
  input: { ownerId: string; purpose: 'EXPORT'; mime: string; body: Uint8Array; retentionUntil: Date | null },
): Promise<string> {
  const now = deps.clock.now();
  const id = crypto.randomUUID();
  const key = objectKey(input.purpose, id, now, 'enc', input.mime);
  await deps.providers.storage.put(key, await encryptObject(deps, id, input.body), 'application/octet-stream');
  await repo.insertFile(db, {
    id,
    ownerId: input.ownerId,
    purpose: input.purpose,
    storageProvider: storageProviderCode(deps),
    bucket: storageBucket(deps),
    storageKey: key,
    mime: input.mime,
    sizeBytes: input.body.length,
    declaredSha256: null,
    encrypted: true,
    encKeyId: deps.crypto.activeKeyId,
    uploadExpiresAt: null,
    now,
    completed: { sha256: await sha256(u8(input.body)), engine: 'server-generated', retentionUntil: input.retentionUntil },
  });
  return id;
}
