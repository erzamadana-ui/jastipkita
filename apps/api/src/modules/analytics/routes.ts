import { createRoute } from '@hono/zod-openapi';
import type { App } from '../../context';
import { createRouter, errorResponses, jsonBody, jsonContent } from '../../lib/openapi';
import { optionalAuth } from '../../middleware/auth';
import { rateLimit } from '../../middleware/rate-limit';
import { AnalyticsBatchSchema, AnalyticsResultSchema } from './schemas';
import * as svc from './service';

export function registerAnalytics(app: App): void {
  const r = createRouter();
  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/analytics/events',
      tags: ['Analytics'],
      summary: 'Batch ingest (≤ 50) of allowlisted product events; anonymous allowed with anonymousId; PII is stripped',
      description: 'Send `Authorization: Bearer …` when signed in (events are attributed to the user); otherwise anonymousId is required.',
      middleware: [optionalAuth, rateLimit({ name: 'analytics.ingest', limit: 120, windowSec: 60, key: 'ip' })] as const,
      request: jsonBody(AnalyticsBatchSchema),
      responses: { 202: jsonContent(AnalyticsResultSchema, 'Accepted'), ...errorResponses },
    }),
    async (c) => c.json(await svc.ingest(c.get('deps'), c.get('auth'), c.req.valid('json')), 202),
  );
  app.route('/', r);
}
