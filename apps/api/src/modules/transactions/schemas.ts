import { z } from '@hono/zod-openapi';

export const TxIdParam = z.object({
  id: z.string().uuid().openapi({ param: { name: 'id', in: 'path' }, example: '0b7f6d7e-5a3b-4a51-9c61-6f2d1c0e9a11' }),
});

export const PurchaseGateSchema = z
  .object({
    canPurchase: z.boolean(),
    banner: z.enum(['DO_NOT_PURCHASE', 'PURCHASE_APPROVED', 'ALREADY_PURCHASED', 'TRANSACTION_CLOSED']),
    paymentBadge: z.enum(['PAYMENT_SECURED']).nullable(),
    tone: z.enum(['error', 'success', 'info', 'neutral']),
    messageId: z.string(),
    messageEn: z.string(),
  })
  .openapi('PurchaseGate', { description: 'Golden rule: traveler may only buy in PURCHASE_APPROVED (red DO NOT PURCHASE banner before).' });

export const PriceLineSchema = z
  .object({
    type: z.enum(['ITEM_PRICE', 'TRAVELER_FEE', 'CUSTOMS_DUTY', 'IMPORT_TAX', 'PROTECTION_FEE', 'PLATFORM_FEE', 'SERVICE_TAX', 'PAYMENT_FEE', 'DISCOUNT', 'REFERRAL_CREDIT', 'TOTAL']),
    labelId: z.string(),
    labelEn: z.string(),
    amountIdr: z.number().int(),
    bucket: z.string().nullable(),
    isEstimate: z.boolean(),
    ruleRef: z.string().nullable(),
    originalAmountIdr: z.number().int().optional(),
  })
  .openapi('PriceLine');

export const QuoteSchema = z
  .looseObject({
    quoteId: z.string().uuid(),
    transactionId: z.string().uuid(),
    status: z.enum(['ACTIVE', 'ACCEPTED', 'EXPIRED', 'SUPERSEDED']),
    createdAt: z.string(),
    expiresAt: z.string().openapi({ description: 'Equals the FX lock expiry' }),
    currency: z.literal('IDR'),
    totalIdr: z.number().int(),
    paymentChannel: z.string(),
    lines: z.array(PriceLineSchema).openapi({ description: 'All 11 lines in §10 display order' }),
    estimateBadges: z.array(z.string()),
    fx: z
      .looseObject({
        base: z.string(),
        quote: z.string(),
        spotRate: z.string(),
        markupBps: z.number().int(),
        lockedRate: z.string(),
        lockedAt: z.string(),
        expiresAt: z.string(),
      })
      .nullable(),
    customs: z.looseObject({ ruleCode: z.string().nullable(), dutyIdr: z.number().int(), importTaxIdr: z.number().int(), isEstimate: z.boolean() }),
    restricted: z.looseObject({ classification: z.string(), requiresAcknowledgement: z.boolean() }),
    promotion: z.looseObject({ discountIdr: z.number().int(), cashbackIdr: z.number().int() }),
    credit: z.looseObject({ appliedIdr: z.number().int(), availableIdr: z.number().int(), withdrawable: z.literal(false) }),
    limits: z.unknown(),
  })
  .openapi('Quote');

export const PaymentSchema = z
  .object({
    id: z.string().uuid(),
    purpose: z.enum(['CHECKOUT', 'SUPPLEMENTAL']),
    status: z.enum(['PENDING', 'SECURED', 'EXPIRED', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED']),
    amountIdr: z.number().int(),
    refundedIdr: z.number().int(),
    channel: z.string().nullable(),
    provider: z.enum(['XENDIT', 'MOCK']),
    providerEnv: z.enum(['TEST', 'LIVE']),
    sandbox: z.boolean().openapi({ description: 'true unless provider_env = LIVE — show a SANDBOX badge' }),
    checkoutUrl: z.string().nullable(),
    expiresAt: z.string().nullable(),
    securedAt: z.string().nullable(),
    failureReason: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi('Payment');

export const TransactionSummarySchema = z.looseObject({
  id: z.string().uuid(),
  number: z.string(),
  status: z.string(),
  role: z.enum(['BUYER', 'TRAVELER']),
  totalIdr: z.number().int().nullable(),
  securedIdr: z.number().int(),
  purchaseGate: PurchaseGateSchema.nullable(),
});

export const TransactionListSchema = z.object({ data: z.array(TransactionSummarySchema), nextCursor: z.string().nullable() }).openapi('TransactionList');

export const TransactionDetailSchema = z
  .looseObject({
    id: z.string().uuid(),
    number: z.string(),
    status: z.string(),
    role: z.enum(['BUYER', 'TRAVELER']),
    quote: QuoteSchema.nullable(),
    payments: z.array(PaymentSchema),
    priceConfirmations: z.array(z.unknown()),
    purchaseProof: z.unknown(),
    delivery: z.unknown().openapi({ description: 'Never contains the PIN; the buyer reveals it via GET /delivery/pin' }),
    refunds: z.array(z.unknown()),
    purchaseGate: PurchaseGateSchema.nullable(),
    allowedActions: z.array(z.string()),
  })
  .openapi('TransactionDetail');

export const TimelineSchema = z
  .object({
    transactionId: z.string().uuid(),
    number: z.string(),
    events: z.array(
      z.object({
        id: z.number().int(),
        from: z.string().nullable(),
        to: z.string(),
        actorType: z.string(),
        reason: z.string().nullable(),
        meta: z.record(z.string(), z.unknown()),
        version: z.number().int(),
        at: z.string(),
      }),
    ),
  })
  .openapi('TransactionTimeline');

export const LooseResult = z.looseObject({}).openapi('MoneyActionResult');

/**
 * Local copy of the Idempotency-Key header schema: lib/openapi.ts `IdempotencyHeader` declares the key
 * `idempotency-key` with param name `Idempotency-Key`, which makes /v1/openapi.json fail with
 * "Conflicting names for parameter" (reported as a shared change).
 */
export const IdemHeader = z.object({
  'idempotency-key': z
    .string()
    .min(8)
    .max(255)
    .openapi({ param: { name: 'idempotency-key', in: 'header' }, description: 'Idempotency-Key (UUID) — required for financial mutations', example: '6f1f3b0e-0a0b-4c55-9d8b-2a2f7e5d1c11' }),
});
