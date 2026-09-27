import { createRoute, z } from '@hono/zod-openapi';
import type { App } from '../../context';
import { bearer, createRouter, errorResponses, IdempotencyHeader, jsonBody, jsonContent } from '../../lib/openapi';
import { getAuth, requireAuth } from '../../middleware/auth';
import { requireIdempotency } from '../../middleware/idempotency';
import { loadTx } from '../transactions/common';
import { LooseResult, TxIdParam } from '../transactions/schemas';
import { cancelTransaction, previewCancellation } from './service';
import { CHARGE_LINE_TYPES } from '@jastipkita/core';

const CancelBody = z
  .object({
    reason: z.string().min(3).max(1000),
    cause: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/).optional().openapi({ description: 'Matrix cause code (e.g. PRICE_CHANGE_REJECTED via the price-confirmation flow)' }),
  })
  .openapi('CancelRequest');

const CauseQuery = z.object({
  cause: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]{2,63}$/)
    .optional()
    .openapi({ description: 'Matrix cause code to evaluate (same as POST /cancel `cause`). Default: PRICE_CHANGE_REJECTED for the buyer during PRICE_CHANGE_PENDING' }),
});

const ByLine = z.object(Object.fromEntries(CHARGE_LINE_TYPES.map((t) => [t, z.number().int()])) as Record<(typeof CHARGE_LINE_TYPES)[number], z.ZodNumber>);

export const CancellationPreviewSchema = z
  .object({
    transactionId: z.string().uuid(),
    status: z.string(),
    actor: z.enum(['BUYER', 'TRAVELER']).openapi({ description: "The caller's role — the actor the matrix is evaluated for" }),
    cause: z.string().nullable(),
    allowed: z.boolean().openapi({ description: 'evaluateCancellation().allowed (matrix)' }),
    stage: z.string().nullable(),
    reasonCode: z.string().nullable(),
    reason: z.string().nullable(),
    paymentCaptured: z.boolean(),
    paidIdr: z.number().int(),
    refundIdr: z.number().int().openapi({ description: 'Cash back to the buyer' }),
    refundByLine: ByLine.openapi({ description: 'Gross refund per charge line (before promo netting)' }),
    retainedByLine: ByLine,
    travelerCompensationIdr: z.number().int(),
    platformRetainedIdr: z.number().int(),
    paymentFeeRetainedIdr: z.number().int(),
    serviceTaxRetainedIdr: z.number().int(),
    customsRetainedIdr: z.number().int(),
    creditRestoredIdr: z.number().int().openapi({ description: 'JastipKita Credit returned to the wallet (not cash)' }),
    discountReversedIdr: z.number().int(),
    trustPenalty: z.number().int(),
    penalizedActor: z.string().nullable(),
    requiresAdminApproval: z.boolean(),
    fsmPermitsActor: z.boolean(),
    transitionPath: z.array(z.string()),
    canCancel: z.boolean().openapi({ description: 'true = POST /cancel with the same cause would succeed now' }),
    blockedBy: z
      .object({ code: z.enum(['CANCELLATION_NOT_ALLOWED', 'ADMIN_APPROVAL_REQUIRED']), message: z.string() })
      .nullable()
      .openapi({ description: 'The 422 POST /cancel would return' }),
  })
  .openapi('CancellationPreview');

export function registerCancellationRoutes(app: App) {
  const r = createRouter();
  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/transactions/{id}/cancel/preview',
      tags: ['Cancellation'],
      summary: 'Preview what cancelling would do for the caller (refund, per-line refund, compensation, trust penalty) — no side effects',
      security: bearer,
      middleware: [requireAuth] as const,
      request: { params: TxIdParam, query: CauseQuery },
      responses: { 200: jsonContent(CancellationPreviewSchema), ...errorResponses },
    }),
    async (c) => c.json(await previewCancellation(c.get('deps'), getAuth(c), c.req.valid('param').id, c.req.valid('query')), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/transactions/{id}/cancel',
      tags: ['Cancellation'],
      summary: 'Cancel per cancellation matrix (Idempotency-Key required). Not allowed → 422 with reason (e.g. use Dispute Center)',
      description: 'Call GET /v1/transactions/{id}/cancel/preview first to show the exact outcome.',
      security: bearer,
      middleware: [requireAuth, requireIdempotency] as const,
      request: { params: TxIdParam, headers: IdempotencyHeader, ...jsonBody(CancelBody) },
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
