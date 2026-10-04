import { StepUpProof } from '../auth/schemas';
import { z } from '@hono/zod-openapi';

export const KycSubmissionSchema = z
  .object({
    id: z.string().uuid(),
    targetLevel: z.number().int(),
    idType: z.enum(['KTP', 'PASSPORT']).nullable(),
    status: z.enum(['PENDING', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'EXPIRED']),
    provider: z.string(),
    providerEnv: z.enum(['TEST', 'LIVE']),
    submittedAt: z.string().nullable(),
    reviewedAt: z.string().nullable(),
    decisionReason: z.string().nullable(),
    rejectionCode: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi('KycSubmission');

export const RequirementSchema = z.object({ code: z.string(), met: z.boolean(), description: z.string() });

export const KycStatusSchema = z
  .object({
    level: z.number().int(),
    levelCode: z.string(),
    next: z
      .object({
        level: z.number().int(),
        levelCode: z.string(),
        evaluatedBy: z.enum(['USER_ACTION', 'SYSTEM']),
        requirements: z.array(RequirementSchema),
      })
      .nullable(),
    kycConsentGranted: z.boolean(),
    submissions: z.array(KycSubmissionSchema),
  })
  .openapi('KycStatus');

export const KycSubmissionBody = z
  .object({
    idType: z.enum(['KTP', 'PASSPORT']),
    idNumber: z.string().trim().min(5).max(32).openapi({ description: 'KTP: 16-digit NIK; passport: 6–9 alphanumerics' }),
    fullName: z.string().trim().min(2).max(120),
    dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).openapi({ example: '1990-05-17' }),
    nationality: z.string().regex(/^[A-Z]{2}$/).optional().openapi({ description: 'ISO-3166 alpha-2; KTP implies ID' }),
    documents: z.object({
      idFront: z.string().uuid().openapi({ description: 'File id (purpose KYC) of the KTP / passport photo page' }),
      idBack: z.string().uuid().optional(),
      selfie: z.string().uuid(),
      liveness: z.string().uuid().optional().openapi({ description: 'Legacy single liveness capture (file id, purpose KYC). Prefer livenessFileIds.' }),
      livenessFileId: z.string().uuid().optional().openapi({ description: 'Alias of `liveness` (legacy single liveness capture)' }),
      livenessFileIds: z
        .array(z.string().uuid())
        .min(1)
        .max(5)
        .optional()
        .openapi({ description: '1–5 liveness captures (file ids, purpose KYC, READY, owned by the caller), in capture order. May be combined with the legacy single field (deduplicated; max 5 in total).' }),
    }),
  })
  .openapi('KycSubmissionInput');

export const PayoutAccountSchema = z
  .object({
    id: z.string().uuid(),
    bankCode: z.string(),
    accountMask: z.string().openapi({ example: '****0961' }),
    holderName: z.string(),
    verificationStatus: z.enum(['UNVERIFIED', 'PENDING', 'VERIFIED', 'FAILED', 'NAME_MISMATCH']),
    isDefault: z.boolean(),
    verifiedAt: z.string().nullable(),
    payoutsFrom: z
      .string()
      .nullable()
      .openapi({
        description:
          'New-account cooldown (anti account-takeover, money.policy.newPayoutAccountCooldownHours): no payout is sent to this account before this time — ' +
          'latest of added / verified / made default + cooldown. null once it has passed.',
      }),
    createdAt: z.string(),
  })
  .openapi('PayoutAccount');

export const PayoutAccountBody = z
  .object({
    bankCode: z.string().trim().toUpperCase().regex(/^[A-Z0-9_]{2,20}$/).openapi({ example: 'BCA' }),
    accountNumber: z.string().trim().regex(/^\d{6,20}$/),
    holderName: z.string().trim().min(2).max(120),
    makeDefault: z.boolean().optional(),
    stepUp: StepUpProof.optional().openapi({ description: 'Required (SEC-12): SENSITIVE_ACTION OTP for action PAYOUT_ACCOUNT_ADD, targetId = own user id' }),
  })
  .openapi('PayoutAccountInput');

export const PayoutDefaultBody = z
  .object({ stepUp: StepUpProof.optional().openapi({ description: 'Required unless already default: SENSITIVE_ACTION OTP for PAYOUT_ACCOUNT_SET_DEFAULT, targetId = account id' }) })
  .openapi('PayoutAccountDefaultInput');
