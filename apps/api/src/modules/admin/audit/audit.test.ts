import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../../../../test/helpers';
import { adminJobs, auditChainVerify, kpiSnapshot, staleOpsCleanup } from '../../../jobs/admin';
import { ALERT_THRESHOLDS, evaluateAlerts, evaluateAndPersistAlerts, type SystemHealth } from '../system/service';
import { type Admin, as, createAdmin } from '../test-support';

let t: TestContext;
let superA: Admin;
let finance: Admin;
let support: Admin;

beforeAll(async () => {
  t = await createTestContext();
  superA = await createAdmin(t, ['SUPER_ADMIN']);
  finance = await createAdmin(t, ['FINANCE']);
  support = await createAdmin(t, ['SUPPORT']);
});
afterAll(async () => {
  await t.close();
});

const healthy = (): SystemHealth => ({
  generatedAt: new Date().toISOString(),
  status: 'OK',
  database: { ok: true, latencyMs: 1, schemaVersion: '0060', connections: 5, maxConnections: 100 },
  outbox: { backlog: 0, oldestUnpublishedAgeSec: null, retryingEvents: 0 },
  jobs: { queued: 0, running: 0, overdue: 0, dead24h: 0, deadTotal: 0, expiredLeases: 0 },
  webhooks: { received24h: 0, failed24h: 0, unprocessedOlderThan10m: 0, invalidSignature24h: 0 },
  refunds: { failed: 0, pendingApproval: 0, pendingApprovalOlderThan24h: 0, processingOlderThan1h: 0 },
  payouts: { failed: 0, onHold: 0, onHoldOlderThan48h: 0, processingOlderThan1h: 0 },
  notifications: { deliveries24h: 0, failed24h: 0, failureRate: null },
  security: { highOrCritical24h: 0, critical24h: 0, byType: [] },
  disputes: { slaBreachedOpen: 0 },
  support: { firstResponseBreached: 0 },
  auditChain: { status: 'UP', checkedAt: null, brokenAtId: null },
  integrations: { payments: 'LIVE', email: 'LIVE', push: 'LIVE', sms: 'LIVE', storage: 'LIVE' },
  alertsOpen: 0,
});

describe('alert thresholds (pure)', () => {
  it('healthy → no alerts; tiers MEDIUM/HIGH/CRITICAL; min sample for rates; production integration check', () => {
    expect(evaluateAlerts(healthy(), 'production')).toEqual([]);
    const h = healthy();
    h.outbox.backlog = 600;
    h.outbox.oldestUnpublishedAgeSec = 400;
    h.notifications = { deliveries24h: 10, failed24h: 5, failureRate: 0.5 };
    h.security = { highOrCritical24h: 2, critical24h: 1, byType: [] };
    h.database.connections = 90;
    h.integrations.payments = 'SANDBOX';
    h.auditChain = { status: 'DOWN', checkedAt: null, brokenAtId: 42 };
    const a = evaluateAlerts(h, 'production');
    const by = Object.fromEntries(a.map((x) => [x.code, x.severity]));
    expect(by).toMatchObject({ OUTBOX_BACKLOG: 'HIGH', OUTBOX_STALE: 'MEDIUM', SECURITY_EVENTS_HIGH: 'CRITICAL', DB_CONNECTIONS: 'HIGH', INTEGRATION_NOT_LIVE_IN_PRODUCTION: 'HIGH', AUDIT_CHAIN_BROKEN: 'CRITICAL' });
    expect(by.NOTIFICATION_FAILURE_RATE).toBeUndefined(); // sample < minSample
    expect(a[0]!.severity).toBe('CRITICAL'); // sorted by severity
    expect(evaluateAlerts(h, 'staging').some((x) => x.code === 'INTEGRATION_NOT_LIVE_IN_PRODUCTION')).toBe(false);
    for (const x of a) expect(x.description).toBe(ALERT_THRESHOLDS[x.code].description);
  });
});

describe('audit log viewer', () => {
  it('audit.read required; filters by action prefix / entity; verify OK', async () => {
    const u = await t.createUser({ kycLevel: 2 });
    await as(t, superA, 'POST', `/v1/admin/users/${u.id}/force-logout`, { reason: 'Perangkat hilang' });
    for (let i = 0; i < 3; i++) {
      const other = await t.createUser({ kycLevel: 2 });
      await as(t, superA, 'POST', `/v1/admin/users/${other.id}/force-logout`, { reason: 'Perangkat hilang' });
    }
    expect((await as(t, support, 'GET', '/v1/admin/audit-logs')).status).toBe(403);
    const res = await as(t, finance, 'GET', `/v1/admin/audit-logs?action=users.*&entityId=${u.id}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ action: 'users.force_logout', actorType: 'ADMIN', actorId: superA.id, entityType: 'user', entityId: u.id });
    expect(res.body.data[0].meta).toMatchObject({ actorRoles: ['SUPER_ADMIN'] });
    expect(res.body.data[0].hash).toMatch(/^[0-9a-f]{64}$/);
    const page = await as(t, finance, 'GET', '/v1/admin/audit-logs?limit=2');
    expect(page.body.nextCursor).toBeTruthy();
    const next = await as(t, finance, 'GET', `/v1/admin/audit-logs?limit=2&cursor=${page.body.nextCursor}`);
    expect(next.body.data[0].id).toBeLessThan(page.body.data[1].id);
    const v = await as(t, finance, 'GET', '/v1/admin/audit-logs/verify');
    expect(v.body).toMatchObject({ status: 'OK', brokenAtId: null });
  });
});

describe('system health, alerts and admin jobs', () => {
  it('health + alerts need infra.db.read (FINANCE denied)', async () => {
    expect((await as(t, finance, 'GET', '/v1/admin/system/health')).status).toBe(403);
    const h = await as(t, superA, 'GET', '/v1/admin/system/health');
    expect(h.status, JSON.stringify(h.body)).toBe(200);
    expect(h.body.database.ok).toBe(true);
    expect(h.body.integrations.payments).toBeTruthy();
    const a = await as(t, superA, 'GET', '/v1/admin/system/alerts');
    expect(a.body.thresholds.OUTBOX_BACKLOG).toMatchObject({ medium: 100, high: 500 });
  });

  it('jobs are registered; KPI snapshot upserts yesterday; stale ops are expired', async () => {
    expect((adminJobs.scheduled ?? []).map((j) => j.name)).toEqual(['admin.kpi_snapshot', 'admin.alerts_evaluate', 'admin.stale_ops_cleanup', 'admin.audit_chain_verify']);
    const k1 = await kpiSnapshot(t.deps);
    const k2 = await kpiSnapshot(t.deps);
    expect(k1.day).toBe(k2.day);
    const rows = await t.adminSql`SELECT metrics FROM admin_kpi_snapshots WHERE day = ${k1.day as string}::date`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metrics.metrics.gmv).toBeDefined();

    const today = new Date(t.clock.now().getTime() + 7 * 3600_000).toISOString().slice(0, 10);
    const req = await as(t, superA, 'POST', '/v1/admin/infra/db/exports', { from: today, to: today, reason: 'Ekspor yang terlupakan' });
    await t.adminSql`UPDATE db_operations SET created_at = now() - interval '80 hours' WHERE id = ${req.body.operationId}`;
    const res = await staleOpsCleanup(t.deps);
    expect(res.dbOperationsCancelled).toBe(1);
    const [op] = await t.adminSql<{ status: string }[]>`SELECT status FROM db_operations WHERE id = ${req.body.operationId}`;
    expect(op!.status).toBe('CANCELLED');
    await t.adminSql`UPDATE jobs SET status = 'DONE' WHERE queue = 'admin.export'`.catch(() => undefined);
  });

  it('alert job opens/updates/resolves alerts and records HIGH/CRITICAL openings once', async () => {
    const [ev] = await t.adminSql<{ id: string }[]>`INSERT INTO security_events (type, severity, meta) VALUES ('TEST_CRITICAL', 'CRITICAL', '{}'::jsonb) RETURNING id`;
    const r1 = await evaluateAndPersistAlerts(t.deps);
    expect(r1.opened).toBeGreaterThanOrEqual(1);
    const r2 = await evaluateAndPersistAlerts(t.deps);
    expect(r2.opened).toBe(0);
    const [al] = await t.adminSql<{ severity: string; occurrences: number; status: string }[]>`SELECT severity, occurrences, status FROM admin_ops_alerts WHERE code = 'SECURITY_EVENTS_HIGH'`;
    expect(al).toMatchObject({ severity: 'CRITICAL', occurrences: 2, status: 'OPEN' });
    const ops = await t.adminSql`SELECT 1 FROM security_events WHERE type = 'OPS_ALERT' AND meta->>'code' = 'SECURITY_EVENTS_HIGH'`;
    expect(ops).toHaveLength(1); // OPS_ALERT itself is not counted → no feedback loop
    const listed = await as(t, superA, 'GET', '/v1/admin/system/alerts');
    expect(listed.body.alerts.find((x: any) => x.code === 'SECURITY_EVENTS_HIGH')).toMatchObject({ severity: 'CRITICAL', occurrences: 2 });
    await t.adminSql.begin(async (tx) => {
      await tx`SET LOCAL session_replication_role = replica`; // test-only: security_events is append-only
      await tx`DELETE FROM security_events WHERE id = ${ev!.id}`;
    });
    const r3 = await evaluateAndPersistAlerts(t.deps);
    expect(r3.resolved).toBeGreaterThanOrEqual(1);
    const [after] = await t.adminSql<{ status: string }[]>`SELECT status FROM admin_ops_alerts WHERE code = 'SECURITY_EVENTS_HIGH' ORDER BY first_seen_at DESC LIMIT 1`;
    expect(after!.status).toBe('RESOLVED');
  });

  it('nightly audit chain verification: UP normally; a tampered row → DOWN + CRITICAL security event', async () => {
    const ok = await auditChainVerify(t.deps);
    expect(ok.status).toBe('UP');
    const [row] = await t.adminSql<{ id: number }[]>`SELECT id FROM audit_logs ORDER BY id LIMIT 1`;
    await t.adminSql.begin(async (tx) => {
      await tx`SET LOCAL session_replication_role = replica`;
      await tx`UPDATE audit_logs SET action = 'tampered.action' WHERE id = ${row!.id}`;
    });
    const bad = await auditChainVerify(t.deps);
    expect(bad).toMatchObject({ status: 'DOWN', brokenAtId: Number(row!.id) });
    const [hc] = await t.adminSql<{ status: string }[]>`SELECT status FROM app_health_checks WHERE component = 'AUDIT_CHAIN' ORDER BY checked_at DESC, id DESC LIMIT 1`;
    expect(hc!.status).toBe('DOWN');
    const sec = await t.adminSql`SELECT 1 FROM security_events WHERE type = 'AUDIT_CHAIN_BROKEN' AND severity = 'CRITICAL'`;
    expect(sec).toHaveLength(1);
    const v = await as(t, superA, 'GET', '/v1/admin/audit-logs/verify');
    expect(v.body.status).toBe('BROKEN');
    const alerts = await as(t, superA, 'GET', '/v1/admin/system/alerts');
    expect(alerts.body.alerts.map((a: any) => a.code)).toContain('AUDIT_CHAIN_BROKEN');
  });
});
