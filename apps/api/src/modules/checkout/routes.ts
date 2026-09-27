import { createRoute, z } from '@hono/zod-openapi';
import type { App } from '../../context';
import { bearer, createRouter, errorResponses, IdempotencyHeader, jsonBody, jsonContent } from '../../lib/openapi';
import { getAuth, requireAuth, requireKycLevel } from '../../middleware/auth';
import { requireIdempotency } from '../../middleware/idempotency';
import { rateLimit } from '../../middleware/rate-limit';
import { paymentsForTx, paymentView } from '../payments/repository';
import { requireParty } from '../transactions/common';
import { PaymentSchema, QuoteSchema, TxIdParam } from '../transactions/schemas';
import { checkout, createQuote } from './service';

const QuoteBody = z
  .object({
    channel: z.enum(['VA', 'QRIS', 'EWALLET', 'CARD']).optional().openapi({ description: 'Payment channel group; fee is computed for it' }),
    promoCode: z.string().regex(/^[A-Za-z0-9_-]{3,32}$/).optional(),
    useCredit: z.boolean().optional().openapi({ description: 'Apply JastipKita Credit (non-withdrawable, expiry-aware)' }),
  })
  .openapi('QuoteRequest');

const CheckoutBody = z
  .object({
    quoteId: z.string().uuid(),
    channel: z.enum(['VA', 'QRIS', 'EWALLET', 'CARD']).optional(),
    acknowledgeRestricted: z.boolean().optional().openapi({ description: 'Required when the quote restricted classification is not ALLOWED' }),
  })
  .openapi('CheckoutRequest');

const CheckoutResult = z
  .looseObject({
    paymentId: z.string().uuid(),
    checkoutUrl: z.string().nullable(),
    expiresAt: z.string().nullable(),
    amountIdr: z.number().int(),
    provider: z.enum(['XENDIT', 'MOCK']),
    providerEnv: z.enum(['TEST', 'LIVE']),
    sandbox: z.boolean(),
    transactionStatus: z.string(),
  })
  .openapi('CheckoutResult');

export function registerCheckoutRoutes(app: App) {
  const r = createRouter();

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/transactions/{id}/quote',
      tags: ['Checkout'],
      summary: 'Create a transparent landed-cost quote (FX lock, customs estimate, restricted check, limits, promo, credit)',
      description: 'Buyer only; transaction MATCHED. Supersedes the previous quote. Expires with the FX lock.',
      security: bearer,
      middleware: [requireAuth, rateLimit({ name: 'money.quote', limit: 30, windowSec: 60, key: 'user' })] as const,
      request: { params: TxIdParam, ...jsonBody(QuoteBody) },
      responses: { 201: jsonContent(QuoteSchema, 'Quote created'), ...errorResponses },
    }),
    async (c) => c.json(await createQuote(c.get('deps'), getAuth(c), c.req.valid('param').id, c.req.valid('json')), 201),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/transactions/{id}/checkout',
      tags: ['Checkout'],
      summary: 'Start SafePay checkout for the active quote (Idempotency-Key required, KYC ≥ 2)',
      security: bearer,
      middleware: [requireAuth, requireKycLevel(2), rateLimit({ name: 'money.checkout', limit: 10, windowSec: 60, key: 'user' }), requireIdempotency] as const,
      request: { params: TxIdParam, headers: IdempotencyHeader, ...jsonBody(CheckoutBody) },
      responses: { 201: jsonContent(CheckoutResult, 'Payment created'), ...errorResponses },
    }),
    async (c) => c.json(await checkout(c.get('deps'), getAuth(c), c.req.valid('param').id, c.req.valid('json')), 201),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/transactions/{id}/payment',
      tags: ['Checkout'],
      summary: 'Payments of the transaction (checkout URL only for the buyer while PENDING)',
      security: bearer,
      middleware: [requireAuth] as const,
      request: { params: TxIdParam },
      responses: { 200: jsonContent(z.object({ data: z.array(PaymentSchema), current: PaymentSchema.nullable() })), ...errorResponses },
    }),
    async (c) => {
      const deps = c.get('deps');
      const { tx, role } = await requireParty(deps.sql, c.req.valid('param').id, getAuth(c));
      const list = (await paymentsForTx(deps.sql, tx.id)).map((p) => paymentView(p, { includeCheckoutUrl: role === 'BUYER' }));
      return c.json({ data: list, current: list[list.length - 1] ?? null }, 200);
    },
  );

  app.route('/', r);
}
