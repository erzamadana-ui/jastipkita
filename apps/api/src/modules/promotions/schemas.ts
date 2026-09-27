import { z } from '@hono/zod-openapi';

export const ValidatePromoSchema = z
  .object({ transactionId: z.string().uuid(), code: z.string().trim().min(3).max(32).regex(/^[A-Za-z0-9_-]+$/) })
  .openapi('ValidatePromotion');

const Applied = z.object({ promotionId: z.string(), type: z.string(), discountIdr: z.number().int(), cashbackIdr: z.number().int(), freePlatformFee: z.boolean() });

export const ValidatePromoResult = z
  .object({
    valid: z.boolean(),
    code: z.string(),
    promotionId: z.string().nullable(),
    type: z.string().nullable(),
    discountIdr: z.number().int(),
    cashbackIdr: z.number().int().openapi({ description: 'Granted as JastipKita Credit after COMPLETED' }),
    freePlatformFee: z.boolean(),
    budgetCapped: z.boolean(),
    reason: z.string().nullable(),
    message: z.string(),
    otherApplied: z.array(Applied).openapi({ description: 'Automatic promotions (e.g. first transaction) the engine would apply' }),
  })
  .openapi('ValidatePromotionResult');

export const PublicPromotion = z
  .object({
    id: z.string().uuid(),
    code: z.string().nullable(),
    name: z.string(),
    description: z.string().nullable(),
    type: z.string(),
    benefit: z
      .object({ kind: z.string(), rateBps: z.number().int().nullable(), amountIdr: z.number().int().nullable(), capIdr: z.number().int().nullable() })
      .nullable(),
    conditions: z.object({ minItemValueIdr: z.number().int().nullable(), originCountries: z.array(z.string()), categories: z.array(z.string()), firstTransactionOnly: z.boolean() }),
    startsAt: z.string(),
    endsAt: z.string().nullable(),
  })
  .openapi('PublicPromotion');

export const PublicPromotionList = z.object({ data: z.array(PublicPromotion) }).openapi('PublicPromotionList');
