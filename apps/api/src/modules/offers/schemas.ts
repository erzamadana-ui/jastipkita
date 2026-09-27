import { z } from '@hono/zod-openapi';
import { RequestListingSchema } from '../requests/schemas';
import { PublicProfileSchema, TripPublicSchema } from '../trips/schemas';

export const OfferStatusEnum = z.enum(['PENDING', 'ACCEPTED', 'DECLINED', 'WITHDRAWN', 'EXPIRED']);

export const OfferCreateBody = z
  .object({
    tripId: z.string().uuid(),
    travelerFeeIdr: z
      .number()
      .int()
      .min(0)
      .max(1e10)
      .optional()
      .openapi({ description: 'Proposed traveler fee (IDR). Default: computed from the trip fee spec. Must be within pricing.traveler_fee_bounds' }),
    message: z.string().trim().max(2000).nullable().optional(),
  })
  .openapi('OfferCreate');

export const InviteBody = z
  .object({
    requestId: z.string().uuid(),
    message: z.string().trim().max(2000).nullable().optional(),
  })
  .openapi('TripInvite');

export const DeclineBody = z.object({ reason: z.string().trim().max(500).optional() }).openapi('OfferDecline');

export const OfferSchema = z
  .object({
    id: z.string().uuid(),
    requestId: z.string().uuid(),
    tripId: z.string().uuid(),
    travelerId: z.string().uuid(),
    buyerId: z.string().uuid(),
    initiatedBy: z.enum(['TRAVELER', 'BUYER']),
    travelerFeeIdr: z.number().int(),
    message: z.string().nullable(),
    status: OfferStatusEnum,
    expiresAt: z.string().nullable(),
    respondedAt: z.string().nullable(),
    declineReason: z.string().nullable(),
    transactionId: z.string().uuid().nullable(),
    createdAt: z.string(),
    trip: TripPublicSchema.nullable(),
    traveler: PublicProfileSchema,
    request: RequestListingSchema.nullable(),
    allowedActions: z.array(z.enum(['ACCEPT', 'DECLINE', 'WITHDRAW'])),
  })
  .openapi('Offer');

export const OfferListSchema = z.object({ data: z.array(OfferSchema) }).openapi('OfferList');
export const OfferPageSchema = z.object({ data: z.array(OfferSchema), nextCursor: z.string().nullable() }).openapi('OfferPage');

export const AcceptResponse = z
  .object({
    offer: OfferSchema,
    transaction: z.object({
      id: z.string().uuid(),
      number: z.string().openapi({ example: 'JK-261005-7K3QZC' }),
      status: z.literal('MATCHED'),
      version: z.number().int(),
      buyerId: z.string().uuid(),
      travelerId: z.string().uuid(),
      tripId: z.string().uuid(),
      requestId: z.string().uuid(),
      offerId: z.string().uuid(),
    }),
  })
  .openapi('OfferAccepted');

export const MineQuery = z.object({
  role: z.enum(['traveler', 'buyer']).optional(),
  status: OfferStatusEnum.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(500).optional(),
});

export const IdParam = z.object({ id: z.string().uuid().openapi({ param: { name: 'id', in: 'path' } }) });
