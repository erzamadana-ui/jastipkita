import { z } from '@hono/zod-openapi';
import { TRANSACTION_STATUSES } from '@jastipkita/core';
import { TrustBadgeSchema, TrustTierSchema } from '../trips/schemas';

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

export const PaymentOptionSchema = z
  .object({
    channel: z.string().openapi({ example: 'QRIS' }),
    label: z.string().openapi({ example: 'QRIS' }),
    feeIdr: z.number().int().openapi({ description: 'PAYMENT_FEE line the buyer would pay with this channel (0 when the platform bears it)' }),
    totalIdr: z.number().int().openapi({ description: 'Quote TOTAL if this channel is chosen (all other lines unchanged)' }),
    bearer: z.enum(['BUYER', 'PLATFORM']),
    refundable: z
      .boolean()
      .openapi({ description: 'false = the provider cannot refund this channel (VA / retail outlets); refunds are then paid out to a buyer bank account' }),
    minAmountIdr: z.number().int().nullable(),
    maxAmountIdr: z.number().int().nullable().openapi({ description: 'Per-transaction nominal limit of the channel (QRIS Rp10.000.000)', example: 10_000_000 }),
    available: z.boolean().openapi({ description: 'false when totalIdr is outside [minAmountIdr, maxAmountIdr]' }),
    unavailableReason: z.enum(['ABOVE_CHANNEL_MAX', 'BELOW_CHANNEL_MIN']).nullable(),
    selected: z.boolean().openapi({ description: 'The channel this quote was priced for (re-quote to switch)' }),
  })
  .openapi('PaymentOption');

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
    paymentOptions: z
      .array(PaymentOptionSchema)
      .openapi({ description: 'Fee & total for every configured channel, computed with the same pricing engine. Empty for quotes created before 2026-09-27.' }),
    item: z.object({ currency: z.string(), unitPriceMinor: z.number().int(), quantity: z.number().int(), totalMinor: z.number().int() }),
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
        status: z.string(),
        source: z.string().nullable(),
        rateAsOf: z.string().nullable(),
      })
      .nullable(),
    customs: z.looseObject({
      ruleCode: z.string().nullable(),
      ruleVersion: z.number().int().nullable(),
      treatment: z.string().nullable(),
      dutyIdr: z.number().int(),
      importTaxIdr: z.number().int(),
      totalIdr: z.number().int(),
      isEstimate: z.boolean(),
      sourceReference: z.string().nullable(),
      warnings: z.array(z.unknown()),
      disclaimerId: z.string(),
    }),
    restricted: z.looseObject({
      classification: z.string(),
      requiresAcknowledgement: z.boolean(),
      blocksCheckout: z.boolean(),
      messagesId: z.array(z.string()),
      messagesEn: z.array(z.string()),
      ruleCodes: z.array(z.string()),
      airlineDg: z.boolean(),
    }),
    promotion: z.looseObject({ discountIdr: z.number().int(), cashbackIdr: z.number().int(), freePlatformFee: z.boolean(), promoIds: z.array(z.string()) }),
    credit: z.looseObject({ requested: z.boolean(), appliedIdr: z.number().int(), availableIdr: z.number().int(), withdrawable: z.literal(false) }),
    limits: z.looseObject({
      buyer: z.object({ effectiveMaxIdr: z.number().int(), perTransactionMaxIdr: z.number().int() }),
      traveler: z.object({ effectiveMaxIdr: z.number().int(), perTransactionMaxIdr: z.number().int() }),
    }),
    adjustments: z.array(z.unknown()),
    configVersions: z.record(z.string(), z.number().int()),
    ruleRefs: z.array(z.string()),
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

// ------------------------------------------------------------------ transaction detail parts

const TxStatusEnum = z.enum(TRANSACTION_STATUSES);
const DeliveryMethodEnum = z.enum(['MEETUP', 'COURIER', 'PARTNER_LOGISTICS']);

const RatingSide = z.object({ average: z.number().nullable(), count: z.number().int() });
export const RatingSummaryCompactSchema = z.object({ asTraveler: RatingSide, asBuyer: RatingSide }).openapi('RatingSummaryCompact');

export const TransactionPartySchema = z
  .object({
    id: z.string().uuid(),
    displayName: z.string().openapi({ description: 'First name + last initial only', example: 'Budi S.' }),
    avatarUrl: z.string().nullable().openapi({ description: 'Absolute URL (GET /v1/files/{id}/content, bearer auth) or null' }),
    trustScore: z.number().int().min(0).max(100),
    trustTier: TrustTierSchema,
    trustBadge: TrustBadgeSchema,
    kycLevel: z.number().int().min(1).max(5),
    identityVerified: z.boolean(),
    ratingSummary: RatingSummaryCompactSchema,
    memberSince: z.string(),
    rating: RatingSummaryCompactSchema.nullable().openapi({ description: 'Deprecated alias of ratingSummary (null when the user has no ratings yet)' }),
  })
  .openapi('TransactionParty', { description: 'Public profile of a transaction party — no e-mail, phone or full name' });

export const TransactionItemSchema = z
  .object({
    productName: z.string(),
    productUrl: z.string().nullable(),
    merchantName: z.string().nullable(),
    merchantCountry: z.string().nullable(),
    categoryCode: z.string().nullable(),
    hsCode: z.string().nullable(),
    variant: z.string().nullable(),
    quantity: z.number().int(),
    unitPriceMinor: z.number().int().nullable().openapi({ description: 'Unit price in the minor unit of `currency`' }),
    currency: z.string().nullable().openapi({ example: 'JPY' }),
    priceCurrency: z.string().nullable().openapi({ description: 'Deprecated alias of currency' }),
    imageUrl: z.string().nullable().openapi({ description: 'First request image — absolute URL (merchant image URL or /v1/files/{id}/content)' }),
    maxBudgetIdr: z.number().int().nullable().openapi({ description: 'Buyer only (null for the traveler)' }),
  })
  .openapi('TransactionItem');

export const TripRouteSchema = z
  .object({
    id: z.string().uuid(),
    status: z.string(),
    originCountry: z.string(),
    originCity: z.string(),
    destinationCountry: z.string(),
    destinationCity: z.string(),
    departureDate: z.string().openapi({ example: '2026-10-20' }),
    arrivalDate: z.string().openapi({ example: '2026-10-21' }),
  })
  .openapi('TripRoute');

export const PriceConfirmationSchema = z
  .object({
    id: z.string().uuid(),
    status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CLARIFICATION_REQUESTED', 'EXPIRED']),
    currency: z.string(),
    originalPriceMinor: z.number().int(),
    actualPriceMinor: z.number().int(),
    originalIdr: z.number().int(),
    actualIdr: z.number().int(),
    supplementalRequiredIdr: z.number().int(),
    receiptFileId: z.string().uuid().nullable(),
    notes: z.string().nullable(),
    responseNote: z.string().nullable(),
    round: z.number().int(),
    windowSeconds: z.number().int(),
    expiresAt: z.string(),
    respondedAt: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi('PriceConfirmation');

export const ProofFileSchema = z
  .object({
    id: z.string().uuid(),
    kind: z.enum(['RECEIPT', 'PRODUCT_PHOTO', 'VIDEO']),
    mime: z.string().nullable(),
    sizeBytes: z.number().int().nullable(),
    contentUrl: z.string().openapi({ description: 'Absolute URL, bearer auth (both parties may read proof files)' }),
  })
  .openapi('PurchaseProofFile');

export const PurchaseProofSchema = z
  .object({
    id: z.string().uuid(),
    status: z.enum(['SUBMITTED', 'ACCEPTED', 'FLAGGED', 'REJECTED']),
    merchantName: z.string(),
    actualPriceMinor: z.number().int(),
    currency: z.string(),
    purchasedAt: z.string(),
    receiptFileId: z.string().uuid(),
    productPhotoFileIds: z.array(z.string().uuid()),
    videoFileId: z.string().uuid().nullable(),
    serialNumber: z.string().nullable().openapi({ description: 'Traveler always; buyer once DELIVERED' }),
    files: z.array(ProofFileSchema).openapi({ description: 'Only the files referenced by this proof (never other private files); no fraud data' }),
  })
  .openapi('PurchaseProof');

export const CustomsDeclarationSchema = z
  .object({
    id: z.string().uuid(),
    status: z.enum(['NOT_REQUIRED', 'PENDING', 'SUBMITTED', 'PAID', 'VERIFIED', 'REJECTED']),
    dutyPaidIdr: z.number().int().nullable(),
    vatPaidIdr: z.number().int().nullable(),
    incomeTaxPaidIdr: z.number().int().nullable(),
    luxuryTaxPaidIdr: z.number().int().nullable(),
    totalPaidIdr: z.number().int().nullable(),
    estimatedTotalIdr: z.number().int().nullable(),
    receiptFileId: z.string().uuid().nullable(),
    paidAt: z.string().nullable(),
  })
  .openapi('CustomsDeclaration');

export const DeliverySchema = z
  .object({
    id: z.string().uuid(),
    method: DeliveryMethodEnum,
    status: z.enum(['PENDING', 'SCHEDULED', 'IN_TRANSIT', 'DELIVERED', 'FAILED', 'CANCELLED']),
    courierName: z.string().nullable(),
    trackingNumber: z.string().nullable(),
    addressCity: z.string().nullable(),
    meetupPoint: z.string().nullable(),
    scheduledAt: z.string().nullable(),
    confirmedAt: z.string().nullable(),
    confirmedVia: z.string().nullable(),
    proofFileIds: z.array(z.string().uuid()),
    pin: z
      .object({ locked: z.boolean(), attemptsRemaining: z.number().int(), revealEndpoint: z.string().optional().openapi({ description: 'Buyer only' }) })
      .nullable()
      .openapi({ description: 'MEETUP only. Never contains the PIN, QR token or their hashes' }),
    pinAvailable: z
      .boolean()
      .optional()
      .openapi({ description: 'Buyer only: true when a handover PIN/QR can be revealed now via GET /v1/transactions/{id}/delivery/pin' }),
  })
  .openapi('Delivery');

export const RefundSchema = z
  .object({
    id: z.string().uuid(),
    number: z.string(),
    paymentId: z.string().uuid().nullable(),
    reasonCode: z.string(),
    reasonNote: z.string().nullable(),
    amountIdr: z.number().int(),
    type: z.string(),
    status: z.string(),
    method: z.string(),
    destinationRequired: z.boolean(),
    destination: z.object({ bankCode: z.string().nullable(), accountMask: z.string().nullable(), validationStatus: z.string() }).nullable(),
    failureReason: z.string().nullable(),
    processedAt: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi('Refund');

export const PayoutSummarySchema = z
  .object({
    id: z.string().uuid(),
    number: z.string(),
    status: z.enum(['SCHEDULED', 'ON_HOLD', 'PROCESSING', 'PAID', 'FAILED', 'CANCELLED']),
    amountIdr: z.number().int(),
    netIdr: z.number().int(),
    holdReason: z.string().nullable(),
    scheduledAt: z.string().nullable(),
    paidAt: z.string().nullable(),
  })
  .openapi('TransactionPayout', { description: 'Traveler only' });

const TxBase = {
  id: z.string().uuid(),
  number: z.string().openapi({ example: 'JK-260927-7K3M9Q' }),
  status: TxStatusEnum,
  role: z.enum(['BUYER', 'TRAVELER']).openapi({ description: "Caller's role in this transaction" }),
  buyerId: z.string().uuid(),
  travelerId: z.string().uuid().nullable(),
  totalIdr: z.number().int().nullable(),
  securedIdr: z.number().int(),
  itemCurrency: z.string().nullable(),
  quantity: z.number().int(),
  deliveryMethod: DeliveryMethodEnum.nullable(),
  purchaseCeiling: z.object({ minor: z.number().int(), idr: z.number().int().nullable() }).nullable().openapi({ description: 'Deprecated: use purchaseCeilingIdr' }),
  purchaseCeilingIdr: z.number().int().nullable().openapi({ description: 'Max the traveler may spend on the item (IDR) once PURCHASE_APPROVED' }),
  autoConfirmAt: z.string().nullable(),
  statusChangedAt: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  cancelledAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  purchaseGate: PurchaseGateSchema.nullable().openapi({ description: 'Traveler only (null for the buyer)' }),
};

export const TransactionSummarySchema = z
  .object({
    ...TxBase,
    item: z.object({
      productName: z.string(),
      categoryCode: z.string().nullable(),
      merchantCountry: z.string().nullable(),
      imageUrl: z.string().nullable(),
    }),
    counterparty: z
      .object({ id: z.string().uuid(), role: z.enum(['BUYER', 'TRAVELER']), displayName: z.string(), avatarUrl: z.string().nullable() })
      .nullable()
      .openapi({ description: 'The other party (null before a traveler is attached)' }),
  })
  .openapi('TransactionSummary');

export const TransactionListSchema = z.object({ data: z.array(TransactionSummarySchema), nextCursor: z.string().nullable() }).openapi('TransactionList');

export const TransactionDetailSchema = z
  .object({
    ...TxBase,
    item: TransactionItemSchema.nullable(),
    buyer: TransactionPartySchema.nullable(),
    traveler: TransactionPartySchema.nullable(),
    trip: TripRouteSchema.nullable(),
    quote: QuoteSchema.nullable(),
    payments: z.array(PaymentSchema),
    priceConfirmations: z.array(PriceConfirmationSchema),
    purchaseProof: PurchaseProofSchema.nullable(),
    customsDeclaration: CustomsDeclarationSchema.nullable(),
    delivery: DeliverySchema.nullable().openapi({ description: 'Never contains the PIN; the buyer reveals it via GET /delivery/pin' }),
    refunds: z.array(RefundSchema),
    payout: PayoutSummarySchema.nullable().openapi({ description: 'Traveler only (always null for the buyer)' }),
    conversationId: z
      .string()
      .uuid()
      .nullable()
      .openapi({ description: 'Chat conversation of this transaction; null until created (GET /v1/transactions/{id}/conversation creates it lazily)' }),
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
