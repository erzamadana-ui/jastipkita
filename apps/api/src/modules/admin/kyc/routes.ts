import { createRoute, z } from '@hono/zod-openapi';
import type { App } from '../../../context';
import { bearer, createRouter, errorResponses, jsonBody, jsonContent } from '../../../lib/openapi';
import { AdminLoose, AdminPage, adminCtx, adminGuard, IdParam, PageQuery, StatusCsvQuery } from '../common';
import * as svc from './service';

const tags = ['Admin · KYC'];

const ApproveBody = z
  .object({
    livenessPassed: z.boolean().openapi({ description: 'Reviewer confirms the selfie/liveness check' }),
    documentMatches: z.boolean().openapi({ description: 'Reviewer confirms the ID document matches the selfie and data' }),
    note: z.string().trim().max(500).optional(),
  })
  .openapi('AdminKycApprove');
const RejectBody = z
  .object({ reason: z.string().trim().min(5).max(500), code: z.string().regex(/^[A-Z][A-Z0-9_]{2,59}$/).optional().openapi({ example: 'DOCUMENT_BLURRY' }) })
  .openapi('AdminKycReject');
const OverrideBody = z.object({ status: z.enum(['VERIFIED', 'FAILED']), reason: z.string().trim().min(10).max(1000) }).openapi('AdminPayoutAccountOverride');

export function registerAdminKyc(app: App) {
  const r = createRouter();
  r.openapi(
    createRoute({
      method: 'get', path: '/v1/admin/kyc/submissions', tags, security: bearer,
      summary: 'KYC review queue (default PENDING,IN_REVIEW; oldest first)',
      middleware: adminGuard(['kyc.review']),
      request: { query: PageQuery.extend({ status: StatusCsvQuery }) },
      responses: { 200: jsonContent(AdminPage), ...errorResponses },
    }),
    async (c) => c.json(await svc.kycQueue(await adminCtx(c), c.req.valid('query')), 200),
  );
  r.openapi(
    createRoute({
      method: 'get', path: '/v1/admin/kyc/submissions/{id}', tags, security: bearer,
      summary: 'Submission detail: document metadata + authenticated content URLs (/v1/files/{id}/content), masked identity (view audited)',
      middleware: adminGuard(['kyc.review']),
      request: { params: IdParam },
      responses: { 200: jsonContent(AdminLoose), ...errorResponses },
    }),
    async (c) => c.json(await svc.kycDetail(await adminCtx(c), c.req.valid('param').id), 200),
  );
  r.openapi(
    createRoute({
      method: 'post', path: '/v1/admin/kyc/submissions/{id}/approve', tags, security: bearer,
      summary: 'Approve (FSM KYC_CHECKS guard) → identity verified, level recompute, kyc.approved',
      middleware: adminGuard(['kyc.review'], { mfa: true }),
      request: { params: IdParam, ...jsonBody(ApproveBody) },
      responses: { 200: jsonContent(AdminLoose), ...errorResponses },
    }),
    async (c) => c.json(await svc.approveKyc(await adminCtx(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );
  r.openapi(
    createRoute({
      method: 'post', path: '/v1/admin/kyc/submissions/{id}/reject', tags, security: bearer,
      summary: 'Reject with reason → kyc.rejected',
      middleware: adminGuard(['kyc.review'], { mfa: true }),
      request: { params: IdParam, ...jsonBody(RejectBody) },
      responses: { 200: jsonContent(AdminLoose), ...errorResponses },
    }),
    async (c) => c.json(await svc.rejectKyc(await adminCtx(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );
  r.openapi(
    createRoute({
      method: 'get', path: '/v1/admin/kyc/payout-accounts', tags, security: bearer,
      summary: 'Payout accounts awaiting verification (masked)',
      middleware: adminGuard(['kyc.review']),
      responses: { 200: jsonContent(AdminPage), ...errorResponses },
    }),
    async (c) => c.json(await svc.payoutAccountQueue(await adminCtx(c)), 200),
  );
  r.openapi(
    createRoute({
      method: 'post', path: '/v1/admin/kyc/payout-accounts/{id}/verification-override', tags, security: bearer,
      summary: 'Override payout account verification (VERIFIED → payout_account.verified + level recompute; FAILED)',
      middleware: adminGuard(['kyc.review'], { mfa: true }),
      request: { params: IdParam, ...jsonBody(OverrideBody) },
      responses: { 200: jsonContent(AdminLoose), ...errorResponses },
    }),
    async (c) => c.json(await svc.overridePayoutAccount(await adminCtx(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );
  app.route('/', r);
}
