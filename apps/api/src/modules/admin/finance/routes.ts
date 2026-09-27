import { createRoute, z } from '@hono/zod-openapi';
import type { App } from '../../../context';
import { bearer, createRouter, errorResponses, IdempotencyHeader, jsonBody, jsonContent } from '../../../lib/openapi';
import { AdminLoose, AdminPage, adminCtx, adminGuard, IdParam, PageQuery, ReasonBody, StatusCsvQuery } from '../common';
import * as svc from './service';

const refundTags = ['Admin · Refunds'];
const payoutTags = ['Admin · Payouts'];
const NoteBody = z.object({ note: z.string().trim().min(5).max(1000) });

export function registerAdminFinance(app: App) {
  const r = createRouter();
  r.openapi(
    createRoute({
      method: 'get', path: '/v1/admin/refunds', tags: refundTags, security: bearer,
      summary: 'Refund approval queue (default PENDING_APPROVAL); `canApprove` = false for the requester',
      middleware: adminGuard(['refunds.approve']),
      request: { query: PageQuery.extend({ status: StatusCsvQuery }) },
      responses: { 200: jsonContent(AdminPage), ...errorResponses },
    }),
    async (c) => c.json(await svc.listRefunds(await adminCtx(c), c.req.valid('query')), 200),
  );
  r.openapi(
    createRoute({
      method: 'post', path: '/v1/admin/refunds/{id}/approve', tags: refundTags, security: bearer,
      summary: 'Approve (maker-checker: approver ≠ requester) → money approveRefund + processor',
      middleware: adminGuard(['refunds.approve'], { mfa: true, idempotent: true }),
      request: { params: IdParam, headers: IdempotencyHeader },
      responses: { 200: jsonContent(AdminLoose), ...errorResponses },
    }),
    async (c) => c.json(await svc.approveRefundAdmin(await adminCtx(c), c.req.valid('param').id), 200),
  );
  r.openapi(
    createRoute({
      method: 'post', path: '/v1/admin/refunds/{id}/reject', tags: refundTags, security: bearer,
      summary: 'Reject (reason) → money rejectRefund (allocation journal reversed)',
      middleware: adminGuard(['refunds.approve'], { mfa: true, idempotent: true }),
      request: { params: IdParam, headers: IdempotencyHeader, ...jsonBody(ReasonBody) },
      responses: { 200: jsonContent(AdminLoose), ...errorResponses },
    }),
    async (c) => c.json(await svc.rejectRefundAdmin(await adminCtx(c), c.req.valid('param').id, c.req.valid('json').reason), 200),
  );
  r.openapi(
    createRoute({
      method: 'get', path: '/v1/admin/payouts', tags: payoutTags, security: bearer,
      summary: 'Payouts (masked destination, SANDBOX flag, hold bookkeeping)',
      middleware: adminGuard(['payouts.manage']),
      request: { query: PageQuery.extend({ status: StatusCsvQuery, travelerId: z.string().uuid().optional() }) },
      responses: { 200: jsonContent(AdminPage), ...errorResponses },
    }),
    async (c) => c.json(await svc.listPayouts(await adminCtx(c), c.req.valid('query')), 200),
  );
  r.openapi(
    createRoute({
      method: 'post', path: '/v1/admin/payouts/{id}/hold', tags: payoutTags, security: bearer,
      summary: 'Hold (SCHEDULED/FAILED → ON_HOLD, reason; holder recorded)',
      middleware: adminGuard(['payouts.manage'], { mfa: true, idempotent: true }),
      request: { params: IdParam, headers: IdempotencyHeader, ...jsonBody(ReasonBody) },
      responses: { 200: jsonContent(AdminLoose), ...errorResponses },
    }),
    async (c) => c.json(await svc.holdPayout(await adminCtx(c), c.req.valid('param').id, c.req.valid('json').reason), 200),
  );
  r.openapi(
    createRoute({
      method: 'post', path: '/v1/admin/payouts/{id}/release', tags: payoutTags, security: bearer,
      summary: 'Release hold (ON_HOLD → SCHEDULED, approver ≠ holder; clears the transaction payout hold)',
      middleware: adminGuard(['payouts.manage'], { mfa: true, idempotent: true }),
      request: { params: IdParam, headers: IdempotencyHeader, ...jsonBody(NoteBody) },
      responses: { 200: jsonContent(AdminLoose), ...errorResponses },
    }),
    async (c) => c.json(await svc.releasePayout(await adminCtx(c), c.req.valid('param').id, c.req.valid('json').note), 200),
  );
  r.openapi(
    createRoute({
      method: 'post', path: '/v1/admin/payouts/{id}/retry', tags: payoutTags, security: bearer,
      summary: 'Retry a FAILED payout (→ SCHEDULED now, system retry budget reset)',
      middleware: adminGuard(['payouts.manage'], { mfa: true, idempotent: true }),
      request: { params: IdParam, headers: IdempotencyHeader, ...jsonBody(NoteBody) },
      responses: { 200: jsonContent(AdminLoose), ...errorResponses },
    }),
    async (c) => c.json(await svc.retryPayout(await adminCtx(c), c.req.valid('param').id, c.req.valid('json').note), 200),
  );
  app.route('/', r);
}
