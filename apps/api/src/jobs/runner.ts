import type { AppDeps } from '../context';
import type { Db } from '../db/sql';
import { adminJobs } from './admin';
import { engagementJobs } from './engagement';
import { identityJobs } from './identity';
import { marketplaceJobs } from './marketplace';
import { moneyJobs } from './money';
import type { JobGroup, OutboxEvent, OutboxHandler, QueueHandler, ScheduledJob } from './types';

const GROUPS: JobGroup[] = [identityJobs, marketplaceJobs, moneyJobs, engagementJobs, adminJobs];

function collect() {
  const outbox = new Map<string, OutboxHandler[]>();
  const scheduled: ScheduledJob[] = [];
  const queues = new Map<string, QueueHandler>();
  for (const g of GROUPS) {
    for (const [type, hs] of Object.entries(g.outbox ?? {})) outbox.set(type, [...(outbox.get(type) ?? []), ...hs]);
    scheduled.push(...(g.scheduled ?? []));
    for (const [q, h] of Object.entries(g.queues ?? {})) {
      if (queues.has(q)) throw new Error(`duplicate queue handler ${q}`);
      queues.set(q, h);
    }
  }
  return { outbox, scheduled, queues };
}

/** Enqueue an ad-hoc job (same DB transaction as the caller when `db` is a TxSql). */
export async function enqueueJob(db: Db, queue: string, name: string, payload: Record<string, unknown>, opts: { runAt?: Date; dedupeKey?: string; maxAttempts?: number } = {}) {
  await db`
    INSERT INTO jobs (queue, name, payload, run_at, dedupe_key, max_attempts)
    VALUES (${queue}, ${name}, ${db.json(payload as never)}, coalesce(${opts.runAt ?? null}::timestamptz, now()), ${opts.dedupeKey ?? null}, ${opts.maxAttempts ?? 10})
    ON CONFLICT DO NOTHING`;
}

export interface TickResult {
  outboxProcessed: number;
  outboxFailed: number;
  jobsRun: number;
  jobsFailed: number;
  scheduledEnqueued: number;
}

/**
 * One worker tick: (1) enqueue due scheduled jobs (deduped per window), (2) run queued jobs,
 * (3) dispatch outbox events to subscribers. Safe to run concurrently on many instances.
 */
export async function runWorkerTick(deps: AppDeps, opts: { outboxLimit?: number; jobLimit?: number } = {}): Promise<TickResult> {
  const { outbox, scheduled, queues } = collect();
  const { sql, clock, logger, env } = deps;
  const worker = env.WORKER_ID;
  const res: TickResult = { outboxProcessed: 0, outboxFailed: 0, jobsRun: 0, jobsFailed: 0, scheduledEnqueued: 0 };
  const now = clock.now();

  // (1) scheduled → jobs rows with a per-window dedupe key (never re-run a window that already ran)
  for (const s of scheduled) {
    const window = Math.floor(now.getTime() / 1000 / s.everySec);
    const key = `${s.name}:${window}`;
    const r = await sql`
      INSERT INTO jobs (queue, name, payload, run_at, dedupe_key, max_attempts)
      SELECT 'scheduled', ${s.name}, '{}'::jsonb, now(), ${key}, 3
       WHERE NOT EXISTS (SELECT 1 FROM jobs WHERE queue = 'scheduled' AND dedupe_key = ${key})
      ON CONFLICT DO NOTHING RETURNING id`;
    if (r.length) res.scheduledEnqueued++;
  }

  // (2) run queued jobs (scheduled + ad-hoc queues)
  const queueNames = ['scheduled', ...queues.keys()];
  for (const q of queueNames) {
    const claimed = await sql<{ id: string; name: string; payload: Record<string, unknown>; dedupe_key: string | null }[]>`
      SELECT id, name, payload, dedupe_key FROM claim_jobs(${q}, ${worker}, ${opts.jobLimit ?? 10}, 300)`;
    for (const j of claimed) {
      try {
        let result: Record<string, unknown> | void;
        if (q === 'scheduled') {
          const s = scheduled.find((x) => x.name === j.name);
          if (!s) throw new Error(`no scheduled job ${j.name}`);
          result = await s.run(deps);
        } else {
          const h = queues.get(q)!;
          result = await h(deps, j.payload);
        }
        await sql`SELECT complete_job(${j.id}, ${worker}, ${sql.json((result ?? {}) as never)})`;
        res.jobsRun++;
      } catch (err) {
        res.jobsFailed++;
        logger.error('job.failed', { queue: q, name: j.name, id: j.id, error: err instanceof Error ? err.message : String(err) });
        await sql`SELECT fail_job(${j.id}, ${worker}, ${err instanceof Error ? err.message.slice(0, 2000) : String(err)})`;
      }
    }
  }

  // (3) outbox dispatch
  const events = await sql<{ id: number; event_id: string; aggregate_type: string; aggregate_id: string; event_type: string; payload: Record<string, unknown>; created_at: Date; attempts: number }[]>`
    SELECT id, event_id, aggregate_type, aggregate_id, event_type, payload, created_at, attempts
      FROM claim_outbox(${worker}, ${opts.outboxLimit ?? 100}, 60)`;
  for (const e of events) {
    const ev: OutboxEvent = {
      id: e.id,
      eventId: e.event_id,
      aggregateType: e.aggregate_type,
      aggregateId: e.aggregate_id,
      eventType: e.event_type,
      payload: e.payload,
      createdAt: e.created_at,
      attempts: e.attempts,
    };
    const handlers = [...(outbox.get(e.event_type) ?? []), ...(outbox.get('*') ?? [])];
    try {
      for (const h of handlers) await h(deps, ev);
      await sql`UPDATE outbox_events SET published_at = now(), locked_by = NULL, locked_until = NULL, last_error = NULL WHERE id = ${e.id}`;
      res.outboxProcessed++;
    } catch (err) {
      res.outboxFailed++;
      const backoffSec = Math.min(3600, 2 ** Math.min(e.attempts, 12));
      logger.error('outbox.handler_failed', { eventType: e.event_type, id: e.id, error: err instanceof Error ? err.message : String(err) });
      await sql`UPDATE outbox_events SET locked_by = NULL, locked_until = NULL,
                  available_at = now() + make_interval(secs => ${backoffSec}),
                  last_error = ${err instanceof Error ? err.message.slice(0, 2000) : String(err)} WHERE id = ${e.id}`;
    }
  }
  return res;
}

/** Drain everything currently runnable (tests / manual ops). */
export async function drainWorker(deps: AppDeps, maxTicks = 20): Promise<TickResult> {
  const total: TickResult = { outboxProcessed: 0, outboxFailed: 0, jobsRun: 0, jobsFailed: 0, scheduledEnqueued: 0 };
  for (let i = 0; i < maxTicks; i++) {
    const r = await runWorkerTick(deps);
    for (const k of Object.keys(total) as (keyof TickResult)[]) total[k] += r[k];
    if (r.outboxProcessed + r.jobsRun + r.outboxFailed + r.jobsFailed === 0) break;
  }
  return total;
}
