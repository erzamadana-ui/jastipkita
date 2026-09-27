import { createRoute, z } from '@hono/zod-openapi';
import type { App } from '../../context';
import { bearer, createRouter, errorResponses, jsonContent } from '../../lib/openapi';
import { requireAuth } from '../../middleware/auth';
import { rateLimit } from '../../middleware/rate-limit';
import { requireAuthContext, unavailableResponse } from '../catalog/shared';
import { RequestListingSchema } from '../requests/schemas';
import { TripPublicSchema } from '../trips/schemas';
import * as svc from './service';

const IdParam = z.object({ id: z.string().uuid().openapi({ param: { name: 'id', in: 'path' } }) });
const LimitQuery = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) });
const Features = z.record(z.string(), z.number()).openapi({ description: 'Soft factors 0–1 (date, rating, trust, price, capacity, history, routeExactness)' });
const Strategy = z.object({ name: z.string(), version: z.string() });

const TravelersResponse = z
  .object({
    data: z.array(
      z.object({
        trip: TripPublicSchema,
        score: z.number().openapi({ description: '0–100' }),
        reasons: z.array(z.string()).openapi({ example: ['Tiba 7 hari sebelum batas', 'Trust Score 86', 'Rating 4,8 (23 ulasan)'] }),
        estimatedTravelerFeeIdr: z.number().int(),
        features: Features,
      }),
    ),
    excludedCount: z.number().int(),
    strategy: Strategy,
  })
  .openapi('RecommendedTravelers');

const RequestsResponse = z
  .object({
    data: z.array(
      z.object({
        request: RequestListingSchema,
        score: z.number(),
        reasons: z.array(z.string()),
        estimatedTravelerFeeIdr: z.number().int(),
        features: Features,
      }),
    ),
    excludedCount: z.number().int(),
    strategy: Strategy,
  })
  .openapi('RecommendedRequests');

export function registerMatching(app: App): void {
  const r = createRouter();
  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/requests/{id}/recommended-travelers',
      tags: ['Matching'],
      summary: 'Ranked trips for a request (buyer only) with Indonesian reasons',
      security: bearer,
      middleware: [requireAuth, rateLimit({ name: 'matching.travelers', limit: 60, windowSec: 60, key: 'user' })] as const,
      request: { params: IdParam, query: LimitQuery },
      responses: { 200: jsonContent(TravelersResponse), ...errorResponses, 503: unavailableResponse },
    }),
    async (c) =>
      c.json(await svc.recommendTravelers(c.get('deps'), requireAuthContext(c), c.req.valid('param').id, c.req.valid('query').limit), 200),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/trips/{id}/recommended-requests',
      tags: ['Matching'],
      summary: 'Ranked open requests for a trip (trip owner only) with Indonesian reasons',
      security: bearer,
      middleware: [requireAuth, rateLimit({ name: 'matching.requests', limit: 60, windowSec: 60, key: 'user' })] as const,
      request: { params: IdParam, query: LimitQuery },
      responses: { 200: jsonContent(RequestsResponse), ...errorResponses },
    }),
    async (c) =>
      c.json(await svc.recommendRequests(c.get('deps'), requireAuthContext(c), c.req.valid('param').id, c.req.valid('query').limit), 200),
  );
  app.route('/', r);
}
