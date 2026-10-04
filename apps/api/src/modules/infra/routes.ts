import { createRoute, z } from '@hono/zod-openapi';
import type { App } from '../../context';
import { bearer, createRouter, errorResponses, jsonBody, jsonContent } from '../../lib/openapi';
import { rateLimit } from '../../middleware/rate-limit';
import { AdminLoose, AdminPage, adminCtx, adminGuard, IdParam, ReasonBody } from '../admin/common';
import { verifyAuditCheckpoints } from './audit-checkpoints';
import { workerHeartbeat } from './heartbeat';
import * as svc from './service';
import { STEPS, approveStep, completeStep, startWorkflow } from './workflow';

const tags = ['Admin · DB & Infra Center'];
const READ = adminGuard(['infra.db.read']);
const OPERATE = adminGuard(['infra.db.read', 'infra.db.operate'], { mfa: true });
const WorkerHeartbeat = z
  .object({
    status: z.enum(['ok', 'stale']),
    lastScheduledJobAt: z.string().nullable(),
    ageSec: z.number().int().nullable(),
    staleAfterSec: z.number().int(),
    checkedAt: z.string(),
  })
  .openapi('WorkerHeartbeat');
const StepParam = IdParam.extend({ step: z.enum(STEPS).openapi({ param: { name: 'step', in: 'path' } }) });

export function registerInfra(app: App) {
  const r = createRouter();
  r.openapi(
    createRoute({
      method: 'get', path: '/v1/health/worker', tags: ['System'],
      summary: 'Public worker heartbeat for uptime checkers: age of the last finished scheduled job; 503 when older than 3 cron intervals (no sensitive data)',
      middleware: [rateLimit({ name: 'health.worker', limit: 60, windowSec: 60, key: 'ip' })] as const,
      responses: { 200: jsonContent(WorkerHeartbeat, 'Worker ran recently'), 503: jsonContent(WorkerHeartbeat, 'Worker stale — Cron Trigger / worker loop not running') },
    }),
    async (c) => {
      const hb = await workerHeartbeat(c.get('deps'));
      c.header('cache-control', 'no-store');
      return hb.status === 'ok' ? c.json(hb, 200) : c.json(hb, 503);
    },
  );
  r.openapi(
    createRoute({ method: 'get', path: '/v1/admin/infra/db/health', tags, security: bearer, summary: 'Version, size, connections, cache hit ratio, long-running queries, replication (host masked; never credentials)', middleware: READ, responses: { 200: jsonContent(AdminLoose), ...errorResponses } }),
    async (c) => c.json((await svc.dbHealth(await adminCtx(c))) as unknown as Record<string, never>, 200),
  );
  r.openapi(
    createRoute({ method: 'get', path: '/v1/admin/infra/db/provider', tags, security: bearer, summary: 'DB admin provider, capabilities and info (generic → backups managed outside the app)', middleware: READ, responses: { 200: jsonContent(AdminLoose), ...errorResponses } }),
    async (c) => c.json((await svc.providerInfo(await adminCtx(c))) as unknown as Record<string, never>, 200),
  );
  r.openapi(
    createRoute({ method: 'get', path: '/v1/admin/infra/db/migrations', tags, security: bearer, summary: 'Schema version + migrations with checksums vs the build manifest (APPLIED / PENDING / CHECKSUM_DRIFT / UNKNOWN_IN_BUILD)', middleware: READ, responses: { 200: jsonContent(AdminLoose), ...errorResponses } }),
    async (c) => c.json((await svc.migrationStatus(await adminCtx(c))) as unknown as Record<string, never>, 200),
  );
  r.openapi(
    createRoute({ method: 'get', path: '/v1/admin/infra/db/storage', tags, security: bearer, summary: 'Largest tables (total/table/index bytes, estimated rows)', middleware: READ, request: { query: z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }) }, responses: { 200: jsonContent(AdminLoose), ...errorResponses } }),
    async (c) => c.json(await svc.storageUsage(await adminCtx(c), c.req.valid('query').limit), 200),
  );
  r.openapi(
    createRoute({ method: 'post', path: '/v1/admin/infra/db/connection-test', tags, security: bearer, summary: 'Connection test (3 × SELECT 1) — recorded as db_operations CONNECTION_TEST', middleware: READ, responses: { 200: jsonContent(AdminLoose), ...errorResponses } }),
    async (c) => c.json(await svc.connectionTest(await adminCtx(c)), 200),
  );
  r.openapi(
    createRoute({
      method: 'get', path: '/v1/admin/infra/audit/checkpoints/verify', tags, security: bearer,
      summary: 'Read-only: recompute the audit hash chain since the latest daily checkpoint and compare with the checkpoint row and its WORM storage object → OK / BROKEN / NO_CHECKPOINT (+ findings, last 10 checkpoints)',
      middleware: READ, responses: { 200: jsonContent(AdminLoose), ...errorResponses },
    }),
    async (c) => c.json((await verifyAuditCheckpoints((await adminCtx(c)).deps)) as unknown as Record<string, never>, 200),
  );
  r.openapi(
    createRoute({ method: 'get', path: '/v1/admin/infra/db/backups', tags, security: bearer, summary: 'Backups (provider) + backup/restore operations', middleware: READ, responses: { 200: jsonContent(AdminLoose), ...errorResponses } }),
    async (c) => c.json((await svc.listBackups(await adminCtx(c))) as unknown as Record<string, never>, 200),
  );
  r.openapi(
    createRoute({ method: 'post', path: '/v1/admin/infra/db/backups', tags, security: bearer, summary: 'Create a backup via the provider (SUPER_ADMIN + infra.db.operate + MFA; generic → 422 managed outside the app)', middleware: OPERATE, request: jsonBody(z.object({ label: z.string().trim().min(3).max(60), reason: z.string().trim().min(5).max(500) })), responses: { 201: jsonContent(AdminLoose, 'Created'), ...errorResponses } }),
    async (c) => c.json(await svc.createBackup(await adminCtx(c), c.req.valid('json')), 201),
  );
  r.openapi(
    createRoute({ method: 'post', path: '/v1/admin/infra/db/restores', tags, security: bearer, summary: 'Request restore-to-NEW branch/database (backupId and/or pointInTime); runs after a second SUPER_ADMIN approves', middleware: OPERATE, request: jsonBody(z.object({ backupId: z.string().max(100).optional(), pointInTime: z.string().datetime({ offset: true }).optional(), label: z.string().trim().min(3).max(60), reason: z.string().trim().min(10).max(1000) })), responses: { 201: jsonContent(AdminLoose, 'Requested'), ...errorResponses } }),
    async (c) => c.json(await svc.requestRestore(await adminCtx(c), c.req.valid('json')), 201),
  );
  r.openapi(
    createRoute({ method: 'post', path: '/v1/admin/infra/db/exports', tags, security: bearer, summary: 'Anonymized analytics export (daily aggregates only) → EXPORT file in storage via a worker job', middleware: OPERATE, request: jsonBody(z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), reason: z.string().trim().min(5).max(500) })), responses: { 202: jsonContent(AdminLoose, 'Accepted'), ...errorResponses } }),
    async (c) => c.json(await svc.requestExport(await adminCtx(c), c.req.valid('json')), 202),
  );
  r.openapi(
    createRoute({ method: 'get', path: '/v1/admin/infra/db/operations', tags, security: bearer, summary: 'db_operations log', middleware: READ, request: { query: z.object({ type: z.enum(['BACKUP', 'RESTORE', 'RESTORE_TEST', 'EXPORT', 'IMPORT', 'MIGRATION', 'CONNECTION_TEST', 'SWITCH', 'ROLLBACK']).optional(), status: z.enum(['REQUESTED', 'APPROVED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED']).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }) }, responses: { 200: jsonContent(AdminPage), ...errorResponses } }),
    async (c) => c.json(await svc.listOperations(await adminCtx(c), c.req.valid('query')), 200),
  );
  r.openapi(
    createRoute({ method: 'get', path: '/v1/admin/infra/db/operations/{id}', tags, security: bearer, summary: 'Operation detail (+ 8 workflow steps for MIGRATION)', middleware: READ, request: { params: IdParam }, responses: { 200: jsonContent(AdminLoose), ...errorResponses } }),
    async (c) => c.json(await svc.operationDetail(await adminCtx(c), c.req.valid('param').id), 200),
  );
  r.openapi(
    createRoute({ method: 'post', path: '/v1/admin/infra/db/operations/{id}/approve', tags, security: bearer, summary: 'Approve (different SUPER_ADMIN). RESTORE executes restore-to-new; MIGRATION plan → APPROVED', middleware: OPERATE, request: { params: IdParam, ...jsonBody(z.object({ note: z.string().trim().max(1000).optional() })) }, responses: { 200: jsonContent(AdminLoose), ...errorResponses } }),
    async (c) => c.json(await svc.approveOperation(await adminCtx(c), c.req.valid('param').id, c.req.valid('json').note), 200),
  );
  r.openapi(
    createRoute({ method: 'post', path: '/v1/admin/infra/db/operations/{id}/cancel', tags, security: bearer, summary: 'Cancel a REQUESTED/APPROVED operation', middleware: OPERATE, request: { params: IdParam, ...jsonBody(ReasonBody) }, responses: { 200: jsonContent(AdminLoose), ...errorResponses } }),
    async (c) => c.json(await svc.cancelOperation(await adminCtx(c), c.req.valid('param').id, c.req.valid('json').reason), 200),
  );
  r.openapi(
    createRoute({ method: 'post', path: '/v1/admin/infra/db/migration-workflows', tags, security: bearer, summary: 'Start a migration workflow record (8 steps; DDL runs from CI, never from here)', middleware: OPERATE, request: jsonBody(z.object({ targetVersion: z.string().regex(/^\d{4}$/), description: z.string().trim().min(5).max(1000), reason: z.string().trim().min(5).max(1000), ciRunUrl: z.string().url().max(500).optional() }).openapi('AdminMigrationWorkflowStart')), responses: { 201: jsonContent(AdminLoose, 'Started'), ...errorResponses } }),
    async (c) => c.json(await startWorkflow(await adminCtx(c), c.req.valid('json')), 201),
  );
  r.openapi(
    createRoute({
      method: 'post', path: '/v1/admin/infra/db/migration-workflows/{id}/steps/{step}', tags, security: bearer,
      summary: 'Record a step outcome (DONE needs every checklist item; order enforced; SCHEMA_MIGRATION DONE requires the version in schema_migrations)',
      middleware: OPERATE,
      request: { params: StepParam, ...jsonBody(z.object({ outcome: z.enum(['DONE', 'SKIPPED', 'FAILED']), checklist: z.record(z.string(), z.boolean()).optional(), notes: z.string().trim().max(4000).optional(), evidence: z.record(z.string(), z.string().max(500)).optional().openapi({ description: 'Links/ids only (CI run URL, backup id) — never secrets' }) }).openapi('AdminMigrationStepRecord')) },
      responses: { 200: jsonContent(AdminLoose), ...errorResponses },
    }),
    async (c) => {
      const p = c.req.valid('param');
      return c.json(await completeStep(await adminCtx(c), p.id, p.step, c.req.valid('json')), 200);
    },
  );
  r.openapi(
    createRoute({ method: 'post', path: '/v1/admin/infra/db/migration-workflows/{id}/steps/{step}/approve', tags, security: bearer, summary: 'Approve a SWITCH / ROLLBACK step (SUPER_ADMIN ≠ the one who recorded it)', middleware: OPERATE, request: { params: StepParam }, responses: { 200: jsonContent(AdminLoose), ...errorResponses } }),
    async (c) => {
      const p = c.req.valid('param');
      return c.json(await approveStep(await adminCtx(c), p.id, p.step), 200);
    },
  );
  app.route('/', r);
}
