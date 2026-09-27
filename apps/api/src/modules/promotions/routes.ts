import { createRoute } from '@hono/zod-openapi';
import type { App } from '../../context';
import { bearer, createRouter, errorResponses, jsonBody, jsonContent } from '../../lib/openapi';
import { getAuth, requireAuth } from '../../middleware/auth';
import { rateLimit } from '../../middleware/rate-limit';
import { PublicPromotionList, ValidatePromoResult, ValidatePromoSchema } from './schemas';
import * as svc from './service';

const tags = ['Promotions'];

export function registerPromotions(app: App): void {
  const r = createRouter();
  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/promotions/validate',
      tags,
      summary: 'Preview a promo code against a transaction’s quote (no redemption — checkout redeems)',
      security: bearer,
      middleware: [requireAuth, rateLimit({ name: 'promotions.validate', limit: 20, windowSec: 60, key: 'user' })] as const,
      request: jsonBody(ValidatePromoSchema),
      responses: { 200: jsonContent(ValidatePromoResult), ...errorResponses },
    }),
    async (c) => c.json(await svc.validate(c.get('deps'), getAuth(c), c.req.valid('json')), 200),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/promotions/active',
      tags,
      summary: 'Public, currently running promotions (no budget/usage/targeting internals)',
      middleware: [rateLimit({ name: 'promotions.active', limit: 120, windowSec: 60 })] as const,
      responses: { 200: jsonContent(PublicPromotionList), ...errorResponses },
    }),
    async (c) => c.json(await svc.listActive(c.get('deps')), 200),
  );
  app.route('/', r);
}
