import { createRoute, z } from '@hono/zod-openapi';
import type { App } from '../../../context';
import { bearer, createRouter, errorResponses, IdempotencyHeader, jsonBody, jsonContent } from '../../../lib/openapi';
import { AdminLoose, AdminPage, adminCtx, adminGuard, IdParam, PageQuery, StatusCsvQuery } from '../common';
import * as svc from './service';

const tags = ['Admin · Reconciliation'];
const NoteBody = z.object({ note: z.string().trim().min(10).max(1000).openapi({ description: 'Apa yang diperiksa/dikoreksi (audit log)' }) });
const ManualRunBody = z.object({
  periodStart: z.string().datetime({ offset: true }),
  periodEnd: z.string().datetime({ offset: true }),
  reason: z.string().trim().min(5).max(1000),
});

export function registerAdminReconciliation(app: App) {
  const r = createRouter();
  r.openapi(
    createRoute({
      method: 'get', path: '/v1/admin/reconciliation/runs', tags, security: bearer,
      summary: 'Reconciliation runs (newest first) with totals and open/resolved difference counts',
      middleware: adminGuard(['finance.reports.read']),
      request: { query: PageQuery.extend({ status: StatusCsvQuery }) },
      responses: { 200: jsonContent(AdminPage), ...errorResponses },
    }),
    async (c) => c.json(await svc.listRuns(await adminCtx(c), c.req.valid('query')), 200),
  );
  r.openapi(
    createRoute({
      method: 'get', path: '/v1/admin/reconciliation/runs/{id}/items', tags, security: bearer,
      summary: 'Items of a run (default: open differences MISMATCH, MISSING_INTERNAL, MISSING_PROVIDER)',
      middleware: adminGuard(['finance.reports.read']),
      request: { params: IdParam, query: PageQuery.extend({ status: StatusCsvQuery }) },
      responses: { 200: jsonContent(AdminPage), ...errorResponses },
    }),
    async (c) => c.json(await svc.listItems(await adminCtx(c), c.req.valid('param').id, c.req.valid('query')), 200),
  );
  r.openapi(
    createRoute({
      method: 'post', path: '/v1/admin/reconciliation/items/{id}/resolve', tags, security: bearer,
      summary: 'Mark an open difference RESOLVED with a note (no money moves; corrections use refund/payout/ledger flows)',
      middleware: adminGuard(['finance.reports.read', 'payouts.manage'], { mfa: true }),
      request: { params: IdParam, ...jsonBody(NoteBody) },
      responses: { 200: jsonContent(AdminLoose), ...errorResponses },
    }),
    async (c) => c.json(await svc.resolveItem(await adminCtx(c), c.req.valid('param').id, c.req.valid('json').note), 200),
  );
  r.openapi(
    createRoute({
      method: 'post', path: '/v1/admin/reconciliation/runs', tags, security: bearer,
      summary: 'Start a manual reconciliation run for a past period (≤ 31 days)',
      middleware: adminGuard(['finance.reports.read', 'payouts.manage'], { mfa: true, idempotent: true }),
      request: { headers: IdempotencyHeader, ...jsonBody(ManualRunBody) },
      responses: { 200: jsonContent(AdminLoose), ...errorResponses },
    }),
    async (c) => c.json(await svc.startManualRun(await adminCtx(c), c.req.valid('json')), 200),
  );
  app.route('/', r);
}
