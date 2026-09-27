import { createRoute, z } from '@hono/zod-openapi';
import type { App } from '../../context';
import { bearer, createRouter, errorResponses, jsonBody, jsonContent } from '../../lib/openapi';
import { getAuth, requireAuth } from '../../middleware/auth';
import { requireIdempotency } from '../../middleware/idempotency';
import { loadTx } from '../transactions/common';
import { LooseResult, TxIdParam, IdemHeader } from '../transactions/schemas';
import { cancelTransaction } from './service';

const CancelBody = z
  .object({
    reason: z.string().min(3).max(1000),
    cause: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/).optional().openapi({ description: 'Matrix cause code (e.g. PRICE_CHANGE_REJECTED via the price-confirmation flow)' }),
  })
  .openapi('CancelRequest');

export function registerCancellationRoutes(app: App) {
  const r = createRouter();
  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/transactions/{id}/cancel',
      tags: ['Cancellation'],
      summary: 'Cancel per cancellation matrix (💰). Not allowed → 422 with reason (e.g. use Dispute Center)',
      security: bearer,
      middleware: [requireAuth, requireIdempotency] as const,
      request: { params: TxIdParam, headers: IdemHeader, ...jsonBody(CancelBody) },
      responses: { 200: jsonContent(LooseResult), ...errorResponses },
    }),
    async (c) => {
      const deps = c.get('deps');
      const id = c.req.valid('param').id;
      const out = await cancelTransaction(deps, getAuth(c), id, c.req.valid('json'));
      const fresh = await loadTx(deps.sql, id);
      return c.json({ ...out, status: fresh?.status ?? out.status }, 200);
    },
  );
  app.route('/', r);
}
