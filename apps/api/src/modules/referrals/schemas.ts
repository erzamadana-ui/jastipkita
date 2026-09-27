import { z } from '@hono/zod-openapi';

export const ApplyReferralSchema = z
  .object({
    code: z.string().trim().min(4).max(16),
    program: z.enum(['BUYER', 'TRAVELER']).optional().openapi({ description: 'Default: TRAVELER when the account is in traveler mode, else BUYER' }),
  })
  .openapi('ApplyReferral');

export const ApplyReferralResult = z
  .object({ referralId: z.string().uuid(), program: z.enum(['BUYER', 'TRAVELER']), status: z.string(), variant: z.string().nullable(), expiresAt: z.string().nullable(), message: z.string() })
  .openapi('ApplyReferralResult');

const Program = z.object({
  enabled: z.boolean(),
  referrerCreditIdr: z.number().int(),
  monthlyCapIdr: z.number().int(),
  creditExpiryDays: z.number().int(),
  withdrawable: z.boolean(),
});

export const MyReferralsSchema = z
  .object({
    code: z.string(),
    shareLink: z.string(),
    programs: z.object({
      buyer: Program.extend({ refereeCreditIdr: z.number().int(), minFirstTransactionIdr: z.number().int() }),
      traveler: Program.extend({ requiredCompletedTransactions: z.number().int() }),
    }),
    stats: z.object({
      invited: z.number().int(),
      pending: z.number().int(),
      underReview: z.number().int(),
      rewarded: z.number().int(),
      rejected: z.number().int(),
      expired: z.number().int(),
      totalEarnedIdr: z.number().int(),
      monthEarnedIdr: z.number().int(),
    }),
    rewards: z.array(
      z.object({
        referralId: z.string().uuid(),
        program: z.enum(['BUYER', 'TRAVELER']),
        status: z.string(),
        refereeName: z.string(),
        rewardIdr: z.number().int(),
        createdAt: z.string(),
        rewardedAt: z.string().nullable(),
      }),
    ),
    referredBy: z.object({ referralId: z.string().uuid(), program: z.enum(['BUYER', 'TRAVELER']), status: z.string(), rewardIdr: z.number().int() }).nullable(),
  })
  .openapi('MyReferrals');
