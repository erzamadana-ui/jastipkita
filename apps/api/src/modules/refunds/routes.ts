import { createRoute, z } from '@hono/zod-openapi';
import type { App } from '../../context';
import { bearer, createRouter, errorResponses, jsonBody, jsonContent } from '../../lib/openapi';
import { getAuth, requireAuth } from '../../middleware/auth';
import { rateLimit } from '../../middleware/rate-limit';
import { requireParty } from '../transactions/common';
import { LooseResult, TxIdParam } from '../transactions/schemas';
import { refundViews, setRefundDestination } from './service';

const DestinationBody = z
  .object({
    bankCode: z.string().regex(/^[A-Z0-9_]{2,20}$/).openapi({ example: 'BCA' }),
    accountNumber: z.string().min(6).max(30).openapi({ description: 'Stored encrypted; only the mask ****1234 is ever returned' }),
    accountHolderName: z.string().min(2).max(100),
  })
  .openapi('RefundDestinationRequest');

export function registerRefundRoutes(app: App) {
  const r = createRouter();

  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/transactions/{id}/refunds',
      tags: ['Refunds'],
      summary: 'Refunds of a transaction (masked destination; destinationRequired for non-refundable channels)',
      security: bearer,
      middleware: [requireAuth] as const,
      request: { params: TxIdParam },
      responses: { 200: jsonContent(z.object({ data: z.array(z.looseObject({ id: z.string(), status: z.string(), amountIdr: z.number().int() })) })), ...errorResponses },
    }),
    async (c) => {
      const deps = c.get('deps');
      const { tx } = await requireParty(deps.sql, c.req.valid('param').id, getAuth(c));
      return c.json({ data: await refundViews(deps.sql, tx.id) }, 200);
    },
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/refunds/{id}/destination',
      tags: ['Refunds'],
      summary: 'Buyer bank account for a refund on a channel that cannot be refunded (e.g. Virtual Account)',
      security: bearer,
      middleware: [requireAuth, rateLimit({ name: 'money.refund_destination', limit: 10, windowSec: 3600, key: 'user' })] as const,
      request: { params: TxIdParam, ...jsonBody(DestinationBody) },
      responses: { 200: jsonContent(LooseResult), ...errorResponses },
    }),
    async (c) => {
      const deps = c.get('deps');
      const out = await setRefundDestination(deps, getAuth(c), c.req.valid('param').id, c.req.valid('json'));
      return c.json(out, 200);
    },
  );

  app.route('/', r);
}

