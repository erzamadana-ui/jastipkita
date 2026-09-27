import { createRoute, z } from '@hono/zod-openapi';
import type { App } from '../../context';
import { bearer, createRouter, errorResponses, jsonContent } from '../../lib/openapi';
import { getAuth, requireAuth } from '../../middleware/auth';
import { TimelineSchema, TransactionDetailSchema, TransactionListSchema, TxIdParam } from './schemas';
import { getTimeline, getTransactionDetail, listTransactions } from './service';

export function registerTransactionRoutes(app: App) {
  const r = createRouter();

  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/transactions',
      tags: ['Transactions'],
      summary: 'List my transactions (as buyer and/or traveler)',
      security: bearer,
      middleware: [requireAuth] as const,
      request: {
        query: z.object({
          role: z.enum(['buyer', 'traveler']).optional(),
          status: z.string().max(400).optional().openapi({ description: 'Comma-separated statuses', example: 'PAYMENT_SECURED,PURCHASE_APPROVED' }),
          limit: z.coerce.number().int().min(1).max(100).default(20),
          cursor: z.string().max(500).optional(),
        }),
      },
      responses: { 200: jsonContent(TransactionListSchema), ...errorResponses },
    }),
    async (c) => {
      const q = c.req.valid('query');
      return c.json(await listTransactions(c.get('deps'), getAuth(c), q), 200);
    },
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/transactions/{id}',
      tags: ['Transactions'],
      summary: 'Transaction detail: quote lines, payments, price confirmations, proof, delivery, purchaseGate, allowedActions',
      security: bearer,
      middleware: [requireAuth] as const,
      request: { params: TxIdParam },
      responses: { 200: jsonContent(TransactionDetailSchema), ...errorResponses },
    }),
    async (c) => c.json(await getTransactionDetail(c.get('deps'), getAuth(c), c.req.valid('param').id), 200),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/transactions/{id}/timeline',
      tags: ['Transactions'],
      summary: 'Status timeline (transaction_events)',
      security: bearer,
      middleware: [requireAuth] as const,
      request: { params: TxIdParam },
      responses: { 200: jsonContent(TimelineSchema), ...errorResponses },
    }),
    async (c) => c.json(await getTimeline(c.get('deps'), getAuth(c), c.req.valid('param').id), 200),
  );

  app.route('/', r);
}
