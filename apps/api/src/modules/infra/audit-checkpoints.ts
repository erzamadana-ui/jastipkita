/**
 * Audit chain checkpoints (launch checklist T12).
 *
 * Job `infra.audit_checkpoint` (daily, registered in src/jobs/infra.ts):
 *   1. snapshot the chain head in ONE statement (audit_chain_head + count of audit_logs up to last_id);
 *   2. verify the chain from the previous checkpoint up to that snapshot (anchor hash + row count of the previous
 *      checkpoint, verify_audit_chain() over the new segment, the previous WORM object). Broken → NO checkpoint is
 *      written (a broken state must never be anchored); a CRITICAL `AUDIT_CHAIN_BROKEN` security event + an
 *      `ALERT audit.checkpoint_refused` log line are emitted instead;
 *   3. in one DB transaction: INSERT the audit_checkpoints row (UNIQUE per UTC day → concurrent/retried runs skip),
 *      PUT the JSON to storage at `audit-checkpoints/YYYY/MM/DD.json`, append the audit row, COMMIT. A failed PUT rolls
 *      the row back, so a row never exists without its object.
 *
 * Production: the storage bucket must have Object Lock / WORM retention (docs/08-backup-dr.md §9) — that is what makes
 * a privileged rewrite of the whole chain (all hashes and the head recomputed) detectable. Dev/test use the in-memory
 * storage provider (MOCK): objects vanish on restart, which the verification reports as a warning, not a break.
 *
 * `verifyAuditCheckpoints` is the read-only check behind GET /v1/admin/infra/audit/checkpoints/verify (infra.db.read).
 */
import type { AppDeps } from '../../context';
import { sha256 } from '../../lib/crypto';
import { iso, num } from '../admin/common';

export const AUDIT_CHECKPOINT_PREFIX = 'audit-checkpoints/';
export const AUDIT_CHECKPOINT_FORMAT = 'jastipkita.audit-checkpoint.v1';
const ZERO_HASH = Buffer.alloc(32);

interface CheckpointRow {
  id: number | string;
  day: string;
  last_id: number | string;
  last_hash: Buffer;
  row_count: number | string;
  head_updated_at: Date;
  storage_key: string;
  object_sha256: Buffer;
  prev_object_sha256: Buffer | null;
  storage_mode: string;
  created_at: Date;
}

export interface AuditCheckpointObject {
  format: typeof AUDIT_CHECKPOINT_FORMAT;
  environment: string;
  checkpointDay: string;
  createdAt: string;
  chain: { lastId: number; lastHash: string; rowCount: number; headUpdatedAt: string };
  previous: { checkpointDay: string; objectSha256: string } | null;
  algorithm: string;
}

export type StorageCheck = 'MATCH' | 'MISMATCH' | 'MISSING' | 'ERROR' | 'SKIPPED';

export function checkpointKey(day: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`invalid checkpoint day ${day}`);
  return `${AUDIT_CHECKPOINT_PREFIX}${day.slice(0, 4)}/${day.slice(5, 7)}/${day.slice(8, 10)}.json`;
}

const hex = (b: Buffer | Uint8Array | null | undefined) => (b ? Buffer.from(b).toString('hex') : null);
const sameBytes = (a: Buffer | Uint8Array | null | undefined, b: Buffer | Uint8Array | null | undefined) =>
  !!a && !!b && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

async function latestCheckpoint(deps: AppDeps): Promise<CheckpointRow | null> {
  const [cp] = await deps.sql<CheckpointRow[]>`
    SELECT id, checkpoint_day::text AS day, last_id, last_hash, row_count, head_updated_at, storage_key, object_sha256,
           prev_object_sha256, storage_mode, created_at
      FROM audit_checkpoints ORDER BY checkpoint_day DESC, id DESC LIMIT 1`;
  return cp ?? null;
}

interface Evaluation {
  findings: string[];
  warnings: string[];
  anchor: { hashMatches: boolean; rowCountMatches: boolean; actualRowCount: number } | null;
  segment: { fromId: number; toId: number | null; brokenAtId: number | null };
  storage: { status: StorageCheck; mode: string; key: string | null; error: string | null };
  history: { checkpoints: number; mismatched: { id: number; day: string; lastId: number }[] };
}

/**
 * Core check shared by the job and the endpoint: `cp` (latest checkpoint or null) against the live chain, up to
 * `target` (job: the head snapshot) or to the live head (endpoint: verify_audit_chain also compares audit_chain_head).
 */
async function evaluate(deps: AppDeps, cp: CheckpointRow | null, target: { lastId: number; lastHash: Buffer } | null): Promise<Evaluation> {
  const db = deps.sql;
  const findings: string[] = [];
  const warnings: string[] = [];
  const cpLastId = cp ? num(cp.last_id) : 0;

  // (a) the previous anchor still matches the live chain (hash at last_id + number of rows up to it)
  let anchor: Evaluation['anchor'] = null;
  if (cp) {
    const [a] = await db<{ hash: Buffer | null; n: number | string }[]>`
      SELECT (SELECT hash FROM audit_logs WHERE id = ${cpLastId}) AS hash,
             (SELECT count(*) FROM audit_logs WHERE id <= ${cpLastId}) AS n`;
    const actualHash = cpLastId === 0 ? ZERO_HASH : a?.hash ?? null;
    const actualRowCount = num(a?.n);
    anchor = { hashMatches: sameBytes(actualHash, cp.last_hash), rowCountMatches: actualRowCount === num(cp.row_count), actualRowCount };
    if (!anchor.hashMatches) {
      findings.push(actualHash ? `Hash baris audit #${cpLastId} berbeda dengan checkpoint ${cp.day} (rantai ditulis ulang).` : `Baris audit #${cpLastId} (anchor checkpoint ${cp.day}) tidak ada lagi.`);
    }
    if (!anchor.rowCountMatches) findings.push(`Jumlah baris audit s.d. #${cpLastId} = ${actualRowCount}, checkpoint ${cp.day} mencatat ${num(cp.row_count)}.`);
  }

  // (b) the segment after the anchor: links, recomputed hashes, gaps (and the head when unbounded)
  const fromId = cpLastId + 1;
  const toId = target ? target.lastId : null;
  const [seg] = await db<{ broken: number | string | null }[]>`SELECT verify_audit_chain(${fromId}::bigint, ${toId}::bigint) AS broken`;
  const brokenAtId = seg?.broken === null || seg?.broken === undefined ? null : num(seg.broken);
  if (brokenAtId !== null) findings.push(`Rantai audit rusak sejak checkpoint: verify_audit_chain(${fromId}${toId !== null ? `, ${toId}` : ''}) gagal di id ${brokenAtId}.`);
  if (target && target.lastId > 0) {
    const [t] = await db<{ hash: Buffer | null }[]>`SELECT hash FROM audit_logs WHERE id = ${target.lastId}`;
    if (!sameBytes(t?.hash, target.lastHash)) findings.push(`Head audit_chain_head (#${target.lastId}) tidak sama dengan baris audit_logs-nya.`);
  }

  // (c) every older checkpoint must still match the chain (a rewrite before the latest anchor)
  const [cnt] = await db<{ n: number | string }[]>`SELECT count(*) AS n FROM audit_checkpoints`;
  const mismatched = await db<{ id: number | string; day: string; last_id: number | string }[]>`
    SELECT c.id, c.checkpoint_day::text AS day, c.last_id FROM audit_checkpoints c LEFT JOIN audit_logs a ON a.id = c.last_id
     WHERE (c.last_id > 0 AND a.hash IS DISTINCT FROM c.last_hash) OR (c.last_id = 0 AND c.last_hash <> ${ZERO_HASH})
     ORDER BY c.checkpoint_day DESC LIMIT 20`;
  const history = { checkpoints: num(cnt?.n), mismatched: mismatched.map((m) => ({ id: num(m.id), day: m.day, lastId: num(m.last_id) })) };
  if (history.mismatched.length) findings.push(`${history.mismatched.length} checkpoint lama tidak cocok lagi dengan rantai (${history.mismatched.map((m) => m.day).join(', ')}).`);

  // (d) the WORM object of the latest checkpoint: digest vs DB row, content vs the live chain
  const p = deps.providers.storage;
  const storage: Evaluation['storage'] = { status: 'SKIPPED', mode: p.mode, key: cp?.storage_key ?? null, error: null };
  if (cp) {
    try {
      const obj = await p.get(cp.storage_key);
      if (!obj) {
        storage.status = 'MISSING';
      } else {
        const digest = await sha256(new Uint8Array(obj.body));
        let parsed: Partial<AuditCheckpointObject> | null = null;
        try {
          parsed = JSON.parse(new TextDecoder().decode(obj.body)) as Partial<AuditCheckpointObject>;
        } catch {
          parsed = null;
        }
        let contentOk = false;
        if (parsed?.format === AUDIT_CHECKPOINT_FORMAT && parsed.chain && Number.isSafeInteger(Number(parsed.chain.lastId)) && Number(parsed.chain.lastId) >= 0) {
          const objLastId = Number(parsed.chain.lastId);
          const [row] = objLastId > 0 ? await db<{ hash: Buffer }[]>`SELECT hash FROM audit_logs WHERE id = ${objLastId}` : [{ hash: ZERO_HASH }];
          contentOk = objLastId === cpLastId && parsed.chain.lastHash === hex(cp.last_hash) && parsed.chain.lastHash === hex(row?.hash);
        }
        storage.status = sameBytes(digest, cp.object_sha256) && contentOk ? 'MATCH' : 'MISMATCH';
      }
    } catch (err) {
      storage.status = 'ERROR';
      storage.error = err instanceof Error ? err.message.slice(0, 200) : 'storage error';
    }
    if (storage.status === 'MISMATCH') findings.push(`Objek WORM ${cp.storage_key} tidak cocok dengan checkpoint/rantai di database.`);
    if (storage.status === 'MISSING') {
      if (p.mode === 'MOCK') warnings.push(`Objek ${cp.storage_key} tidak ada di storage memori (MOCK, tidak persisten — normal setelah restart dev).`);
      else findings.push(`Objek WORM ${cp.storage_key} hilang dari storage ${p.mode}.`);
    }
    if (storage.status === 'ERROR') warnings.push(`Storage tidak dapat dibaca: ${storage.error}. Verifikasi objek WORM belum dilakukan.`);
  }
  return { findings, warnings, anchor, segment: { fromId, toId, brokenAtId }, storage, history };
}

/** Read-only verification for the DB & Infra Center (no writes). */
export async function verifyAuditCheckpoints(deps: AppDeps) {
  const t0 = Date.now();
  const now = deps.clock.now();
  const cp = await latestCheckpoint(deps);
  const ev = await evaluate(deps, cp, null);
  const [head] = await deps.sql<{ last_id: number | string; last_hash: Buffer; updated_at: Date }[]>`SELECT last_id, last_hash, updated_at FROM audit_chain_head WHERE singleton`;
  const recent = await deps.sql<{ day: string; last_id: number | string; row_count: number | string; created_at: Date; storage_key: string; storage_mode: string }[]>`
    SELECT checkpoint_day::text AS day, last_id, row_count, created_at, storage_key, storage_mode FROM audit_checkpoints ORDER BY checkpoint_day DESC LIMIT 10`;
  const headLastId = num(head?.last_id);
  return {
    status: ev.findings.length ? ('BROKEN' as const) : cp ? ('OK' as const) : ('NO_CHECKPOINT' as const),
    checkedAt: now.toISOString(),
    durationMs: Date.now() - t0,
    checkpoint: cp
      ? {
          id: num(cp.id),
          day: cp.day,
          lastId: num(cp.last_id),
          lastHash: hex(cp.last_hash)!,
          rowCount: num(cp.row_count),
          headUpdatedAt: iso(cp.head_updated_at)!,
          createdAt: iso(cp.created_at)!,
          ageSec: Math.max(0, Math.round((now.getTime() - new Date(cp.created_at).getTime()) / 1000)),
          storageKey: cp.storage_key,
          storageMode: cp.storage_mode,
          objectSha256: hex(cp.object_sha256)!,
        }
      : null,
    anchor: ev.anchor,
    segment: { ...ev.segment, toId: headLastId, rowsSinceCheckpoint: Math.max(0, headLastId - (cp ? num(cp.last_id) : 0)) },
    head: head ? { lastId: headLastId, lastHash: hex(head.last_hash)!, updatedAt: iso(head.updated_at)! } : null,
    history: ev.history,
    storage: ev.storage,
    findings: ev.findings,
    warnings: ev.warnings,
    recent: recent.map((r) => ({ day: r.day, lastId: num(r.last_id), rowCount: num(r.row_count), createdAt: iso(r.created_at)!, storageKey: r.storage_key, storageMode: r.storage_mode })),
    note:
      'Checkpoint harian (job infra.audit_checkpoint) mencatat head rantai audit di tabel append-only audit_checkpoints DAN sebagai objek JSON di storage. ' +
      'Production: bucket wajib Object Lock/WORM agar penulisan ulang seluruh rantai oleh superuser tetap terdeteksi. Dev memakai storage memori (MOCK).',
  };
}

/** Daily job: verify since the previous anchor, then record + store the new checkpoint. Idempotent per UTC day. */
export async function createAuditCheckpoint(deps: AppDeps): Promise<Record<string, unknown>> {
  const now = deps.clock.now();
  const day = now.toISOString().slice(0, 10);
  const key = checkpointKey(day);
  const [existing] = await deps.sql<{ last_id: number | string }[]>`SELECT last_id FROM audit_checkpoints WHERE checkpoint_day = ${day}::date`;
  if (existing) return { skipped: 'ALREADY_EXISTS', day, lastId: num(existing.last_id) };

  // One statement = one snapshot: the head and the row count are consistent with each other.
  const [snap] = await deps.sql<{ last_id: number | string; last_hash: Buffer; updated_at: Date; row_count: number | string }[]>`
    SELECT h.last_id, h.last_hash, h.updated_at, (SELECT count(*) FROM audit_logs a WHERE a.id <= h.last_id) AS row_count
      FROM audit_chain_head h WHERE h.singleton`;
  if (!snap) throw new Error('audit_chain_head missing');
  const lastId = num(snap.last_id);
  const rowCount = num(snap.row_count);

  const prev = await latestCheckpoint(deps);
  const ev = await evaluate(deps, prev, { lastId, lastHash: Buffer.from(snap.last_hash) });
  if (rowCount !== lastId) ev.findings.push(`Jumlah baris audit (${rowCount}) ≠ id terakhir (${lastId}): ada baris yang hilang.`);
  if (ev.findings.length) {
    const details = { day, lastId, rowCount, findings: ev.findings, previousCheckpoint: prev?.day ?? null, source: 'infra.audit_checkpoint' };
    deps.logger.error('ALERT audit.checkpoint_refused', details);
    await deps.sql`INSERT INTO security_events (type, severity, meta, created_at) VALUES ('AUDIT_CHAIN_BROKEN', 'CRITICAL', ${deps.sql.json(details as never)}, ${now})`;
    return { status: 'REFUSED', ...details };
  }

  const prevDigest = prev ? Buffer.from(prev.object_sha256) : null;
  const storage = deps.providers.storage;

  // WORM buckets (R2 bucket lock, S3 Object Lock) refuse to overwrite. If an earlier attempt of today's run stored the
  // object but its DB transaction did not commit, adopt that object (after checking it against the chain) instead of
  // re-uploading — the retry stays idempotent and the row always mirrors the bytes that are actually in storage.
  let doc: AuditCheckpointObject;
  let body: Uint8Array;
  let adopted = false;
  const already = await storage.get(key);
  if (already) {
    const found = await adoptableObject(deps, already.body, day, prevDigest);
    if (typeof found === 'string') {
      const details = { day, lastId, rowCount, findings: [found], previousCheckpoint: prev?.day ?? null, source: 'infra.audit_checkpoint' };
      deps.logger.error('ALERT audit.checkpoint_refused', details);
      await deps.sql`INSERT INTO security_events (type, severity, meta, created_at) VALUES ('AUDIT_CHAIN_BROKEN', 'CRITICAL', ${deps.sql.json(details as never)}, ${now})`;
      return { status: 'REFUSED', ...details };
    }
    doc = found;
    body = already.body;
    adopted = true;
  } else {
    doc = {
      format: AUDIT_CHECKPOINT_FORMAT,
      environment: deps.env.APP_ENV,
      checkpointDay: day,
      createdAt: now.toISOString(),
      chain: { lastId, lastHash: hex(snap.last_hash)!, rowCount, headUpdatedAt: iso(snap.updated_at)! },
      previous: prev && prevDigest ? { checkpointDay: prev.day, objectSha256: prevDigest.toString('hex') } : null,
      algorithm: 'hash = sha256(prev_hash || utf8(audit_log_canonical(row))); genesis prev_hash = 32 zero bytes',
    };
    body = new TextEncoder().encode(JSON.stringify(doc));
  }
  const digest = Buffer.from(await sha256(new Uint8Array(body)));
  const c = doc.chain;

  const written = await deps.sql.begin(async (tx) => {
    const [row] = await tx<{ id: number | string }[]>`
      INSERT INTO audit_checkpoints (checkpoint_day, last_id, last_hash, row_count, head_updated_at, storage_key, object_sha256,
                                     prev_object_sha256, storage_mode, created_at)
      VALUES (${day}::date, ${c.lastId}, ${Buffer.from(c.lastHash, 'hex')}, ${c.rowCount}, ${new Date(c.headUpdatedAt)}, ${key}, ${digest},
              ${prevDigest}, ${storage.mode}, ${now})
      ON CONFLICT (checkpoint_day) DO NOTHING RETURNING id`;
    if (!row) return null; // another run recorded today's checkpoint first (its object is the one in storage)
    if (!adopted) await storage.put(key, body, 'application/json'); // throws → the row is rolled back
    await tx`SELECT jk_audit('JOB', NULL, 'infra.audit_checkpoint_created', 'audit_checkpoint', ${String(num(row.id))}, NULL,
      ${tx.json({ day, lastId: c.lastId, rowCount: c.rowCount, storageKey: key, objectSha256: digest.toString('hex'), storageMode: storage.mode, adoptedExistingObject: adopted } as never)}::jsonb, '{}'::jsonb)`;
    return num(row.id);
  });
  if (written === null) return { skipped: 'ALREADY_EXISTS', day };
  if (ev.warnings.length) deps.logger.warn('audit.checkpoint_warnings', { day, warnings: ev.warnings });
  deps.logger.info('audit.checkpoint_created', { day, lastId: c.lastId, rowCount: c.rowCount, storageKey: key, storageMode: storage.mode, adopted });
  return { status: 'CREATED', id: written, day, lastId: c.lastId, rowCount: c.rowCount, storageKey: key, objectSha256: digest.toString('hex'), storageMode: storage.mode, adoptedExistingObject: adopted, warnings: ev.warnings };
}

/** An object already at today's key is adopted only if it is ours, for today, linked to the previous one and matches the chain. */
async function adoptableObject(deps: AppDeps, body: Uint8Array, day: string, prevDigest: Buffer | null): Promise<AuditCheckpointObject | string> {
  let o: AuditCheckpointObject;
  try {
    o = JSON.parse(new TextDecoder().decode(body)) as AuditCheckpointObject;
  } catch {
    return `Objek ${checkpointKey(day)} sudah ada di storage tetapi bukan JSON checkpoint.`;
  }
  const lastId = Number(o?.chain?.lastId);
  if (o?.format !== AUDIT_CHECKPOINT_FORMAT || o.checkpointDay !== day || !Number.isSafeInteger(lastId) || lastId < 0 || o.chain.rowCount !== lastId
      || typeof o.chain.lastHash !== 'string' || !/^[0-9a-f]{64}$/.test(o.chain.lastHash) || Number.isNaN(Date.parse(o.chain.headUpdatedAt))) {
    return `Objek ${checkpointKey(day)} sudah ada di storage dengan format/isi yang tidak dikenal.`;
  }
  if ((o.previous?.objectSha256 ?? null) !== (prevDigest ? prevDigest.toString('hex') : null)) {
    return `Objek ${checkpointKey(day)} sudah ada tetapi tidak tertaut ke checkpoint sebelumnya.`;
  }
  const [r] = await deps.sql<{ hash: Buffer | null; n: number | string }[]>`
    SELECT (SELECT hash FROM audit_logs WHERE id = ${lastId}) AS hash, (SELECT count(*) FROM audit_logs WHERE id <= ${lastId}) AS n`;
  const actual = lastId === 0 ? ZERO_HASH : r?.hash ?? null;
  if (hex(actual) !== o.chain.lastHash || num(r?.n) !== lastId) {
    return `Objek ${checkpointKey(day)} sudah ada tetapi tidak cocok dengan rantai audit (#${lastId}).`;
  }
  return o;
}
