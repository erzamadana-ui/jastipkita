import { z } from '@hono/zod-openapi';
import { PageQuery } from '../../lib/pagination';

export const FAQ_CATEGORIES = ['GENERAL', 'BUYER', 'TRAVELER', 'PAYMENT', 'CUSTOMS', 'DELIVERY', 'DISPUTE', 'ACCOUNT', 'REFERRAL'] as const;
/** COMPLAINT = consumer complaint channel ("Layanan Pengaduan Konsumen", Permendag 19/2026 · UU 8/1999), migration 0130. */
export const TICKET_CATEGORIES = ['TRANSACTION', 'DISPUTE', 'REFUND', 'ACCOUNT', 'PAYMENT', 'CUSTOMS', 'OTHER', 'COMPLAINT'] as const;
export const TICKET_STATUSES = ['OPEN', 'PENDING_USER', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'] as const;
export const TICKET_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;
/** Priorities a user may choose when filing; URGENT is set by agents only. */
export const USER_TICKET_PRIORITIES = ['LOW', 'NORMAL', 'HIGH'] as const;

export const FaqQuery = z.object({
  locale: z.enum(['id', 'en']).default('id'),
  category: z.enum(FAQ_CATEGORIES).optional(),
  q: z.string().trim().min(2).max(100).optional().openapi({ description: 'Full-text-ish search (pg_trgm word similarity)' }),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const FaqItem = z
  .object({
    slug: z.string(),
    locale: z.enum(['id', 'en']),
    category: z.enum(FAQ_CATEGORIES),
    question: z.string(),
    excerpt: z.string(),
    tags: z.array(z.string()),
    score: z.number().nullable(),
  })
  .openapi('FaqItem');
export const FaqList = z.object({ data: z.array(FaqItem) }).openapi('FaqList');
export const FaqArticle = z
  .object({ slug: z.string(), locale: z.enum(['id', 'en']), category: z.enum(FAQ_CATEGORIES), question: z.string(), answerMd: z.string(), tags: z.array(z.string()), updatedAt: z.string() })
  .openapi('FaqArticle');
export const LocaleQuery = z.object({ locale: z.enum(['id', 'en']).default('id') });

export const CreateTicketSchema = z
  .object({
    category: z.enum(TICKET_CATEGORIES),
    subject: z.string().trim().min(3).max(200),
    message: z.string().trim().min(1).max(5000),
    transactionId: z.string().uuid().optional(),
    disputeId: z.string().uuid().optional(),
    fileIds: z.array(z.string().uuid()).max(5).optional(),
    priority: z.enum(USER_TICKET_PRIORITIES).optional().openapi({
      description: 'Optional. Default: HIGH for COMPLAINT / DISPUTE / REFUND / PAYMENT, NORMAL otherwise. URGENT is agent-only (400).',
    }),
  })
  .openapi('CreateSupportTicket');

export const TicketMessageSchema = z.object({ body: z.string().trim().min(1).max(5000), fileIds: z.array(z.string().uuid()).max(5).optional() }).openapi('CreateTicketMessage');

export const TicketSchema = z
  .object({
    id: z.string().uuid(),
    number: z.string(),
    category: z.enum(TICKET_CATEGORIES),
    subject: z.string(),
    status: z.enum(TICKET_STATUSES),
    priority: z.enum(TICKET_PRIORITIES),
    transactionId: z.string().uuid().nullable(),
    disputeId: z.string().uuid().nullable(),
    slaDueAt: z.string().nullable(),
    firstResponseAt: z.string().nullable(),
    resolvedAt: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi('SupportTicket');

export const TicketDetailSchema = TicketSchema.extend({
  messages: z.array(
    z.object({ id: z.string().uuid(), authorType: z.enum(['USER', 'AGENT', 'SYSTEM']), mine: z.boolean(), body: z.string(), attachments: z.array(z.object({ fileId: z.string().uuid(), mime: z.string() })), createdAt: z.string() }),
  ),
}).openapi('SupportTicketDetail');

export const TicketPage = z.object({ data: z.array(TicketSchema), nextCursor: z.string().nullable() }).openapi('SupportTicketPage');
export const TicketListQuery = PageQuery.extend({ status: z.enum(TICKET_STATUSES).optional() });

const Hours = z.number().int().positive();

export const ComplaintInfoSchema = z
  .object({
    channels: z.object({
      inApp: z.object({
        ticketCategory: z.literal('COMPLAINT'),
        endpoint: z.literal('/v1/support/tickets').openapi({ description: 'POST with category COMPLAINT (bearer)' }),
      }),
      whatsapp: z
        .object({ number: z.string().openapi({ example: '628117805600' }), url: z.string() })
        .nullable()
        .openapi({ description: 'Env SUPPORT_WHATSAPP; null while the channel is not announced yet' }),
      email: z.string().nullable().openapi({ description: 'Env SUPPORT_EMAIL; null while not announced yet' }),
      webUrl: z.string().openapi({ description: 'Public page with channels, SLA and process (WEB_BASE_URL/pengaduan/)' }),
    }),
    sla: z.object({
      basis: z.literal('FIRST_RESPONSE').openapi({ description: 'Target = first public agent response (sla_due_at), not resolution' }),
      complaintPriority: z.enum(TICKET_PRIORITIES).openapi({ description: 'Default priority of a COMPLAINT ticket' }),
      complaintFirstResponseHours: Hours,
      hoursByPriority: z.object({ URGENT: Hours, HIGH: Hours, NORMAL: Hours, LOW: Hours }),
      configKey: z.literal('support.sla'),
      isAssumption: z.boolean().openapi({ description: 'true while the SLA is an internal assumption (pre-launch), not a contractual commitment' }),
    }),
    escalation: z.object({
      authority: z.string(),
      unit: z.string(),
      ministry: z.string(),
      whatsapp: z.object({ number: z.string(), display: z.string(), url: z.string() }),
      email: z.string(),
      phone: z.object({ number: z.string(), display: z.string() }),
      website: z.string(),
      verification: z.object({
        status: z.enum(['VERIFIED', 'NEEDS_VERIFICATION']),
        accessedAt: z.string().openapi({ description: 'Date the contact data was checked against the sources (YYYY-MM-DD)' }),
        sources: z.array(z.string()),
      }),
      outOfCourt: z.string().openapi({ description: 'Out-of-court dispute body under UU 8/1999 (BPSK)' }),
    }),
    disputeFlow: z.object({
      endpoint: z.literal('/v1/transactions/{id}/disputes'),
      note: z.string(),
    }),
    legalBasis: z.array(z.string()),
  })
  .openapi('ComplaintInfo');
