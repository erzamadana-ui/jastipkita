import { createRoute, z } from '@hono/zod-openapi';
import type { App } from '../../../context';
import { bearer, createRouter, errorResponses, IdempotencyHeader, jsonBody, jsonContent } from '../../../lib/openapi';
import { AdminLoose, AdminPage, adminCtx, adminGuard, IdParam, ReasonBody, StatusCsvQuery } from '../common';
import * as svc from './service';

const promoTags = ['Admin · Promotions'];
const refTags = ['Admin · Referrals'];

const Conditions = z
  .object({
    minItemValueIdr: z.number().int().nonnegative().optional(),
    originCountries: z.array(z.string().regex(/^[A-Z]{2}$/)).optional(),
    categories: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)).optional(),
    firstTransactionOnly: z.boolean().optional(),
    travelerIds: z.array(z.string().uuid()).optional(),
    userSegments: z.array(z.string().max(60)).optional(),
    priority: z.number().int().optional(),
    public: z.boolean().optional(),
    cashbackExpiryDays: z.number().int().min(1).max(365).optional(),
  })
  .strict()
  .openapi('AdminPromoConditions');
const Benefit = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('PERCENT'), rateBps: z.number().int().min(1).max(10000), capIdr: z.number().int().positive().nullable().optional(), base: z.enum(['ITEM_PRICE', 'TRAVELER_FEE', 'PLATFORM_FEE', 'SUBTOTAL']).optional() }),
    z.object({ kind: z.literal('FIXED'), amountIdr: z.number().int().positive() }),
    z.object({ kind: z.literal('FREE_PLATFORM_FEE') }),
    z.object({ kind: z.literal('CASHBACK_CREDIT'), rateBps: z.number().int().min(1).max(10000).optional(), amountIdr: z.number().int().positive().optional(), capIdr: z.number().int().positive().nullable().optional(), base: z.enum(['ITEM_PRICE', 'TRAVELER_FEE', 'PLATFORM_FEE', 'SUBTOTAL']).optional() }),
  ])
  .openapi('AdminPromoBenefit');
const PromoFields = {
  code: z.string().regex(/^[A-Za-z0-9_-]{3,32}$/).nullable().optional(),
  name: z.string().trim().min(3).max(120),
  description: z.string().trim().max(2000).nullable().optional(),
  type: z.enum(['PROMO_CODE', 'FIRST_TRANSACTION', 'COUNTRY', 'TRAVELER', 'CAMPAIGN', 'CASHBACK', 'FREE_PLATFORM_FEE']),
  conditions: Conditions.optional(),
  benefit: Benefit,
  budgetTotalIdr: z.number().int().positive().nullable().optional(),
  usageLimitTotal: z.number().int().positive().nullable().optional(),
  usageLimitPerUser: z.number().int().positive().nullable().optional(),
  startsAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true }).nullable().optional(),
  fundedBy: z.enum(['PLATFORM', 'PARTNER', 'MERCHANT', 'TRAVELER']).optional(),
};
const PromoCreate = z.object(PromoFields).openapi('AdminPromotionCreate');
const PromoPatch = z
  .object({ ...PromoFields, name: PromoFields.name.optional(), type: PromoFields.type.optional(), benefit: Benefit.optional(), startsAt: PromoFields.startsAt.optional() })
  .openapi('AdminPromotionPatch');

export function registerAdminGrowth(app: App) {
  const r = createRouter();
  r.openapi(
    createRoute({ method: 'get', path: '/v1/admin/promotions', tags: promoTags, security: bearer, summary: 'Promotions with budget usage and redemption counts', middleware: adminGuard(['promotions.manage']), request: { query: z.object({ status: StatusCsvQuery }) }, responses: { 200: jsonContent(AdminPage), ...errorResponses } }),
    async (c) => c.json(await svc.listPromotions(await adminCtx(c), c.req.valid('query').status), 200),
  );
  r.openapi(
    createRoute({ method: 'get', path: '/v1/admin/promotions/{id}', tags: promoTags, security: bearer, summary: 'Promotion detail', middleware: adminGuard(['promotions.manage']), request: { params: IdParam }, responses: { 200: jsonContent(AdminLoose), ...errorResponses } }),
    async (c) => c.json(await svc.promotionDetail(await adminCtx(c), c.req.valid('param').id), 200),
  );
  r.openapi(
    createRoute({ method: 'post', path: '/v1/admin/promotions', tags: promoTags, security: bearer, summary: 'Create (DRAFT) — conditions/benefit per docs/api/engagement.md §7', middleware: adminGuard(['promotions.manage']), request: jsonBody(PromoCreate), responses: { 201: jsonContent(AdminLoose, 'Created'), ...errorResponses } }),
    async (c) => c.json(await svc.createPromotion(await adminCtx(c), c.req.valid('json')), 201),
  );
  r.openapi(
    createRoute({ method: 'patch', path: '/v1/admin/promotions/{id}', tags: promoTags, security: bearer, summary: 'Edit a DRAFT/PAUSED promotion (budget never below used)', middleware: adminGuard(['promotions.manage']), request: { params: IdParam, ...jsonBody(PromoPatch) }, responses: { 200: jsonContent(AdminLoose), ...errorResponses } }),
    async (c) => c.json(await svc.updatePromotion(await adminCtx(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );
  r.openapi(
    createRoute({ method: 'post', path: '/v1/admin/promotions/{id}/activate', tags: promoTags, security: bearer, summary: 'Activate (maker-checker: activator ≠ creator; fresh MFA)', middleware: adminGuard(['promotions.manage'], { mfa: true }), request: { params: IdParam }, responses: { 200: jsonContent(AdminLoose), ...errorResponses } }),
    async (c) => c.json(await svc.setPromotionStatus(await adminCtx(c), c.req.valid('param').id, 'ACTIVE'), 200),
  );
  r.openapi(
    createRoute({ method: 'post', path: '/v1/admin/promotions/{id}/pause', tags: promoTags, security: bearer, summary: 'Pause an ACTIVE promotion', middleware: adminGuard(['promotions.manage']), request: { params: IdParam, ...jsonBody(ReasonBody) }, responses: { 200: jsonContent(AdminLoose), ...errorResponses } }),
    async (c) => c.json(await svc.setPromotionStatus(await adminCtx(c), c.req.valid('param').id, 'PAUSED', c.req.valid('json').reason), 200),
  );
  r.openapi(
    createRoute({ method: 'post', path: '/v1/admin/promotions/{id}/end', tags: promoTags, security: bearer, summary: 'End a promotion (terminal)', middleware: adminGuard(['promotions.manage']), request: { params: IdParam, ...jsonBody(ReasonBody) }, responses: { 200: jsonContent(AdminLoose), ...errorResponses } }),
    async (c) => c.json(await svc.setPromotionStatus(await adminCtx(c), c.req.valid('param').id, 'ENDED', c.req.valid('json').reason), 200),
  );

  r.openapi(
    createRoute({ method: 'get', path: '/v1/admin/referrals/stats', tags: refTags, security: bearer, summary: 'Referral unit economics: CAC proxy, conversion, fraud rate, repeat, LTV proxy, gross margin + guardrail verdict', middleware: adminGuard(['referrals.manage']), responses: { 200: jsonContent(AdminLoose), ...errorResponses } }),
    async (c) => c.json(await svc.referralStats(await adminCtx(c)), 200),
  );
  r.openapi(
    createRoute({ method: 'get', path: '/v1/admin/referrals', tags: refTags, security: bearer, summary: 'Referrals (masked names, fraud reasons, open risk reviews)', middleware: adminGuard(['referrals.manage']), request: { query: z.object({ status: StatusCsvQuery }) }, responses: { 200: jsonContent(AdminPage), ...errorResponses } }),
    async (c) => c.json(await svc.listReferrals(await adminCtx(c), c.req.valid('query').status), 200),
  );
  r.openapi(
    createRoute({ method: 'post', path: '/v1/admin/referrals/{id}/reject', tags: refTags, security: bearer, summary: 'Reject a suspicious PENDING/QUALIFIED referral (no credit)', middleware: adminGuard(['referrals.manage']), request: { params: IdParam, ...jsonBody(ReasonBody) }, responses: { 200: jsonContent(AdminLoose), ...errorResponses } }),
    async (c) => c.json(await svc.rejectReferral(await adminCtx(c), c.req.valid('param').id, c.req.valid('json').reason), 200),
  );
  r.openapi(
    createRoute({ method: 'post', path: '/v1/admin/referrals/{id}/hold', tags: refTags, security: bearer, summary: 'Hold a QUALIFIED reward (opens a REFERRAL risk review)', middleware: adminGuard(['referrals.manage']), request: { params: IdParam, ...jsonBody(ReasonBody) }, responses: { 200: jsonContent(AdminLoose), ...errorResponses } }),
    async (c) => c.json(await svc.holdReferral(await adminCtx(c), c.req.valid('param').id, c.req.valid('json').reason), 200),
  );
  r.openapi(
    createRoute({ method: 'post', path: '/v1/admin/referrals/{id}/release', tags: refTags, security: bearer, summary: 'Release a QUALIFIED reward → REWARDED + credits (after RISK cleared the review)', middleware: adminGuard(['referrals.manage'], { mfa: true, idempotent: true }), request: { params: IdParam, headers: IdempotencyHeader, ...jsonBody(z.object({ note: z.string().trim().min(5).max(1000) })) }, responses: { 200: jsonContent(AdminLoose), ...errorResponses } }),
    async (c) => c.json(await svc.releaseReferral(await adminCtx(c), c.req.valid('param').id, c.req.valid('json').note), 200),
  );
  app.route('/', r);
}
