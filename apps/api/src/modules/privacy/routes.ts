import { createRoute, z } from '@hono/zod-openapi';
import type { App } from '../../context';
import { bearer, createRouter, errorResponses, jsonBody, jsonContent } from '../../lib/openapi';
import { getAuth, requireAuth } from '../../middleware/auth';
import { rateLimit } from '../../middleware/rate-limit';
import { requestMeta, requireAuthAllowPendingDeletion } from '../auth/common';
import * as svc from './service';

const tags = ['Privacy'];

export const PrivacyRequestSchema = z
  .object({
    id: z.string().uuid(),
    type: z.enum(['EXPORT', 'DELETION', 'CORRECTION', 'CONSENT_WITHDRAWAL']),
    status: z.enum(['RECEIVED', 'VERIFYING', 'IN_PROGRESS', 'COMPLETED', 'REJECTED', 'CANCELLED']),
    dueAt: z.string(),
    scheduledFor: z.string().nullable().openapi({ description: 'DELETION: end of the 14-day grace period' }),
    completedAt: z.string().nullable(),
    rejectionReason: z.string().nullable(),
    exportFileId: z.string().uuid().nullable().openapi({ description: 'EXPORT: download via GET /v1/files/{id}/url' }),
    createdAt: z.string(),
  })
  .openapi('PrivacyRequest');

export function registerPrivacy(app: App) {
  const r = createRouter();

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/privacy/export',
      tags,
      summary: 'Request a copy of my data (UU PDP right of access)',
      description: 'Processed asynchronously; `privacy.export_ready` is emitted when the encrypted JSON export (7-day retention) is available.',
      security: bearer,
      middleware: [requireAuth, rateLimit({ name: 'privacy.export', limit: 3, windowSec: 3600, key: 'user' })] as const,
      responses: { 202: jsonContent(PrivacyRequestSchema, 'Accepted'), ...errorResponses },
    }),
    async (c) => c.json(await svc.requestExport(c.get('deps'), getAuth(c), await requestMeta(c)), 202),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/privacy/requests',
      tags,
      summary: 'My privacy requests',
      description: 'Also available while the account is PENDING_DELETION.',
      security: bearer,
      middleware: [requireAuthAllowPendingDeletion] as const,
      responses: { 200: jsonContent(z.object({ data: z.array(PrivacyRequestSchema) })), ...errorResponses },
    }),
    async (c) => c.json({ data: await svc.listRequests(c.get('deps'), getAuth(c)) }, 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/privacy/delete-account',
      tags,
      summary: 'Request account deletion (14-day grace period)',
      description:
        'Refused (409 DELETION_BLOCKED) while transactions, disputes, refunds or payouts are open. Otherwise the account becomes PENDING_DELETION, ' +
        'every session is revoked and anonymization runs after 14 days unless cancelled (log in again → POST /v1/privacy/cancel-deletion).',
      security: bearer,
      middleware: [requireAuth] as const,
      request: jsonBody(z.object({ confirm: z.literal(true), reason: z.string().max(500).optional() }).openapi('DeleteAccount')),
      responses: { 202: jsonContent(z.object({ request: PrivacyRequestSchema, effectiveAt: z.string() }), 'Scheduled'), ...errorResponses },
    }),
    async (c) => c.json(await svc.requestDeletion(c.get('deps'), getAuth(c), c.req.valid('json'), await requestMeta(c)), 202),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/privacy/cancel-deletion',
      tags,
      summary: 'Cancel a scheduled account deletion',
      security: bearer,
      middleware: [requireAuthAllowPendingDeletion] as const,
      responses: { 200: jsonContent(PrivacyRequestSchema), ...errorResponses },
    }),
    async (c) => c.json(await svc.cancelDeletion(c.get('deps'), getAuth(c), await requestMeta(c)), 200),
  );

  app.route('/', r);
}
