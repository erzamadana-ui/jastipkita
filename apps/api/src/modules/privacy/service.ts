/**
 * Privacy (UU PDP) workflows:
 *  - Export: request → queued job builds the JSON (own data only) → encrypted EXPORT file (7-day retention)
 *    → privacy_requests COMPLETED → outbox `privacy.export_ready`.
 *  - Deletion: blocked while transactions/disputes/payouts/refunds are open; otherwise the account goes to
 *    PENDING_DELETION for a 14-day grace period (all sessions revoked, `account.deletion_scheduled`).
 *    The user may log in again and cancel. A scheduled job then calls DB anonymize_user().
 */
import type { AppDeps, AuthContext } from '../../context';
import type { Db } from '../../db/sql';
import { Errors, fromPgError } from '../../lib/errors';
import { audit } from '../../services/audit';
import { emitEvent } from '../../services/outbox';
import { buf, iso, SECURITY, securityEvent, type RequestMeta } from '../auth/common';
import { inTx } from '../auth/repository';
import { storeServerFile } from '../files/service';
import { buildExport } from './export';

export const EXPORT_QUEUE = 'identity.privacy_export';

/** Same row shape as jobs/runner enqueueJob (not imported: runner → jobs/identity → this module would be circular). */
async function enqueueExport(db: Db, requestId: string) {
  await db`
    INSERT INTO jobs (queue, name, payload, dedupe_key, max_attempts)
    VALUES (${EXPORT_QUEUE}, 'privacy.export', ${db.json({ requestId } as never)}, ${`privacy_export:${requestId}`}, 5)
    ON CONFLICT DO NOTHING`;
}

interface RequestRow {
  id: string;
  type: 'EXPORT' | 'DELETION' | 'CORRECTION' | 'CONSENT_WITHDRAWAL';
  status: string;
  due_at: Date;
  scheduled_for: Date | null;
  completed_at: Date | null;
  rejection_reason: string | null;
  export_file_id: string | null;
  created_at: Date;
}

const toDto = (r: RequestRow) => ({
  id: r.id,
  type: r.type,
  status: r.status as 'RECEIVED' | 'VERIFYING' | 'IN_PROGRESS' | 'COMPLETED' | 'REJECTED' | 'CANCELLED',
  dueAt: iso(r.due_at)!,
  scheduledFor: iso(r.scheduled_for),
  completedAt: iso(r.completed_at),
  rejectionReason: r.rejection_reason,
  exportFileId: r.export_file_id,
  createdAt: iso(r.created_at)!,
});

async function getRequest(db: Db, id: string) {
  const [r] = await db<RequestRow[]>`
    SELECT id, type, status, due_at, scheduled_for, completed_at, rejection_reason, export_file_id, created_at FROM privacy_requests WHERE id = ${id}`;
  return r;
}

export async function listRequests(deps: AppDeps, auth: AuthContext) {
  const rows = await deps.sql<RequestRow[]>`
    SELECT id, type, status, due_at, scheduled_for, completed_at, rejection_reason, export_file_id, created_at
      FROM privacy_requests WHERE user_id = ${auth.userId} ORDER BY created_at DESC LIMIT 50`;
  return rows.map(toDto);
}

const isUniqueOpen = (err: unknown) => (err as { code?: string; constraint_name?: string }).code === '23505' && (err as { constraint_name?: string }).constraint_name === 'privacy_requests_one_open_uq';

// =================================================================== export
export async function requestExport(deps: AppDeps, auth: AuthContext, req: RequestMeta) {
  const now = deps.clock.now();
  try {
    const id = await inTx(deps, async (tx) => {
      const [r] = await tx<{ id: string }[]>`
        INSERT INTO privacy_requests (user_id, type, status, due_at, verified_at, created_at)
        VALUES (${auth.userId}, 'EXPORT', 'RECEIVED', ${new Date(now.getTime() + 72 * 3600_000)}, ${now}, ${now}) RETURNING id`;
      await enqueueExport(tx, r!.id);
      await securityEvent(deps, tx, { userId: auth.userId, type: 'DATA_EXPORT_REQUESTED', req, meta: { requestId: r!.id } });
      return r!.id;
    });
    return toDto((await getRequest(deps.sql, id))!);
  } catch (err) {
    if (isUniqueOpen(err)) throw Errors.conflict('PRIVACY_REQUEST_OPEN', 'Permintaan ekspor data Anda sedang diproses');
    throw err;
  }
}

/** Queue handler: builds and stores the export, completes the request, emits privacy.export_ready. */
export async function runExport(deps: AppDeps, requestId: string) {
  const [r] = await deps.sql<{ user_id: string; status: string }[]>`SELECT user_id, status FROM privacy_requests WHERE id = ${requestId} AND type = 'EXPORT'`;
  if (!r || r.status === 'COMPLETED' || r.status === 'REJECTED' || r.status === 'CANCELLED') return { skipped: true };
  await deps.sql`UPDATE privacy_requests SET status = 'IN_PROGRESS' WHERE id = ${requestId} AND status = 'RECEIVED'`;
  const data = await buildExport(deps, deps.sql, r.user_id);
  const body = new TextEncoder().encode(JSON.stringify(data, null, 2));
  const now = deps.clock.now();
  await inTx(deps, async (tx) => {
    const fileId = await storeServerFile(deps, tx, {
      ownerId: r.user_id,
      purpose: 'EXPORT',
      mime: 'application/json',
      body,
      retentionUntil: new Date(now.getTime() + SECURITY.EXPORT_RETENTION_DAYS * 86400_000),
    });
    await tx`UPDATE privacy_requests SET status = 'COMPLETED', completed_at = ${now}, export_file_id = ${fileId} WHERE id = ${requestId}`;
    await emitEvent(tx, 'privacy_request', requestId, 'privacy.export_ready', { requestId, userId: r.user_id });
  });
  return { requestId, bytes: body.length };
}

// =================================================================== deletion
export async function deletionBlockers(db: Db, userId: string) {
  const [b] = await db<{ active_transactions: number; open_disputes: number; unpaid_payouts: number; inflight_refunds: number }[]>`
    SELECT (SELECT count(*) FROM transactions WHERE (buyer_id = ${userId} OR traveler_id = ${userId})
                                             AND status NOT IN ('COMPLETED','CANCELLED','REFUNDED'))::int AS active_transactions,
           (SELECT count(*) FROM disputes d JOIN transactions t ON t.id = d.transaction_id
             WHERE d.status <> 'CLOSED' AND (t.buyer_id = ${userId} OR t.traveler_id = ${userId}))::int AS open_disputes,
           (SELECT count(*) FROM payouts WHERE traveler_id = ${userId} AND status IN ('SCHEDULED','ON_HOLD','PROCESSING','FAILED'))::int AS unpaid_payouts,
           (SELECT count(*) FROM refunds r JOIN transactions t ON t.id = r.transaction_id
             WHERE t.buyer_id = ${userId} AND r.status NOT IN ('SUCCEEDED','REJECTED','CANCELLED'))::int AS inflight_refunds`;
  const out = {
    activeTransactions: b!.active_transactions,
    openDisputes: b!.open_disputes,
    unpaidPayouts: b!.unpaid_payouts,
    inflightRefunds: b!.inflight_refunds,
  };
  return Object.values(out).some((n) => n > 0) ? out : null;
}

export async function requestDeletion(deps: AppDeps, auth: AuthContext, input: { reason?: string | undefined }, req: RequestMeta) {
  const now = deps.clock.now();
  const effectiveAt = new Date(now.getTime() + SECURITY.DELETION_GRACE_DAYS * 86400_000);
  try {
    const id = await inTx(deps, async (tx) => {
      const [u] = await tx<{ status: string }[]>`SELECT status FROM users WHERE id = ${auth.userId} FOR UPDATE`;
      if (!u || u.status !== 'ACTIVE') throw Errors.conflict('ACCOUNT_NOT_ACTIVE', 'Akun tidak dalam status aktif');
      const blockers = await deletionBlockers(tx, auth.userId);
      if (blockers) {
        throw Errors.conflict('DELETION_BLOCKED', 'Akun belum dapat dihapus: selesaikan transaksi, sengketa, refund, atau payout yang masih berjalan', blockers);
      }
      const [r] = await tx<{ id: string }[]>`
        INSERT INTO privacy_requests (user_id, type, status, details, due_at, verified_at, scheduled_for, created_at)
        VALUES (${auth.userId}, 'DELETION', 'IN_PROGRESS', ${tx.json({ reason: input.reason ?? null, graceDays: SECURITY.DELETION_GRACE_DAYS } as never)},
                ${effectiveAt}, ${now}, ${effectiveAt}, ${now}) RETURNING id`;
      await tx`UPDATE users SET status = 'PENDING_DELETION' WHERE id = ${auth.userId}`;
      await tx`UPDATE refresh_tokens SET revoked_at = ${now}, revoked_reason = 'ACCOUNT_DELETED' WHERE user_id = ${auth.userId} AND revoked_at IS NULL`;
      await emitEvent(tx, 'user', auth.userId, 'account.deletion_scheduled', { requestId: r!.id, userId: auth.userId, effectiveAt: effectiveAt.toISOString() });
      await securityEvent(deps, tx, { userId: auth.userId, type: 'ACCOUNT_DELETION_REQUESTED', severity: 'MEDIUM', req, meta: { requestId: r!.id } });
      await audit(tx, {
        actorType: 'USER',
        actorId: auth.userId,
        action: 'privacy.deletion_scheduled',
        entityType: 'user',
        entityId: auth.userId,
        before: { status: 'ACTIVE' },
        after: { status: 'PENDING_DELETION', effectiveAt: effectiveAt.toISOString() },
        meta: { requestId: r!.id },
      });
      return r!.id;
    });
    return { request: toDto((await getRequest(deps.sql, id))!), effectiveAt: effectiveAt.toISOString() };
  } catch (err) {
    if (isUniqueOpen(err)) throw Errors.conflict('PRIVACY_REQUEST_OPEN', 'Penghapusan akun sudah dijadwalkan');
    throw err;
  }
}

export async function cancelDeletion(deps: AppDeps, auth: AuthContext, req: RequestMeta) {
  const now = deps.clock.now();
  const id = await inTx(deps, async (tx) => {
    const [r] = await tx<{ id: string }[]>`
      SELECT id FROM privacy_requests WHERE user_id = ${auth.userId} AND type = 'DELETION' AND status = 'IN_PROGRESS' FOR UPDATE`;
    if (!r) throw Errors.notFound('Permintaan penghapusan', 'DELETION_NOT_SCHEDULED');
    await tx`UPDATE privacy_requests SET status = 'CANCELLED', completed_at = ${now},
                    details = details || ${tx.json({ cancelledAt: now.toISOString() } as never)} WHERE id = ${r.id}`;
    await tx`UPDATE users SET status = 'ACTIVE' WHERE id = ${auth.userId} AND status = 'PENDING_DELETION'`;
    await securityEvent(deps, tx, { userId: auth.userId, type: 'ACCOUNT_DELETION_CANCELLED', severity: 'MEDIUM', req, meta: { requestId: r.id } });
    await audit(tx, {
      actorType: 'USER',
      actorId: auth.userId,
      action: 'privacy.deletion_cancelled',
      entityType: 'user',
      entityId: auth.userId,
      before: { status: 'PENDING_DELETION' },
      after: { status: 'ACTIVE' },
      meta: { requestId: r.id },
    });
    return r.id;
  });
  return toDto((await getRequest(deps.sql, id))!);
}

/**
 * Scheduled: anonymizes accounts whose grace period ended (DB anonymize_user keeps financial/audit
 * records pseudonymous). The login e-mail HMAC goes to email_suppressions first (the DB cannot compute it).
 * If blockers appeared meanwhile (JK423), the run is retried next time and the reason recorded.
 */
export async function finalizeDueDeletions(deps: AppDeps, limit = 50) {
  const now = deps.clock.now();
  const due = await deps.sql<{ id: string; user_id: string }[]>`
    SELECT id, user_id FROM privacy_requests
     WHERE type = 'DELETION' AND status = 'IN_PROGRESS' AND scheduled_for <= ${now}
     ORDER BY scheduled_for LIMIT ${limit}`;
  let completed = 0;
  let deferred = 0;
  let skipped = 0;
  for (const d of due) {
    const res = await inTx(deps, async (tx) => {
      const [u] = await tx<{ status: string; email: string | null; transaction_email: string | null }[]>`
        SELECT status, email, transaction_email FROM users WHERE id = ${d.user_id} FOR UPDATE`;
      if (!u || u.status !== 'PENDING_DELETION') {
        await tx`UPDATE privacy_requests SET status = 'CANCELLED', completed_at = ${now},
                        details = details || ${tx.json({ note: 'account no longer pending deletion' } as never)} WHERE id = ${d.id}`;
        return 'skipped' as const;
      }
      for (const e of [u.email, u.transaction_email]) {
        if (!e) continue;
        const h = await deps.crypto.hashIdentifier('email', e.toLowerCase());
        await tx`INSERT INTO email_suppressions (email_hash, reason, scope, source) VALUES (${buf(h)}, 'ACCOUNT_DELETED', 'ALL', 'privacy.deletion')
                 ON CONFLICT (email_hash) DO UPDATE SET reason = 'ACCOUNT_DELETED', scope = 'ALL', updated_at = now()`;
      }
      try {
        await tx.savepoint(async (sp) => {
          await sp`SELECT anonymize_user(${d.user_id}::uuid, NULL::uuid, false)`;
        });
      } catch (err) {
        const mapped = fromPgError(err);
        if (mapped?.code === 'JK423') {
          await tx`UPDATE privacy_requests SET details = details || ${tx.json({ lastAttemptAt: now.toISOString(), blockers: mapped.details ?? {} } as never)} WHERE id = ${d.id}`;
          return 'deferred' as const;
        }
        throw err;
      }
      await tx`UPDATE privacy_requests SET status = 'COMPLETED', completed_at = ${now} WHERE id = ${d.id}`;
      return 'completed' as const;
    });
    if (res === 'completed') completed++;
    else if (res === 'deferred') deferred++;
    else skipped++;
  }
  return { due: due.length, completed, deferred, skipped };
}

