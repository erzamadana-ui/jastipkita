import { createRoute, z } from '@hono/zod-openapi';
import type { App } from '../../context';
import { bearer, createRouter, errorResponses, jsonBody, jsonContent } from '../../lib/openapi';
import { getAuth, requireAuth } from '../../middleware/auth';
import {
  NotificationListQuery,
  NotificationPage,
  PreferencesSchema,
  PreferencesUpdateSchema,
  ReadAllResultSchema,
  ReadResultSchema,
  UnreadCountSchema,
} from './schemas';
import * as svc from './service';

const tags = ['Notifications'];
const IdParam = z.object({ id: z.string().uuid().openapi({ param: { name: 'id', in: 'path' } }) });

export function registerNotifications(app: App): void {
  const r = createRouter();

  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/notifications',
      tags,
      summary: 'In-app notification inbox (newest first, cursor pagination)',
      security: bearer,
      middleware: [requireAuth] as const,
      request: { query: NotificationListQuery },
      responses: { 200: jsonContent(NotificationPage), ...errorResponses },
    }),
    async (c) => c.json(await svc.listNotifications(c.get('deps'), getAuth(c), c.req.valid('query')), 200),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/notifications/unread-count',
      tags,
      summary: 'Number of unread in-app notifications (badge)',
      security: bearer,
      middleware: [requireAuth] as const,
      responses: { 200: jsonContent(UnreadCountSchema), ...errorResponses },
    }),
    async (c) => c.json(await svc.unreadCount(c.get('deps'), getAuth(c)), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/notifications/{id}/read',
      tags,
      summary: 'Mark one notification as read',
      security: bearer,
      middleware: [requireAuth] as const,
      request: { params: IdParam },
      responses: { 200: jsonContent(ReadResultSchema), ...errorResponses },
    }),
    async (c) => c.json(await svc.markRead(c.get('deps'), getAuth(c), c.req.valid('param').id), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/notifications/read-all',
      tags,
      summary: 'Mark every in-app notification as read',
      security: bearer,
      middleware: [requireAuth] as const,
      responses: { 200: jsonContent(ReadAllResultSchema), ...errorResponses },
    }),
    async (c) => c.json(await svc.markAllRead(c.get('deps'), getAuth(c)), 200),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/notifications/preferences',
      tags,
      summary: 'Notification preferences per group (TRANSACTION, PAYMENT, CHAT, PROMOTION, ACCOUNT) × channel (PUSH, EMAIL, IN_APP)',
      description: 'locked = transaction-critical channel that cannot be disabled. Critical templates (payment secured, refund, dispute, price change) are always delivered by e-mail.',
      security: bearer,
      middleware: [requireAuth] as const,
      responses: { 200: jsonContent(PreferencesSchema), ...errorResponses },
    }),
    async (c) => c.json(await svc.getPreferences(c.get('deps'), getAuth(c)), 200),
  );

  r.openapi(
    createRoute({
      method: 'put',
      path: '/v1/notifications/preferences',
      tags,
      summary: 'Update notification preferences (partial; locked channels cannot be disabled → 422 PREFERENCE_LOCKED)',
      security: bearer,
      middleware: [requireAuth] as const,
      request: jsonBody(PreferencesUpdateSchema),
      responses: { 200: jsonContent(PreferencesSchema), ...errorResponses },
    }),
    async (c) => c.json(await svc.updatePreferences(c.get('deps'), getAuth(c), c.req.valid('json').preferences), 200),
  );

  app.route('/', r);
}
