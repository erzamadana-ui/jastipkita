/**
 * DB & Infra Center (read: infra.db.read; actions: infra.db.operate + SUPER_ADMIN role + fresh MFA).
 *
 * Safety decisions (docs/api/admin.md §15):
 *  - Credentials are never returned or editable: responses carry the provider name and a MASKED host only.
 *  - No DDL from the admin UI. Schema migrations run from CI (db/scripts/migrate.sh); the admin UI tracks, approves and
 *    records the 8-step workflow in db_operations / db_operation_steps (see workflow.ts).
 *  - Restores always go to a NEW branch/database (provider restoreToNew) and need a second approver (DB CHECK on
 *    db_operations for RESTORE/IMPORT/SWITCH/ROLLBACK).
 *  - The generic provider cannot create backups: backups/PITR are "managed outside the app" (pg_dump schedule or the
 *    managed provider's console) — reported as such, never faked.
 */
import type { AppDeps } from '../../context';
import { AppError, Errors } from '../../lib/errors';
import { enqueueJob } from '../../jobs/enqueue';
import { storeServerFile } from '../files/service';
import { type AdminCtx, adminAudit, inAdminTx, iso, makerChecker, maskHost, num, requireRole } from '../admin/common';
import { MIGRATION_MANIFEST } from './migration-manifest';

export const EXPORT_QUEUE = 'admin.export';

function dbTarget(env: AppDeps['env']) {
  try {
    const u = new URL(env.DATABASE_URL);
    return { host: maskHost(u.hostname), port: u.port || '5432', database: `${u.pathname.replace(/^\//, '').slice(0, 2)}***`, ssl: /sslmode=(require|verify)/.test(u.search) };
  } catch {
    return { host: null, port: null, database: null, ssl: null };
  }
}

export function environmentOf(env: AppDeps['env']): 'DEVELOPMENT' | 'STAGING' | 'PRODUCTION' {
  return env.APP_ENV === 'production' ? 'PRODUCTION' : env.APP_ENV === 'staging' ? 'STAGING' : 'DEVELOPMENT';
}

export async function dbHealth(ctx: AdminCtx) {
  const db = ctx.deps.sql;
  const t0 = Date.now();
  const [v] = await db<{ version: string; server_version: string; size: number; in_recovery: boolean; started: Date; tz: string }[]>`
    SELECT version() AS version, current_setting('server_version') AS server_version, pg_database_size(current_database()) AS size,
           pg_is_in_recovery() AS in_recovery, pg_postmaster_start_time() AS started, current_setting('TimeZone') AS tz`;
  const latencyMs = Date.now() - t0;
  const conns = await db<{ state: string | null; n: number }[]>`
    SELECT state, count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() GROUP BY state`;
  const [max] = await db<{ max: number; reserved: number }[]>`
    SELECT current_setting('max_connections')::int AS max, current_setting('superuser_reserved_connections')::int AS reserved`;
  const [stats] = await db<{ hit: number; read: number; commits: number; rollbacks: number; deadlocks: number; temp_bytes: number }[]>`
    SELECT blks_hit AS hit, blks_read AS read, xact_commit AS commits, xact_rollback AS rollbacks, deadlocks, temp_bytes
      FROM pg_stat_database WHERE datname = current_database()`;
  const [longq] = await db<{ n: number; visible: number }[]>`
    SELECT count(*) FILTER (WHERE state = 'active' AND query_start < now() - interval '30 seconds' AND pid <> pg_backend_pid())::int AS n,
           count(*) FILTER (WHERE state IS NOT NULL)::int AS visible
      FROM pg_stat_activity WHERE datname = current_database()`;
  const [repl] = await db<{ senders: number }[]>`SELECT count(*)::int AS senders FROM pg_stat_replication`;
  const [recv] = await db<{ status: string | null }[]>`SELECT (SELECT status FROM pg_stat_wal_receiver LIMIT 1) AS status`;
  const hit = num(stats?.hit);
  const read = num(stats?.read);
  const total = conns.reduce((s, c) => s + c.n, 0);
  return {
    checkedAt: ctx.deps.clock.now().toISOString(),
    provider: { dbProvider: ctx.deps.env.DB_PROVIDER, adminProvider: ctx.deps.providers.dbAdmin.name },
    target: dbTarget(ctx.deps.env),
    server: { version: v!.server_version, versionString: v!.version.split(',')[0], timezone: v!.tz, startedAt: iso(v!.started), inRecovery: v!.in_recovery },
    latencyMs,
    sizeBytes: num(v!.size),
    connections: {
      total,
      max: max!.max,
      reservedSuperuser: max!.reserved,
      utilization: max!.max > 0 ? Math.round((total / max!.max) * 10000) / 10000 : null,
      byState: conns.map((c) => ({ state: c.state ?? 'UNKNOWN (other role)', count: c.n })),
    },
    cacheHitRatio: hit + read > 0 ? Math.round((hit / (hit + read)) * 10000) / 10000 : null,
    transactions: { commits: num(stats?.commits), rollbacks: num(stats?.rollbacks), deadlocks: num(stats?.deadlocks), tempBytes: num(stats?.temp_bytes) },
    longRunningQueries: { thresholdSec: 30, count: longq?.n ?? 0 },
    replication: { walSenders: repl?.senders ?? 0, walReceiverStatus: recv?.status ?? null, isReplica: v!.in_recovery },
    dataQuality: (longq?.visible ?? 0) < total ? 'Role aplikasi tidak melihat state/kueri sesi role lain (pg_stat_activity); long-running count bisa lebih rendah dari aktual.' : null,
  };
}

export async function providerInfo(ctx: AdminCtx) {
  const p = ctx.deps.providers.dbAdmin;
  let info: Record<string, unknown>;
  try {
    info = { ...(await p.info()) };
  } catch (err) {
    info = { error: err instanceof Error ? err.message.slice(0, 200) : 'provider error' };
  }
  return {
    provider: p.name,
    dbProvider: ctx.deps.env.DB_PROVIDER,
    capabilities: p.capabilities,
    info,
    target: dbTarget(ctx.deps.env),
    backupsManagedOutsideApp: !p.capabilities.backups,
    credentials: 'Tidak pernah ditampilkan atau dapat diubah dari admin UI (secret store / env server).',
  };
}

export interface MigrationStatusRow {
  version: string;
  name: string;
  status: 'APPLIED' | 'PENDING' | 'CHECKSUM_DRIFT' | 'UNKNOWN_IN_BUILD';
  fileChecksum: string | null;
  appliedChecksum: string | null;
  appliedAt: string | null;
  executionMs: number | null;
  appliedBy: string | null;
}

export async function migrationStatus(ctx: AdminCtx) {
  const applied = await ctx.deps.sql<{ version: string; name: string; checksum: string; applied_at: Date; execution_ms: number | null; applied_by: string }[]>`
    SELECT version, name, checksum, applied_at, execution_ms, applied_by FROM schema_migrations ORDER BY version`;
  const byVersion = new Map(applied.map((a) => [a.version, a]));
  const rowsOut: MigrationStatusRow[] = MIGRATION_MANIFEST.map((m) => {
    const a = byVersion.get(m.version);
    return {
      version: m.version,
      name: m.name,
      status: !a ? 'PENDING' : a.checksum === m.checksum ? 'APPLIED' : 'CHECKSUM_DRIFT',
      fileChecksum: m.checksum,
      appliedChecksum: a?.checksum ?? null,
      appliedAt: iso(a?.applied_at),
      executionMs: a?.execution_ms ?? null,
      appliedBy: a ? (a.applied_by.length > 3 ? `${a.applied_by.slice(0, 3)}***` : '***') : null,
    };
  });
  for (const a of applied) {
    if (!MIGRATION_MANIFEST.some((m) => m.version === a.version)) {
      rowsOut.push({ version: a.version, name: a.name, status: 'UNKNOWN_IN_BUILD', fileChecksum: null, appliedChecksum: a.checksum, appliedAt: iso(a.applied_at), executionMs: a.execution_ms, appliedBy: '***' });
    }
  }
  rowsOut.sort((x, y) => x.version.localeCompare(y.version));
  const count = (s: MigrationStatusRow['status']) => rowsOut.filter((r) => r.status === s).length;
  return {
    schemaVersion: applied.length ? applied[applied.length - 1]!.version : null,
    buildVersion: MIGRATION_MANIFEST.length ? MIGRATION_MANIFEST[MIGRATION_MANIFEST.length - 1]!.version : null,
    summary: { applied: count('APPLIED'), pending: count('PENDING'), checksumDrift: count('CHECKSUM_DRIFT'), unknownInBuild: count('UNKNOWN_IN_BUILD') },
    inSync: count('PENDING') + count('CHECKSUM_DRIFT') + count('UNKNOWN_IN_BUILD') === 0,
    migrations: rowsOut,
    note: 'Migrasi dijalankan dari CI (db/scripts/migrate.sh), bukan dari admin UI. CHECKSUM_DRIFT = file migrasi yang sudah diterapkan berubah (dilarang; buat migrasi baru).',
  };
}

export async function storageUsage(ctx: AdminCtx, limit: number) {
  const r = await ctx.deps.sql<{ relname: string; total: number; table_bytes: number; index_bytes: number; rows: number; seq_scan: number; idx_scan: number | null }[]>`
    SELECT c.relname, pg_total_relation_size(c.oid) AS total, pg_relation_size(c.oid) AS table_bytes, pg_indexes_size(c.oid) AS index_bytes,
           coalesce(s.n_live_tup, 0) AS rows, coalesce(s.seq_scan, 0) AS seq_scan, s.idx_scan
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
     WHERE n.nspname = 'public' AND c.relkind = 'r'
     ORDER BY pg_total_relation_size(c.oid) DESC LIMIT ${limit}`;
  const [db] = await ctx.deps.sql<{ size: number }[]>`SELECT pg_database_size(current_database()) AS size`;
  return {
    databaseBytes: num(db?.size),
    tables: r.map((t) => ({ table: t.relname, totalBytes: num(t.total), tableBytes: num(t.table_bytes), indexBytes: num(t.index_bytes), estimatedRows: num(t.rows), seqScans: num(t.seq_scan), indexScans: t.idx_scan === null ? null : num(t.idx_scan) })),
    definition: 'pg_total_relation_size (tabel + indeks + TOAST); jumlah baris = estimasi n_live_tup.',
  };
}

export async function connectionTest(ctx: AdminCtx) {
  const samples: number[] = [];
  let ok = true;
  let error: string | null = null;
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now();
    try {
      await ctx.deps.sql`SELECT 1`;
      samples.push(Date.now() - t0);
    } catch (err) {
      ok = false;
      error = err instanceof Error ? err.message.replace(/postgres(ql)?:\/\/\S+/g, '[redacted]').slice(0, 200) : 'error';
      break;
    }
  }
  const now = ctx.deps.clock.now();
  const result = { ok, samplesMs: samples, avgMs: samples.length ? Math.round(samples.reduce((a, b) => a + b, 0) / samples.length) : null };
  const id = await inAdminTx(ctx, async (tx) => {
    const [op] = await tx<{ id: string }[]>`
      INSERT INTO db_operations (type, status, environment, provider, requested_by, reason, params, result, error, started_at, finished_at)
      VALUES ('CONNECTION_TEST', ${ok ? 'SUCCEEDED' : 'FAILED'}, ${environmentOf(ctx.deps.env)}, ${ctx.deps.providers.dbAdmin.name}, ${ctx.auth.userId},
              'connection test', '{}'::jsonb, ${tx.json(result as never)}, ${error}, ${now}, ${now})
      RETURNING id`;
    await adminAudit(tx, ctx, { action: 'infra.db_connection_tested', entityType: 'db_operation', entityId: op!.id, after: result });
    return op!.id;
  });
  return { operationId: id, ...result, error, target: dbTarget(ctx.deps.env) };
}

// ------------------------------------------------------------------ backups / restore

export async function listBackups(ctx: AdminCtx) {
  const p = ctx.deps.providers.dbAdmin;
  const ops = await ctx.deps.sql<{ id: string; type: string; status: string; created_at: Date; result: unknown }[]>`
    SELECT id, type, status, created_at, result FROM db_operations WHERE type IN ('BACKUP','RESTORE','RESTORE_TEST') ORDER BY created_at DESC LIMIT 50`;
  if (!p.capabilities.backups) {
    return {
      provider: p.name,
      managedOutsideApp: true,
      backups: [],
      note: 'Backup & PITR dikelola di luar aplikasi (jadwal pg_dump atau konsol provider). Catat restore test sebagai db_operations RESTORE_TEST.',
      operations: ops.map((o) => ({ id: o.id, type: o.type, status: o.status, createdAt: iso(o.created_at)!, result: o.result })),
    };
  }
  let backups: { id: string; createdAt: string; kind: string; sizeBytes: number | null; status: string }[] = [];
  let error: string | null = null;
  try {
    backups = (await p.listBackups()).map((b) => ({ id: b.id, createdAt: b.createdAt.toISOString(), kind: b.kind, sizeBytes: b.sizeBytes ?? null, status: b.status }));
  } catch (err) {
    error = err instanceof Error ? err.message.slice(0, 200) : 'provider error';
  }
  return { provider: p.name, managedOutsideApp: false, backups, error, operations: ops.map((o) => ({ id: o.id, type: o.type, status: o.status, createdAt: iso(o.created_at)!, result: o.result })) };
}

function requireOperator(ctx: AdminCtx) {
  requireRole(ctx.auth, 'SUPER_ADMIN', 'Aksi DB & Infra hanya untuk SUPER_ADMIN dengan izin infra.db.operate');
}

export async function createBackup(ctx: AdminCtx, input: { label: string; reason: string }) {
  requireOperator(ctx);
  const p = ctx.deps.providers.dbAdmin;
  if (!p.capabilities.backups) {
    throw Errors.unprocessable('BACKUP_MANAGED_OUTSIDE_APP', 'Provider generic: backup dikelola di luar aplikasi (pg_dump / konsol provider)', { provider: p.name });
  }
  const now = ctx.deps.clock.now();
  const opId = await inAdminTx(ctx, async (tx) => {
    const [op] = await tx<{ id: string }[]>`
      INSERT INTO db_operations (type, status, environment, provider, requested_by, reason, params, started_at)
      VALUES ('BACKUP', 'RUNNING', ${environmentOf(ctx.deps.env)}, ${p.name}, ${ctx.auth.userId}, ${input.reason}, ${tx.json({ label: input.label } as never)}, ${now})
      RETURNING id`;
    await adminAudit(tx, ctx, { action: 'infra.db_backup_requested', entityType: 'db_operation', entityId: op!.id, meta: { label: input.label, reason: input.reason } });
    return op!.id;
  });
  try {
    const b = await p.createBackup(input.label);
    const result = { backupId: b.id, kind: b.kind, status: b.status };
    await ctx.deps.sql`UPDATE db_operations SET status = 'SUCCEEDED', result = ${ctx.deps.sql.json(result as never)}, finished_at = ${ctx.deps.clock.now()} WHERE id = ${opId}`;
    return { operationId: opId, status: 'SUCCEEDED', backup: { ...result, createdAt: b.createdAt.toISOString() } };
  } catch (err) {
    const msg = err instanceof Error ? err.message.slice(0, 300) : 'provider error';
    await ctx.deps.sql`UPDATE db_operations SET status = 'FAILED', error = ${msg}, finished_at = ${ctx.deps.clock.now()} WHERE id = ${opId}`;
    throw new AppError(502, 'DB_PROVIDER_ERROR', 'Provider gagal membuat backup', { operationId: opId, error: msg });
  }
}

export async function requestRestore(ctx: AdminCtx, input: { backupId?: string | undefined; pointInTime?: string | undefined; label: string; reason: string }) {
  requireOperator(ctx);
  const p = ctx.deps.providers.dbAdmin;
  if (!input.backupId && !input.pointInTime) throw Errors.validation({ issues: [{ path: 'backupId', message: 'backupId atau pointInTime wajib' }] });
  if (input.pointInTime && !p.capabilities.pitr) throw Errors.unprocessable('PITR_UNSUPPORTED', 'Provider tidak mendukung point-in-time restore lewat API');
  if (!p.capabilities.branching && !p.capabilities.backups) throw Errors.unprocessable('RESTORE_MANAGED_OUTSIDE_APP', 'Provider generic: restore dilakukan di luar aplikasi; catat sebagai operasi manual');
  const op = await inAdminTx(ctx, async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO db_operations (type, status, environment, provider, requested_by, reason, params)
      VALUES ('RESTORE', 'REQUESTED', ${environmentOf(ctx.deps.env)}, ${p.name}, ${ctx.auth.userId}, ${input.reason},
              ${tx.json({ backupId: input.backupId ?? null, pointInTime: input.pointInTime ?? null, label: input.label, target: 'NEW_BRANCH' } as never)})
      RETURNING id`;
    await adminAudit(tx, ctx, { action: 'infra.db_restore_requested', entityType: 'db_operation', entityId: row!.id, meta: { backupId: input.backupId ?? null, pointInTime: input.pointInTime ?? null, label: input.label, reason: input.reason } });
    return row!;
  });
  return { operationId: op.id, status: 'REQUESTED', note: 'Restore selalu ke branch/database BARU dan membutuhkan persetujuan SUPER_ADMIN lain.' };
}

interface OpRow {
  id: string;
  type: string;
  status: string;
  environment: string;
  provider: string | null;
  requested_by: string | null;
  approved_by: string | null;
  approved_at: Date | null;
  reason: string | null;
  params: Record<string, unknown>;
  result: unknown;
  error: string | null;
  started_at: Date | null;
  finished_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export function opDto(o: OpRow) {
  return {
    id: o.id,
    type: o.type,
    status: o.status,
    environment: o.environment,
    provider: o.provider,
    requestedBy: o.requested_by,
    approvedBy: o.approved_by,
    approvedAt: iso(o.approved_at),
    reason: o.reason,
    params: o.params,
    result: o.result,
    error: o.error,
    startedAt: iso(o.started_at),
    finishedAt: iso(o.finished_at),
    createdAt: iso(o.created_at)!,
    updatedAt: iso(o.updated_at)!,
  };
}

export async function listOperations(ctx: AdminCtx, q: { type?: string | undefined; status?: string | undefined; limit: number }) {
  const db = ctx.deps.sql;
  const r = await db<OpRow[]>`
    SELECT * FROM db_operations WHERE true ${q.type ? db`AND type = ${q.type}` : db``} ${q.status ? db`AND status = ${q.status}` : db``}
     ORDER BY created_at DESC LIMIT ${q.limit}`;
  return { data: r.map(opDto), nextCursor: null };
}

export async function operationDetail(ctx: AdminCtx, id: string) {
  const [o] = await ctx.deps.sql<OpRow[]>`SELECT * FROM db_operations WHERE id = ${id}`;
  if (!o) throw Errors.notFound('Operasi DB', 'DB_OPERATION_NOT_FOUND');
  const steps = await ctx.deps.sql<Record<string, unknown>[]>`
    SELECT step_no, step, status, checklist, requires_approval, notes, evidence, completed_by, completed_at, approved_by, approved_at
      FROM db_operation_steps WHERE operation_id = ${id} ORDER BY step_no`;
  return {
    ...opDto(o),
    steps: steps.map((s) => ({
      stepNo: num(s.step_no),
      step: String(s.step),
      status: String(s.status),
      checklist: s.checklist,
      requiresApproval: !!s.requires_approval,
      notes: (s.notes as string | null) ?? null,
      evidence: s.evidence,
      completedBy: (s.completed_by as string | null) ?? null,
      completedAt: iso(s.completed_at as Date | null),
      approvedBy: (s.approved_by as string | null) ?? null,
      approvedAt: iso(s.approved_at as Date | null),
    })),
  };
}

export async function approveOperation(ctx: AdminCtx, id: string, note?: string) {
  requireOperator(ctx);
  const now = ctx.deps.clock.now();
  const o = await inAdminTx(ctx, async (tx) => {
    const [row] = await tx<OpRow[]>`SELECT * FROM db_operations WHERE id = ${id} FOR UPDATE`;
    if (!row) throw Errors.notFound('Operasi DB', 'DB_OPERATION_NOT_FOUND');
    makerChecker(row.requested_by, ctx.auth.userId, 'Operasi DB harus disetujui SUPER_ADMIN lain (maker-checker)');
    if (row.status !== 'REQUESTED') throw Errors.unprocessable('DB_OPERATION_NOT_REQUESTED', 'Operasi tidak menunggu persetujuan', { status: row.status });
    const run = row.type === 'RESTORE';
    await tx`UPDATE db_operations SET status = ${run ? 'RUNNING' : 'APPROVED'}, approved_by = ${ctx.auth.userId}, approved_at = ${now},
                    started_at = ${run ? now : null} WHERE id = ${id}`;
    await adminAudit(tx, ctx, { action: 'infra.db_operation_approved', entityType: 'db_operation', entityId: id, before: { status: 'REQUESTED' }, after: { status: run ? 'RUNNING' : 'APPROVED' }, meta: { type: row.type, note: note ?? null } });
    return row;
  });
  if (o.type !== 'RESTORE') return operationDetail(ctx, id);
  const p = ctx.deps.providers.dbAdmin;
  try {
    const params = o.params as { backupId?: string | null; pointInTime?: string | null; label: string };
    const res = await p.restoreToNew({ ...(params.backupId ? { backupId: params.backupId } : {}), ...(params.pointInTime ? { pointInTime: new Date(params.pointInTime) } : {}), label: params.label });
    await ctx.deps.sql`UPDATE db_operations SET status = 'SUCCEEDED', result = ${ctx.deps.sql.json(res as never)}, finished_at = ${ctx.deps.clock.now()} WHERE id = ${id}`;
  } catch (err) {
    await ctx.deps.sql`UPDATE db_operations SET status = 'FAILED', error = ${err instanceof Error ? err.message.slice(0, 300) : 'provider error'}, finished_at = ${ctx.deps.clock.now()} WHERE id = ${id}`;
  }
  return operationDetail(ctx, id);
}

export async function cancelOperation(ctx: AdminCtx, id: string, reason: string) {
  requireOperator(ctx);
  await inAdminTx(ctx, async (tx) => {
    const [row] = await tx<OpRow[]>`SELECT * FROM db_operations WHERE id = ${id} FOR UPDATE`;
    if (!row) throw Errors.notFound('Operasi DB', 'DB_OPERATION_NOT_FOUND');
    if (!['REQUESTED', 'APPROVED'].includes(row.status)) throw Errors.unprocessable('DB_OPERATION_NOT_CANCELLABLE', 'Operasi tidak dapat dibatalkan pada status ini', { status: row.status });
    await tx`UPDATE db_operations SET status = 'CANCELLED', error = ${`cancelled: ${reason}`}, finished_at = ${ctx.deps.clock.now()} WHERE id = ${id}`;
    await adminAudit(tx, ctx, { action: 'infra.db_operation_cancelled', entityType: 'db_operation', entityId: id, before: { status: row.status }, after: { status: 'CANCELLED' }, meta: { reason } });
  });
  return operationDetail(ctx, id);
}

// ------------------------------------------------------------------ anonymized analytics export

export async function requestExport(ctx: AdminCtx, input: { from: string; to: string; reason: string }) {
  requireOperator(ctx);
  if (input.to < input.from) throw Errors.unprocessable('RANGE_INVALID', 'Rentang tanggal tidak valid');
  const op = await inAdminTx(ctx, async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO db_operations (type, status, environment, provider, requested_by, reason, params)
      VALUES ('EXPORT', 'REQUESTED', ${environmentOf(ctx.deps.env)}, ${ctx.deps.providers.dbAdmin.name}, ${ctx.auth.userId}, ${input.reason},
              ${tx.json({ kind: 'ANALYTICS_ANONYMIZED', from: input.from, to: input.to } as never)})
      RETURNING id`;
    await enqueueJob(tx, EXPORT_QUEUE, 'analytics_export', { operationId: row!.id }, { dedupeKey: `export:${row!.id}`, maxAttempts: 3 });
    await adminAudit(tx, ctx, { action: 'infra.analytics_export_requested', entityType: 'db_operation', entityId: row!.id, meta: { from: input.from, to: input.to, reason: input.reason } });
    return row!;
  });
  return { operationId: op.id, status: 'REQUESTED', note: 'File ekspor (tanpa data pribadi) dibuat oleh worker; unduh via GET /v1/files/{fileId}/url (hanya pemohon).' };
}

/** Queue handler: aggregates only (no user ids, no free text) → EXPORT file owned by the requester. */
export async function runAnalyticsExport(deps: AppDeps, operationId: string): Promise<Record<string, unknown>> {
  const [op] = await deps.sql<OpRow[]>`SELECT * FROM db_operations WHERE id = ${operationId}`;
  if (!op || op.type !== 'EXPORT') return { skipped: 'NOT_FOUND' };
  if (op.status === 'SUCCEEDED' || op.status === 'CANCELLED') return { skipped: op.status };
  const params = op.params as { from: string; to: string };
  const now = deps.clock.now();
  await deps.sql`UPDATE db_operations SET status = 'RUNNING', started_at = coalesce(started_at, ${now}) WHERE id = ${operationId}`;
  try {
    const funnel = await deps.sql`SELECT * FROM v_funnel_daily WHERE day BETWEEN ${params.from}::date AND ${params.to}::date ORDER BY day`;
    const gmv = await deps.sql`SELECT * FROM v_gmv_daily WHERE day BETWEEN ${params.from}::date AND ${params.to}::date ORDER BY day`;
    const take = await deps.sql`SELECT * FROM v_take_rate WHERE day BETWEEN ${params.from}::date AND ${params.to}::date ORDER BY day`;
    const events = await deps.sql`
      SELECT (occurred_at AT TIME ZONE 'Asia/Jakarta')::date AS day, event_name, platform, count(*)::int AS events,
             count(DISTINCT coalesce(user_id::text, anonymous_id))::int AS actors
        FROM analytics_events
       WHERE occurred_at >= ${new Date(`${params.from}T00:00:00+07:00`)} AND occurred_at < ${new Date(new Date(`${params.to}T00:00:00+07:00`).getTime() + 86400_000)}
       GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`;
    const payload = {
      kind: 'ANALYTICS_ANONYMIZED',
      generatedAt: now.toISOString(),
      range: params,
      anonymization: 'Hanya agregat harian; tanpa id pengguna, e-mail, telepon, teks bebas. Kelompok < 5 aktor tetap ditampilkan sebagai hitungan saja.',
      funnelDaily: funnel,
      gmvDaily: gmv,
      takeRateDaily: take,
      analyticsEventsDaily: events,
    };
    const body = new TextEncoder().encode(JSON.stringify(payload, (_k, v) => (typeof v === 'bigint' ? Number(v) : v)));
    const fileId = await deps.sql.begin(async (tx) => {
      const id = await storeServerFile(deps, tx, { ownerId: op.requested_by!, purpose: 'EXPORT', mime: 'application/json', body, retentionUntil: new Date(now.getTime() + 7 * 86400_000) });
      await tx`UPDATE db_operations SET status = 'SUCCEEDED', result = ${tx.json({ fileId: id, bytes: body.length, rows: { funnel: funnel.length, gmv: gmv.length, takeRate: take.length, events: events.length } } as never)},
                      finished_at = ${deps.clock.now()} WHERE id = ${operationId}`;
      await tx`SELECT jk_audit('JOB', NULL, 'infra.analytics_export_completed', 'db_operation', ${operationId}, NULL, ${tx.json({ fileId: id, bytes: body.length } as never)}::jsonb, '{}'::jsonb)`;
      return id;
    });
    return { operationId, fileId };
  } catch (err) {
    await deps.sql`UPDATE db_operations SET status = 'FAILED', error = ${err instanceof Error ? err.message.slice(0, 300) : 'export failed'}, finished_at = ${deps.clock.now()} WHERE id = ${operationId}`;
    throw err;
  }
}
