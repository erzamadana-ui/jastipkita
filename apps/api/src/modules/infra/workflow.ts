/**
 * Migration workflow (DB & Infra Center). DELIBERATE DECISION: the admin UI never executes DDL. Schema migrations run
 * from CI (`db/scripts/migrate.sh`, forward-only, checksummed); the admin UI TRACKS, APPROVES and RECORDS the 8-step
 * change process as a state record:
 *
 *   1 PRE_CHECK → 2 BACKUP → 3 SCHEMA_MIGRATION → 4 DATA_MIGRATION → 5 VALIDATION → 6 SWITCH → 7 MONITORING
 *   (8 ROLLBACK — only after a FAILED step; otherwise auto-SKIPPED when MONITORING is done)
 *
 * db_operations(type MIGRATION): REQUESTED → APPROVED (plan approved by a DIFFERENT SUPER_ADMIN) → RUNNING (first step)
 * → SUCCEEDED (monitoring done) | FAILED (rolled back / aborted) | CANCELLED.
 * db_operation_steps: each step has a checklist (every item must be ticked for DONE), notes and evidence (CI run URL,
 * backup id … never secrets). SWITCH and ROLLBACK require a second SUPER_ADMIN approval before the next step.
 * SCHEMA_MIGRATION can only be marked DONE when schema_migrations actually contains the target version (the UI records
 * reality, it does not assert it).
 */
import { Errors } from '../../lib/errors';
import { type AdminCtx, adminAudit, inAdminTx, makerChecker, requireRole } from '../admin/common';
import { environmentOf, operationDetail } from './service';

export const STEPS = ['PRE_CHECK', 'BACKUP', 'SCHEMA_MIGRATION', 'DATA_MIGRATION', 'VALIDATION', 'SWITCH', 'MONITORING', 'ROLLBACK'] as const;
export type Step = (typeof STEPS)[number];

export const CHECKLISTS: Record<Step, { key: string; label: string }[]> = {
  PRE_CHECK: [
    { key: 'reviewed_ci_green', label: 'Migrasi sudah direview dan lolos CI (bash db/scripts/test-db.sh)' },
    { key: 'no_checksum_drift', label: 'Tidak ada checksum drift (GET /v1/admin/infra/db/migrations)' },
    { key: 'window_announced', label: 'Jendela maintenance & komunikasi ke tim disetujui' },
    { key: 'rollback_plan', label: 'Rencana rollback (migrasi kompensasi / restore ke branch baru) terdokumentasi' },
  ],
  BACKUP: [
    { key: 'backup_taken', label: 'Backup/branch dibuat tepat sebelum migrasi' },
    { key: 'backup_id_recorded', label: 'ID backup/branch dicatat di evidence' },
  ],
  SCHEMA_MIGRATION: [
    { key: 'ran_from_ci', label: 'db/scripts/migrate.sh dijalankan dari pipeline CI (bukan dari admin UI)' },
    { key: 'verify_passed', label: 'migrate.sh --verify lulus' },
  ],
  DATA_MIGRATION: [
    { key: 'backfill_done', label: 'Backfill/data job selesai (atau tidak diperlukan)' },
    { key: 'row_counts_checked', label: 'Jumlah baris / invarian data diperiksa' },
  ],
  VALIDATION: [
    { key: 'smoke_green', label: 'Smoke test API hijau (GET /v1/health)' },
    { key: 'audit_chain_ok', label: 'verify_audit_chain() OK' },
    { key: 'ledger_ok', label: 'Ledger seimbang, tidak ada error JKL0x' },
  ],
  SWITCH: [
    { key: 'traffic_switched', label: 'Aplikasi/traffic dialihkan ke versi baru' },
    { key: 'flags_enabled', label: 'Feature flag terkait diaktifkan (bila ada)' },
  ],
  MONITORING: [
    { key: 'errors_normal', label: 'Error rate & latensi normal minimal 30 menit' },
    { key: 'no_new_alerts', label: 'Tidak ada alert HIGH/CRITICAL baru (GET /v1/admin/system/alerts)' },
  ],
  ROLLBACK: [
    { key: 'compensation_applied', label: 'Migrasi kompensasi atau restore ke branch baru dijalankan' },
    { key: 'app_reverted', label: 'Aplikasi kembali ke versi sebelumnya dan sehat' },
    { key: 'incident_logged', label: 'Insiden dicatat (penyebab, dampak, tindak lanjut)' },
  ],
};

const NEEDS_APPROVAL: ReadonlySet<Step> = new Set<Step>(['SWITCH', 'ROLLBACK']);

function requireOperator(ctx: AdminCtx) {
  requireRole(ctx.auth, 'SUPER_ADMIN', 'Aksi DB & Infra hanya untuk SUPER_ADMIN dengan izin infra.db.operate');
}

export async function startWorkflow(ctx: AdminCtx, input: { targetVersion: string; description: string; reason: string; ciRunUrl?: string | undefined }) {
  requireOperator(ctx);
  const id = await inAdminTx(ctx, async (tx) => {
    const [open] = await tx<{ id: string }[]>`SELECT id FROM db_operations WHERE type = 'MIGRATION' AND status IN ('REQUESTED','APPROVED','RUNNING')`;
    if (open) throw Errors.conflict('MIGRATION_WORKFLOW_OPEN', 'Masih ada workflow migrasi yang berjalan', { operationId: open.id });
    const [op] = await tx<{ id: string }[]>`
      INSERT INTO db_operations (type, status, environment, provider, requested_by, reason, params)
      VALUES ('MIGRATION', 'REQUESTED', ${environmentOf(ctx.deps.env)}, ${ctx.deps.providers.dbAdmin.name}, ${ctx.auth.userId}, ${input.reason},
              ${tx.json({ targetVersion: input.targetVersion, description: input.description, ciRunUrl: input.ciRunUrl ?? null, executedBy: 'CI' } as never)})
      RETURNING id`;
    for (const [i, step] of STEPS.entries()) {
      const checklist = CHECKLISTS[step].map((c) => ({ ...c, done: false }));
      await tx`INSERT INTO db_operation_steps (operation_id, step_no, step, checklist, requires_approval)
               VALUES (${op!.id}, ${i + 1}, ${step}, ${tx.json(checklist as never)}, ${NEEDS_APPROVAL.has(step)})`;
    }
    await adminAudit(tx, ctx, { action: 'infra.migration_workflow_started', entityType: 'db_operation', entityId: op!.id, after: { status: 'REQUESTED', targetVersion: input.targetVersion }, meta: { description: input.description, reason: input.reason } });
    return op!.id;
  });
  return operationDetail(ctx, id);
}

interface StepRow {
  id: string;
  step_no: number;
  step: Step;
  status: 'PENDING' | 'DONE' | 'SKIPPED' | 'FAILED';
  checklist: { key: string; label: string; done: boolean }[];
  requires_approval: boolean;
  completed_by: string | null;
  approved_by: string | null;
}

export async function completeStep(
  ctx: AdminCtx,
  operationId: string,
  step: Step,
  input: { outcome: 'DONE' | 'SKIPPED' | 'FAILED'; checklist?: Record<string, boolean> | undefined; notes?: string | undefined; evidence?: Record<string, string> | undefined },
) {
  requireOperator(ctx);
  const now = ctx.deps.clock.now();
  await inAdminTx(ctx, async (tx) => {
    const [op] = await tx<{ id: string; type: string; status: string; params: { targetVersion?: string } }[]>`SELECT id, type, status, params FROM db_operations WHERE id = ${operationId} FOR UPDATE`;
    if (!op || op.type !== 'MIGRATION') throw Errors.notFound('Workflow migrasi', 'MIGRATION_WORKFLOW_NOT_FOUND');
    if (!['APPROVED', 'RUNNING'].includes(op.status)) throw Errors.unprocessable('MIGRATION_WORKFLOW_NOT_ACTIVE', 'Workflow belum disetujui atau sudah selesai', { status: op.status });
    const steps = await tx<StepRow[]>`SELECT * FROM db_operation_steps WHERE operation_id = ${operationId} ORDER BY step_no FOR UPDATE`;
    const cur = steps.find((s) => s.step === step)!;
    if (cur.status !== 'PENDING') throw Errors.unprocessable('STEP_ALREADY_RECORDED', `Langkah ${step} sudah ${cur.status}`);
    const anyFailed = steps.some((s) => s.status === 'FAILED');
    if (step === 'ROLLBACK') {
      if (!anyFailed && input.outcome !== 'SKIPPED') throw Errors.unprocessable('ROLLBACK_NOT_NEEDED', 'Rollback hanya setelah ada langkah FAILED');
    } else {
      if (anyFailed) throw Errors.unprocessable('WORKFLOW_FAILED', 'Ada langkah FAILED; lanjutkan dengan ROLLBACK');
      const blocking = steps.filter((s) => s.step_no < cur.step_no && s.step !== 'ROLLBACK').find((s) => s.status === 'PENDING' || (s.requires_approval && s.status === 'DONE' && !s.approved_by));
      if (blocking) throw Errors.unprocessable('STEP_OUT_OF_ORDER', `Selesaikan${blocking.status === 'DONE' ? ' persetujuan' : ''} langkah ${blocking.step} terlebih dahulu`, { blockingStep: blocking.step });
    }
    const ticks = input.checklist ?? {};
    const checklist = cur.checklist.map((c) => ({ ...c, done: ticks[c.key] === true }));
    if (input.outcome === 'DONE' && checklist.some((c) => !c.done)) {
      throw Errors.unprocessable('CHECKLIST_INCOMPLETE', 'Semua butir checklist wajib dicentang untuk DONE', { missing: checklist.filter((c) => !c.done).map((c) => c.key) });
    }
    if (input.outcome === 'SKIPPED' && ['PRE_CHECK', 'BACKUP', 'SCHEMA_MIGRATION', 'VALIDATION', 'MONITORING'].includes(step)) {
      throw Errors.unprocessable('STEP_NOT_SKIPPABLE', `Langkah ${step} tidak boleh dilewati`);
    }
    if (step === 'SCHEMA_MIGRATION' && input.outcome === 'DONE') {
      const [applied] = await tx`SELECT 1 FROM schema_migrations WHERE version = ${op.params.targetVersion ?? ''}`;
      if (!applied) throw Errors.unprocessable('MIGRATION_NOT_APPLIED', `schema_migrations belum memuat versi ${op.params.targetVersion}; jalankan migrasi dari CI dulu`);
    }
    await tx`UPDATE db_operation_steps SET status = ${input.outcome}, checklist = ${tx.json(checklist as never)}, notes = ${input.notes ?? null},
                    evidence = ${tx.json((input.evidence ?? {}) as never)}, completed_by = ${ctx.auth.userId}, completed_at = ${now}
              WHERE id = ${cur.id}`;
    if (op.status === 'APPROVED') await tx`UPDATE db_operations SET status = 'RUNNING', started_at = ${now} WHERE id = ${operationId}`;
    if (step === 'MONITORING' && input.outcome === 'DONE') {
      await tx`UPDATE db_operation_steps SET status = 'SKIPPED', notes = 'tidak diperlukan', completed_by = ${ctx.auth.userId}, completed_at = ${now}
                WHERE operation_id = ${operationId} AND step = 'ROLLBACK' AND status = 'PENDING'`;
      await tx`UPDATE db_operations SET status = 'SUCCEEDED', finished_at = ${now}, result = ${tx.json({ outcome: 'MIGRATED', targetVersion: op.params.targetVersion ?? null } as never)} WHERE id = ${operationId}`;
    }
    if (step === 'ROLLBACK' && input.outcome === 'FAILED') {
      await tx`UPDATE db_operations SET status = 'FAILED', finished_at = ${now}, error = 'rollback failed — manual intervention required' WHERE id = ${operationId}`;
    }
    await adminAudit(tx, ctx, { action: 'infra.migration_step_recorded', entityType: 'db_operation', entityId: operationId, after: { step, outcome: input.outcome }, meta: { notes: input.notes ?? null, evidence: input.evidence ?? {} } });
  });
  return operationDetail(ctx, operationId);
}

export async function approveStep(ctx: AdminCtx, operationId: string, step: Step) {
  requireOperator(ctx);
  const now = ctx.deps.clock.now();
  await inAdminTx(ctx, async (tx) => {
    const [s] = await tx<StepRow[]>`SELECT * FROM db_operation_steps WHERE operation_id = ${operationId} AND step = ${step} FOR UPDATE`;
    if (!s) throw Errors.notFound('Langkah workflow', 'MIGRATION_STEP_NOT_FOUND');
    if (!s.requires_approval) throw Errors.unprocessable('STEP_APPROVAL_NOT_REQUIRED', `Langkah ${step} tidak memerlukan persetujuan`);
    if (s.status !== 'DONE' || s.approved_by) throw Errors.unprocessable('STEP_NOT_AWAITING_APPROVAL', 'Langkah belum selesai atau sudah disetujui');
    makerChecker(s.completed_by, ctx.auth.userId, 'Persetujuan langkah harus oleh SUPER_ADMIN lain (maker-checker)');
    await tx`UPDATE db_operation_steps SET approved_by = ${ctx.auth.userId}, approved_at = ${now} WHERE id = ${s.id}`;
    if (step === 'ROLLBACK') await tx`UPDATE db_operations SET status = 'FAILED', finished_at = ${now}, error = 'rolled back' WHERE id = ${operationId}`;
    await adminAudit(tx, ctx, { action: 'infra.migration_step_approved', entityType: 'db_operation', entityId: operationId, after: { step, approvedBy: ctx.auth.userId } });
  });
  return operationDetail(ctx, operationId);
}
