import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../context';
import { bytesToHex, sha256 } from '../lib/crypto';
import { Errors } from '../lib/errors';

/**
 * Idempotency for financial mutations (checkout, payment, refund, payout, price approval...).
 * Client sends `Idempotency-Key: <uuid>`; the first response (2xx/4xx) is stored for 24h and replayed.
 * Same key + different body → 422 IDEMPOTENCY_KEY_REUSED. Concurrent duplicate → 409 IDEMPOTENCY_IN_PROGRESS.
 * Must run after requireAuth.
 */
export const requireIdempotency: MiddlewareHandler<AppEnv> = async (c, next) => {
  const key = c.req.header('idempotency-key');
  if (!key || key.length < 8 || key.length > 255) {
    throw Errors.badRequest('IDEMPOTENCY_KEY_REQUIRED', 'Header Idempotency-Key wajib untuk aksi finansial');
  }
  const auth = c.get('auth');
  if (!auth) throw Errors.unauthorized();
  const { sql, clock } = c.get('deps');
  const body = await c.req.raw.clone().text();
  const hash = await sha256(`${c.req.method}\n${c.req.path}\n${body}`);
  const now = clock.now();

  const inserted = await sql<{ inserted: boolean }[]>`
    INSERT INTO idempotency_keys (user_id, key, method, path, request_hash, status, locked_until, expires_at, created_at)
    VALUES (${auth.userId}, ${key}, ${c.req.method}, ${c.req.path}, ${Buffer.from(hash)}, 'IN_PROGRESS',
            ${new Date(now.getTime() + 60_000)}, ${new Date(now.getTime() + 24 * 3600_000)}, ${now})
    ON CONFLICT (user_id, key) DO NOTHING
    RETURNING true AS inserted`;

  if (inserted.length === 0) {
    const [row] = await sql<{ request_hash: Buffer; status: string; response_status: number | null; response_body: unknown; locked_until: Date | null; path: string }[]>`
      SELECT request_hash, status, response_status, response_body, locked_until, path
        FROM idempotency_keys WHERE user_id = ${auth.userId} AND key = ${key}`;
    if (!row) throw Errors.conflict('IDEMPOTENCY_IN_PROGRESS', 'Permintaan yang sama sedang diproses');
    if (bytesToHex(new Uint8Array(row.request_hash)) !== bytesToHex(hash) || row.path !== c.req.path) {
      throw Errors.unprocessable('IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key sudah dipakai untuk permintaan berbeda');
    }
    if (row.status === 'COMPLETED' && row.response_status) {
      c.header('idempotent-replayed', 'true');
      return c.json(row.response_body as object, row.response_status as 200);
    }
    if (row.status === 'IN_PROGRESS' && row.locked_until && row.locked_until > now) {
      throw Errors.conflict('IDEMPOTENCY_IN_PROGRESS', 'Permintaan yang sama sedang diproses');
    }
    // FAILED (5xx / thrown) or stale lock → allow ONE retry. The claim is a compare-and-set: concurrent retries of
    // the same key race on this UPDATE and only the winner runs the handler (SEC-04; before, all of them did).
    const claimed = await sql`
      UPDATE idempotency_keys SET status = 'IN_PROGRESS', locked_until = ${new Date(now.getTime() + 60_000)}
       WHERE user_id = ${auth.userId} AND key = ${key}
         AND (status = 'FAILED' OR (status = 'IN_PROGRESS' AND (locked_until IS NULL OR locked_until <= ${now})))
       RETURNING 1`;
    if (claimed.length === 0) throw Errors.conflict('IDEMPOTENCY_IN_PROGRESS', 'Permintaan yang sama sedang diproses');
  }

  try {
    await next();
  } catch (err) {
    await sql`UPDATE idempotency_keys SET status = 'FAILED', locked_until = NULL WHERE user_id = ${auth.userId} AND key = ${key}`;
    throw err;
  }
  const status = c.res.status;
  if (status >= 500) {
    await sql`UPDATE idempotency_keys SET status = 'FAILED', locked_until = NULL WHERE user_id = ${auth.userId} AND key = ${key}`;
    return;
  }
  let stored: unknown = null;
  try {
    stored = await c.res.clone().json();
  } catch {
    stored = null;
  }
  await sql`UPDATE idempotency_keys
               SET status = 'COMPLETED', response_status = ${status}, response_body = ${sql.json(stored as never)},
                   completed_at = ${clock.now()}, locked_until = NULL
             WHERE user_id = ${auth.userId} AND key = ${key}`;
};
