import { z } from '@hono/zod-openapi';

export const CreditsSchema = z
  .object({
    balanceIdr: z.number().int().openapi({ description: 'Σ credit_entries (non-withdrawable)' }),
    availableIdr: z.number().int().openapi({ description: 'Balance excluding lots already past expiry but not yet written off by the hourly job' }),
    withdrawable: z.literal(false),
    nextExpiryAt: z.string().nullable(),
    expiringSoon: z.object({
      withinDays: z.number().int(),
      totalIdr: z.number().int(),
      lots: z.array(z.object({ amountIdr: z.number().int(), expiresAt: z.string(), source: z.string() })),
    }),
    history: z.object({
      data: z.array(
        z.object({
          id: z.string(),
          amountIdr: z.number().int(),
          reason: z.string().openapi({ description: 'REFERRAL_REWARD | PROMO_CASHBACK | CHECKOUT_REDEEM | REDEEM_REVERSAL | EXPIRY | ADMIN_ADJUST' }),
          label: z.string(),
          referenceType: z.string().nullable(),
          referenceId: z.string().nullable(),
          expiresAt: z.string().nullable(),
          createdAt: z.string(),
        }),
      ),
      nextCursor: z.string().nullable(),
    }),
  })
  .openapi('Credits');
