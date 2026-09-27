import { createRoute, z } from '@hono/zod-openapi';
import type { App } from '../../context';
import { bearer, createRouter, errorResponses, jsonBody, jsonContent } from '../../lib/openapi';
import { PageQuery } from '../../lib/pagination';
import { getAuth, requireAuth } from '../../middleware/auth';
import { rateLimit } from '../../middleware/rate-limit';
import { ConversationLookupSchema, ConversationPage, ConversationSchema, MarkReadResult, MarkReadSchema, MessagePage, MessageSchema, SendMessageSchema } from './schemas';
import * as svc from './service';

const tags = ['Chat'];
const IdParam = z.object({ id: z.string().uuid().openapi({ param: { name: 'id', in: 'path' } }) });

export function registerChat(app: App): void {
  const r = createRouter();

  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/conversations',
      tags,
      summary: 'My conversations (one per transaction, created automatically at MATCHED)',
      security: bearer,
      middleware: [requireAuth] as const,
      request: { query: PageQuery },
      responses: { 200: jsonContent(ConversationPage), ...errorResponses },
    }),
    async (c) => c.json(await svc.listConversations(c.get('deps'), getAuth(c), c.req.valid('query')), 200),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/conversations/{id}',
      tags,
      summary: 'One conversation (participants only; 404 otherwise)',
      security: bearer,
      middleware: [requireAuth] as const,
      request: { params: IdParam },
      responses: { 200: jsonContent(ConversationSchema), ...errorResponses },
    }),
    async (c) => c.json(await svc.getConversation(c.get('deps'), getAuth(c), c.req.valid('param').id), 200),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/transactions/{id}/conversation',
      tags,
      summary: 'Conversation of a transaction (parties only); created lazily when the transaction reached MATCHED',
      description: '409 CONVERSATION_NOT_AVAILABLE when the transaction never reached MATCHED (no traveler yet).',
      security: bearer,
      middleware: [requireAuth] as const,
      request: { params: IdParam },
      responses: { 200: jsonContent(ConversationLookupSchema), ...errorResponses },
    }),
    async (c) => c.json(await svc.conversationForTransaction(c.get('deps'), getAuth(c), c.req.valid('param').id), 200),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/conversations/{id}/messages',
      tags,
      summary: 'Messages of a conversation (participants only; newest first, cursor pagination)',
      security: bearer,
      middleware: [requireAuth] as const,
      request: { params: IdParam, query: PageQuery },
      responses: { 200: jsonContent(MessagePage), ...errorResponses },
    }),
    async (c) => c.json(await svc.listMessages(c.get('deps'), getAuth(c), c.req.valid('param').id, c.req.valid('query')), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/conversations/{id}/messages',
      tags,
      summary: 'Send a message (TEXT, IMAGE, PRODUCT, RECEIPT). Off-platform payment / contact sharing is flagged and masked.',
      security: bearer,
      middleware: [requireAuth, rateLimit({ name: 'chat.send', limit: 30, windowSec: 60, key: 'user' })] as const,
      request: { params: IdParam, ...jsonBody(SendMessageSchema) },
      responses: { 201: jsonContent(MessageSchema, 'Created'), ...errorResponses },
    }),
    async (c) => c.json(await svc.sendMessage(c.get('deps'), getAuth(c), c.req.valid('param').id, c.req.valid('json')), 201),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/conversations/{id}/read',
      tags,
      summary: 'Mark messages read (up to messageId, default the latest)',
      security: bearer,
      middleware: [requireAuth] as const,
      request: { params: IdParam, body: { content: { 'application/json': { schema: MarkReadSchema } }, required: false } },
      responses: { 200: jsonContent(MarkReadResult), ...errorResponses },
    }),
    async (c) => {
      // body is optional: without one, everything up to the latest message is marked read
      const body = (c.req.valid('json') as { messageId?: string } | undefined) ?? {};
      return c.json(await svc.markRead(c.get('deps'), getAuth(c), c.req.valid('param').id, body.messageId), 200);
    },
  );

  app.route('/', r);
}
