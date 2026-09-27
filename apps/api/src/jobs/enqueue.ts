import type { Db } from '../db/sql';

/**
 * Enqueue an ad-hoc background job (same DB transaction as the caller when `db` is a TxSql).
 * Lives in its own module (no imports of job groups) so any module can import it without cycles.
 */
export async function enqueueJob(
  db: Db,
  queue: string,
  name: string,
  payload: Record<string, unknown>,
  opts: { runAt?: Date; dedupeKey?: string; maxAttempts?: number } = {},
): Promise<void> {
  await db`
    INSERT INTO jobs (queue, name, payload, run_at, dedupe_key, max_attempts)
    VALUES (${queue}, ${name}, ${db.json(payload as never)}, coalesce(${opts.runAt ?? null}::timestamptz, now()), ${opts.dedupeKey ?? null}, ${opts.maxAttempts ?? 10})
    ON CONFLICT DO NOTHING`;
}
