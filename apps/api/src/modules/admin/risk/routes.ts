import { createRoute, z } from '@hono/zod-openapi';
import type { App } from '../../../context';
import { bearer, createRouter, errorResponses, jsonBody, jsonContent } from '../../../lib/openapi';
import { AdminLoose, AdminPage, adminCtx, adminGuard, IdParam, PageQuery, StatusCsvQuery } from '../common';
import * as svc from './service';

const riskTags = ['Admin · Risk'];
const trustTags = ['Admin · Trust score'];

export function registerAdminRisk(app: App) {
  const r = createRouter();
  r.openapi(
    createRoute({
      method: 'get', path: '/v1/admin/risk/reviews', tags: riskTags, security: bearer,
      summary: 'Risk review queue (default OPEN,IN_REVIEW) with assessment reasons & signals',
      middleware: adminGuard(['risk.read']),
      request: { query: PageQuery.extend({ status: StatusCsvQuery, subjectType: z.string().max(100).optional(), assignee: z.string().max(40).optional() }) },
      responses: { 200: jsonContent(AdminPage), ...errorResponses },
    }),
    async (c) => c.json(await svc.reviewQueue(await adminCtx(c), c.req.valid('query')), 200),
  );
  r.openapi(
    createRoute({
      method: 'get', path: '/v1/admin/risk/reviews/{id}', tags: riskTags, security: bearer,
      summary: 'Review detail: subject, involved users (masked), assessment history',
      middleware: adminGuard(['risk.read']),
      request: { params: IdParam },
      responses: { 200: jsonContent(AdminLoose), ...errorResponses },
    }),
    async (c) => c.json(await svc.reviewDetail(await adminCtx(c), c.req.valid('param').id), 200),
  );
  r.openapi(
    createRoute({
      method: 'post', path: '/v1/admin/risk/reviews/{id}/assign', tags: riskTags, security: bearer,
      summary: 'Assign (default me) → IN_REVIEW',
      middleware: adminGuard(['risk.review']),
      request: { params: IdParam, ...jsonBody(z.object({ assigneeId: z.string().uuid().optional() })) },
      responses: { 200: jsonContent(AdminLoose), ...errorResponses },
    }),
    async (c) => c.json(await svc.assignReview(await adminCtx(c), c.req.valid('param').id, c.req.valid('json').assigneeId), 200),
  );
  r.openapi(
    createRoute({
      method: 'post', path: '/v1/admin/risk/reviews/{id}/resolve', tags: riskTags, security: bearer,
      summary: 'Resolve CLEARED / CONFIRMED_FRAUD (+ suspendUser, needs users.suspend) → risk.review_resolved; payout holds updated',
      middleware: adminGuard(['risk.review'], { mfa: true }),
      request: { params: IdParam, ...jsonBody(z.object({ outcome: z.enum(['CLEARED', 'CONFIRMED_FRAUD']), notes: z.string().trim().min(10).max(2000), suspendUser: z.boolean().optional() }).openapi('AdminRiskResolve')) },
      responses: { 200: jsonContent(AdminLoose), ...errorResponses },
    }),
    async (c) => c.json(await svc.resolveReview(await adminCtx(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );

  r.openapi(
    createRoute({
      method: 'get', path: '/v1/admin/trust/overrides', tags: trustTags, security: bearer,
      summary: 'Trust score override requests (maker-checker)',
      middleware: adminGuard(['risk.read']),
      request: { query: z.object({ status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'APPLIED', 'EXPIRED']).optional() }) },
      responses: { 200: jsonContent(AdminPage), ...errorResponses },
    }),
    async (c) => c.json(await svc.listOverrides(await adminCtx(c), c.req.valid('query').status), 200),
  );
  r.openapi(
    createRoute({
      method: 'post', path: '/v1/admin/trust/overrides', tags: trustTags, security: bearer,
      summary: 'Request a trust score override (reason ≥ 10 chars, optional validUntil)',
      middleware: adminGuard(['trust.override.request'], { mfa: true }),
      request: jsonBody(z.object({ userId: z.string().uuid(), newScore: z.number().int().min(0).max(100), reason: z.string().trim().min(10).max(2000), validUntil: z.string().datetime({ offset: true }).optional() }).openapi('AdminTrustOverrideRequest')),
      responses: { 201: jsonContent(AdminLoose, 'Requested'), ...errorResponses },
    }),
    async (c) => c.json(await svc.requestOverride(await adminCtx(c), c.req.valid('json')), 201),
  );
  r.openapi(
    createRoute({
      method: 'post', path: '/v1/admin/trust/overrides/{id}/approve', tags: trustTags, security: bearer,
      summary: 'Approve & apply (approver ≠ requester ≠ subject, fresh MFA) → apply_trust_score_override',
      middleware: adminGuard(['trust.override.approve'], { mfa: true }),
      request: { params: IdParam, ...jsonBody(z.object({ note: z.string().trim().max(1000).optional() })) },
      responses: { 200: jsonContent(AdminLoose), ...errorResponses },
    }),
    async (c) => c.json(await svc.approveOverride(await adminCtx(c), c.req.valid('param').id, c.req.valid('json').note), 200),
  );
  r.openapi(
    createRoute({
      method: 'post', path: '/v1/admin/trust/overrides/{id}/reject', tags: trustTags, security: bearer,
      summary: 'Reject a pending override',
      middleware: adminGuard(['trust.override.approve'], { mfa: true }),
      request: { params: IdParam, ...jsonBody(z.object({ note: z.string().trim().min(5).max(1000) })) },
      responses: { 200: jsonContent(AdminLoose), ...errorResponses },
    }),
    async (c) => c.json(await svc.rejectOverride(await adminCtx(c), c.req.valid('param').id, c.req.valid('json').note), 200),
  );
  app.route('/', r);
}
