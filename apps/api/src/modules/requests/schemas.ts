import { z } from '@hono/zod-openapi';
import { PublicProfileSchema } from '../trips/schemas';

const Country = z
  .string()
  .regex(/^[A-Za-z]{2}$/)
  .transform((s) => s.toUpperCase());
const Ccy = z
  .string()
  .regex(/^[A-Za-z]{3}$/)
  .transform((s) => s.toUpperCase());
const IsoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Format YYYY-MM-DD');
const Category = z.string().regex(/^[A-Z][A-Z0-9_]*$/);
const HttpUrl = z
  .string()
  .max(2000)
  .regex(/^https?:\/\//i, 'URL http/https');

export const RequestStatusEnum = z.enum(['DRAFT', 'OPEN', 'MATCHED', 'CLOSED', 'CANCELLED', 'EXPIRED']);
export const RestrictionEnum = z.enum(['ALLOWED', 'RESTRICTED', 'DECLARATION_REQUIRED', 'PERMIT_REQUIRED', 'PROHIBITED']);
const DeliveryPref = z.enum(['MEETUP', 'COURIER', 'PARTNER_LOGISTICS', 'ANY']);

export const ExtractBody = z
  .object({
    url: HttpUrl.optional().openapi({ example: 'https://www.uniqlo.com/jp/ja/products/E465185-000' }),
    fileId: z.string().uuid().optional().openapi({ description: 'PRODUCT_PHOTO file owned by caller' }),
    query: z.string().trim().min(2).max(300).optional(),
    country: Country.optional().openapi({ description: 'Merchant country hint for search' }),
    hint: z.string().trim().max(300).optional().openapi({ description: 'Optional product name hint for photos' }),
  })
  .openapi('ExtractRequest');

const Draft = z.object({
  sourceType: z.enum(['URL', 'PHOTO', 'SEARCH']),
  productUrl: z.string().nullable(),
  productName: z.string().nullable(),
  merchantName: z.string().nullable(),
  merchantCountry: z.string().nullable(),
  unitPriceMinor: z.number().int().nullable(),
  priceCurrency: z.string().nullable(),
  imageUrl: z.string().nullable(),
  categoryCode: z.string().nullable(),
  variant: z.string().nullable(),
});

export const ExtractResponse = z
  .object({
    drafts: z.array(Draft),
    confidence: z.number(),
    needsManualInput: z.boolean(),
    warnings: z.array(z.string()),
    mode: z.enum(['MOCK', 'SANDBOX', 'LIVE']),
  })
  .openapi('ExtractionResult');

const RequestFields = {
  productUrl: HttpUrl.nullable().optional(),
  productName: z.string().trim().min(2).max(300),
  merchantName: z.string().trim().max(200).nullable().optional(),
  merchantCountry: Country.openapi({ example: 'JP' }),
  categoryCode: Category.openapi({ example: 'FASHION_APPAREL' }),
  hsCode: z.string().regex(/^[0-9.]{4,14}$/).nullable().optional(),
  quantity: z.number().int().min(1).max(999).default(1),
  variant: z.string().trim().max(200).nullable().optional(),
  unitPriceMinor: z.number().int().min(0).max(1e13).openapi({ description: 'Unit price in minor units of priceCurrency', example: 2990 }),
  priceCurrency: Ccy.openapi({ example: 'JPY' }),
  estWeightKg: z.number().positive().max(100).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  maxBudgetIdr: z.number().int().positive().max(1e12).nullable().optional().openapi({ description: 'Buyer ceiling for item + fees (IDR)' }),
  neededBy: IsoDay.nullable().optional(),
  destinationCountry: Country.default('ID'),
  destinationCity: z.string().trim().min(2).max(100).nullable().optional(),
  deliveryPreference: DeliveryPref.nullable().optional(),
  imageUrls: z.array(HttpUrl).max(5).optional(),
  imageFileIds: z.array(z.string().uuid()).max(5).optional(),
  acknowledgeRestriction: z.boolean().optional().openapi({ description: 'Buyer acknowledges the restricted-item warning' }),
};

export const RequestCreateBody = z
  .object({
    sourceType: z.enum(['URL', 'PHOTO', 'SEARCH', 'MANUAL']).default('MANUAL'),
    ...RequestFields,
    extraction: z.record(z.string(), z.unknown()).optional(),
    publish: z.boolean().optional().openapi({ description: 'true → create directly as OPEN (all publish checks apply)' }),
  })
  .openapi('RequestCreate');

export const RequestPatchBody = z
  .object({
    productUrl: RequestFields.productUrl,
    productName: RequestFields.productName.optional(),
    merchantName: RequestFields.merchantName,
    merchantCountry: Country.optional(),
    categoryCode: Category.optional(),
    hsCode: RequestFields.hsCode,
    quantity: z.number().int().min(1).max(999).optional(),
    variant: RequestFields.variant,
    unitPriceMinor: z.number().int().min(0).max(1e13).optional(),
    priceCurrency: Ccy.optional(),
    estWeightKg: RequestFields.estWeightKg,
    notes: RequestFields.notes,
    maxBudgetIdr: RequestFields.maxBudgetIdr,
    neededBy: RequestFields.neededBy,
    destinationCountry: Country.optional(),
    destinationCity: RequestFields.destinationCity,
    deliveryPreference: RequestFields.deliveryPreference,
    imageUrls: RequestFields.imageUrls,
    imageFileIds: RequestFields.imageFileIds,
    acknowledgeRestriction: RequestFields.acknowledgeRestriction,
    version: z.number().int().positive().optional().openapi({ description: 'Optimistic lock: current version' }),
  })
  .openapi('RequestPatch');

export const PublishBody = z.object({ acknowledgeRestriction: z.boolean().optional() }).openapi('RequestPublish');
export const CancelBody = z.object({ reason: z.string().trim().max(500).optional() }).openapi('RequestCancel');

const Image = z.object({ fileId: z.string().uuid().nullable(), url: z.string().nullable() });

export const RequestOwnerSchema = z
  .object({
    id: z.string().uuid(),
    status: RequestStatusEnum,
    version: z.number().int(),
    sourceType: z.enum(['URL', 'PHOTO', 'SEARCH', 'MANUAL']),
    productUrl: z.string().nullable(),
    productName: z.string(),
    merchantName: z.string().nullable(),
    merchantCountry: z.string().nullable(),
    categoryCode: z.string().nullable(),
    hsCode: z.string().nullable(),
    quantity: z.number().int(),
    variant: z.string().nullable(),
    unitPriceMinor: z.number().int().nullable(),
    priceCurrency: z.string().nullable(),
    itemValueIdr: z.number().int().nullable().openapi({ description: 'Estimate at spot FX (no markup)' }),
    estWeightKg: z.number().nullable(),
    notes: z.string().nullable(),
    maxBudgetIdr: z.number().int().nullable(),
    neededBy: z.string().nullable(),
    destinationCountry: z.string(),
    destinationCity: z.string().nullable(),
    deliveryPreference: DeliveryPref.nullable(),
    restriction: z.object({
      classification: RestrictionEnum.nullable(),
      ruleRef: z.string().nullable(),
      requiresAcknowledgement: z.boolean(),
      acknowledgedAt: z.string().nullable(),
      blocksPublishing: z.boolean(),
    }),
    images: z.array(Image),
    pendingOffers: z.number().int(),
    publishedAt: z.string().nullable(),
    expiresAt: z.string().nullable(),
    closedAt: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi('RequestOwner');

export const RequestListingSchema = z
  .object({
    id: z.string().uuid(),
    status: RequestStatusEnum,
    productUrl: z.string().nullable(),
    productName: z.string(),
    merchantName: z.string().nullable(),
    merchantCountry: z.string().nullable(),
    categoryCode: z.string().nullable(),
    quantity: z.number().int(),
    variant: z.string().nullable(),
    unitPriceMinor: z.number().int().nullable(),
    priceCurrency: z.string().nullable(),
    itemValueIdr: z.number().int().nullable(),
    estWeightKg: z.number().nullable(),
    maxBudgetIdr: z.number().int().nullable(),
    neededBy: z.string().nullable(),
    destinationCountry: z.string(),
    destinationCity: z.string().nullable(),
    deliveryPreference: DeliveryPref.nullable(),
    restrictionClass: RestrictionEnum.nullable(),
    images: z.array(Image),
    publishedAt: z.string().nullable(),
    expiresAt: z.string().nullable(),
    buyer: PublicProfileSchema,
    matchingTripIds: z.array(z.string().uuid()).optional(),
  })
  .openapi('RequestListing');

export const RequestViewSchema = z
  .object({ view: z.enum(['OWNER', 'LISTING']), request: z.union([RequestOwnerSchema, RequestListingSchema]) })
  .openapi('RequestView');

export const MineQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(500).optional(),
  status: RequestStatusEnum.optional(),
});

export const OpenQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(500).optional(),
  tripId: z.string().uuid().optional(),
  categoryCode: Category.optional(),
});

export const RequestPageSchema = z.object({ data: z.array(RequestOwnerSchema), nextCursor: z.string().nullable() }).openapi('RequestOwnerPage');
export const ListingPageSchema = z.object({ data: z.array(RequestListingSchema), nextCursor: z.string().nullable() }).openapi('RequestListingPage');
export const IdParam = z.object({ id: z.string().uuid().openapi({ param: { name: 'id', in: 'path' } }) });
