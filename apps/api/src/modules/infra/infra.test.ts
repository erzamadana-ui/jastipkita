import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../../../test/helpers';
import { type Admin, as, auditRows, createAdmin } from '../admin/test-support';
import { MIGRATION_MANIFEST } from './migration-manifest';

let t: TestContext;
let superA: Admin;
let superB: Admin;
let superNoMfa: Admin;
let ops: Admin;
let fsa: Admin;

beforeAll(async () => {
  t = await createTestContext();
  superA = await createAdmin(t, ['SUPER_ADMIN']);
  superB = await createAdmin(t, ['SUPER_ADMIN']);
  superNoMfa = await createAdmin(t, ['SUPER_ADMIN'], { mfa: false });
  ops = await createAdmin(t, ['OPERATIONS']);
  fsa = await createAdmin(t, ['FINANCE_SUPER_ADMIN']);
});
afterAll(async () => {
  await t.close();
});

function noSecrets(body: unknown) {
  const s = JSON.stringify(body);
  const url = new URL(t.env.DATABASE_URL);
  expect(s).not.toContain(t.env.DATABASE_URL);
  expect(s).not.toContain(`:${decodeURIComponent(url.password)}@`);
  expect(s).not.toContain(url.password === '' ? '\u0000' : `"${decodeURIComponent(url.password)}"`);
  expect(s).not.toMatch(/postgres(ql)?:\/\//);
  expect(s).not.toContain(url.pathname.slice(1)); // full database name never shown
}

describe('DB & Infra Center — read', () => {
  it('only SUPER_ADMIN has infra.db.read (OPERATIONS / FINANCE_SUPER_ADMIN denied)', async () => {
    expect((await as(t, ops, 'GET', '/v1/admin/infra/db/health')).status).toBe(403);
    expect((await as(t, fsa, 'GET', '/v1/admin/infra/db/health')).status).toBe(403);
  });

  it('health: version, size, connections, cache ratio, replication — host masked, never credentials', async () => {
    const res = await as(t, superA, 'GET', '/v1/admin/infra/db/health');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.server.version).toMatch(/^16/);
    expect(res.body.sizeBytes).toBeGreaterThan(0);
    expect(res.body.connections.max).toBeGreaterThan(0);
    expect(res.body.provider).toEqual({ dbProvider: t.env.DB_PROVIDER, adminProvider: 'generic-postgres' });
    expect(res.body.target.database).toMatch(/\*\*\*$/);
    noSecrets(res.body);
    const prov = await as(t, superA, 'GET', '/v1/admin/infra/db/provider');
    expect(prov.body).toMatchObject({ provider: 'generic-postgres', backupsManagedOutsideApp: true, capabilities: { backups: false } });
    noSecrets(prov.body);
  });

  it('migrations: build manifest vs schema_migrations → in sync, same checksums', async () => {
    const res = await as(t, superA, 'GET', '/v1/admin/infra/db/migrations');
    expect(res.status).toBe(200);
    expect(res.body.inSync).toBe(true);
    expect(res.body.summary).toMatchObject({ applied: MIGRATION_MANIFEST.length, pending: 0, checksumDrift: 0, unknownInBuild: 0 });
    expect(res.body.schemaVersion).toBe(res.body.buildVersion);
    expect(res.body.migrations.find((m: any) => m.version === '0060')).toMatchObject({ name: 'admin', status: 'APPLIED' });
  });

  it('storage + connection test (recorded in db_operations) + audit', async () => {
    const st = await as(t, superA, 'GET', '/v1/admin/infra/db/storage?limit=5');
    expect(st.body.tables).toHaveLength(5);
    const ct = await as(t, superA, 'POST', '/v1/admin/infra/db/connection-test');
    expect(ct.status, JSON.stringify(ct.body)).toBe(200);
    expect(ct.body).toMatchObject({ ok: true });
    expect(ct.body.samplesMs).toHaveLength(3);
    noSecrets(ct.body);
    expect(await auditRows(t, 'infra.db_connection_tested', ct.body.operationId)).toHaveLength(1);
  });
});

describe('DB & Infra Center — operations', () => {
  it('generic provider: backups/restores are managed outside the app; MFA + SUPER_ADMIN required', async () => {
    const list = await as(t, superA, 'GET', '/v1/admin/infra/db/backups');
    expect(list.body).toMatchObject({ provider: 'generic-postgres', managedOutsideApp: true, backups: [] });
    const noMfa = await as(t, superNoMfa, 'POST', '/v1/admin/infra/db/backups', { label: 'pre-launch', reason: 'Sebelum peluncuran' });
    expect(noMfa.body.error.code).toBe('MFA_REQUIRED');
    const b = await as(t, superA, 'POST', '/v1/admin/infra/db/backups', { label: 'pre-launch', reason: 'Sebelum peluncuran' });
    expect(b.status).toBe(422);
    expect(b.body.error.code).toBe('BACKUP_MANAGED_OUTSIDE_APP');
    const r = await as(t, superA, 'POST', '/v1/admin/infra/db/restores', { backupId: 'br-xyz', label: 'restore-test', reason: 'Uji restore bulanan' });
    expect(r.body.error.code).toBe('RESTORE_MANAGED_OUTSIDE_APP');
  });

  it('anonymized analytics export → worker job → EXPORT file owned by the requester, no personal data', async () => {
    const u = await t.createUser({ kycLevel: 2, email: 'siapa.saja@example.com' });
    void u;
    const today = new Date(t.clock.now().getTime() + 7 * 3600_000).toISOString().slice(0, 10);
    const req = await as(t, superA, 'POST', '/v1/admin/infra/db/exports', { from: today, to: today, reason: 'Laporan investor bulanan' });
    expect(req.status, JSON.stringify(req.body)).toBe(202);
    await t.drain();
    const op = await as(t, superA, 'GET', `/v1/admin/infra/db/operations/${req.body.operationId}`);
    expect(op.body.status).toBe('SUCCEEDED');
    const fileId = op.body.result.fileId;
    const [f] = await t.adminSql<{ owner_id: string; purpose: string; storage_key: string }[]>`SELECT owner_id, purpose, storage_key FROM files WHERE id = ${fileId}`;
    expect(f).toMatchObject({ owner_id: superA.id, purpose: 'EXPORT' });
    const raw = new TextDecoder().decode(t.storage.objects.get(f!.storage_key)!.body);
    expect(raw).not.toContain('ANALYTICS_ANONYMIZED'); // encrypted at rest
    const content = await as(t, superA, 'GET', `/v1/files/${fileId}/content`);
    expect(content.status).toBe(200);
    const text = JSON.stringify(content.body);
    expect((await as(t, superB, 'GET', `/v1/files/${fileId}/content`)).status).not.toBe(200);
    expect(text).toContain('ANALYTICS_ANONYMIZED');
    expect(text).not.toContain('siapa.saja@example.com');
    expect(text).not.toMatch(/"(user_id|email|phone_e164)"/);
  });

  it('8-step migration workflow: plan approval by another SUPER_ADMIN, ordered steps, checklist, SWITCH maker-checker, MONITORING → SUCCEEDED', async () => {
    const start = await as(t, superA, 'POST', '/v1/admin/infra/db/migration-workflows', { targetVersion: '0060', description: 'Admin tables', reason: 'Rilis modul admin' });
    expect(start.status, JSON.stringify(start.body)).toBe(201);
    const id = start.body.id;
    expect(start.body.steps.map((s: any) => s.step)).toEqual(['PRE_CHECK', 'BACKUP', 'SCHEMA_MIGRATION', 'DATA_MIGRATION', 'VALIDATION', 'SWITCH', 'MONITORING', 'ROLLBACK']);
    expect((await as(t, superA, 'POST', '/v1/admin/infra/db/migration-workflows', { targetVersion: '0061', description: 'x-lain', reason: 'kedua' })).status).toBe(409);

    const step = (who: Admin, s: string, body: Record<string, unknown>) => as(t, who, 'POST', `/v1/admin/infra/db/migration-workflows/${id}/steps/${s}`, body);
    const all = (s: string) => Object.fromEntries(start.body.steps.find((x: any) => x.step === s).checklist.map((c: any) => [c.key, true]));

    expect((await step(superA, 'PRE_CHECK', { outcome: 'DONE', checklist: all('PRE_CHECK') })).body.error.code).toBe('MIGRATION_WORKFLOW_NOT_ACTIVE');
    expect((await as(t, superA, 'POST', `/v1/admin/infra/db/operations/${id}/approve`, {})).body.error.code).toBe('MAKER_CHECKER_VIOLATION');
    expect((await as(t, superB, 'POST', `/v1/admin/infra/db/operations/${id}/approve`, { note: 'Rencana OK' })).body.status).toBe('APPROVED');

    expect((await step(superA, 'BACKUP', { outcome: 'DONE', checklist: all('BACKUP') })).body.error.code).toBe('STEP_OUT_OF_ORDER');
    const partial = await step(superA, 'PRE_CHECK', { outcome: 'DONE', checklist: { reviewed_ci_green: true } });
    expect(partial.body.error.code).toBe('CHECKLIST_INCOMPLETE');
    expect((await step(superA, 'PRE_CHECK', { outcome: 'SKIPPED' })).body.error.code).toBe('STEP_NOT_SKIPPABLE');
    expect((await step(superA, 'PRE_CHECK', { outcome: 'DONE', checklist: all('PRE_CHECK') })).status).toBe(200);
    expect((await step(superA, 'BACKUP', { outcome: 'DONE', checklist: all('BACKUP'), evidence: { backupId: 'pg_dump-2026-09-27' } })).status).toBe(200);
    expect((await step(superA, 'SCHEMA_MIGRATION', { outcome: 'DONE', checklist: all('SCHEMA_MIGRATION'), evidence: { ciRun: 'https://ci.example.com/run/1' } })).status).toBe(200);
    expect((await step(superA, 'DATA_MIGRATION', { outcome: 'SKIPPED', notes: 'tidak ada backfill' })).status).toBe(200);
    expect((await step(superA, 'VALIDATION', { outcome: 'DONE', checklist: all('VALIDATION') })).status).toBe(200);
    expect((await step(superA, 'SWITCH', { outcome: 'DONE', checklist: all('SWITCH') })).status).toBe(200);
    const early = await step(superA, 'MONITORING', { outcome: 'DONE', checklist: all('MONITORING') });
    expect(early.body.error.code).toBe('STEP_OUT_OF_ORDER');
    expect((await as(t, superA, 'POST', `/v1/admin/infra/db/migration-workflows/${id}/steps/SWITCH/approve`)).body.error.code).toBe('MAKER_CHECKER_VIOLATION');
    expect((await as(t, superB, 'POST', `/v1/admin/infra/db/migration-workflows/${id}/steps/SWITCH/approve`)).status).toBe(200);
    const done = await step(superA, 'MONITORING', { outcome: 'DONE', checklist: all('MONITORING') });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.status).toBe('SUCCEEDED');
    expect(done.body.steps.find((s: any) => s.step === 'ROLLBACK').status).toBe('SKIPPED');
    expect((await auditRows(t, 'infra.migration_step_recorded', id)).length).toBe(7);
  });

  it('SCHEMA_MIGRATION cannot be marked DONE before CI applied the version; a failed step leads to ROLLBACK', async () => {
    const start = await as(t, superA, 'POST', '/v1/admin/infra/db/migration-workflows', { targetVersion: '0069', description: 'Belum ada', reason: 'Uji kegagalan' });
    const id = start.body.id;
    await as(t, superB, 'POST', `/v1/admin/infra/db/operations/${id}/approve`, {});
    const all = (s: string) => Object.fromEntries(start.body.steps.find((x: any) => x.step === s).checklist.map((c: any) => [c.key, true]));
    const step = (s: string, body: Record<string, unknown>) => as(t, superA, 'POST', `/v1/admin/infra/db/migration-workflows/${id}/steps/${s}`, body);
    await step('PRE_CHECK', { outcome: 'DONE', checklist: all('PRE_CHECK') });
    await step('BACKUP', { outcome: 'DONE', checklist: all('BACKUP') });
    expect((await step('SCHEMA_MIGRATION', { outcome: 'DONE', checklist: all('SCHEMA_MIGRATION') })).body.error.code).toBe('MIGRATION_NOT_APPLIED');
    expect((await step('SCHEMA_MIGRATION', { outcome: 'FAILED', notes: 'CI gagal' })).status).toBe(200);
    expect((await step('DATA_MIGRATION', { outcome: 'SKIPPED' })).body.error.code).toBe('WORKFLOW_FAILED');
    expect((await step('ROLLBACK', { outcome: 'DONE', checklist: all('ROLLBACK') })).status).toBe(200);
    const fin = await as(t, superB, 'POST', `/v1/admin/infra/db/migration-workflows/${id}/steps/ROLLBACK/approve`);
    expect(fin.body.status).toBe('FAILED');
  });
});
