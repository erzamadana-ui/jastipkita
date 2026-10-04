import { createRoute, z } from '@hono/zod-openapi';
import type { App } from '../../context';
import { bearer, createRouter, errorResponses, jsonContent } from '../../lib/openapi';
import { decodeCursor, encodeCursor } from '../../lib/pagination';
import { getAuth, requireAuth } from '../../middleware/auth';
import { myPayouts } from './service';

const PayoutItem = z
  .object({
    id: z.string().uuid(),
    number: z.string(),
    transactionId: z.string().uuid().nullable(),
    transactionNumber: z.string().nullable(),
    amountIdr: z.number().int(),
    feeIdr: z.number().int(),
    netIdr: z.number().int(),
    status: z.enum(['SCHEDULED', 'ON_HOLD', 'PROCESSING', 'PAID', 'FAILED', 'CANCELLED']),
    holdReason: z.string().nullable(),
    scheduledFor: z.string(),
    cooldownUntil: z
      .string()
      .nullable()
      .openapi({ description: 'Set while the destination account is in its new-account cooldown (money.policy.newPayoutAccountCooldownHours): the payout is not sent before this time (ISO-8601)' }),
    paidAt: z.string().nullable(),
    destination: z.object({ bankCode: z.string(), accountMask: z.string() }),
    providerEnv: z.string(),
    createdAt: z.string(),
  })
  .openapi('Payout');

export function registerPayoutRoutes(app: App) {
  const r = createRouter();
  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/payouts/mine',
      tags: ['Payouts'],
      summary: 'Traveler earnings: scheduled / paid / held payouts (masked destination)',
      security: bearer,
      middleware: [requireAuth] as const,
      request: { query: z.object({ limit: z.coerce.number().int().min(1).max(100).default(20), cursor: z.string().max(500).optional() }) },
      responses: {
        200: jsonContent(
          z.object({
            data: z.array(PayoutItem),
            nextCursor: z.string().nullable(),
            summary: z.object({ scheduledIdr: z.number().int(), paidIdr: z.number().int(), heldIdr: z.number().int(), processingIdr: z.number().int(), failedIdr: z.number().int() }),
          }),
        ),
        ...errorResponses,
      },
    }),
    async (c) => {
      const q = c.req.valid('query');
      const out = await myPayouts(c.get('deps'), getAuth(c), { limit: q.limit, cursor: decodeCursor(q.cursor) });
      const hasMore = out.data.length > q.limit;
      const data = hasMore ? out.data.slice(0, q.limit) : out.data;
      const last = data[data.length - 1];
      return c.json({ data, nextCursor: hasMore && last ? encodeCursor({ t: last.createdAt, id: last.id }) : null, summary: out.summary }, 200);
    },
  );
  app.route('/', r);
}
