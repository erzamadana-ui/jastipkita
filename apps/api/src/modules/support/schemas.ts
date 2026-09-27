import { z } from '@hono/zod-openapi';
import { PageQuery } from '../../lib/pagination';

export const FAQ_CATEGORIES = ['GENERAL', 'BUYER', 'TRAVELER', 'PAYMENT', 'CUSTOMS', 'DELIVERY', 'DISPUTE', 'ACCOUNT', 'REFERRAL'] as const;
export const TICKET_CATEGORIES = ['TRANSACTION', 'DISPUTE', 'REFUND', 'ACCOUNT', 'PAYMENT', 'CUSTOMS', 'OTHER'] as const;
export const TICKET_STATUSES = ['OPEN', 'PENDING_USER', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'] as const;

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
    priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']),
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
