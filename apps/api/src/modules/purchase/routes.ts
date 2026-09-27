import { createRoute, z } from '@hono/zod-openapi';
import type { App } from '../../context';
import { bearer, createRouter, errorResponses, jsonBody, jsonContent } from '../../lib/openapi';
import { getAuth, requireAuth } from '../../middleware/auth';
import { LooseResult, TxIdParam } from '../transactions/schemas';
import { submitCustomsDeclaration, submitPurchaseProof, updateTravelStatus } from './service';

const ProofBody = z
  .object({
    receiptFileId: z.string().uuid(),
    productPhotoFileIds: z.array(z.string().uuid()).min(1).max(10),
    videoFileId: z.string().uuid().optional(),
    serialNumber: z.string().min(3).max(100).optional(),
    receiptNumber: z.string().max(100).optional(),
    merchantName: z.string().min(2).max(200),
    actualPriceMinor: z.number().int().min(0).openapi({ description: 'Receipt total for all units, item currency minor units' }),
    currency: z.string().regex(/^[A-Z]{3}$/),
    purchasedAt: z.string().datetime({ offset: true }),
  })
  .openapi('PurchaseProofRequest');

const StatusBody = z
  .object({ to: z.enum(['TRAVELING', 'ARRIVED', 'CUSTOMS_PROCESS', 'READY_FOR_HANDOVER']), note: z.string().max(500).optional() })
  .openapi('TravelStatusRequest');

const Idr = z.number().int().min(0).max(1_000_000_000_000);
const CustomsBody = z
  .object({
    dutyPaidIdr: Idr,
    vatPaidIdr: Idr,
    incomeTaxPaidIdr: Idr,
    luxuryTaxPaidIdr: Idr.default(0),
    declarationRef: z.string().max(100).optional(),
    receiptFileId: z.string().uuid().optional(),
    declaredValueMinor: z.number().int().min(0).optional(),
    declaredCurrency: z.string().regex(/^[A-Z]{3}$/).optional(),
    notes: z.string().max(1000).optional(),
  })
  .openapi('CustomsDeclarationRequest');

export function registerPurchaseRoutes(app: App) {
  const r = createRouter();

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/transactions/{id}/purchase-proof',
      tags: ['Purchase'],
      summary: 'Traveler submits purchase proof (only in PURCHASE_APPROVED; price ≤ approved ceiling; fraud checks)',
      security: bearer,
      middleware: [requireAuth] as const,
      request: { params: TxIdParam, ...jsonBody(ProofBody) },
      responses: { 201: jsonContent(LooseResult, 'Proof recorded; transaction PURCHASED'), ...errorResponses },
    }),
    async (c) => c.json(await submitPurchaseProof(c.get('deps'), getAuth(c), c.req.valid('param').id, c.req.valid('json')), 201),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/transactions/{id}/status',
      tags: ['Purchase'],
      summary: 'Traveler travel status (TRAVELING, ARRIVED, CUSTOMS_PROCESS, READY_FOR_HANDOVER) via the FSM',
      security: bearer,
      middleware: [requireAuth] as const,
      request: { params: TxIdParam, ...jsonBody(StatusBody) },
      responses: { 200: jsonContent(LooseResult), ...errorResponses },
    }),
    async (c) => c.json(await updateTravelStatus(c.get('deps'), getAuth(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/transactions/{id}/customs-declaration',
      tags: ['Purchase'],
      summary: 'Traveler records duty/tax actually paid (+ official receipt when > 0)',
      security: bearer,
      middleware: [requireAuth] as const,
      request: { params: TxIdParam, ...jsonBody(CustomsBody) },
      responses: { 200: jsonContent(LooseResult), ...errorResponses },
    }),
    async (c) => c.json(await submitCustomsDeclaration(c.get('deps'), getAuth(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );

  app.route('/', r);
}
