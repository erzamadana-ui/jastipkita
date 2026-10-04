/**
 * Worker heartbeat for external uptime checkers (launch checklist T6, infra/monitoring/alerts.yaml WORKER_STALE).
 *
 * GET /v1/health/worker is public on purpose: a free uptime checker cannot hold an admin session (15-minute JWT + MFA).
 * It returns nothing sensitive — only how long ago the last scheduled job finished — and answers 503 when that is older
 * than three cron intervals, so a plain HTTP-status monitor pages when the Cron Trigger / worker loop stopped (which
 * also stops admin.alerts_evaluate, i.e. every in-app alert goes silent — the failure in-app alerting cannot report).
 */
import type { AppDeps } from '../../context';

/** Cron cadence per environment (infra/cloudflare/wrangler.toml: production every 5 min, staging every 15 min). */
export function heartbeatStaleAfterSec(appEnv: string): number {
  return appEnv === 'production' ? 15 * 60 : 45 * 60;
}

export async function workerHeartbeat(deps: AppDeps) {
  const now = deps.clock.now();
  const staleAfterSec = heartbeatStaleAfterSec(deps.env.APP_ENV);
  const [r] = await deps.sql<{ last: Date | null }[]>`
    SELECT max(finished_at) AS last FROM jobs WHERE status = 'SUCCEEDED' AND queue = 'scheduled'`;
  const last = r?.last ? new Date(r.last) : null;
  const ageSec = last ? Math.max(0, Math.round((now.getTime() - last.getTime()) / 1000)) : null;
  const ok = ageSec !== null && ageSec <= staleAfterSec;
  return {
    status: ok ? ('ok' as const) : ('stale' as const),
    lastScheduledJobAt: last ? last.toISOString() : null,
    ageSec,
    staleAfterSec,
    checkedAt: now.toISOString(),
  };
}
