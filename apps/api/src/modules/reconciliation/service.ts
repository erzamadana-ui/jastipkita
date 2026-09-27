/**
 * Reconciliation:
 * - pollPendingPayments: missed-webhook safety net — asks the provider about PENDING payments older than
 *   N minutes and feeds the answer through the same idempotent event processor.
 * - runDailyReconciliation: SECURED payments vs ledger capture journals for a period → reconciliation_runs
 *   + reconciliation_items; any difference is an ALERT log line and a COMPLETED_WITH_DIFFS run.
 */
import type { AppDeps } from '../../context';
import { providerEnv } from '../../providers/payment';
import { processPaymentEvent } from '../payments/service';
import { moneyPolicy } from '../transactions/common';

export async function pollPendingPayments(deps: AppDeps): Promise<{ checked: number; secured: number; expired: number }> {
  const policy = await moneyPolicy(deps.sql);
  const now = deps.clock.now();
  const cutoff = new Date(now.getTime() - policy.pendingPaymentPollMinutes * 60_000);
  const provider = deps.providers.payment;
  const rows = await deps.sql<{ id: string; provider_ref: string | null }[]>`
    SELECT id, provider_ref FROM payments
     WHERE status = 'PENDING' AND provider = ${provider.name} AND created_at <= ${cutoff} AND provider_ref IS NOT NULL
     ORDER BY created_at LIMIT 200`;
  let secured = 0;
  let expired = 0;
  for (const p of rows) {
    try {
      const remote = await provider.getPayment(p.provider_ref!);
      if (remote.status === 'PENDING') continue;
      const r = await processPaymentEvent(deps, {
        provider: provider.name,
        providerRef: p.provider_ref!,
        referenceId: p.id,
        status: remote.status === 'SECURED' ? 'SUCCEEDED' : remote.status,
        amountIdr: remote.amountIdr,
        currency: remote.currency,
        channel: remote.channel,
        source: 'RECONCILIATION',
        signatureValid: true,
      });
      if (r.outcome === 'SECURED' || r.outcome === 'SECURED_LATE_REFUND') secured++;
      if (r.outcome === 'EXPIRED' || r.outcome === 'FAILED') expired++;
    } catch (err) {
      deps.logger.warn('reconciliation.poll_failed', { paymentId: p.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { checked: rows.length, secured, expired };
}

export interface DailyRunResult {
  runId: string;
  status: 'MATCHED' | 'COMPLETED_WITH_DIFFS';
  payments: number;
  mismatches: number;
}

/**
 * Compares, for payments secured in [periodStart, periodEnd), the payment amount with the PROVIDER_CASH debit
 * of its capture journal (`capture:<paymentId>`). Missing journal → MISSING_INTERNAL; amount difference →
 * MISMATCH; journals whose payment is not SECURED → MISSING_PROVIDER.
 */
export async function runDailyReconciliation(deps: AppDeps, period?: { start: Date; end: Date }): Promise<DailyRunResult> {
  const now = deps.clock.now();
  const DAY = 86_400_000;
  const WIB = 7 * 3600_000;
  // Default period: the last complete calendar day in WIB (Asia/Jakarta, UTC+7).
  const end = period?.end ?? new Date(Math.floor((now.getTime() + WIB) / DAY) * DAY - WIB);
  const start = period?.start ?? new Date(end.getTime() - DAY);
  const provider = deps.providers.payment;
  return deps.sql.begin(async (db) => {
    const [run] = await db<{ id: string }[]>`
      INSERT INTO reconciliation_runs (provider, provider_env, period_start, period_end, status, started_at)
      VALUES (${provider.name}, ${providerEnv(provider)}, ${start}, ${end}, 'RUNNING', ${now}) RETURNING id`;
    const rows = await db<{ id: string; provider_ref: string | null; amount_idr: number; status: string; captured: number | null }[]>`
      SELECT p.id, p.provider_ref, p.amount_idr, p.status,
             (SELECT sum(e.amount) FROM ledger_journals j JOIN ledger_entries e ON e.journal_id = j.id
                JOIN ledger_accounts a ON a.id = e.account_id
               WHERE j.idempotency_key = 'capture:' || p.id AND a.bucket = 'PROVIDER_CASH' AND e.direction = 'DEBIT')::bigint AS captured
        FROM payments p
       WHERE p.provider = ${provider.name} AND p.secured_at >= ${start} AND p.secured_at < ${end}
         AND p.status IN ('SECURED','PARTIALLY_REFUNDED','REFUNDED')`;
    let mismatches = 0;
    let internalTotal = 0;
    let providerTotal = 0;
    for (const r of rows) {
      const captured = r.captured === null ? null : Number(r.captured);
      const status = captured === null ? 'MISSING_INTERNAL' : captured === Number(r.amount_idr) ? 'MATCHED' : 'MISMATCH';
      if (status !== 'MATCHED') mismatches++;
      internalTotal += captured ?? 0;
      providerTotal += Number(r.amount_idr);
      await db`
        INSERT INTO reconciliation_items (run_id, item_type, internal_ref, provider_ref, internal_amount_idr, provider_amount_idr, status)
        VALUES (${run!.id}, 'PAYMENT', ${r.id}, ${r.provider_ref}, ${captured}, ${Number(r.amount_idr)}, ${status})`;
    }
    const orphans = await db<{ payment_id: string; amount: number }[]>`
      SELECT j.payment_id, sum(e.amount)::bigint AS amount
        FROM ledger_journals j JOIN ledger_entries e ON e.journal_id = j.id JOIN ledger_accounts a ON a.id = e.account_id
        JOIN payments p ON p.id = j.payment_id
       WHERE j.kind IN ('PAYMENT_CAPTURED','SUPPLEMENTAL_CAPTURED','LATE_PAYMENT_CAPTURED') AND a.bucket = 'PROVIDER_CASH' AND e.direction = 'DEBIT'
         AND j.posted_at >= ${start} AND j.posted_at < ${end} AND p.status NOT IN ('SECURED','PARTIALLY_REFUNDED','REFUNDED')
       GROUP BY j.payment_id`;
    for (const o of orphans) {
      mismatches++;
      await db`
        INSERT INTO reconciliation_items (run_id, item_type, internal_ref, internal_amount_idr, provider_amount_idr, status)
        VALUES (${run!.id}, 'PAYMENT', ${o.payment_id}, ${Number(o.amount)}, NULL, 'MISSING_PROVIDER')`;
    }
    const status = mismatches === 0 ? 'MATCHED' : 'COMPLETED_WITH_DIFFS';
    await db`UPDATE reconciliation_runs SET status = ${status}, finished_at = ${deps.clock.now()},
               totals = ${db.json({ payments: rows.length, mismatches, internalCapturedIdr: internalTotal, providerSecuredIdr: providerTotal } as never)}
             WHERE id = ${run!.id}`;
    if (mismatches > 0) deps.logger.error('ALERT reconciliation.mismatch', { runId: run!.id, mismatches, provider: provider.name });
    return { runId: run!.id, status, payments: rows.length, mismatches };
  });
}
