/**
 * Dispute SLA job (every 5 min):
 *   1. OPEN (e.g. created by an admin tool) → EVIDENCE_COLLECTION, deadlines filled from dispute.sla
 *   2. EVIDENCE_COLLECTION whose evidence window closed → UNDER_REVIEW (guard EVIDENCE_DONE)
 *   3. SLA breach flag (core slaBreach) on disputes past their review deadline → sla_breach +
 *      outbox `dispute.sla_breached` (ops/admin dashboards)
 *   4. RESOLVED whose appeal window passed → CLOSED
 * Each dispute is moved in its own DB transaction with optimistic locking; one failure never blocks others.
 */
import { appealDeadline, computeSla, disputeFsm, slaBreach, type DisputeStatus } from '@jastipkita/core';
import type { AppDeps } from '../../context';
import type { TxSql } from '../../db/sql';
import { emitEvent } from '../../services/outbox';
import { transitionDispute } from './repository';

type Row = { id: string; number: string; status: string; version: number; created_at: Date; evidence_due_at: Date | null; sla_due_at: Date | null; resolved_at: Date | null };

export async function runDisputeSla(deps: AppDeps): Promise<Record<string, number>> {
  const sla = await deps.config.get('dispute.sla');
  const now = deps.clock.now();
  const out = { accepted: 0, toReview: 0, breached: 0, closed: 0, errors: 0 };

  const step = async (label: keyof typeof out, rows: Row[], fn: (tx: TxSql, r: Row) => Promise<boolean>) => {
    for (const r of rows) {
      try {
        const done = await deps.sql.begin(async (tq) => fn(tq as unknown as TxSql, r));
        if (done) out[label]++;
      } catch (err) {
        out.errors++;
        deps.logger.warn('disputes.sla_step_failed', { step: label, disputeId: r.id, error: err instanceof Error ? err.message : String(err) });
      }
    }
  };

  const open = await deps.sql<Row[]>`
    SELECT id, number, status, version, created_at, evidence_due_at, sla_due_at, resolved_at FROM disputes WHERE status = 'OPEN' LIMIT 200`;
  await step('accepted', open, async (tx, r) => {
    const s = computeSla(r.created_at, sla);
    await tx`UPDATE disputes SET evidence_due_at = coalesce(evidence_due_at, ${s.evidenceDueAt}), sla_due_at = coalesce(sla_due_at, ${s.reviewDueAt}) WHERE id = ${r.id}`;
    await transitionDispute(tx, r.id, r.version, 'EVIDENCE_COLLECTION', 'SYSTEM', null, 'evidence window started (SLA job)');
    return true;
  });

  const evidenceDone = await deps.sql<Row[]>`
    SELECT id, number, status, version, created_at, evidence_due_at, sla_due_at, resolved_at FROM disputes
     WHERE status = 'EVIDENCE_COLLECTION' AND evidence_due_at <= ${now} LIMIT 200`;
  await step('toReview', evidenceDone, async (tx, r) => {
    const ok = disputeFsm.canTransition('EVIDENCE_COLLECTION', 'UNDER_REVIEW', 'SYSTEM', { evidenceWindowClosed: true });
    if (!ok.ok) return false;
    await transitionDispute(tx, r.id, r.version, 'UNDER_REVIEW', 'SYSTEM', null, 'evidence window closed', { evidenceDueAt: r.evidence_due_at?.toISOString() });
    return true;
  });

  const active = await deps.sql<Row[]>`
    SELECT id, number, status, version, created_at, evidence_due_at, sla_due_at, resolved_at FROM disputes
     WHERE status NOT IN ('RESOLVED','CLOSED') AND sla_breached_at IS NULL AND sla_due_at IS NOT NULL AND sla_due_at < ${now} LIMIT 500`;
  await step('breached', active, async (tx, r) => {
    const breach = slaBreach(r.status as DisputeStatus, { openedAt: r.created_at, evidenceDueAt: r.evidence_due_at ?? r.created_at, reviewDueAt: r.sla_due_at! }, now);
    if (!breach) return false;
    const upd = await tx`UPDATE disputes SET sla_breach = ${breach}, sla_breached_at = ${now} WHERE id = ${r.id} AND sla_breached_at IS NULL`;
    if (upd.count === 0) return false;
    await emitEvent(tx, 'dispute', r.id, 'dispute.sla_breached', { disputeId: r.id, number: r.number, status: r.status, breach, slaDueAt: r.sla_due_at!.toISOString() });
    return true;
  });

  const resolved = await deps.sql<Row[]>`
    SELECT id, number, status, version, created_at, evidence_due_at, sla_due_at, resolved_at FROM disputes
     WHERE status = 'RESOLVED' AND resolved_at IS NOT NULL
       AND resolved_at + make_interval(hours => ${sla.appealWindowHours}) <= ${now}
     ORDER BY resolved_at LIMIT 500`;
  await step(
    'closed',
    resolved.filter((r) => appealDeadline(r.resolved_at!, sla) <= now),
    async (tx, r) => {
      await transitionDispute(tx, r.id, r.version, 'CLOSED', 'SYSTEM', null, 'appeal window over');
      return true;
    },
  );
  return out;
}
