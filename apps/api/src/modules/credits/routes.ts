import { createRoute } from '@hono/zod-openapi';
import type { App } from '../../context';
import { bearer, createRouter, errorResponses, jsonContent } from '../../lib/openapi';
import { PageQuery } from '../../lib/pagination';
import { getAuth, requireAuth } from '../../middleware/auth';
import { CreditsSchema } from './schemas';
import * as svc from './service';

export function registerCredits(app: App): void {
  const r = createRouter();
  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/credits',
      tags: ['Referrals & Credit'],
      summary: 'JastipKita Credit: balance, expiring soon (earliest-expiring used first) and history (cursor pagination)',
      security: bearer,
      middleware: [requireAuth] as const,
      request: { query: PageQuery },
      responses: { 200: jsonContent(CreditsSchema), ...errorResponses },
    }),
    async (c) => c.json(await svc.getCredits(c.get('deps'), getAuth(c), c.req.valid('query')), 200),
  );
  app.route('/', r);
}
