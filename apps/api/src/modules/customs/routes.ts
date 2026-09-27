import { createRoute } from '@hono/zod-openapi';
import type { App } from '../../context';
import { createRouter, errorResponses, jsonBody, jsonContent } from '../../lib/openapi';
import { rateLimit } from '../../middleware/rate-limit';
import { unavailableResponse } from '../catalog/shared';
import { CustomsEstimateBody, CustomsEstimateResponse } from './schemas';
import * as svc from './service';

export function registerCustoms(app: App): void {
  const r = createRouter();
  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/customs/estimate',
      tags: ['Customs'],
      summary: 'Public import duty & tax calculator (estimate; NON_PERSONAL default for jastip, PERSONAL comparison)',
      middleware: [rateLimit({ name: 'customs.estimate', limit: 60, windowSec: 60 })] as const,
      request: jsonBody(CustomsEstimateBody),
      responses: { 200: jsonContent(CustomsEstimateResponse), 400: errorResponses[400], 422: errorResponses[422], 429: errorResponses[429], 503: unavailableResponse },
    }),
    async (c) => {
      const deps = c.get('deps');
      const b = c.req.valid('json');
      const out = await svc.publicEstimate(deps.sql, deps, {
        originCountry: b.originCountry,
        destinationCountry: b.destinationCountry,
        categoryCode: b.categoryCode,
        hsCode: b.hsCode ?? null,
        unitPriceMinor: b.unitPriceMinor,
        currency: b.currency,
        quantity: b.quantity,
        ...(b.treatment ? { treatment: b.treatment } : {}),
        ...(b.hasNpwp !== undefined ? { hasNpwp: b.hasNpwp } : {}),
      });
      return c.json(out, 200);
    },
  );
  app.route('/', r);
}
