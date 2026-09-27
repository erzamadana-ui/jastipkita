import { createRoute, z } from '@hono/zod-openapi';
import type { App } from '../../context';
import { bearer, createRouter, errorResponses, IdempotencyHeader, jsonBody, jsonContent } from '../../lib/openapi';
import { getAuth, requireAuth } from '../../middleware/auth';
import { requireIdempotency } from '../../middleware/idempotency';
import { rateLimit } from '../../middleware/rate-limit';
import { LooseResult, TxIdParam } from '../transactions/schemas';
import { clarifyPriceConfirmation, priceCheck, respondPriceConfirmation } from './service';

const PcParams = TxIdParam.extend({ pcId: z.string().uuid().openapi({ param: { name: 'pcId', in: 'path' } }) });

const PriceCheckBody = z
  .object({
    actualUnitPriceMinor: z.number().int().min(0).openapi({ description: 'Actual shelf price per unit, item currency minor units' }),
    currency: z.string().regex(/^[A-Z]{3}$/),
    receiptFileId: z.string().uuid().optional(),
    photoFileId: z.string().uuid().optional(),
    notes: z.string().max(1000).optional(),
  })
  .openapi('PriceCheckRequest');

const RespondBody = z
  .object({ action: z.enum(['APPROVE', 'REJECT', 'CLARIFY']), note: z.string().max(1000).optional() })
  .openapi('PriceConfirmationResponse');

const ClarifyBody = z
  .object({
    note: z.string().min(1).max(1000),
    actualUnitPriceMinor: z.number().int().min(0).optional(),
    receiptFileId: z.string().uuid().optional(),
  })
  .openapi('PriceClarification');

export function registerPriceConfirmationRoutes(app: App) {
  const r = createRouter();

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/transactions/{id}/price-check',
      tags: ['Price confirmation'],
      summary: 'Traveler reports the actual price (within tolerance → PURCHASE_APPROVED, else buyer confirmation)',
      security: bearer,
      middleware: [requireAuth] as const,
      request: { params: TxIdParam, ...jsonBody(PriceCheckBody) },
      responses: { 200: jsonContent(LooseResult), ...errorResponses },
    }),
    async (c) => c.json(await priceCheck(c.get('deps'), getAuth(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/transactions/{id}/price-confirmations/{pcId}/respond',
      tags: ['Price confirmation'],
      summary: 'Buyer approves / rejects (no-fault full refund) / asks for clarification (Idempotency-Key required)',
      security: bearer,
      middleware: [requireAuth, rateLimit({ name: 'money.price_respond', limit: 30, windowSec: 60, key: 'user' }), requireIdempotency] as const,
      request: { params: PcParams, headers: IdempotencyHeader, ...jsonBody(RespondBody) },
      responses: { 200: jsonContent(LooseResult), ...errorResponses },
    }),
    async (c) => {
      const p = c.req.valid('param');
      return c.json(await respondPriceConfirmation(c.get('deps'), getAuth(c), p.id, p.pcId, c.req.valid('json')), 200);
    },
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/transactions/{id}/price-confirmations/{pcId}/clarify',
      tags: ['Price confirmation'],
      summary: 'Traveler answers a clarification request (window resets; price may be revised)',
      security: bearer,
      middleware: [requireAuth] as const,
      request: { params: PcParams, ...jsonBody(ClarifyBody) },
      responses: { 200: jsonContent(LooseResult), ...errorResponses },
    }),
    async (c) => {
      const p = c.req.valid('param');
      return c.json(await clarifyPriceConfirmation(c.get('deps'), getAuth(c), p.id, p.pcId, c.req.valid('json')), 200);
    },
  );

  app.route('/', r);
}
