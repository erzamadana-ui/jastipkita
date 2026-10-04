import { z } from '@hono/zod-openapi';

const Country = z
  .string()
  .regex(/^[A-Za-z]{2}$/)
  .transform((s) => s.toUpperCase());
const IsoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Format YYYY-MM-DD');
const City = z.string().trim().min(2).max(100);
const Category = z.string().regex(/^[A-Z][A-Z0-9_]*$/);

export const TripStatusEnum = z.enum(['DRAFT', 'VERIFICATION_PENDING', 'VERIFIED', 'ACTIVE', 'FULL', 'TRAVELING', 'COMPLETED', 'CANCELLED']);
export const FeeTypeEnum = z.enum(['FIXED', 'PERCENT', 'PER_KG']);

const FeeInput = z
  .object({
    type: FeeTypeEnum,
    value: z.number().int().min(0).openapi({ description: 'IDR for FIXED / PER_KG; basis points for PERCENT (1000 = 10%)', example: 1000 }),
  })
  .openapi('TripFeeInput');

export const TripCreateBody = z
  .object({
    originCountry: Country.openapi({ example: 'JP' }),
    originCity: City.openapi({ example: 'Tokyo' }),
    destinationCountry: Country.default('ID'),
    destinationCity: City.openapi({ example: 'Jakarta' }),
    departureDate: IsoDay.openapi({ example: '2026-10-20' }),
    arrivalDate: IsoDay.openapi({ example: '2026-10-20' }),
    returnDate: IsoDay.nullable().optional(),
    capacityKg: z.number().positive().max(1000).openapi({ example: 10 }),
    maxItems: z.number().int().min(1).max(999).nullable().optional(),
    fee: FeeInput,
    excludedCategories: z.array(Category).max(50).optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .openapi('TripCreateRequest');

export const TripPatchBody = z
  .object({
    originCountry: Country.optional(),
    originCity: City.optional(),
    destinationCountry: Country.optional(),
    destinationCity: City.optional(),
    departureDate: IsoDay.optional(),
    arrivalDate: IsoDay.optional(),
    returnDate: IsoDay.nullable().optional(),
    capacityKg: z.number().positive().max(1000).optional(),
    maxItems: z.number().int().min(1).max(999).nullable().optional(),
    fee: FeeInput.optional(),
    excludedCategories: z.array(Category).max(50).optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .openapi('TripPatchRequest');

export const VerificationBody = z
  .object({
    docType: z.enum(['ETICKET', 'ITINERARY', 'BOARDING_PASS']),
    fileId: z.string().uuid().openapi({ description: 'File uploaded via /v1/files/uploads with purpose TRIP_DOC (owned by caller, scan CLEAN)' }),
    flightNumber: z
      .string()
      .regex(/^[A-Za-z0-9]{2,3}\s?[0-9]{1,5}[A-Za-z]?$/)
      .nullable()
      .optional()
      .openapi({ example: 'GA 875' }),
    flightDate: IsoDay.nullable().optional(),
  })
  .openapi('TripVerificationRequest');

export const CancelBody = z.object({ reason: z.string().trim().min(3).max(500) }).openapi('TripCancelRequest');

const TripFee = z.object({ type: FeeTypeEnum, value: z.number().int(), label: z.string() }).openapi('TripFee');

export const TrustTierSchema = z
  .object({
    tier: z.enum(['EXCELLENT', 'GOOD', 'FAIR', 'LOW']).openapi({ description: 'Trust Score band: EXCELLENT 85–100, GOOD 70–84, FAIR 40–69, LOW 0–39' }),
    label: z.string().openapi({ example: 'Sangat tepercaya' }),
    labelEn: z.string().openapi({ example: 'Excellent' }),
  })
  .openapi('TrustTier');

export const TrustBadgeSchema = z
  .object({ tier: z.enum(['TRUSTED_TRAVELER', 'TRAVELER_VERIFIED', 'IDENTITY_VERIFIED', 'BASIC']), label: z.string() })
  .openapi('TrustBadge', { description: 'Verification badge derived from the KYC level' });

export const PublicProfileSchema = z
  .object({
    id: z.string().uuid().openapi({ description: 'Public profile id' }),
    displayName: z.string().openapi({ description: 'First name + last initial only', example: 'Budi S.' }),
    trustBadge: TrustBadgeSchema,
    trustScore: z.number().int().min(0).max(100).openapi({ description: 'Trust Score 0–100 (users.trust_score)', example: 82 }),
    trustTier: TrustTierSchema,
    kycLevel: z.number().int().min(1).max(5),
    identityVerified: z.boolean(),
    rating: z.object({ average: z.number().nullable(), count: z.number().int() }).openapi({ description: 'Rating in the role shown (traveler or buyer)' }),
    completedTransactions: z.number().int(),
  })
  .openapi('PublicProfile');

const DateWindowSchema = z
  .object({
    from: z.string().openapi({ example: '2026-10-12' }),
    to: z.string().openapi({ example: '2026-10-18' }),
  })
  .openapi('TripDateWindow', { description: 'Inclusive calendar-date window (YYYY-MM-DD). DAY precision: from = to = the exact date; WEEK: Monday–Sunday.' });

export const TripPublicSchema = z
  .object({
    id: z.string().uuid(),
    status: TripStatusEnum,
    originCountry: z.string(),
    originCity: z.string(),
    destinationCountry: z.string(),
    destinationCity: z.string(),
    departureDate: z.string().openapi({ description: 'DAY precision: exact date. WEEK precision (anonymous): Monday of the departure week — NOT the exact date; render departureWindow.' }),
    arrivalDate: z.string().openapi({ description: 'DAY precision: exact date. WEEK precision (anonymous): Monday of the arrival week — render arrivalWindow.' }),
    datePrecision: z.enum(['DAY', 'WEEK']).openapi({
      description: 'SEC-19: WEEK for anonymous requests (dates coarsened to the ISO week, Mon–Sun), DAY for signed-in users (exact dates).',
    }),
    departureWindow: DateWindowSchema,
    arrivalWindow: DateWindowSchema,
    capacityRemainingKg: z.number(),
    itemsRemaining: z.number().int().nullable(),
    fee: TripFee,
    excludedCategories: z.array(z.string()),
    verified: z.boolean().openapi({ description: 'Travel document verified by JastipKita' }),
    traveler: PublicProfileSchema,
  })
  .openapi('TripPublic');

export const TripOwnerSchema = z
  .object({
    id: z.string().uuid(),
    travelerId: z.string().uuid(),
    status: TripStatusEnum,
    version: z.number().int(),
    originCountry: z.string(),
    originCity: z.string(),
    destinationCountry: z.string(),
    destinationCity: z.string(),
    departureDate: z.string(),
    arrivalDate: z.string(),
    returnDate: z.string().nullable(),
    capacityKg: z.number(),
    reservedKg: z.number(),
    remainingCapacityKg: z.number(),
    maxItems: z.number().int().nullable(),
    reservedItems: z.number().int(),
    fee: TripFee,
    excludedCategories: z.array(z.string()),
    notes: z.string().nullable(),
    verified: z.boolean(),
    verifiedAt: z.string().nullable(),
    publishedAt: z.string().nullable(),
    completedAt: z.string().nullable(),
    cancelledAt: z.string().nullable(),
    cancelledReason: z.string().nullable(),
    verifications: z.array(
      z.object({
        id: z.string().uuid(),
        docType: z.string(),
        status: z.string(),
        fileId: z.string().uuid().nullable(),
        flightNumber: z.string().nullable(),
        flightDate: z.string().nullable(),
        createdAt: z.string(),
        reviewedAt: z.string().nullable(),
      }),
    ),
    allowedActions: z.array(z.string()),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi('TripOwner');

export const TripViewSchema = z
  .object({ view: z.enum(['OWNER', 'PUBLIC']), trip: z.union([TripOwnerSchema, TripPublicSchema]) })
  .openapi('TripView');

export const MyTripsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(500).optional(),
  status: TripStatusEnum.optional(),
});

export const DiscoveryQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().max(500).optional(),
  originCountry: Country.optional(),
  originCity: z.string().trim().min(1).max(100).optional(),
  destinationCountry: Country.optional(),
  destinationCity: z.string().trim().min(1).max(100).optional(),
  departureFrom: IsoDay.optional().openapi({ description: 'Anonymous requests (WEEK precision): evaluated from the Monday of this week' }),
  departureTo: IsoDay.optional().openapi({ description: 'Anonymous requests (WEEK precision): evaluated up to the Sunday of this week' }),
  arrivalBy: IsoDay.optional().openapi({ description: 'Trips arriving on or before this date (anonymous requests: on or before the Sunday of its week)' }),
  categoryCode: Category.optional().openapi({ description: 'Only trips that do not exclude this category' }),
  minCapacityKg: z.coerce.number().positive().max(1000).optional(),
  verifiedOnly: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});

export const TripPageSchema = z.object({ data: z.array(TripOwnerSchema), nextCursor: z.string().nullable() }).openapi('TripOwnerPage');
export const TripPublicPageSchema = z.object({ data: z.array(TripPublicSchema), nextCursor: z.string().nullable() }).openapi('TripPublicPage');
export const IdParam = z.object({ id: z.string().uuid().openapi({ param: { name: 'id', in: 'path' } }) });
