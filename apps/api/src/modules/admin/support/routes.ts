import { createRoute, z } from '@hono/zod-openapi';
import type { App } from '../../../context';
import { bearer, createRouter, errorResponses, jsonBody, jsonContent } from '../../../lib/openapi';
import { AdminLoose, AdminPage, adminCtx, adminGuard, IdParam, PageQuery, ReasonBody, StatusCsvQuery } from '../common';
import * as svc from './service';

const tags = ['Admin · Support'];
const modTags = ['Admin · Chat moderation'];
const TicketStatus = z.enum(['OPEN', 'PENDING_USER', 'IN_PROGRESS', 'RESOLVED', 'CLOSED']);

export function registerAdminSupport(app: App) {
  const r = createRouter();
  r.openapi(
    createRoute({
      method: 'get', path: '/v1/admin/support/tickets', tags, security: bearer,
      summary: 'Ticket queue (default open statuses) with SLA state',
      middleware: adminGuard(['support.tickets.manage']),
      request: { query: PageQuery.extend({ status: StatusCsvQuery, priority: z.string().max(60).optional(), assignee: z.string().max(40).optional(), sla: z.enum(['BREACHED', 'DUE_SOON']).optional() }) },
      responses: { 200: jsonContent(AdminPage), ...errorResponses },
    }),
    async (c) => c.json(await svc.ticketQueue(await adminCtx(c), c.req.valid('query')), 200),
  );
  r.openapi(
    createRoute({
      method: 'get', path: '/v1/admin/support/sla', tags, security: bearer,
      summary: 'SLA view per priority (support.sla config) + 30-day first-response stats',
      middleware: adminGuard(['support.tickets.manage']),
      responses: { 200: jsonContent(AdminLoose), ...errorResponses },
    }),
    async (c) => c.json(await svc.slaView(await adminCtx(c)), 200),
  );
  r.openapi(
    createRoute({
      method: 'get', path: '/v1/admin/support/tickets/{id}', tags, security: bearer,
      summary: 'Ticket detail incl. internal notes',
      middleware: adminGuard(['support.tickets.manage']),
      request: { params: IdParam },
      responses: { 200: jsonContent(AdminLoose), ...errorResponses },
    }),
    async (c) => c.json(await svc.ticketDetail(await adminCtx(c), c.req.valid('param').id), 200),
  );
  r.openapi(
    createRoute({
      method: 'post', path: '/v1/admin/support/tickets/{id}/assign', tags, security: bearer,
      summary: 'Assign (default me)',
      middleware: adminGuard(['support.tickets.manage']),
      request: { params: IdParam, ...jsonBody(z.object({ assigneeId: z.string().uuid().optional() })) },
      responses: { 200: jsonContent(AdminLoose), ...errorResponses },
    }),
    async (c) => c.json(await svc.assignTicket(await adminCtx(c), c.req.valid('param').id, c.req.valid('json').assigneeId), 200),
  );
  r.openapi(
    createRoute({
      method: 'post', path: '/v1/admin/support/tickets/{id}/reply', tags, security: bearer,
      summary: 'Reply (public → user notified; internal note never shown to the user)',
      middleware: adminGuard(['support.tickets.manage']),
      request: { params: IdParam, ...jsonBody(z.object({ body: z.string().trim().min(1).max(5000), internal: z.boolean().default(false), status: TicketStatus.optional() }).openapi('AdminTicketReply')) },
      responses: { 200: jsonContent(AdminLoose), ...errorResponses },
    }),
    async (c) => c.json(await svc.replyTicket(await adminCtx(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );
  r.openapi(
    createRoute({
      method: 'patch', path: '/v1/admin/support/tickets/{id}', tags, security: bearer,
      summary: 'Change status and/or priority (SLA recalculated while no first response)',
      middleware: adminGuard(['support.tickets.manage']),
      request: { params: IdParam, ...jsonBody(z.object({ status: TicketStatus.optional(), priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).optional(), note: z.string().trim().max(1000).optional() })) },
      responses: { 200: jsonContent(AdminLoose), ...errorResponses },
    }),
    async (c) => c.json(await svc.updateTicket(await adminCtx(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );

  r.openapi(
    createRoute({
      method: 'get', path: '/v1/admin/chat/flagged', tags: modTags, security: bearer,
      summary: 'Moderation queue (default FLAGGED) — masked text only',
      middleware: adminGuard(['chat.moderate']),
      request: { query: PageQuery.extend({ status: StatusCsvQuery }) },
      responses: { 200: jsonContent(AdminPage), ...errorResponses },
    }),
    async (c) => c.json(await svc.flaggedQueue(await adminCtx(c), c.req.valid('query')), 200),
  );
  r.openapi(
    createRoute({
      method: 'post', path: '/v1/admin/chat/messages/{id}/reveal', tags: modTags, security: bearer,
      summary: 'Original text of a FLAGGED/HIDDEN message (audited chat.message_revealed)',
      middleware: adminGuard(['chat.moderate']),
      request: { params: IdParam, ...jsonBody(ReasonBody) },
      responses: { 200: jsonContent(AdminLoose), ...errorResponses },
    }),
    async (c) => c.json(await svc.revealMessage(await adminCtx(c), c.req.valid('param').id, c.req.valid('json').reason), 200),
  );
  r.openapi(
    createRoute({
      method: 'post', path: '/v1/admin/chat/messages/{id}/hide', tags: modTags, security: bearer,
      summary: 'Hide a message ("Pesan disembunyikan oleh moderator.")',
      middleware: adminGuard(['chat.moderate']),
      request: { params: IdParam, ...jsonBody(ReasonBody) },
      responses: { 200: jsonContent(AdminLoose), ...errorResponses },
    }),
    async (c) => c.json(await svc.hideMessage(await adminCtx(c), c.req.valid('param').id, c.req.valid('json').reason), 200),
  );
  r.openapi(
    createRoute({
      method: 'post', path: '/v1/admin/chat/messages/{id}/unhide', tags: modTags, security: bearer,
      summary: 'Unhide (restores FLAGGED or CLEAN)',
      middleware: adminGuard(['chat.moderate']),
      request: { params: IdParam, ...jsonBody(ReasonBody) },
      responses: { 200: jsonContent(AdminLoose), ...errorResponses },
    }),
    async (c) => c.json(await svc.unhideMessage(await adminCtx(c), c.req.valid('param').id, c.req.valid('json').reason), 200),
  );
  r.openapi(
    createRoute({
      method: 'get', path: '/v1/admin/chat/conversations/{id}/messages', tags: modTags, security: bearer,
      summary: 'Read a conversation — only when linked to an OPEN dispute or OPEN ticket (disputeId/ticketId required; audited)',
      middleware: adminGuard(['chat.moderate']),
      request: {
        params: IdParam,
        query: z.object({ disputeId: z.string().uuid().optional(), ticketId: z.string().uuid().optional(), reason: z.string().trim().min(5).max(500), limit: z.coerce.number().int().min(1).max(500).default(200) }),
      },
      responses: { 200: jsonContent(AdminLoose), ...errorResponses },
    }),
    async (c) => c.json(await svc.readConversation(await adminCtx(c), c.req.valid('param').id, c.req.valid('query')), 200),
  );
  app.route('/', r);
}
