/**
 * Retention & purge jobs.
 *  - purgeExpiredOtpAndIdempotency (hourly): OTP challenges expired > 24 h ago (the rate-limit look-back
 *    window; abuse evidence stays in security_events) and expired idempotency keys.
 *  - retentionPurge (daily): applies data_retention_policies (all flagged is_assumption — legal review
 *    pending) to the entities the API role may purge; deletes storage objects for files whose
 *    retention ended (exports, anonymized users' files, purged KYC documents, trip docs, chat files)
 *    and abandoned uploads. Append-only / legally retained entities are reported as skipped.
 */
import type { AppDeps } from '../../context';

const BATCH = 500;
const DAY = 86400_000;

export async function purgeExpiredOtpAndIdempotency(deps: AppDeps) {
  const now = deps.clock.now();
  const otp = await deps.sql`DELETE FROM otp_challenges WHERE expires_at < ${new Date(now.getTime() - DAY)}`;
  const idem = await deps.sql`DELETE FROM idempotency_keys WHERE expires_at < ${now} AND status <> 'IN_PROGRESS'`;
  return { otpChallenges: otp.count, idempotencyKeys: idem.count };
}

async function purgeObjects(deps: AppDeps, rows: readonly { id: string; storage_key: string }[]): Promise<number> {
  const now = deps.clock.now();
  let n = 0;
  for (const f of rows) {
    try {
      await deps.providers.storage.delete(f.storage_key);
    } catch (err) {
      deps.logger.error('retention.object_delete_failed', { fileId: f.id, error: err instanceof Error ? err.message : String(err) });
      continue; // retried next run
    }
    await deps.sql`UPDATE files SET deleted_at = ${now} WHERE id = ${f.id} AND deleted_at IS NULL`;
    n++;
  }
  return n;
}

const SKIPPED = new Set(['security_events', 'audit_logs', 'financial_records', 'payment_webhook_events']);

export async function retentionPurge(deps: AppDeps) {
  const now = deps.clock.now();
  const sql = deps.sql;
  const policies = await sql<{ entity: string; retention_days: number }[]>`
    SELECT entity, retention_days FROM data_retention_policies WHERE enabled ORDER BY entity`;
  const result: Record<string, number | string> = {};
  for (const p of policies) {
    // `cutoff` (app clock) for columns the API stamps with deps.clock; `dbCutoff` (DB now()) for columns the DB
    // stamps itself (defaults, transition functions, anonymize_user, the worker) — keeps both consistent.
    const cutoff = new Date(now.getTime() - p.retention_days * DAY);
    const dbCutoff = sql`now() - make_interval(days => ${p.retention_days})`;
    switch (p.entity) {
      case 'otp_challenges':
        result[p.entity] = (await sql`DELETE FROM otp_challenges WHERE created_at < ${cutoff}`).count;
        break;
      case 'refresh_tokens':
        result[p.entity] = (await sql`DELETE FROM refresh_tokens WHERE expires_at < ${cutoff}`).count;
        break;
      case 'idempotency_keys':
        result[p.entity] = (await sql`DELETE FROM idempotency_keys WHERE expires_at < ${cutoff} AND status <> 'IN_PROGRESS'`).count;
        break;
      case 'notifications':
        result[p.entity] = (await sql`DELETE FROM notifications WHERE created_at < ${dbCutoff}`).count;
        break;
      case 'analytics_events':
        result[p.entity] = (await sql`DELETE FROM analytics_events WHERE received_at < ${dbCutoff}`).count;
        break;
      case 'outbox_events':
        result[p.entity] = (await sql`DELETE FROM outbox_events WHERE published_at IS NOT NULL AND published_at < ${dbCutoff}`).count;
        break;
      case 'jobs':
        result[p.entity] = (await sql`DELETE FROM jobs WHERE status IN ('SUCCEEDED','DEAD','CANCELLED') AND finished_at < ${dbCutoff}`).count;
        break;
      case 'identity_records':
        // purge_after is set on account closure (anonymize_user) from this same policy
        result[p.entity] = (await sql`DELETE FROM identity_records WHERE purge_after IS NOT NULL AND purge_after <= now()`).count;
        break;
      case 'kyc_documents': {
        const docs = await sql<{ id: string; file_id: string | null; storage_key: string | null }[]>`
          SELECT kd.id, kd.file_id, f.storage_key FROM kyc_documents kd LEFT JOIN files f ON f.id = kd.file_id
           WHERE kd.purged_at IS NULL AND kd.purge_after IS NOT NULL AND kd.purge_after <= now() LIMIT ${BATCH}`;
        await purgeObjects(deps, docs.filter((d) => d.file_id && d.storage_key).map((d) => ({ id: d.file_id!, storage_key: d.storage_key! })));
        for (const d of docs) await sql`UPDATE kyc_documents SET status = 'PURGED', purged_at = ${now}, file_id = NULL WHERE id = ${d.id}`;
        result[p.entity] = docs.length;
        break;
      }
      case 'messages':
        result[p.entity] = (
          await sql`
            UPDATE messages m SET body = NULL, attachments = '[]', meta = '{}', deleted_at = coalesce(m.deleted_at, ${now})
              FROM conversations cv JOIN transactions t ON t.id = cv.transaction_id
             WHERE m.conversation_id = cv.id AND m.sender_id IS NOT NULL AND m.body IS NOT NULL
               AND t.status IN ('COMPLETED','CANCELLED','REFUNDED')
               AND coalesce(t.completed_at, t.cancelled_at, t.refunded_at) < ${dbCutoff}
               AND NOT EXISTS (SELECT 1 FROM dispute_evidence de WHERE de.message_id = m.id)`
        ).count;
        break;
      case 'deliveries.address':
        result[p.entity] = (
          await sql`
            UPDATE deliveries d SET address_enc = NULL, enc_key_id = NULL, meetup_point = NULL
              FROM transactions t
             WHERE t.id = d.transaction_id AND (d.address_enc IS NOT NULL OR d.meetup_point IS NOT NULL)
               AND t.status IN ('COMPLETED','CANCELLED','REFUNDED')
               AND coalesce(t.completed_at, t.cancelled_at, t.refunded_at) < ${dbCutoff}`
        ).count;
        break;
      case 'trip_verifications.file': {
        const rows = await sql<{ id: string; storage_key: string }[]>`
          SELECT f.id, f.storage_key FROM files f
           WHERE f.purpose = 'TRIP_DOC' AND f.deleted_at IS NULL
             AND EXISTS (SELECT 1 FROM trip_verifications tv JOIN trips tr ON tr.id = tv.trip_id
                          WHERE tv.file_id = f.id AND tr.status IN ('COMPLETED','CANCELLED')
                            AND coalesce(tr.completed_at, tr.cancelled_at) < ${dbCutoff})
           LIMIT ${BATCH}`;
        result[p.entity] = await purgeObjects(deps, rows);
        break;
      }
      case 'files.chat': {
        const rows = await sql<{ id: string; storage_key: string }[]>`
          SELECT f.id, f.storage_key FROM files f
           WHERE f.purpose = 'CHAT' AND f.deleted_at IS NULL
             AND NOT EXISTS (SELECT 1 FROM dispute_evidence de WHERE de.file_id = f.id)
             AND EXISTS (SELECT 1 FROM messages m JOIN conversations cv ON cv.id = m.conversation_id JOIN transactions t ON t.id = cv.transaction_id
                          WHERE m.attachments @> jsonb_build_array(jsonb_build_object('fileId', f.id::text))
                            AND t.status IN ('COMPLETED','CANCELLED','REFUNDED')
                            AND coalesce(t.completed_at, t.cancelled_at, t.refunded_at) < ${dbCutoff})
           LIMIT ${BATCH}`;
        result[p.entity] = await purgeObjects(deps, rows);
        break;
      }
      default:
        result[p.entity] = SKIPPED.has(p.entity) ? 'SKIPPED_APPEND_ONLY_OR_LEGAL_RETENTION' : 'UNSUPPORTED';
    }
  }
  // files whose retention ended: exports (retention_until from the app clock) and files flagged by anonymize_user
  // (DB now()) — either reference passing counts
  const expired = await sql<{ id: string; storage_key: string }[]>`
    SELECT id, storage_key FROM files
     WHERE deleted_at IS NULL AND retention_until IS NOT NULL AND (retention_until <= ${now} OR retention_until <= now()) LIMIT ${BATCH}`;
  result['files.retention_until'] = await purgeObjects(deps, expired);
  // abandoned uploads (never completed)
  const abandoned = await sql<{ id: string; storage_key: string }[]>`
    SELECT id, storage_key FROM files WHERE completed_at IS NULL AND deleted_at IS NULL AND upload_expires_at < ${new Date(now.getTime() - DAY)} LIMIT ${BATCH}`;
  result['files.abandoned_uploads'] = await purgeObjects(deps, abandoned);
  return result;
}
