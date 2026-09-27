import type { AppDeps } from '../context';
import { kpis } from '../modules/admin/dashboard/service';
import { evaluateAndPersistAlerts } from '../modules/admin/system/service';
import { EXPORT_QUEUE, runAnalyticsExport } from '../modules/infra/service';
import type { JobGroup } from './types';

/**
 * Background jobs for the "admin" module group. OWNED by the admin agent/team. Every job is idempotent.
 *   admin.kpi_snapshot         daily   yesterday's (WIB) KPIs → admin_kpi_snapshots (upsert per day)
 *   admin.alerts_evaluate      5 min   alert conditions → admin_ops_alerts (OPEN/RESOLVED) + security_events OPS_ALERT (HIGH/CRITICAL)
 *   admin.stale_ops_cleanup    hourly  expire stale approvals (db_operations, role requests, settlement changes, trust overrides)
 *   admin.audit_chain_verify   daily   verify_audit_chain() → app_health_checks AUDIT_CHAIN (+ CRITICAL security event if broken)
 *   queue admin.export                 anonymized analytics export (DB & Infra Center)
 */
export async function kpiSnapshot(deps: AppDeps): Promise<Record<string, unknown>> {
  const now = deps.clock.now();
  const day = new Date(now.getTime() + 7 * 3600_000 - 86400_000).toISOString().slice(0, 10);
  const out = await kpis(deps as never, { from: day, to: day });
  const metrics = Object.fromEntries(out.metrics.map((m) => [m.key, { value: m.value, unit: m.unit, sampleSize: m.sampleSize }]));
  const payload = { metrics, breakdowns: out.breakdowns, systemStatus: out.systemHealth.status, generatedAt: out.generatedAt };
  await deps.sql`
    INSERT INTO admin_kpi_snapshots (day, metrics, computed_at) VALUES (${day}::date, ${deps.sql.json(payload as never)}, ${now})
    ON CONFLICT (day) DO UPDATE SET metrics = EXCLUDED.metrics, computed_at = EXCLUDED.computed_at`;
  return { day, metrics: out.metrics.length };
}

export async function staleOpsCleanup(deps: AppDeps): Promise<Record<string, unknown>> {
  const now = deps.clock.now();
  const h72 = new Date(now.getTime() - 72 * 3600_000);
  const h24 = new Date(now.getTime() - 24 * 3600_000);
  const cancelled = await deps.sql`
    UPDATE db_operations SET status = 'CANCELLED', error = 'expired: not approved within 72 h', finished_at = ${now}
     WHERE status = 'REQUESTED' AND created_at < ${h72} RETURNING id`;
  const failed = await deps.sql`
    UPDATE db_operations SET status = 'FAILED', error = coalesce(error, 'stale: RUNNING for more than 24 h'), finished_at = ${now}
     WHERE status = 'RUNNING' AND type <> 'MIGRATION' AND coalesce(started_at, created_at) < ${h24} RETURNING id`;
  const roles = await deps.sql`UPDATE admin_role_requests SET status = 'EXPIRED' WHERE status = 'PENDING' AND expires_at <= now() RETURNING id`;
  const settlement = await deps.sql`UPDATE settlement_account_changes SET status = 'EXPIRED' WHERE status IN ('PENDING','APPROVED') AND expires_at <= now() RETURNING id`;
  const trust = await deps.sql`UPDATE trust_score_overrides SET status = 'EXPIRED' WHERE status IN ('PENDING','APPROVED') AND expires_at <= now() RETURNING id`;
  const total = cancelled.length + failed.length + roles.length + settlement.length + trust.length;
  if (total > 0) {
    await deps.sql`SELECT jk_audit('JOB', NULL, 'infra.stale_operations_expired', 'system', 'admin.stale_ops_cleanup', NULL,
      ${deps.sql.json({ dbOperationsCancelled: cancelled.length, dbOperationsFailed: failed.length, roleRequests: roles.length, settlementChanges: settlement.length, trustOverrides: trust.length } as never)}::jsonb, '{}'::jsonb)`;
  }
  return { dbOperationsCancelled: cancelled.length, dbOperationsFailed: failed.length, roleRequestsExpired: roles.length, settlementChangesExpired: settlement.length, trustOverridesExpired: trust.length };
}

export async function auditChainVerify(deps: AppDeps): Promise<Record<string, unknown>> {
  const t0 = Date.now();
  const [r] = await deps.sql<{ broken: number | null }[]>`SELECT verify_audit_chain() AS broken`;
  const [head] = await deps.sql<{ last_id: number }[]>`SELECT last_id FROM audit_chain_head WHERE singleton`;
  const broken = r?.broken === null || r?.broken === undefined ? null : Number(r.broken);
  const status = broken === null ? 'UP' : 'DOWN';
  const details = { brokenAtId: broken, lastId: Number(head?.last_id ?? 0), durationMs: Date.now() - t0 };
  await deps.sql`INSERT INTO app_health_checks (component, status, latency_ms, is_sandbox, details, checked_at)
                 VALUES ('AUDIT_CHAIN', ${status}, ${details.durationMs}, false, ${deps.sql.json(details as never)}, ${deps.clock.now()})`;
  if (broken !== null) {
    deps.logger.error('admin.audit_chain_broken', details);
    await deps.sql`INSERT INTO security_events (type, severity, meta, created_at) VALUES ('AUDIT_CHAIN_BROKEN', 'CRITICAL', ${deps.sql.json(details as never)}, ${deps.clock.now()})`;
  }
  return { status, ...details };
}

export const adminJobs: JobGroup = {
  outbox: {},
  scheduled: [
    { name: 'admin.kpi_snapshot', everySec: 86_400, run: kpiSnapshot },
    { name: 'admin.alerts_evaluate', everySec: 300, run: evaluateAndPersistAlerts },
    { name: 'admin.stale_ops_cleanup', everySec: 3600, run: staleOpsCleanup },
    { name: 'admin.audit_chain_verify', everySec: 86_400, run: auditChainVerify },
  ],
  queues: {
    [EXPORT_QUEUE]: async (deps, payload) => {
      if (typeof payload.operationId !== 'string') throw new Error('admin.export job without operationId');
      return runAnalyticsExport(deps, payload.operationId);
    },
  },
};
