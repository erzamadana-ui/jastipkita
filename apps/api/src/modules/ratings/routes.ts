import { createRoute, z } from '@hono/zod-openapi';
import type { App } from '../../context';
import { bearer, createRouter, errorResponses, jsonBody, jsonContent } from '../../lib/openapi';
import { getAuth, requireAuth } from '../../middleware/auth';
import { rateLimit } from '../../middleware/rate-limit';
import { CreateRatingSchema, RatingSchema, RatingSummarySchema } from './schemas';
import * as svc from './service';

const IdParam = z.object({ id: z.string().uuid().openapi({ param: { name: 'id', in: 'path' } }) });

export function registerRatings(app: App): void {
  const r = createRouter();

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/transactions/{id}/ratings',
      tags: ['Ratings'],
      summary: 'Rate the counterparty after COMPLETED (once per side, within 14 days)',
      description:
        'Buyer → traveler: overall, communication, accuracy, timeliness. Traveler → buyer: overall, communication, timeliness (responsiveness). Comments are filtered (profanity & contact details masked). Linked accounts get weight 0.',
      security: bearer,
      middleware: [requireAuth] as const,
      request: { params: IdParam, ...jsonBody(CreateRatingSchema) },
      responses: { 201: jsonContent(RatingSchema, 'Created'), ...errorResponses },
    }),
    async (c) => c.json(await svc.createRating(c.get('deps'), getAuth(c), c.req.valid('param').id, c.req.valid('json')), 201),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/users/{id}/rating-summary',
      tags: ['Ratings'],
      summary: 'Public rating summary (as traveler / as buyer) with abuse-weighted Bayesian scores',
      middleware: [rateLimit({ name: 'ratings.summary', limit: 120, windowSec: 60 })] as const,
      request: { params: IdParam },
      responses: { 200: jsonContent(RatingSummarySchema), ...errorResponses },
    }),
    async (c) => c.json(await svc.ratingSummary(c.get('deps'), c.req.valid('param').id), 200),
  );

  app.route('/', r);
}
