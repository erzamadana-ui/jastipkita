import { createRoute, z } from '@hono/zod-openapi';
import type { App } from '../../../context';
import { bearer, createRouter, errorResponses, jsonBody, jsonContent } from '../../../lib/openapi';
import { AdminIdemHeader, AdminLoose, AdminPage, adminCtx, adminGuard, IdParam, PageQuery, StatusCsvQuery } from '../common';
import * as svc from './service';

const tags = ['Admin · Disputes'];

const ResolveBody = z
  .object({
    resolution: z.enum(['REFUND_FULL', 'REFUND_PARTIAL', 'NO_REFUND', 'RETURN_AND_REFUND', 'OTHER']),
    amountIdr: z.number().int().positive().optional().openapi({ description: 'Required for REFUND_PARTIAL (< escrow held). REFUND_FULL / RETURN_AND_REFUND refund everything still held.' }),
    note: z.string().trim().min(10).max(2000),
    releaseBeforeDelivery: z.boolean().optional().openapi({ description: 'Confirms a NO_REFUND/OTHER resolution on a dispute opened BEFORE delivery (releases escrow to the traveler)' }),
  })
  .openapi('AdminDisputeResolve');

export function registerAdminDisputes(app: App) {
  const r = createRouter();
  r.openapi(
    createRoute({
      method: 'get', path: '/v1/admin/disputes', tags, security: bearer,
      summary: 'Dispute queue with SLA state (ON_TRACK / DUE_SOON / BREACHED)',
      middleware: adminGuard(['disputes.manage']),
      request: {
        query: PageQuery.extend({
          status: StatusCsvQuery,
          assignee: z.string().max(40).optional().openapi({ description: '"me", "none" or an admin user id' }),
          sla: z.enum(['BREACHED', 'DUE_SOON']).optional(),
        }),
      },
      responses: { 200: jsonContent(AdminPage), ...errorResponses },
    }),
    async (c) => c.json(await svc.disputeQueue(await adminCtx(c), c.req.valid('query')), 200),
  );
  r.openapi(
    createRoute({
      method: 'get', path: '/v1/admin/disputes/{id}', tags, security: bearer,
      summary: 'Dispute detail: evidence, timeline, escrow held, refunds, linked conversation, allowed actions',
      middleware: adminGuard(['disputes.manage']),
      request: { params: IdParam },
      responses: { 200: jsonContent(AdminLoose), ...errorResponses },
    }),
    async (c) => c.json(await svc.disputeDetail(await adminCtx(c), c.req.valid('param').id), 200),
  );
  r.openapi(
    createRoute({
      method: 'post', path: '/v1/admin/disputes/{id}/assign', tags, security: bearer,
      summary: 'Assign (default: me). Assignee must hold disputes.manage',
      middleware: adminGuard(['disputes.manage']),
      request: { params: IdParam, ...jsonBody(z.object({ assigneeId: z.string().uuid().optional() })) },
      responses: { 200: jsonContent(AdminLoose), ...errorResponses },
    }),
    async (c) => c.json(await svc.assignDispute(await adminCtx(c), c.req.valid('param').id, c.req.valid('json').assigneeId), 200),
  );
  r.openapi(
    createRoute({
      method: 'post', path: '/v1/admin/disputes/{id}/request-evidence', tags, security: bearer,
      summary: 'Request (more) evidence → EVIDENCE_COLLECTION with a new deadline',
      middleware: adminGuard(['disputes.manage']),
      request: { params: IdParam, ...jsonBody(z.object({ note: z.string().trim().min(5).max(2000), dueHours: z.number().int().min(1).max(240).default(48) })) },
      responses: { 200: jsonContent(AdminLoose), ...errorResponses },
    }),
    async (c) => c.json(await svc.requestEvidence(await adminCtx(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );
  r.openapi(
    createRoute({
      method: 'post', path: '/v1/admin/disputes/{id}/review', tags, security: bearer,
      summary: 'Move to UNDER_REVIEW (from OPEN, EVIDENCE_COLLECTION after the window, or APPEALED)',
      middleware: adminGuard(['disputes.manage']),
      request: { params: IdParam, ...jsonBody(z.object({ closeEvidenceWindow: z.boolean().optional(), note: z.string().trim().max(1000).optional() })) },
      responses: { 200: jsonContent(AdminLoose), ...errorResponses },
    }),
    async (c) => c.json(await svc.startReview(await adminCtx(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );
  r.openapi(
    createRoute({
      method: 'post', path: '/v1/admin/disputes/{id}/resolve', tags, security: bearer,
      summary: 'Resolve → refund via money requestRefund (REFUND_PENDING) or BUYER_CONFIRMED; dispute.resolved',
      middleware: adminGuard(['disputes.manage'], { mfa: true, idempotent: true }),
      request: { params: IdParam, headers: AdminIdemHeader, ...jsonBody(ResolveBody) },
      responses: { 200: jsonContent(AdminLoose), ...errorResponses },
    }),
    async (c) => c.json(await svc.resolveDispute(await adminCtx(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );
  r.openapi(
    createRoute({
      method: 'post', path: '/v1/admin/disputes/{id}/close', tags, security: bearer,
      summary: 'Close (RESOLVED after the appeal window/execution, or OPEN/EVIDENCE_COLLECTION as invalid)',
      middleware: adminGuard(['disputes.manage']),
      request: { params: IdParam, ...jsonBody(z.object({ note: z.string().trim().min(5).max(1000) })) },
      responses: { 200: jsonContent(AdminLoose), ...errorResponses },
    }),
    async (c) => c.json(await svc.closeDispute(await adminCtx(c), c.req.valid('param').id, c.req.valid('json').note), 200),
  );
  app.route('/', r);
}
