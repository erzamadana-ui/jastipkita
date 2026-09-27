import { createRoute } from '@hono/zod-openapi';
import type { App } from '../../context';
import { bearer, createRouter, errorResponses, jsonBody, jsonContent } from '../../lib/openapi';
import { requireAuth, requireKycLevel } from '../../middleware/auth';
import { rateLimit } from '../../middleware/rate-limit';
import { requireAuthContext, unavailableResponse } from '../catalog/shared';
import { AcceptResponse, DeclineBody, IdParam, InviteBody, MineQuery, OfferCreateBody, OfferListSchema, OfferPageSchema, OfferSchema } from './schemas';
import * as svc from './service';

export function registerOffers(app: App): void {
  const r = createRouter();

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/requests/{id}/offers',
      tags: ['Offers'],
      summary: 'Traveler offer on an OPEN request (KYC ≥ 3, own ACTIVE trip on the same route, fee within bounds, capacity, limits)',
      security: bearer,
      middleware: [requireAuth, requireKycLevel(3), rateLimit({ name: 'offers.create', limit: 30, windowSec: 3600, key: 'user' })] as const,
      request: { params: IdParam, ...jsonBody(OfferCreateBody) },
      responses: { 201: jsonContent(OfferSchema, 'Created'), ...errorResponses, 503: unavailableResponse },
    }),
    async (c) => {
      const b = c.req.valid('json');
      const out = await svc.createTravelerOffer(c.get('deps'), requireAuthContext(c), c.req.valid('param').id, {
        tripId: b.tripId,
        travelerFeeIdr: b.travelerFeeIdr,
        message: b.message ?? null,
      });
      return c.json(out, 201);
    },
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/trips/{id}/invites',
      tags: ['Offers'],
      summary: "Buyer invites a traveler's ACTIVE trip for one of their OPEN requests",
      security: bearer,
      middleware: [requireAuth, rateLimit({ name: 'offers.invite', limit: 30, windowSec: 3600, key: 'user' })] as const,
      request: { params: IdParam, ...jsonBody(InviteBody) },
      responses: { 201: jsonContent(OfferSchema, 'Created'), ...errorResponses, 503: unavailableResponse },
    }),
    async (c) => {
      const b = c.req.valid('json');
      return c.json(await svc.createBuyerInvite(c.get('deps'), requireAuthContext(c), c.req.valid('param').id, { requestId: b.requestId, message: b.message ?? null }), 201);
    },
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/requests/{id}/offers',
      tags: ['Offers'],
      summary: 'Offers on a request (buyer: all; traveler: own)',
      security: bearer,
      middleware: [requireAuth] as const,
      request: { params: IdParam },
      responses: { 200: jsonContent(OfferListSchema), 401: errorResponses[401], 404: errorResponses[404] },
    }),
    async (c) => c.json(await svc.listRequestOffers(c.get('deps'), requireAuthContext(c), c.req.valid('param').id), 200),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/offers/mine',
      tags: ['Offers'],
      summary: 'Offers/invites where the caller is the traveler or the buyer',
      security: bearer,
      middleware: [requireAuth] as const,
      request: { query: MineQuery },
      responses: { 200: jsonContent(OfferPageSchema), 400: errorResponses[400], 401: errorResponses[401] },
    }),
    async (c) => c.json(await svc.listMyOffers(c.get('deps'), requireAuthContext(c), c.req.valid('query')), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/offers/{id}/accept',
      tags: ['Offers'],
      summary: 'Accept (counterparty of the initiator) → creates the transaction and moves it to MATCHED atomically',
      security: bearer,
      middleware: [requireAuth, rateLimit({ name: 'offers.accept', limit: 30, windowSec: 60, key: 'user' })] as const,
      request: { params: IdParam },
      responses: { 200: jsonContent(AcceptResponse), ...errorResponses, 503: unavailableResponse },
    }),
    async (c) => c.json(await svc.acceptOffer(c.get('deps'), requireAuthContext(c), c.req.valid('param').id), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/offers/{id}/decline',
      tags: ['Offers'],
      summary: 'Decline (counterparty of the initiator)',
      security: bearer,
      middleware: [requireAuth] as const,
      request: { params: IdParam, body: { content: { 'application/json': { schema: DeclineBody } }, required: false } },
      responses: { 200: jsonContent(OfferSchema), ...errorResponses },
    }),
    async (c) => {
      let reason: string | null = null;
      try {
        const body = (await c.req.json()) as { reason?: unknown };
        reason = typeof body?.reason === 'string' && body.reason.trim() ? body.reason.trim().slice(0, 500) : null;
      } catch {
        reason = null;
      }
      return c.json(await svc.declineOffer(c.get('deps'), requireAuthContext(c), c.req.valid('param').id, reason), 200);
    },
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/offers/{id}/withdraw',
      tags: ['Offers'],
      summary: 'Withdraw (initiator)',
      security: bearer,
      middleware: [requireAuth] as const,
      request: { params: IdParam },
      responses: { 200: jsonContent(OfferSchema), ...errorResponses },
    }),
    async (c) => c.json(await svc.withdrawOffer(c.get('deps'), requireAuthContext(c), c.req.valid('param').id), 200),
  );

  app.route('/', r);
}
