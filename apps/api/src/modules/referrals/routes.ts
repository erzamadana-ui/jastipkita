import { createRoute } from '@hono/zod-openapi';
import type { App } from '../../context';
import { bearer, createRouter, errorResponses, jsonBody, jsonContent } from '../../lib/openapi';
import { getAuth, requireAuth } from '../../middleware/auth';
import { rateLimit } from '../../middleware/rate-limit';
import { ApplyReferralResult, ApplyReferralSchema, MyReferralsSchema } from './schemas';
import * as svc from './service';

const tags = ['Referrals & Credit'];

export function registerReferrals(app: App): void {
  const r = createRouter();
  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/referrals/me',
      tags,
      summary: 'My referral code, share link, program terms, stats and rewards',
      security: bearer,
      middleware: [requireAuth] as const,
      responses: { 200: jsonContent(MyReferralsSchema), ...errorResponses },
    }),
    async (c) => c.json(await svc.getMine(c.get('deps'), getAuth(c)), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/referrals/apply',
      tags,
      summary: 'Apply a referral code (new users only: within 7 days of signup and before the first secured payment)',
      description: 'Self-referral and identity reuse are refused. Rewards are evaluated when the qualifying transaction COMPLETES (fraud gate: shared device/IP/payment/identity, velocity).',
      security: bearer,
      middleware: [requireAuth, rateLimit({ name: 'referrals.apply', limit: 10, windowSec: 3600, key: 'ip+user' })] as const,
      request: jsonBody(ApplyReferralSchema),
      responses: { 201: jsonContent(ApplyReferralResult, 'Created'), ...errorResponses },
    }),
    async (c) => c.json(await svc.apply(c.get('deps'), getAuth(c), c.req.valid('json')), 201),
  );
  app.route('/', r);
}
