import { createRoute, z } from '@hono/zod-openapi';
import type { App } from '../../context';
import { Errors } from '../../lib/errors';
import { bearer, createRouter, errorResponses, jsonBody, jsonContent } from '../../lib/openapi';
import { getAuth, requireAuth, requireKycLevel } from '../../middleware/auth';
import { rateLimit } from '../../middleware/rate-limit';
import { requestMeta } from '../auth/common';
import { OkSchema } from '../me/schemas';
import { KycStatusSchema, KycSubmissionBody, KycSubmissionSchema, PayoutAccountBody, PayoutAccountSchema, PayoutDefaultBody } from './schemas';
import * as svc from './service';

const tags = ['KYC'];
const IdParam = z.object({ id: z.string().uuid() });

export function registerKyc(app: App) {
  const r = createRouter();

  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/kyc/status',
      tags,
      summary: 'Account level, requirements for the next level, submissions',
      security: bearer,
      middleware: [requireAuth] as const,
      responses: { 200: jsonContent(KycStatusSchema), ...errorResponses },
    }),
    async (c) => c.json(await svc.kycStatus(c.get('deps'), getAuth(c)), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/kyc/submissions',
      tags,
      summary: 'Submit identity verification (level 3)',
      description:
        'Requires level 2 and a granted KYC consent. ID number, full name and DOB are stored encrypted; one ID document = one account. ' +
        'Documents are file ids with purpose KYC (encrypted uploads). The provider (MOCK auto-decides; manual → IN_REVIEW) drives PENDING → IN_REVIEW → APPROVED/REJECTED.',
      security: bearer,
      middleware: [requireAuth, requireKycLevel(2), rateLimit({ name: 'kyc.submit', limit: 5, windowSec: 3600, key: 'user' })] as const,
      request: jsonBody(KycSubmissionBody),
      responses: { 201: jsonContent(z.object({ submission: KycSubmissionSchema, kycLevel: z.number().int() }), 'Submitted'), ...errorResponses },
    }),
    async (c) => c.json(await svc.submitKyc(c.get('deps'), getAuth(c), c.req.valid('json'), await requestMeta(c)), 201),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/kyc/payout-accounts',
      tags,
      summary: 'Payout (bank) accounts — masked',
      security: bearer,
      middleware: [requireAuth, requireKycLevel(3)] as const,
      responses: { 200: jsonContent(z.object({ data: z.array(PayoutAccountSchema) })), ...errorResponses },
    }),
    async (c) => c.json({ data: await svc.listPayoutAccounts(c.get('deps'), getAuth(c)) }, 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/kyc/payout-accounts',
      tags,
      summary: 'Add a payout account (bank name inquiry; step-up OTP)',
      description:
        'Requires `stepUp` (SENSITIVE_ACTION OTP, action PAYOUT_ACCOUNT_ADD, targetId = own user id) — `403 STEP_UP_REQUIRED` otherwise. ' +
        'The account number is encrypted; responses only show the mask (****1234). A bank holder name that differs from the verified identity ' +
        'is stored as `NAME_MISMATCH` (manual review, never default) instead of being accepted.',
      security: bearer,
      middleware: [requireAuth, requireKycLevel(3), rateLimit({ name: 'kyc.payout_add', limit: 10, windowSec: 3600, key: 'user' })] as const,
      request: jsonBody(PayoutAccountBody),
      responses: { 201: jsonContent(PayoutAccountSchema, 'Added'), ...errorResponses },
    }),
    async (c) => c.json(await svc.addPayoutAccount(c.get('deps'), getAuth(c), c.req.valid('json'), await requestMeta(c)), 201),
  );

  r.openapi(
    createRoute({
      method: 'delete',
      path: '/v1/kyc/payout-accounts/{id}',
      tags,
      summary: 'Remove a payout account',
      security: bearer,
      middleware: [requireAuth, requireKycLevel(3)] as const,
      request: { params: IdParam },
      responses: { 200: jsonContent(OkSchema), ...errorResponses },
    }),
    async (c) => {
      await svc.removePayoutAccount(c.get('deps'), getAuth(c), c.req.valid('param').id);
      return c.json({ ok: true as const }, 200);
    },
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/kyc/payout-accounts/{id}/default',
      tags,
      summary: 'Make a verified payout account the default (step-up OTP)',
      description: 'Requires `stepUp` (SENSITIVE_ACTION OTP, action PAYOUT_ACCOUNT_SET_DEFAULT, targetId = account id) unless it already is the default.',
      security: bearer,
      middleware: [requireAuth, requireKycLevel(3)] as const,
      request: { params: IdParam, body: { content: { 'application/json': { schema: PayoutDefaultBody } }, required: false } },
      responses: { 200: jsonContent(PayoutAccountSchema), ...errorResponses },
    }),
    async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const parsed = PayoutDefaultBody.safeParse(body ?? {});
      if (!parsed.success) throw Errors.validation({ issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
      return c.json(await svc.setDefaultPayoutAccount(c.get('deps'), getAuth(c), c.req.valid('param').id, parsed.data, await requestMeta(c)), 200);
    },
  );

  app.route('/', r);
}
