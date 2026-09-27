import { z } from '@hono/zod-openapi';
import { DISPUTE_RESOLUTIONS, DISPUTE_STATUSES, DISPUTE_TYPES } from '@jastipkita/core';
import { PageQuery } from '../../lib/pagination';

export const EVIDENCE_TYPES = ['PHOTO', 'VIDEO', 'RECEIPT', 'CHAT', 'TRACKING', 'DELIVERY_PROOF', 'OTHER'] as const;

export const OpenDisputeSchema = z
  .object({
    type: z.enum(DISPUTE_TYPES),
    description: z.string().trim().min(10).max(5000),
    requestedResolution: z.enum(DISPUTE_RESOLUTIONS).optional(),
  })
  .openapi('OpenDispute');

export const AddEvidenceSchema = z
  .object({
    type: z.enum(EVIDENCE_TYPES),
    fileId: z.string().uuid().optional(),
    messageId: z.string().uuid().optional(),
    note: z.string().trim().max(4000).optional(),
  })
  .refine((v) => v.fileId || v.messageId || v.note, { message: 'fileId, messageId atau note wajib diisi' })
  .openapi('AddDisputeEvidence');

export const AppealSchema = z.object({ reason: z.string().trim().min(10).max(2000) }).openapi('DisputeAppeal');
export const WithdrawSchema = z.object({ reason: z.string().trim().max(1000).optional() }).openapi('DisputeWithdraw');

export const EvidenceSchema = z
  .object({
    id: z.string().uuid(),
    party: z.enum(['BUYER', 'TRAVELER', 'ADMIN', 'SYSTEM']),
    type: z.enum(EVIDENCE_TYPES),
    fileId: z.string().uuid().nullable(),
    messageId: z.string().uuid().nullable(),
    note: z.string().nullable(),
    mine: z.boolean(),
    createdAt: z.string(),
  })
  .openapi('DisputeEvidence');

export const DisputeSchema = z
  .object({
    id: z.string().uuid(),
    number: z.string(),
    transactionId: z.string().uuid(),
    transactionNumber: z.string(),
    transactionStatus: z.string(),
    type: z.enum(DISPUTE_TYPES),
    status: z.enum(DISPUTE_STATUSES),
    description: z.string(),
    requestedResolution: z.enum(DISPUTE_RESOLUTIONS).nullable(),
    resolution: z.enum(DISPUTE_RESOLUTIONS).nullable(),
    resolutionAmountIdr: z.number().int().nullable(),
    resolutionNote: z.string().nullable(),
    openedByRole: z.enum(['BUYER', 'TRAVELER', 'ADMIN']),
    openedByMe: z.boolean(),
    myRole: z.enum(['BUYER', 'TRAVELER']),
    evidenceDueAt: z.string().nullable(),
    slaDueAt: z.string().nullable(),
    resolvedAt: z.string().nullable(),
    appealDeadline: z.string().nullable(),
    closedAt: z.string().nullable(),
    allowedActions: z.array(z.enum(['ADD_EVIDENCE', 'APPEAL', 'WITHDRAW'])),
    evidence: z.array(EvidenceSchema),
    timeline: z.array(z.object({ from: z.string().nullable(), to: z.string(), actorType: z.string(), at: z.string() })),
    createdAt: z.string(),
  })
  .openapi('Dispute');

export const DisputeSummarySchema = DisputeSchema.omit({ evidence: true, timeline: true }).openapi('DisputeSummary');
export const DisputePage = z.object({ data: z.array(DisputeSummarySchema), nextCursor: z.string().nullable() }).openapi('DisputePage');
export const DisputeListQuery = PageQuery.extend({ status: z.enum(DISPUTE_STATUSES).optional() });

export const WithdrawResultSchema = DisputeSchema.extend({
  transactionFollowUp: z.enum(['BUYER_CONFIRMED', 'ADMIN_REQUIRED']).openapi({
    description: 'BUYER_CONFIRMED: a buyer withdrew a dispute on a delivered item → the transaction resumes. ADMIN_REQUIRED: §4 has no DISPUTED → previous-status edge, ops restores the transaction.',
  }),
}).openapi('DisputeWithdrawResult');

export const FileUrlSchema = z.object({ url: z.string(), expiresAt: z.string() }).openapi('DisputeEvidenceFileUrl');
