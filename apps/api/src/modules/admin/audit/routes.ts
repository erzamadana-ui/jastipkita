import { createRoute, z } from '@hono/zod-openapi';
import type { App } from '../../../context';
import { bearer, createRouter, errorResponses, jsonContent } from '../../../lib/openapi';
import { AdminLoose, AdminPage, adminCtx, adminGuard } from '../common';
import { currentAlerts, systemHealth } from '../system/service';
import * as svc from './service';

const DateQ = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional();

export function registerAdminAudit(app: App) {
  const r = createRouter();
  r.openapi(
    createRoute({
      method: 'get', path: '/v1/admin/audit-logs', tags: ['Admin · Audit'], security: bearer,
      summary: 'Audit log (newest first; filter actor/entity/action (prefix with *)/date WIB; cursor = last id)',
      middleware: adminGuard(['audit.read']),
      request: {
        query: z.object({
          actorId: z.string().uuid().optional(),
          actorType: z.enum(['USER', 'BUYER', 'TRAVELER', 'ADMIN', 'SYSTEM', 'WEBHOOK', 'JOB']).optional(),
          entityType: z.string().max(60).optional(),
          entityId: z.string().max(100).optional(),
          action: z.string().max(100).optional().openapi({ example: 'finance.*' }),
          from: DateQ,
          to: DateQ,
          limit: z.coerce.number().int().min(1).max(200).default(50),
          cursor: z.string().max(30).optional(),
        }),
      },
      responses: { 200: jsonContent(AdminPage), ...errorResponses },
    }),
    async (c) => c.json(await svc.listAudit(await adminCtx(c), c.req.valid('query')), 200),
  );
  r.openapi(
    createRoute({
      method: 'get', path: '/v1/admin/audit-logs/verify', tags: ['Admin · Audit'], security: bearer,
      summary: 'Run verify_audit_chain() (optionally a range) → OK / BROKEN + first broken id',
      middleware: adminGuard(['audit.read']),
      request: { query: z.object({ fromId: z.coerce.number().int().positive().optional(), toId: z.coerce.number().int().positive().optional() }) },
      responses: { 200: jsonContent(AdminLoose), ...errorResponses },
    }),
    async (c) => c.json(await svc.verifyAudit(await adminCtx(c), c.req.valid('query')), 200),
  );

  r.openapi(
    createRoute({
      method: 'get', path: '/v1/admin/system/health', tags: ['Admin · System'], security: bearer,
      summary: 'Outbox backlog, jobs, webhook/refund/payout failures, notification failure rate, security events, integration modes, audit chain',
      middleware: adminGuard(['infra.db.read']),
      responses: { 200: jsonContent(AdminLoose), ...errorResponses },
    }),
    async (c) => c.json((await systemHealth(c.get('deps'))) as unknown as Record<string, never>, 200),
  );
  r.openapi(
    createRoute({
      method: 'get', path: '/v1/admin/system/alerts', tags: ['Admin · System'], security: bearer,
      summary: 'Active alert conditions (thresholds in docs/06-observability.md) with first-seen/occurrences from the alert job',
      middleware: adminGuard(['infra.db.read']),
      responses: { 200: jsonContent(AdminLoose), ...errorResponses },
    }),
    async (c) => c.json((await currentAlerts(c.get('deps'))) as unknown as Record<string, never>, 200),
  );
  app.route('/', r);
}
