import { z } from '@hono/zod-openapi';

const Score = z.number().int().min(1).max(5);

export const CreateRatingSchema = z
  .object({
    overall: Score,
    communication: Score.optional(),
    accuracy: Score.optional().openapi({ description: 'Buyer → traveler only (item as described)' }),
    timeliness: Score.optional().openapi({ description: 'Buyer → traveler: delivery on time; traveler → buyer: responsiveness at handover' }),
    comment: z.string().max(1000).optional(),
  })
  .openapi('CreateRating');

export const RatingSchema = z
  .object({
    id: z.string().uuid(),
    transactionId: z.string().uuid(),
    direction: z.enum(['BUYER_TO_TRAVELER', 'TRAVELER_TO_BUYER']),
    rateeId: z.string().uuid(),
    overall: z.number().int(),
    communication: z.number().int().nullable(),
    accuracy: z.number().int().nullable(),
    timeliness: z.number().int().nullable(),
    comment: z.string().nullable(),
    status: z.string(),
    createdAt: z.string(),
  })
  .openapi('Rating');

const SideSummary = z.object({
  count: z.number().int(),
  average: z.number().nullable(),
  weightedAverage: z.number().nullable(),
  bayesianScore: z.number().nullable().openapi({ description: 'Abuse-weighted Bayesian average (prior 4.0 × 5) used by ranking & trust' }),
  effectiveCount: z.number(),
});

export const RatingSummarySchema = z
  .object({ userId: z.string().uuid(), asTraveler: SideSummary, asBuyer: SideSummary, updatedAt: z.string().nullable() })
  .openapi('RatingSummary');
