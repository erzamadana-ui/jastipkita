import { createRoute, z } from '@hono/zod-openapi';
import type { App } from '../../../context';
import { bearer, createRouter, errorResponses, IdempotencyHeader, jsonBody, jsonContent } from '../../../lib/openapi';
import { AdminLoose, AdminPage, adminCtx, adminGuard, IdParam, PageQuery, StatusCsvQuery } from '../common';
import * as svc from './service';

const tags = ['Admin · Transactions'];
const DateQ = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional();

const CancelBody = z
  .object({
    reason: z.string().trim().min(5).max(1000),
    cause: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/).optional().openapi({ description: 'Cancellation-matrix cause code' }),
    approvalNote: z.string().trim().min(10).max(1000).openapi({ description: 'Recorded admin approval (why the override is justified)' }),
  })
  .openapi('AdminTransactionCancel');
const RefundBody = z
  .object({
    amountIdr: z.number().int().positive(),
    reason: z.string().trim().min(5).max(1000),
    remainderTo: z.enum(['TRAVELER', 'NONE']).openapi({ description: 'TRAVELER: partial refund, the rest is released to the traveler (→ COMPLETED); NONE: → REFUNDED' }),
  })
  .openapi('AdminTransactionRefund');

export function registerAdminTransactions(app: App) {
  const r = createRouter();
  r.openapi(
    createRoute({
      method: 'get', path: '/v1/admin/transactions', tags, security: bearer,
      summary: 'List / filter / search by number (JK-… prefix)',
      middleware: adminGuard(['transactions.read']),
      request: {
        query: PageQuery.extend({
          status: StatusCsvQuery,
          q: z.string().max(40).optional().openapi({ description: 'Transaction number (prefix)' }),
          buyerId: z.string().uuid().optional(),
          travelerId: z.string().uuid().optional(),
          from: DateQ,
          to: DateQ,
        }),
      },
      responses: { 200: jsonContent(AdminPage), ...errorResponses },
    }),
    async (c) => c.json(await svc.listTransactions(await adminCtx(c), c.req.valid('query')), 200),
  );
  r.openapi(
    createRoute({
      method: 'get', path: '/v1/admin/transactions/{id}', tags, security: bearer,
      summary: 'Full detail incl. quote lines, payments, refunds, payouts, ledger journals & entries, escrow, events, disputes',
      middleware: adminGuard(['transactions.read']),
      request: { params: IdParam },
      responses: { 200: jsonContent(AdminLoose), ...errorResponses },
    }),
    async (c) => c.json(await svc.transactionDetail(await adminCtx(c), c.req.valid('param').id), 200),
  );
  r.openapi(
    createRoute({
      method: 'post', path: '/v1/admin/transactions/{id}/cancel', tags, security: bearer,
      summary: 'Admin cancel / refund-pending override through the cancellation matrix (actor ADMIN, approval recorded)',
      middleware: adminGuard(['transactions.override'], { mfa: true, idempotent: true }),
      request: { params: IdParam, headers: IdempotencyHeader, ...jsonBody(CancelBody) },
      responses: { 200: jsonContent(AdminLoose), ...errorResponses },
    }),
    async (c) => c.json(await svc.adminCancel(await adminCtx(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );
  r.openapi(
    createRoute({
      method: 'post', path: '/v1/admin/transactions/{id}/refund', tags, security: bearer,
      summary: 'Admin refund (money requestRefund, reason ADMIN) → REFUND_PENDING; above auto-approve → maker-checker',
      middleware: adminGuard(['transactions.override', 'refunds.request'], { mfa: true, idempotent: true }),
      request: { params: IdParam, headers: IdempotencyHeader, ...jsonBody(RefundBody) },
      responses: { 200: jsonContent(AdminLoose), ...errorResponses },
    }),
    async (c) => c.json(await svc.adminRefund(await adminCtx(c), c.req.valid('param').id, c.req.valid('json'), c.req.valid('header')['idempotency-key']), 200),
  );
  app.route('/', r);
}
