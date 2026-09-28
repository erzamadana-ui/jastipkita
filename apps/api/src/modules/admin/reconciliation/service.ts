/**
 * Admin · Reconciliation (docs/04-payments-ledger.md): the daily job (`money.daily_reconciliation`, every 24 h, period = last full WIB day) compares
 * SECURED payments with their ledger capture journals and stores the result in reconciliation_runs/items.
 * Finance reads runs + open differences here, resolves each difference with a written note (audited), and can start
 * a manual run for a past period (MFA, idempotent). Resolving never changes money — corrections go through the
 * normal refund/payout/ledger flows; the note records what was done.
 */
import { Errors } from '../../../lib/errors';
import { runDailyReconciliation } from '../../reconciliation/service';
import { type AdminCtx, adminAudit, decodeKey, encodeKey, inAdminTx, iso, num, numOrNull, parseCsv } from '../common';

export const RUN_STATUSES = ['RUNNING', 'MATCHED', 'COMPLETED_WITH_DIFFS', 'FAILED'] as const;
export const ITEM_STATUSES = ['MATCHED', 'MISMATCH', 'MISSING_INTERNAL', 'MISSING_PROVIDER', 'RESOLVED'] as const;
const OPEN_ITEM_STATUSES = ['MISMATCH', 'MISSING_INTERNAL', 'MISSING_PROVIDER'] as const;
const MAX_MANUAL_PERIOD_DAYS = 31;

export async function listRuns(ctx: AdminCtx, q: { status?: string | undefined; limit: number; cursor?: string | undefined }) {
  const db = ctx.deps.sql;
  const statuses = parseCsv(q.status, RUN_STATUSES, 'status');
  const cursor = decodeKey(q.cursor);
  const rows = await db<Record<string, unknown>[]>`
    SELECT r.id, r.provider, r.provider_env, r.period_start, r.period_end, r.status, r.totals, r.started_at, r.finished_at,
           r.created_by, r.error,
           (SELECT count(*) FROM reconciliation_items i WHERE i.run_id = r.id AND i.status = ANY(${OPEN_ITEM_STATUSES as unknown as string[]}::text[]))::int AS open_items,
           (SELECT count(*) FROM reconciliation_items i WHERE i.run_id = r.id AND i.status = 'RESOLVED')::int AS resolved_items
      FROM reconciliation_runs r
     WHERE TRUE
       ${statuses ? db`AND r.status = ANY(${statuses}::text[])` : db``}
       ${cursor ? db`AND (r.started_at, r.id) < (${cursor.t}::timestamptz, ${cursor.id}::uuid)` : db``}
     ORDER BY r.started_at DESC, r.id DESC LIMIT ${q.limit + 1}`;
  const more = rows.length > q.limit;
  const data = rows.slice(0, q.limit).map(runView);
  const last = data[data.length - 1];
  return { data, nextCursor: more && last ? encodeKey({ t: last.startedAt, id: last.id }) : null };
}

function runView(r: Record<string, unknown>) {
  const totals = (r.totals as Record<string, unknown> | null) ?? {};
  return {
    id: String(r.id),
    provider: String(r.provider),
    sandbox: r.provider_env !== 'LIVE',
    periodStart: iso(r.period_start as Date)!,
    periodEnd: iso(r.period_end as Date)!,
    status: String(r.status),
    payments: num(totals.payments ?? 0),
    mismatches: num(totals.mismatches ?? 0),
    internalCapturedIdr: num(totals.internalCapturedIdr ?? 0),
    providerSecuredIdr: num(totals.providerSecuredIdr ?? 0),
    openItems: num(r.open_items ?? 0),
    resolvedItems: num(r.resolved_items ?? 0),
    manual: r.created_by !== null && r.created_by !== undefined,
    error: (r.error as string | null) ?? null,
    startedAt: iso(r.started_at as Date)!,
    finishedAt: iso(r.finished_at as Date | null),
  };
}

export async function listItems(ctx: AdminCtx, runId: string, q: { status?: string | undefined; limit: number; cursor?: string | undefined }) {
  const db = ctx.deps.sql;
  const [run] = await db`SELECT 1 FROM reconciliation_runs WHERE id = ${runId}`;
  if (!run) throw Errors.notFound('Run rekonsiliasi', 'RECONCILIATION_RUN_NOT_FOUND');
  // default: what needs attention
  const statuses = parseCsv(q.status, ITEM_STATUSES, 'status') ?? [...OPEN_ITEM_STATUSES];
  const cursor = decodeKey(q.cursor);
  const rows = await db<Record<string, unknown>[]>`
    SELECT i.id, i.item_type, i.internal_ref, i.provider_ref, i.internal_amount_idr, i.provider_amount_idr, i.diff_idr, i.status,
           i.resolution_note, i.resolved_by, i.resolved_at, i.created_at,
           p.transaction_id, t.number AS tx_number, p.channel
      FROM reconciliation_items i
      LEFT JOIN payments p ON p.id = i.internal_ref AND i.item_type = 'PAYMENT'
      LEFT JOIN transactions t ON t.id = p.transaction_id
     WHERE i.run_id = ${runId} AND i.status = ANY(${statuses}::text[])
       ${cursor ? db`AND (i.created_at, i.id) > (${cursor.t}::timestamptz, ${cursor.id}::uuid)` : db``}
     ORDER BY i.created_at, i.id LIMIT ${q.limit + 1}`;
  const more = rows.length > q.limit;
  const data = rows.slice(0, q.limit).map((x) => ({
    id: String(x.id),
    itemType: String(x.item_type),
    internalRef: (x.internal_ref as string | null) ?? null,
    providerRef: (x.provider_ref as string | null) ?? null,
    transactionId: (x.transaction_id as string | null) ?? null,
    transactionNumber: (x.tx_number as string | null) ?? null,
    channel: (x.channel as string | null) ?? null,
    internalAmountIdr: numOrNull(x.internal_amount_idr),
    providerAmountIdr: numOrNull(x.provider_amount_idr),
    diffIdr: num(x.diff_idr ?? 0),
    status: String(x.status),
    resolutionNote: (x.resolution_note as string | null) ?? null,
    resolvedBy: (x.resolved_by as string | null) ?? null,
    resolvedAt: iso(x.resolved_at as Date | null),
    createdAt: iso(x.created_at as Date)!,
  }));
  const last = data[data.length - 1];
  return { data, nextCursor: more && last ? encodeKey({ t: last.createdAt, id: last.id }) : null };
}

export async function resolveItem(ctx: AdminCtx, itemId: string, note: string) {
  const now = ctx.deps.clock.now();
  return inAdminTx(ctx, async (tx) => {
    const [it] = await tx<{ id: string; run_id: string; status: string; diff_idr: number }[]>`
      SELECT id, run_id, status, diff_idr FROM reconciliation_items WHERE id = ${itemId} FOR UPDATE`;
    if (!it) throw Errors.notFound('Item rekonsiliasi', 'RECONCILIATION_ITEM_NOT_FOUND');
    if (!(OPEN_ITEM_STATUSES as readonly string[]).includes(it.status)) {
      throw Errors.conflict('RECONCILIATION_ITEM_NOT_OPEN', 'Item ini tidak memiliki selisih terbuka', { status: it.status });
    }
    await tx`UPDATE reconciliation_items SET status = 'RESOLVED', resolution_note = ${note}, resolved_by = ${ctx.auth.userId}, resolved_at = ${now}
              WHERE id = ${itemId}`;
    await adminAudit(tx, ctx, {
      action: 'reconciliation.item_resolved',
      entityType: 'reconciliation_item',
      entityId: itemId,
      before: { status: it.status },
      after: { status: 'RESOLVED' },
      meta: { runId: it.run_id, diffIdr: Number(it.diff_idr), note },
    });
    return { id: itemId, runId: it.run_id, previousStatus: it.status, status: 'RESOLVED', resolvedAt: now.toISOString() };
  });
}

export async function startManualRun(ctx: AdminCtx, input: { periodStart: string; periodEnd: string; reason: string }) {
  const start = new Date(input.periodStart);
  const end = new Date(input.periodEnd);
  const now = ctx.deps.clock.now();
  if (!(end > start)) throw Errors.unprocessable('PERIOD_INVALID', 'Akhir periode harus setelah awal periode');
  if (end > now) throw Errors.unprocessable('PERIOD_IN_FUTURE', 'Periode tidak boleh melewati waktu sekarang');
  if (end.getTime() - start.getTime() > MAX_MANUAL_PERIOD_DAYS * 86_400_000) {
    throw Errors.unprocessable('PERIOD_TOO_LONG', `Periode maksimal ${MAX_MANUAL_PERIOD_DAYS} hari`);
  }
  const res = await runDailyReconciliation(ctx.deps, { start, end });
  await inAdminTx(ctx, async (tx) => {
    await tx`UPDATE reconciliation_runs SET created_by = ${ctx.auth.userId} WHERE id = ${res.runId}`;
    await adminAudit(tx, ctx, {
      action: 'reconciliation.manual_run',
      entityType: 'reconciliation_run',
      entityId: res.runId,
      after: { status: res.status, payments: res.payments, mismatches: res.mismatches },
      meta: { periodStart: start.toISOString(), periodEnd: end.toISOString(), reason: input.reason },
    });
  });
  return res;
}
