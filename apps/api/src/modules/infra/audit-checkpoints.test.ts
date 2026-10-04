import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../../../test/helpers';
import { infraJobs } from '../../jobs/infra';
import { sha256Hex } from '../../lib/crypto';
import { MemoryStorageProvider } from '../../providers/mock';
import type { StorageProvider } from '../../providers/types';
import { type Admin, as, auditRows, createAdmin } from '../admin/test-support';
import { checkpointKey, createAuditCheckpoint, verifyAuditCheckpoints } from './audit-checkpoints';

const NOW = new Date('2026-10-04T03:00:00Z');

async function addAuditRows(t: TestContext, n: number, tag = 'x') {
  for (let i = 0; i < n; i++) await t.adminSql`SELECT jk_audit('SYSTEM', NULL, ${`test.checkpoint_${tag}`}, 'x', ${String(i)}, NULL, NULL)`;
}

/** Superuser attack: edit row `fromId`, then recompute every later hash and the head → verify_audit_chain() passes again. */
async function rewriteChainFrom(t: TestContext, fromId: number) {
  await t.adminSql.unsafe(`
    ALTER TABLE audit_logs DISABLE TRIGGER trg_append_only;
    UPDATE audit_logs SET meta = '{"forged": true}' WHERE id = ${fromId};
    DO $$
    DECLARE r audit_logs; v_prev bytea;
    BEGIN
      SELECT coalesce((SELECT hash FROM audit_logs WHERE id = ${fromId} - 1), decode(repeat('00', 32), 'hex')) INTO v_prev;
      FOR r IN SELECT * FROM audit_logs WHERE id >= ${fromId} ORDER BY id LOOP
        r.prev_hash := v_prev;
        r.hash := audit_log_compute_hash(r);
        UPDATE audit_logs SET prev_hash = r.prev_hash, hash = r.hash WHERE id = r.id;
        v_prev := r.hash;
      END LOOP;
      UPDATE audit_chain_head SET last_hash = v_prev WHERE singleton;
    END $$;
    ALTER TABLE audit_logs ENABLE TRIGGER trg_append_only;`);
}

/** Storage that reports LIVE (like R2/S3) but keeps objects in memory. Emulates a WORM bucket lock (no overwrite)
 *  and failures before / after the object is written. */
class LiveLikeStorage implements StorageProvider {
  readonly mode = 'LIVE' as const;
  readonly inner = new MemoryStorageProvider('http://api.test');
  failPut = false;
  failAfterPut = false;
  locked = true;
  presignUpload(i: Parameters<StorageProvider['presignUpload']>[0]) {
    return this.inner.presignUpload(i);
  }
  presignDownload(i: Parameters<StorageProvider['presignDownload']>[0]) {
    return this.inner.presignDownload(i);
  }
  async put(key: string, body: Uint8Array, contentType: string) {
    if (this.failPut) throw new Error('S3 PUT failed: 503');
    if (this.locked && this.inner.objects.has(key)) throw new Error('S3 PUT failed: 403 object is locked by a bucket lock rule');
    await this.inner.put(key, body, contentType);
    if (this.failAfterPut) throw new Error('connection reset after upload');
  }
  get(key: string) {
    return this.inner.get(key);
  }
  head(key: string) {
    return this.inner.head(key);
  }
  delete(key: string) {
    return this.inner.delete(key);
  }
}

describe('audit checkpoints — job, storage object, read-only verification', () => {
  let t: TestContext;
  let superA: Admin;
  let ops: Admin;
  beforeAll(async () => {
    t = await createTestContext({ now: NOW });
    superA = await createAdmin(t, ['SUPER_ADMIN']);
    ops = await createAdmin(t, ['OPERATIONS']);
  });
  afterAll(async () => {
    await t.close();
  });

  it('infra.audit_checkpoint is a daily scheduled job; the key layout is audit-checkpoints/YYYY/MM/DD.json', () => {
    expect(infraJobs.scheduled?.map((j) => [j.name, j.everySec])).toEqual([['infra.audit_checkpoint', 86_400]]);
    expect(checkpointKey('2026-10-04')).toBe('audit-checkpoints/2026/10/04.json');
    expect(() => checkpointKey('2026/10/04')).toThrow();
  });

  it('verification needs infra.db.read; before any checkpoint → NO_CHECKPOINT with the full chain verified', async () => {
    expect((await as(t, ops, 'GET', '/v1/admin/infra/audit/checkpoints/verify')).status).toBe(403);
    const res = await as(t, superA, 'GET', '/v1/admin/infra/audit/checkpoints/verify');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ status: 'NO_CHECKPOINT', checkpoint: null, findings: [], segment: { fromId: 1, brokenAtId: null }, storage: { status: 'SKIPPED' } });
  });

  it('the worker records the head in audit_checkpoints (as jk_app) and stores the same JSON in storage; idempotent per day', async () => {
    await addAuditRows(t, 3, 'a');
    const [head] = await t.adminSql<{ last_id: string; last_hash: Buffer }[]>`SELECT last_id, last_hash FROM audit_chain_head`;
    await t.drain();
    const rows = await t.adminSql<{ id: string; checkpoint_day: string; last_id: string; last_hash: Buffer; row_count: string; storage_key: string; object_sha256: Buffer; prev_object_sha256: Buffer | null; storage_mode: string }[]>`
      SELECT id, checkpoint_day::text, last_id, last_hash, row_count, storage_key, object_sha256, prev_object_sha256, storage_mode FROM audit_checkpoints`;
    expect(rows).toHaveLength(1);
    const cp = rows[0]!;
    // the drained worker may have audited more before the checkpoint job ran; the anchor is at or after our snapshot
    expect(Number(cp.last_id)).toBeGreaterThanOrEqual(Number(head!.last_id));
    expect(cp).toMatchObject({ checkpoint_day: '2026-10-04', storage_key: 'audit-checkpoints/2026/10/04.json', storage_mode: 'MOCK', prev_object_sha256: null });
    expect(Number(cp.row_count)).toBe(Number(cp.last_id));
    const obj = t.storage.objects.get(cp.storage_key)!;
    expect(obj.contentType).toBe('application/json');
    expect(await sha256Hex(new Uint8Array(obj.body))).toBe(Buffer.from(cp.object_sha256).toString('hex'));
    const doc = JSON.parse(new TextDecoder().decode(obj.body));
    expect(doc).toMatchObject({ format: 'jastipkita.audit-checkpoint.v1', environment: 'test', checkpointDay: '2026-10-04', previous: null, chain: { lastId: Number(cp.last_id), rowCount: Number(cp.row_count), lastHash: Buffer.from(cp.last_hash).toString('hex') } });
    expect(await auditRows(t, 'infra.audit_checkpoint_created', cp.id)).toHaveLength(1);

    expect(await createAuditCheckpoint(t.deps)).toMatchObject({ skipped: 'ALREADY_EXISTS', day: '2026-10-04' });
    expect((await t.adminSql`SELECT 1 FROM audit_checkpoints`).length).toBe(1);
    // append-only, also for the app role
    await expect(t.sql`UPDATE audit_checkpoints SET row_count = 0`).rejects.toThrow();
    await expect(t.adminSql`DELETE FROM audit_checkpoints`).rejects.toThrow(/append-only/);
  });

  it('verify → OK: anchor + segment since the checkpoint + WORM object match; new rows are counted', async () => {
    await addAuditRows(t, 4, 'b');
    const res = await as(t, superA, 'GET', '/v1/admin/infra/audit/checkpoints/verify');
    expect(res.status).toBe(200);
    expect(res.body.status, JSON.stringify(res.body.findings)).toBe('OK');
    expect(res.body.anchor).toMatchObject({ hashMatches: true, rowCountMatches: true });
    expect(res.body.storage).toMatchObject({ status: 'MATCH', mode: 'MOCK', key: 'audit-checkpoints/2026/10/04.json' });
    expect(res.body.segment.rowsSinceCheckpoint).toBeGreaterThanOrEqual(4);
    expect(res.body.segment.brokenAtId).toBeNull();
    expect(res.body.recent).toHaveLength(1);
    expect(res.body.checkpoint.ageSec).toBe(0);
  });

  it('next day: a new checkpoint links to the previous object digest', async () => {
    t.clock.advance(86_400_000);
    const r = await createAuditCheckpoint(t.deps);
    expect(r).toMatchObject({ status: 'CREATED', day: '2026-10-05', storageKey: 'audit-checkpoints/2026/10/05.json' });
    const [first] = await t.adminSql<{ object_sha256: Buffer }[]>`SELECT object_sha256 FROM audit_checkpoints WHERE checkpoint_day = '2026-10-04'`;
    const [second] = await t.adminSql<{ prev_object_sha256: Buffer }[]>`SELECT prev_object_sha256 FROM audit_checkpoints WHERE checkpoint_day = '2026-10-05'`;
    expect(Buffer.from(second!.prev_object_sha256).equals(Buffer.from(first!.object_sha256))).toBe(true);
    const doc = JSON.parse(new TextDecoder().decode(t.storage.objects.get('audit-checkpoints/2026/10/05.json')!.body));
    expect(doc.previous).toEqual({ checkpointDay: '2026-10-04', objectSha256: Buffer.from(first!.object_sha256).toString('hex') });
    const v = await verifyAuditCheckpoints(t.deps);
    expect(v.status).toBe('OK');
    expect(v.history.checkpoints).toBe(2);
    expect(v.recent.map((x) => x.day)).toEqual(['2026-10-05', '2026-10-04']);
  });

  it('MOCK storage lost the object (dev restart) → still OK, with a warning', async () => {
    t.storage.objects.delete('audit-checkpoints/2026/10/05.json');
    const v = await verifyAuditCheckpoints(t.deps);
    expect(v.status).toBe('OK');
    expect(v.storage.status).toBe('MISSING');
    expect(v.warnings.join(' ')).toMatch(/MOCK/);
  });
});

describe('audit checkpoints — tamper detection', () => {
  let t: TestContext;
  beforeAll(async () => {
    t = await createTestContext({ now: NOW });
  });
  afterAll(async () => {
    await t.close();
  });

  it('a row edited after the checkpoint → BROKEN at that id; the job refuses to anchor it (CRITICAL security event, no row)', async () => {
    await addAuditRows(t, 3, 'c');
    expect(await createAuditCheckpoint(t.deps)).toMatchObject({ status: 'CREATED' });
    await addAuditRows(t, 3, 'd');
    const [maxRow] = await t.adminSql<{ id: string }[]>`SELECT max(id) - 1 AS id FROM audit_logs`;
    const id = maxRow!.id;
    await t.adminSql.unsafe(`ALTER TABLE audit_logs DISABLE TRIGGER trg_append_only;
      UPDATE audit_logs SET action = 'test.tampered' WHERE id = ${Number(id)};
      ALTER TABLE audit_logs ENABLE TRIGGER trg_append_only;`);
    const v = await verifyAuditCheckpoints(t.deps);
    expect(v.status).toBe('BROKEN');
    expect(v.segment.brokenAtId).toBe(Number(id));
    expect(v.anchor).toMatchObject({ hashMatches: true, rowCountMatches: true });

    t.clock.advance(86_400_000);
    const r = await createAuditCheckpoint(t.deps);
    expect(r).toMatchObject({ status: 'REFUSED', day: '2026-10-05' });
    expect((await t.adminSql`SELECT 1 FROM audit_checkpoints WHERE checkpoint_day = '2026-10-05'`).length).toBe(0);
    expect(t.storage.objects.has('audit-checkpoints/2026/10/05.json')).toBe(false);
    const ev = await t.adminSql<{ severity: string; meta: { source: string; findings: string[] } }[]>`SELECT severity, meta FROM security_events WHERE type = 'AUDIT_CHAIN_BROKEN'`;
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ severity: 'CRITICAL', meta: { source: 'infra.audit_checkpoint' } });
  });
});

describe('audit checkpoints — full-chain rewrite (what verify_audit_chain alone cannot see)', () => {
  let t: TestContext;
  let superA: Admin;
  beforeAll(async () => {
    t = await createTestContext({ now: NOW });
    superA = await createAdmin(t, ['SUPER_ADMIN']);
  });
  afterAll(async () => {
    await t.close();
  });

  it('rewritten + rehashed chain passes verify_audit_chain() but fails against the checkpoint; a forged checkpoint row fails against the WORM object', async () => {
    await addAuditRows(t, 5, 'e');
    expect(await createAuditCheckpoint(t.deps)).toMatchObject({ status: 'CREATED' });
    await rewriteChainFrom(t, 2);
    const [full] = await t.adminSql<{ broken: string | null }[]>`SELECT verify_audit_chain() AS broken`;
    expect(full!.broken).toBeNull(); // the in-DB check alone is fooled

    const v1 = await as(t, superA, 'GET', '/v1/admin/infra/audit/checkpoints/verify');
    expect(v1.body.status).toBe('BROKEN');
    expect(v1.body.anchor.hashMatches).toBe(false);
    expect(v1.body.history.mismatched).toHaveLength(1);
    expect(v1.body.storage.status).toBe('MISMATCH'); // the object still carries the original hash
    expect(v1.body.findings.join(' ')).toMatch(/ditulis ulang/);

    // the attacker also forges the checkpoint row (and even copies the real object digest) → the object content disagrees
    await t.adminSql.unsafe(`ALTER TABLE audit_checkpoints DISABLE TRIGGER trg_append_only;
      UPDATE audit_checkpoints c SET last_hash = a.hash FROM audit_logs a WHERE a.id = c.last_id;
      ALTER TABLE audit_checkpoints ENABLE TRIGGER trg_append_only;`);
    const v2 = await verifyAuditCheckpoints(t.deps);
    expect(v2.anchor).toMatchObject({ hashMatches: true });
    expect(v2.history.mismatched).toHaveLength(0);
    expect(v2.storage.status).toBe('MISMATCH');
    expect(v2.status).toBe('BROKEN');
  });
});

describe('audit checkpoints — LIVE storage semantics', () => {
  let t: TestContext;
  const storage = new LiveLikeStorage();
  beforeAll(async () => {
    t = await createTestContext({ now: NOW, providers: { storage } });
  });
  afterAll(async () => {
    await t.close();
  });

  it('a failed PUT rolls the checkpoint row back (never a row without its object)', async () => {
    storage.failPut = true;
    await expect(createAuditCheckpoint(t.deps)).rejects.toThrow(/PUT failed/);
    expect((await t.adminSql`SELECT 1 FROM audit_checkpoints`).length).toBe(0);
    expect(await auditRows(t, 'infra.audit_checkpoint_created')).toHaveLength(0);
    storage.failPut = false;
    expect(await createAuditCheckpoint(t.deps)).toMatchObject({ status: 'CREATED', storageMode: 'LIVE' });
    expect((await verifyAuditCheckpoints(t.deps)).status).toBe('OK');
  });

  it('object stored but the DB commit failed → the retry adopts that object instead of overwriting a locked key', async () => {
    t.clock.advance(86_400_000);
    storage.failAfterPut = true;
    await expect(createAuditCheckpoint(t.deps)).rejects.toThrow(/connection reset/);
    expect((await t.adminSql`SELECT 1 FROM audit_checkpoints WHERE checkpoint_day = '2026-10-05'`).length).toBe(0);
    expect(storage.inner.objects.has('audit-checkpoints/2026/10/05.json')).toBe(true);
    storage.failAfterPut = false;
    await t.adminSql`SELECT jk_audit('SYSTEM', NULL, 'test.after_upload', 'x', '1', NULL, NULL)`; // head moved on meanwhile
    const r = await createAuditCheckpoint(t.deps);
    expect(r).toMatchObject({ status: 'CREATED', day: '2026-10-05', adoptedExistingObject: true });
    const stored = storage.inner.objects.get('audit-checkpoints/2026/10/05.json')!;
    const doc = JSON.parse(new TextDecoder().decode(stored.body));
    const [row] = await t.adminSql<{ last_id: string; object_sha256: Buffer }[]>`SELECT last_id, object_sha256 FROM audit_checkpoints WHERE checkpoint_day = '2026-10-05'`;
    expect(Number(row!.last_id)).toBe(doc.chain.lastId); // the row mirrors the stored bytes, not the newer head
    expect(Buffer.from(row!.object_sha256).toString('hex')).toBe(await sha256Hex(new Uint8Array(stored.body)));
    expect((await verifyAuditCheckpoints(t.deps)).status).toBe('OK');
  });

  it('a foreign / non-matching object already at the key is never adopted → REFUSED', async () => {
    t.clock.advance(86_400_000);
    await storage.inner.put('audit-checkpoints/2026/10/06.json', new TextEncoder().encode(JSON.stringify({ format: 'jastipkita.audit-checkpoint.v1', checkpointDay: '2026-10-06', chain: { lastId: 1, rowCount: 1, lastHash: 'ab'.repeat(32), headUpdatedAt: '2026-10-06T00:00:00Z' }, previous: null })), 'application/json');
    const r = await createAuditCheckpoint(t.deps);
    expect(r).toMatchObject({ status: 'REFUSED', day: '2026-10-06' });
    expect((await t.adminSql`SELECT 1 FROM audit_checkpoints WHERE checkpoint_day = '2026-10-06'`).length).toBe(0);
  });

  it('a missing object in LIVE storage is a break, not a warning', async () => {
    await storage.inner.delete('audit-checkpoints/2026/10/05.json');
    const v = await verifyAuditCheckpoints(t.deps);
    expect(v.storage.status).toBe('MISSING');
    expect(v.status).toBe('BROKEN');
  });
});
