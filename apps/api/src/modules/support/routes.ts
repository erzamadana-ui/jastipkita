import { createRoute, z } from '@hono/zod-openapi';
import type { App } from '../../context';
import { bearer, createRouter, errorResponses, jsonBody, jsonContent } from '../../lib/openapi';
import { getAuth, requireAuth } from '../../middleware/auth';
import { rateLimit } from '../../middleware/rate-limit';
import { CreateTicketSchema, FaqArticle, FaqList, FaqQuery, LocaleQuery, TicketDetailSchema, TicketListQuery, TicketMessageSchema, TicketPage } from './schemas';
import * as svc from './service';

const tags = ['Support'];
const IdParam = z.object({ id: z.string().uuid().openapi({ param: { name: 'id', in: 'path' } }) });
const SlugParam = z.object({ slug: z.string().regex(/^[a-z0-9-]{1,120}$/).openapi({ param: { name: 'slug', in: 'path' } }) });

export function registerSupport(app: App): void {
  const r = createRouter();
  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/support/faq',
      tags,
      summary: 'Published FAQ (locale with Indonesian fallback), optional category filter and search',
      middleware: [rateLimit({ name: 'support.faq', limit: 120, windowSec: 60 })] as const,
      request: { query: FaqQuery },
      responses: { 200: jsonContent(FaqList), ...errorResponses },
    }),
    async (c) => c.json(await svc.listFaq(c.get('deps'), c.req.valid('query')), 200),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/support/faq/{slug}',
      tags,
      summary: 'FAQ article (Markdown answer)',
      middleware: [rateLimit({ name: 'support.faq', limit: 120, windowSec: 60 })] as const,
      request: { params: SlugParam, query: LocaleQuery },
      responses: { 200: jsonContent(FaqArticle), ...errorResponses },
    }),
    async (c) => c.json(await svc.faqArticle(c.get('deps'), c.req.valid('param').slug, c.req.valid('query').locale), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/support/tickets',
      tags,
      summary: 'Create a support ticket (TKT-…), optionally linked to my transaction or dispute; SLA by priority',
      security: bearer,
      middleware: [requireAuth, rateLimit({ name: 'support.tickets', limit: 10, windowSec: 3600, key: 'user' })] as const,
      request: jsonBody(CreateTicketSchema),
      responses: { 201: jsonContent(TicketDetailSchema, 'Created'), ...errorResponses },
    }),
    async (c) => c.json(await svc.createTicket(c.get('deps'), getAuth(c), c.req.valid('json')), 201),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/support/tickets',
      tags,
      summary: 'My support tickets',
      security: bearer,
      middleware: [requireAuth] as const,
      request: { query: TicketListQuery },
      responses: { 200: jsonContent(TicketPage), ...errorResponses },
    }),
    async (c) => c.json(await svc.listTickets(c.get('deps'), getAuth(c), c.req.valid('query')), 200),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/support/tickets/{id}',
      tags,
      summary: 'Ticket detail with the public conversation (internal agent notes excluded)',
      security: bearer,
      middleware: [requireAuth] as const,
      request: { params: IdParam },
      responses: { 200: jsonContent(TicketDetailSchema), ...errorResponses },
    }),
    async (c) => c.json(await svc.getTicket(c.get('deps'), getAuth(c), c.req.valid('param').id), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/support/tickets/{id}/messages',
      tags,
      summary: 'Reply on my ticket (re-opens RESOLVED / PENDING_USER; CLOSED → 422)',
      security: bearer,
      middleware: [requireAuth, rateLimit({ name: 'support.messages', limit: 30, windowSec: 3600, key: 'user' })] as const,
      request: { params: IdParam, ...jsonBody(TicketMessageSchema) },
      responses: { 201: jsonContent(TicketDetailSchema, 'Created'), ...errorResponses },
    }),
    async (c) => c.json(await svc.addMessage(c.get('deps'), getAuth(c), c.req.valid('param').id, c.req.valid('json')), 201),
  );
  app.route('/', r);
}
