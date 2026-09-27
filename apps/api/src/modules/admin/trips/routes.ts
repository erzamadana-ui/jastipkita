import { createRoute, z } from '@hono/zod-openapi';
import type { App } from '../../../context';
import { bearer, createRouter, errorResponses, jsonBody, jsonContent } from '../../../lib/openapi';
import { AdminLoose, AdminPage, adminCtx, adminGuard, IdParam, PageQuery, ReasonBody } from '../common';
import * as svc from './service';

const tags = ['Admin · Trips'];

export function registerAdminTrips(app: App) {
  const r = createRouter();
  r.openapi(
    createRoute({
      method: 'get', path: '/v1/admin/trips/verifications', tags, security: bearer,
      summary: 'Trip verification queue (VERIFICATION_PENDING, oldest document first)',
      middleware: adminGuard(['trips.verify']),
      request: { query: PageQuery },
      responses: { 200: jsonContent(AdminPage), ...errorResponses },
    }),
    async (c) => c.json(await svc.verificationQueue(await adminCtx(c), c.req.valid('query')), 200),
  );
  r.openapi(
    createRoute({
      method: 'get', path: '/v1/admin/trips/{id}', tags, security: bearer,
      summary: 'Trip detail with travel documents (authenticated content URL) and timeline',
      middleware: adminGuard(['trips.verify']),
      request: { params: IdParam },
      responses: { 200: jsonContent(AdminLoose), ...errorResponses },
    }),
    async (c) => c.json(await svc.tripDetail(await adminCtx(c), c.req.valid('param').id), 200),
  );
  r.openapi(
    createRoute({
      method: 'post', path: '/v1/admin/trips/{id}/verification/approve', tags, security: bearer,
      summary: 'Approve travel documents → VERIFIED (transition_trip, ADMIN) + trip.verified',
      middleware: adminGuard(['trips.verify']),
      request: { params: IdParam, ...jsonBody(z.object({ note: z.string().trim().max(500).optional() })) },
      responses: { 200: jsonContent(AdminLoose), ...errorResponses },
    }),
    async (c) => c.json(await svc.approveTrip(await adminCtx(c), c.req.valid('param').id, c.req.valid('json').note), 200),
  );
  r.openapi(
    createRoute({
      method: 'post', path: '/v1/admin/trips/{id}/verification/reject', tags, security: bearer,
      summary: 'Reject travel documents → DRAFT with reason',
      middleware: adminGuard(['trips.verify']),
      request: { params: IdParam, ...jsonBody(ReasonBody) },
      responses: { 200: jsonContent(AdminLoose), ...errorResponses },
    }),
    async (c) => c.json(await svc.rejectTrip(await adminCtx(c), c.req.valid('param').id, c.req.valid('json').reason), 200),
  );
  app.route('/', r);
}
