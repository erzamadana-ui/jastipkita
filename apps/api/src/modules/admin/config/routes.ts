import { createRoute, z } from '@hono/zod-openapi';
import type { App } from '../../../context';
import { bearer, createRouter, errorResponses, jsonBody, jsonContent } from '../../../lib/openapi';
import { AdminLoose, adminCtx, adminGuard, IdParam, ReasonBody } from '../common';
import * as svc from './service';

const tags = ['Admin · Business config'];
const KeyParam = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/).openapi({ param: { name: 'key', in: 'path' }, example: 'pricing.platform_fee' }),
});
const ProposeBody = z
  .object({
    value: z.unknown().openapi({ description: 'Full value for the key (validated with @jastipkita/core validateBusinessConfig)' }),
    changeReason: z.string().trim().min(10).max(2000),
    isAssumption: z.boolean().default(false).openapi({ description: 'true = value not yet validated (contract/tax/legal); shown as ASSUMPTION in the UI' }),
    notes: z.string().trim().max(2000).optional(),
  })
  .openapi('AdminConfigProposal');

export function registerAdminConfig(app: App) {
  const r = createRouter();
  r.openapi(
    createRoute({
      method: 'get', path: '/v1/admin/config', tags, security: bearer,
      summary: 'All business config keys with the ACTIVE version and pending approvals',
      middleware: adminGuard(['config.read']),
      responses: { 200: jsonContent(AdminLoose), ...errorResponses },
    }),
    async (c) => c.json(await svc.listConfigs(await adminCtx(c)), 200),
  );
  r.openapi(
    createRoute({
      method: 'get', path: '/v1/admin/config/{key}', tags, security: bearer,
      summary: 'ACTIVE version + full history (each with a diff vs ACTIVE)',
      middleware: adminGuard(['config.read']),
      request: { params: KeyParam },
      responses: { 200: jsonContent(AdminLoose), ...errorResponses },
    }),
    async (c) => c.json(await svc.configDetail(await adminCtx(c), c.req.valid('param').key), 200),
  );
  r.openapi(
    createRoute({
      method: 'get', path: '/v1/admin/config/{key}/diff', tags, security: bearer,
      summary: 'Structural JSON diff of a version against ACTIVE (or `against`)',
      middleware: adminGuard(['config.read']),
      request: { params: KeyParam, query: z.object({ version: z.coerce.number().int().positive(), against: z.coerce.number().int().positive().optional() }) },
      responses: { 200: jsonContent(AdminLoose), ...errorResponses },
    }),
    async (c) => {
      const q = c.req.valid('query');
      return c.json(await svc.configDiff(await adminCtx(c), c.req.valid('param').key, q.version, q.against), 200);
    },
  );
  r.openapi(
    createRoute({
      method: 'post', path: '/v1/admin/config/{key}/versions', tags, security: bearer,
      summary: 'Propose a new version (PENDING_APPROVAL); one pending proposal per key',
      middleware: adminGuard(['config.propose'], { mfa: true }),
      request: { params: KeyParam, ...jsonBody(ProposeBody) },
      responses: { 201: jsonContent(AdminLoose, 'Proposed'), ...errorResponses },
    }),
    async (c) => c.json(await svc.proposeConfig(await adminCtx(c), c.req.valid('param').key, c.req.valid('json')), 201),
  );
  r.openapi(
    createRoute({
      method: 'post', path: '/v1/admin/config-versions/{id}/approve', tags, security: bearer,
      summary: 'Approve & activate (approver ≠ proposer, fresh MFA) → previous SUPERSEDED, config.activated, cache invalidated',
      middleware: adminGuard(['config.approve'], { mfa: true }),
      request: { params: IdParam },
      responses: { 200: jsonContent(AdminLoose), ...errorResponses },
    }),
    async (c) => c.json(await svc.approveConfig(await adminCtx(c), c.req.valid('param').id), 200),
  );
  r.openapi(
    createRoute({
      method: 'post', path: '/v1/admin/config-versions/{id}/reject', tags, security: bearer,
      summary: 'Reject a pending version (reason)',
      middleware: adminGuard(['config.approve'], { mfa: true }),
      request: { params: IdParam, ...jsonBody(ReasonBody) },
      responses: { 200: jsonContent(AdminLoose), ...errorResponses },
    }),
    async (c) => c.json(await svc.rejectConfig(await adminCtx(c), c.req.valid('param').id, c.req.valid('json').reason), 200),
  );
  app.route('/', r);
}
