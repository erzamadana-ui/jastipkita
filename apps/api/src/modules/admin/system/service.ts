/**
 * System health & alerting (docs/06-observability.md). Everything is computed from the database at request time
 * (no metrics backend required); the `admin.alerts_evaluate` job persists the same alert set into admin_ops_alerts
 * (OPEN → RESOLVED lifecycle) and raises security_events OPS_ALERT for HIGH/CRITICAL alerts.
 */
import type { AppDeps } from '../../../context';
import { sandboxFlags } from '../../../env';
import { iso, num } from '../common';

export type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface SystemHealth {
  generatedAt: string;
  status: 'OK' | 'DEGRADED' | 'CRITICAL';
  database: { ok: boolean; latencyMs: number | null; schemaVersion: string | null; connections: number; maxConnections: number };
  outbox: { backlog: number; oldestUnpublishedAgeSec: number | null; retryingEvents: number };
  jobs: { queued: number; running: number; overdue: number; dead24h: number; deadTotal: number; expiredLeases: number };
  webhooks: { received24h: number; failed24h: number; unprocessedOlderThan10m: number; invalidSignature24h: number };
  refunds: { failed: number; pendingApproval: number; pendingApprovalOlderThan24h: number; processingOlderThan1h: number };
  payouts: { failed: number; onHold: number; onHoldOlderThan48h: number; processingOlderThan1h: number };
  notifications: { deliveries24h: number; failed24h: number; failureRate: number | null };
  security: { highOrCritical24h: number; critical24h: number; byType: { type: string; severity: string; count: number }[] };
  disputes: { slaBreachedOpen: number };
  support: { firstResponseBreached: number };
  auditChain: { status: string | null; checkedAt: string | null; brokenAtId: number | null };
  integrations: Record<string, string>;
  alertsOpen: number;
}

/** Alert thresholds — the single source for /v1/admin/system/alerts, the alert job and docs/06-observability.md. */
export const ALERT_THRESHOLDS = {
  OUTBOX_BACKLOG: { medium: 100, high: 500, unit: 'events', description: 'Unpublished outbox events' },
  OUTBOX_STALE: { medium: 300, high: 900, unit: 'seconds', description: 'Age of the oldest unpublished outbox event' },
  JOBS_DEAD: { high: 1, unit: 'jobs', description: 'Jobs that reached DEAD (max attempts) in the last 24 h' },
  JOBS_OVERDUE: { medium: 20, unit: 'jobs', description: 'QUEUED jobs whose run_at is more than 10 minutes in the past' },
  JOBS_LEASE_EXPIRED: { medium: 1, unit: 'jobs', description: 'RUNNING jobs with an expired lease (crashed worker)' },
  WEBHOOK_FAILURES: { medium: 1, high: 5, unit: 'events', description: 'Payment webhooks with processing_error in the last 24 h' },
  WEBHOOK_BACKLOG: { high: 1, unit: 'events', description: 'Payment webhooks unprocessed for more than 10 minutes' },
  WEBHOOK_SIGNATURE_INVALID: { medium: 3, high: 10, unit: 'events', description: 'Webhooks with an invalid signature/token in the last 24 h' },
  REFUND_FAILURES: { high: 1, unit: 'refunds', description: 'Refunds in FAILED' },
  REFUND_STUCK: { medium: 1, unit: 'refunds', description: 'Refunds PROCESSING for more than 1 hour' },
  REFUND_APPROVAL_BACKLOG: { medium: 1, unit: 'refunds', description: 'Refunds PENDING_APPROVAL for more than 24 hours' },
  PAYOUT_FAILURES: { high: 1, unit: 'payouts', description: 'Payouts in FAILED' },
  PAYOUT_STUCK: { medium: 1, unit: 'payouts', description: 'Payouts PROCESSING for more than 1 hour' },
  PAYOUT_HOLD_AGING: { medium: 1, unit: 'payouts', description: 'Payouts ON_HOLD for more than 48 hours' },
  NOTIFICATION_FAILURE_RATE: { medium: 0.05, high: 0.2, minSample: 20, unit: 'ratio', description: 'Failed / (sent + failed) notification deliveries, last 24 h' },
  SECURITY_EVENTS_HIGH: { medium: 1, high: 10, unit: 'events', description: 'HIGH/CRITICAL security events in the last 24 h (any CRITICAL → CRITICAL)' },
  AUDIT_CHAIN_BROKEN: { critical: 1, unit: 'check', description: 'Latest nightly verify_audit_chain() result is DOWN' },
  DB_CONNECTIONS: { medium: 0.7, high: 0.85, unit: 'ratio', description: 'Connections to this database ÷ max_connections' },
  DISPUTE_SLA_BREACHED: { medium: 1, unit: 'disputes', description: 'Open disputes with an SLA breach flag' },
  SUPPORT_SLA_BREACHED: { medium: 5, unit: 'tickets', description: 'Open tickets past sla_due_at without a first response' },
  INTEGRATION_NOT_LIVE_IN_PRODUCTION: { high: 1, unit: 'integrations', description: 'APP_ENV=production while an integration is MOCK/SANDBOX' },
} as const;

export type AlertCode = keyof typeof ALERT_THRESHOLDS;

export interface Alert {
  code: AlertCode;
  severity: Severity;
  value: number;
  threshold: number;
  message: string;
  description: string;
}

async function one<T>(q: Promise<readonly T[]>): Promise<T> {
  const r = await q;
  return r[0]!;
}

export async function systemHealth(deps: AppDeps): Promise<SystemHealth> {
  const db = deps.sql;
  const now = deps.clock.now();
  const d24 = new Date(now.getTime() - 86400_000);
  const m10 = new Date(now.getTime() - 600_000);
  const h1 = new Date(now.getTime() - 3600_000);
  const h24 = d24;
  const h48 = new Date(now.getTime() - 48 * 3600_000);

  let dbOk = true;
  let latencyMs: number | null = null;
  let schemaVersion: string | null = null;
  const t0 = Date.now();
  try {
    const [r] = await db<{ v: string | null }[]>`SELECT max(version) AS v FROM schema_migrations`;
    schemaVersion = r?.v ?? null;
    latencyMs = Date.now() - t0;
  } catch {
    dbOk = false;
  }
  const conn = await one(db<{ n: number; max: number }[]>`
    SELECT (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database())::int AS n,
           current_setting('max_connections')::int AS max`);
  const outbox = await one(db<{ backlog: number; oldest: Date | null; retrying: number }[]>`
    SELECT count(*)::int AS backlog, min(created_at) AS oldest, count(*) FILTER (WHERE attempts >= 3)::int AS retrying
      FROM outbox_events WHERE published_at IS NULL`);
  const jobs = await one(db<{ queued: number; running: number; overdue: number; dead24: number; dead: number; expired: number }[]>`
    SELECT count(*) FILTER (WHERE status = 'QUEUED')::int AS queued,
           count(*) FILTER (WHERE status = 'RUNNING')::int AS running,
           count(*) FILTER (WHERE status = 'QUEUED' AND run_at < ${m10})::int AS overdue,
           count(*) FILTER (WHERE status = 'DEAD' AND finished_at >= ${d24})::int AS dead24,
           count(*) FILTER (WHERE status = 'DEAD')::int AS dead,
           count(*) FILTER (WHERE status = 'RUNNING' AND lease_until < ${now})::int AS expired
      FROM jobs WHERE status IN ('QUEUED','RUNNING','DEAD')`);
  const wh = await one(db<{ received: number; failed: number; stale: number; invalid: number }[]>`
    SELECT count(*) FILTER (WHERE received_at >= ${d24})::int AS received,
           count(*) FILTER (WHERE received_at >= ${d24} AND processing_error IS NOT NULL)::int AS failed,
           count(*) FILTER (WHERE processed_at IS NULL AND received_at < ${m10})::int AS stale,
           count(*) FILTER (WHERE received_at >= ${d24} AND NOT signature_valid)::int AS invalid
      FROM payment_webhook_events WHERE received_at >= ${d24} OR processed_at IS NULL`);
  const rf = await one(db<{ failed: number; pa: number; pa_old: number; stuck: number }[]>`
    SELECT count(*) FILTER (WHERE status = 'FAILED')::int AS failed,
           count(*) FILTER (WHERE status = 'PENDING_APPROVAL')::int AS pa,
           count(*) FILTER (WHERE status = 'PENDING_APPROVAL' AND created_at < ${h24})::int AS pa_old,
           count(*) FILTER (WHERE status = 'PROCESSING' AND updated_at < ${h1})::int AS stuck
      FROM refunds WHERE status IN ('FAILED','PENDING_APPROVAL','PROCESSING')`);
  const po = await one(db<{ failed: number; hold: number; hold_old: number; stuck: number }[]>`
    SELECT count(*) FILTER (WHERE status = 'FAILED')::int AS failed,
           count(*) FILTER (WHERE status = 'ON_HOLD')::int AS hold,
           count(*) FILTER (WHERE status = 'ON_HOLD' AND updated_at < ${h48})::int AS hold_old,
           count(*) FILTER (WHERE status = 'PROCESSING' AND updated_at < ${h1})::int AS stuck
      FROM payouts WHERE status IN ('FAILED','ON_HOLD','PROCESSING')`);
  const nd = await one(db<{ total: number; failed: number }[]>`
    SELECT count(*) FILTER (WHERE status IN ('SENT','FAILED'))::int AS total, count(*) FILTER (WHERE status = 'FAILED')::int AS failed
      FROM notification_deliveries WHERE created_at >= ${d24}`);
  const sec = await db<{ type: string; severity: string; n: number }[]>`
    SELECT type, severity, count(*)::int AS n FROM security_events
     WHERE created_at >= ${d24} AND severity IN ('HIGH','CRITICAL') AND type <> 'OPS_ALERT' GROUP BY type, severity ORDER BY n DESC LIMIT 20`;
  const misc = await one(db<{ disputes: number; tickets: number; alerts: number }[]>`
    SELECT (SELECT count(*) FROM disputes WHERE sla_breached_at IS NOT NULL AND status <> 'CLOSED')::int AS disputes,
           (SELECT count(*) FROM support_tickets WHERE status NOT IN ('RESOLVED','CLOSED') AND first_response_at IS NULL AND sla_due_at < ${now})::int AS tickets,
           (SELECT count(*) FROM admin_ops_alerts WHERE status = 'OPEN')::int AS alerts`);
  const [chain] = await db<{ status: string; checked_at: Date; details: { brokenAtId?: number | null } }[]>`
    SELECT status, checked_at, details FROM app_health_checks WHERE component = 'AUDIT_CHAIN' ORDER BY checked_at DESC, id DESC LIMIT 1`;

  const total = nd.total;
  const health: SystemHealth = {
    generatedAt: now.toISOString(),
    status: 'OK',
    database: { ok: dbOk, latencyMs, schemaVersion, connections: conn.n, maxConnections: conn.max },
    outbox: {
      backlog: outbox.backlog,
      oldestUnpublishedAgeSec: outbox.oldest ? Math.max(0, Math.round((now.getTime() - new Date(outbox.oldest).getTime()) / 1000)) : null,
      retryingEvents: outbox.retrying,
    },
    jobs: { queued: jobs.queued, running: jobs.running, overdue: jobs.overdue, dead24h: jobs.dead24, deadTotal: jobs.dead, expiredLeases: jobs.expired },
    webhooks: { received24h: wh.received, failed24h: wh.failed, unprocessedOlderThan10m: wh.stale, invalidSignature24h: wh.invalid },
    refunds: { failed: rf.failed, pendingApproval: rf.pa, pendingApprovalOlderThan24h: rf.pa_old, processingOlderThan1h: rf.stuck },
    payouts: { failed: po.failed, onHold: po.hold, onHoldOlderThan48h: po.hold_old, processingOlderThan1h: po.stuck },
    notifications: { deliveries24h: total, failed24h: nd.failed, failureRate: total > 0 ? Math.round((nd.failed / total) * 10000) / 10000 : null },
    security: {
      highOrCritical24h: sec.reduce((s, r) => s + r.n, 0),
      critical24h: sec.filter((r) => r.severity === 'CRITICAL').reduce((s, r) => s + r.n, 0),
      byType: sec.map((r) => ({ type: r.type, severity: r.severity, count: r.n })),
    },
    disputes: { slaBreachedOpen: misc.disputes },
    support: { firstResponseBreached: misc.tickets },
    auditChain: { status: chain?.status ?? null, checkedAt: iso(chain?.checked_at), brokenAtId: chain?.details?.brokenAtId ?? null },
    integrations: {
      ...sandboxFlags(deps.env),
      dbAdmin: deps.providers.dbAdmin.name,
      paymentProviderEnv: deps.env.PAYMENT_PROVIDER === 'mock' ? 'MOCK' : deps.env.XENDIT_ENV === 'live' ? 'LIVE' : 'SANDBOX',
    },
    alertsOpen: misc.alerts,
  };
  const alerts = evaluateAlerts(health, deps.env.APP_ENV);
  health.status = alerts.some((a) => a.severity === 'CRITICAL') ? 'CRITICAL' : alerts.some((a) => a.severity === 'HIGH') ? 'DEGRADED' : 'OK';
  if (!dbOk) health.status = 'CRITICAL';
  return health;
}

/** Pure: alert conditions from a health snapshot (thresholds in ALERT_THRESHOLDS). */
export function evaluateAlerts(h: SystemHealth, appEnv: string): Alert[] {
  const out: Alert[] = [];
  const push = (code: AlertCode, severity: Severity, value: number, threshold: number, message: string) =>
    out.push({ code, severity, value, threshold, message, description: ALERT_THRESHOLDS[code].description });
  const T = ALERT_THRESHOLDS;
  const tiered = (code: AlertCode, value: number, tiers: { medium?: number; high?: number; critical?: number }, message: (v: number) => string, strict = false) => {
    const ge = (v: number, t: number) => (strict ? v > t : v >= t);
    if (tiers.critical !== undefined && ge(value, tiers.critical)) push(code, 'CRITICAL', value, tiers.critical, message(value));
    else if (tiers.high !== undefined && ge(value, tiers.high)) push(code, 'HIGH', value, tiers.high, message(value));
    else if (tiers.medium !== undefined && ge(value, tiers.medium)) push(code, 'MEDIUM', value, tiers.medium, message(value));
  };
  tiered('OUTBOX_BACKLOG', h.outbox.backlog, T.OUTBOX_BACKLOG, (v) => `${v} event outbox belum terkirim`);
  if (h.outbox.oldestUnpublishedAgeSec !== null) {
    tiered('OUTBOX_STALE', h.outbox.oldestUnpublishedAgeSec, T.OUTBOX_STALE, (v) => `Event outbox tertua menunggu ${Math.round(v / 60)} menit`);
  }
  tiered('JOBS_DEAD', h.jobs.dead24h, T.JOBS_DEAD, (v) => `${v} job DEAD dalam 24 jam`);
  tiered('JOBS_OVERDUE', h.jobs.overdue, T.JOBS_OVERDUE, (v) => `${v} job terlambat > 10 menit`);
  tiered('JOBS_LEASE_EXPIRED', h.jobs.expiredLeases, T.JOBS_LEASE_EXPIRED, (v) => `${v} job RUNNING dengan lease kedaluwarsa (worker crash?)`);
  tiered('WEBHOOK_FAILURES', h.webhooks.failed24h, T.WEBHOOK_FAILURES, (v) => `${v} webhook pembayaran gagal diproses (24 jam)`);
  tiered('WEBHOOK_BACKLOG', h.webhooks.unprocessedOlderThan10m, T.WEBHOOK_BACKLOG, (v) => `${v} webhook belum diproses > 10 menit`);
  tiered('WEBHOOK_SIGNATURE_INVALID', h.webhooks.invalidSignature24h, T.WEBHOOK_SIGNATURE_INVALID, (v) => `${v} webhook dengan signature/token tidak valid (24 jam)`);
  tiered('REFUND_FAILURES', h.refunds.failed, T.REFUND_FAILURES, (v) => `${v} refund FAILED`);
  tiered('REFUND_STUCK', h.refunds.processingOlderThan1h, T.REFUND_STUCK, (v) => `${v} refund PROCESSING > 1 jam`);
  tiered('REFUND_APPROVAL_BACKLOG', h.refunds.pendingApprovalOlderThan24h, T.REFUND_APPROVAL_BACKLOG, (v) => `${v} refund menunggu approval > 24 jam`);
  tiered('PAYOUT_FAILURES', h.payouts.failed, T.PAYOUT_FAILURES, (v) => `${v} payout FAILED`);
  tiered('PAYOUT_STUCK', h.payouts.processingOlderThan1h, T.PAYOUT_STUCK, (v) => `${v} payout PROCESSING > 1 jam`);
  tiered('PAYOUT_HOLD_AGING', h.payouts.onHoldOlderThan48h, T.PAYOUT_HOLD_AGING, (v) => `${v} payout ON_HOLD > 48 jam`);
  if (h.notifications.failureRate !== null && h.notifications.deliveries24h >= T.NOTIFICATION_FAILURE_RATE.minSample) {
    tiered('NOTIFICATION_FAILURE_RATE', h.notifications.failureRate, T.NOTIFICATION_FAILURE_RATE, (v) => `Tingkat gagal notifikasi ${(v * 100).toFixed(1)}% (24 jam)`, true);
  }
  if (h.security.critical24h > 0) push('SECURITY_EVENTS_HIGH', 'CRITICAL', h.security.critical24h, 1, `${h.security.critical24h} security event CRITICAL (24 jam)`);
  else tiered('SECURITY_EVENTS_HIGH', h.security.highOrCritical24h, T.SECURITY_EVENTS_HIGH, (v) => `${v} security event HIGH (24 jam)`);
  if (h.auditChain.status === 'DOWN') push('AUDIT_CHAIN_BROKEN', 'CRITICAL', 1, 1, `Hash chain audit log rusak pada id ${h.auditChain.brokenAtId ?? '?'}`);
  if (h.database.maxConnections > 0) {
    tiered('DB_CONNECTIONS', h.database.connections / h.database.maxConnections, T.DB_CONNECTIONS, (v) => `Koneksi DB ${(v * 100).toFixed(0)}% dari max_connections`, true);
  }
  tiered('DISPUTE_SLA_BREACHED', h.disputes.slaBreachedOpen, T.DISPUTE_SLA_BREACHED, (v) => `${v} dispute melewati SLA`);
  tiered('SUPPORT_SLA_BREACHED', h.support.firstResponseBreached, T.SUPPORT_SLA_BREACHED, (v) => `${v} tiket melewati SLA respons pertama`);
  if (appEnv === 'production') {
    const notLive = Object.entries(h.integrations).filter(([k, v]) => ['payments', 'email', 'push', 'sms', 'storage'].includes(k) && v !== 'LIVE');
    if (notLive.length) push('INTEGRATION_NOT_LIVE_IN_PRODUCTION', 'HIGH', notLive.length, 1, `Integrasi belum LIVE di produksi: ${notLive.map(([k]) => k).join(', ')}`);
  }
  const rank: Record<Severity, number> = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };
  return out.sort((a, b) => rank[b.severity] - rank[a.severity]);
}

export async function currentAlerts(deps: AppDeps) {
  const health = await systemHealth(deps);
  const alerts = evaluateAlerts(health, deps.env.APP_ENV);
  const persisted = await deps.sql<{ code: string; first_seen_at: Date; occurrences: number; acknowledged_at: Date | null }[]>`
    SELECT code, first_seen_at, occurrences, acknowledged_at FROM admin_ops_alerts WHERE status = 'OPEN'`;
  const byCode = new Map(persisted.map((p) => [p.code, p]));
  return {
    generatedAt: health.generatedAt,
    status: health.status,
    alerts: alerts.map((a) => {
      const p = byCode.get(a.code);
      return { ...a, firstSeenAt: iso(p?.first_seen_at) ?? health.generatedAt, occurrences: num(p?.occurrences ?? 1), acknowledged: !!p?.acknowledged_at };
    }),
    thresholds: ALERT_THRESHOLDS,
  };
}

/**
 * Job: persists the alert set (OPEN/RESOLVED lifecycle) and records HIGH/CRITICAL openings as security_events
 * OPS_ALERT (deduplicated: one row per alert opening).
 */
export async function evaluateAndPersistAlerts(deps: AppDeps): Promise<Record<string, unknown>> {
  const health = await systemHealth(deps);
  const alerts = evaluateAlerts(health, deps.env.APP_ENV);
  const now = deps.clock.now();
  let opened = 0;
  const openedAlerts: Alert[] = []; // logged after COMMIT (infra/monitoring/alerts.yaml: log-based paging)
  let resolved = 0;
  await deps.sql.begin(async (tx) => {
    const open = await tx<{ id: string; code: string }[]>`SELECT id, code FROM admin_ops_alerts WHERE status = 'OPEN' FOR UPDATE`;
    const active = new Set(alerts.map((a) => a.code as string));
    for (const o of open) {
      if (!active.has(o.code)) {
        await tx`UPDATE admin_ops_alerts SET status = 'RESOLVED', resolved_at = ${now} WHERE id = ${o.id}`;
        resolved++;
      }
    }
    const openCodes = new Set(open.map((o) => o.code));
    for (const a of alerts) {
      if (openCodes.has(a.code)) {
        await tx`UPDATE admin_ops_alerts SET last_seen_at = ${now}, occurrences = occurrences + 1, value = ${a.value}, severity = ${a.severity}, message = ${a.message}
                  WHERE code = ${a.code} AND status = 'OPEN'`;
        continue;
      }
      await tx`INSERT INTO admin_ops_alerts (code, severity, value, threshold, message, details, first_seen_at, last_seen_at)
               VALUES (${a.code}, ${a.severity}, ${a.value}, ${a.threshold}, ${a.message}, ${tx.json({ description: a.description } as never)}, ${now}, ${now})`;
      opened++;
      openedAlerts.push(a);
      if (a.severity === 'HIGH' || a.severity === 'CRITICAL') {
        await tx`INSERT INTO security_events (type, severity, meta, created_at)
                 VALUES ('OPS_ALERT', ${a.severity}, ${tx.json({ code: a.code, value: a.value, threshold: a.threshold, message: a.message } as never)}, ${now})`;
      }
    }
  });
  for (const a of openedAlerts) {
    deps.logger[a.severity === 'HIGH' || a.severity === 'CRITICAL' ? 'error' : 'warn']('ALERT ops.alert_opened', { code: a.code, severity: a.severity, value: a.value, threshold: a.threshold });
  }
  return { status: health.status, active: alerts.length, opened, resolved };
}
