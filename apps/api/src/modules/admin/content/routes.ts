import { createRoute, z } from '@hono/zod-openapi';
import type { App } from '../../../context';
import { bearer, createRouter, errorResponses, jsonBody, jsonContent } from '../../../lib/openapi';
import { AdminLoose, AdminPage, adminCtx, adminGuard, IdParam, ReasonBody } from '../common';
import * as svc from './service';

const faqTags = ['Admin · FAQ'];
const legalTags = ['Admin · Legal documents'];
const FaqCategory = z.enum(['GENERAL', 'BUYER', 'TRAVELER', 'PAYMENT', 'CUSTOMS', 'DELIVERY', 'DISPUTE', 'ACCOUNT', 'REFERRAL']);
const Locale = z.enum(['id', 'en']);
const LegalType = z.enum(['TOS', 'PRIVACY', 'KYC', 'MARKETING', 'COOKIES', 'TRAVELER_AGREEMENT', 'PAYMENT_TERMS', 'REFUND_POLICY', 'PROHIBITED_ITEMS']);

const FaqCreate = z
  .object({
    slug: z.string().regex(/^[a-z0-9-]{2,120}$/),
    locale: Locale.default('id'),
    category: FaqCategory,
    question: z.string().trim().min(5).max(300),
    answerMd: z.string().trim().min(5).max(20000),
    tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
    sortOrder: z.number().int().min(0).max(100000).default(0),
  })
  .openapi('AdminFaqCreate');
const FaqPatch = z
  .object({
    slug: z.string().regex(/^[a-z0-9-]{2,120}$/).optional(),
    locale: Locale.optional(),
    category: FaqCategory.optional(),
    question: z.string().trim().min(5).max(300).optional(),
    answerMd: z.string().trim().min(5).max(20000).optional(),
    tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
    sortOrder: z.number().int().min(0).max(100000).optional(),
  })
  .openapi('AdminFaqPatch');

export function registerAdminContent(app: App) {
  const r = createRouter();
  const faq = adminGuard(['faq.manage']);
  r.openapi(
    createRoute({ method: 'get', path: '/v1/admin/faq', tags: faqTags, security: bearer, summary: 'FAQ articles (all statuses)', middleware: faq, request: { query: z.object({ status: z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']).optional(), locale: Locale.optional(), category: FaqCategory.optional() }) }, responses: { 200: jsonContent(AdminPage), ...errorResponses } }),
    async (c) => c.json(await svc.listFaq(await adminCtx(c), c.req.valid('query')), 200),
  );
  r.openapi(
    createRoute({ method: 'get', path: '/v1/admin/faq/{id}', tags: faqTags, security: bearer, summary: 'FAQ article', middleware: faq, request: { params: IdParam }, responses: { 200: jsonContent(AdminLoose), ...errorResponses } }),
    async (c) => c.json(await svc.faqDetail(await adminCtx(c), c.req.valid('param').id), 200),
  );
  r.openapi(
    createRoute({ method: 'post', path: '/v1/admin/faq', tags: faqTags, security: bearer, summary: 'Create (DRAFT)', middleware: faq, request: jsonBody(FaqCreate), responses: { 201: jsonContent(AdminLoose, 'Created'), ...errorResponses } }),
    async (c) => c.json(await svc.createFaq(await adminCtx(c), c.req.valid('json')), 201),
  );
  r.openapi(
    createRoute({ method: 'patch', path: '/v1/admin/faq/{id}', tags: faqTags, security: bearer, summary: 'Edit', middleware: faq, request: { params: IdParam, ...jsonBody(FaqPatch) }, responses: { 200: jsonContent(AdminLoose), ...errorResponses } }),
    async (c) => c.json(await svc.updateFaq(await adminCtx(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );
  for (const [action, to] of [['publish', 'PUBLISHED'], ['archive', 'ARCHIVED'], ['unpublish', 'DRAFT']] as const) {
    r.openapi(
      createRoute({ method: 'post', path: `/v1/admin/faq/{id}/${action}`, tags: faqTags, security: bearer, summary: `→ ${to}`, middleware: faq, request: { params: IdParam }, responses: { 200: jsonContent(AdminLoose), ...errorResponses } }),
      async (c) => c.json(await svc.setFaqStatus(await adminCtx(c), c.req.valid('param').id, to), 200),
    );
  }
  r.openapi(
    createRoute({ method: 'delete', path: '/v1/admin/faq/{id}', tags: faqTags, security: bearer, summary: 'Delete a DRAFT', middleware: faq, request: { params: IdParam }, responses: { 200: jsonContent(AdminLoose), ...errorResponses } }),
    async (c) => c.json(await svc.deleteFaq(await adminCtx(c), c.req.valid('param').id), 200),
  );

  const legal = adminGuard(['legal.documents.manage']);
  r.openapi(
    createRoute({ method: 'get', path: '/v1/admin/legal-documents', tags: legalTags, security: bearer, summary: 'Versions per type/locale; `current` = latest published (what users see)', middleware: legal, request: { query: z.object({ type: LegalType.optional(), locale: Locale.optional() }) }, responses: { 200: jsonContent(AdminPage), ...errorResponses } }),
    async (c) => c.json(await svc.listLegal(await adminCtx(c), c.req.valid('query')), 200),
  );
  r.openapi(
    createRoute({ method: 'get', path: '/v1/admin/legal-documents/{id}', tags: legalTags, security: bearer, summary: 'Version with body', middleware: legal, request: { params: IdParam }, responses: { 200: jsonContent(AdminLoose), ...errorResponses } }),
    async (c) => c.json(await svc.legalDetail(await adminCtx(c), c.req.valid('param').id), 200),
  );
  r.openapi(
    createRoute({
      method: 'post', path: '/v1/admin/legal-documents', tags: legalTags, security: bearer, summary: 'Create a new version (draft)', middleware: legal,
      request: jsonBody(z.object({ type: LegalType, version: z.string().regex(/^[0-9A-Za-z._-]{1,40}$/), locale: Locale, title: z.string().trim().min(3).max(200), bodyMd: z.string().trim().min(20).max(200000), summaryOfChanges: z.string().trim().max(5000).optional() }).openapi('AdminLegalDocumentCreate')),
      responses: { 201: jsonContent(AdminLoose, 'Created'), ...errorResponses },
    }),
    async (c) => c.json(await svc.createLegal(await adminCtx(c), c.req.valid('json')), 201),
  );
  r.openapi(
    createRoute({ method: 'patch', path: '/v1/admin/legal-documents/{id}', tags: legalTags, security: bearer, summary: 'Edit an unpublished version', middleware: legal, request: { params: IdParam, ...jsonBody(z.object({ title: z.string().trim().min(3).max(200).optional(), bodyMd: z.string().trim().min(20).max(200000).optional(), summaryOfChanges: z.string().trim().max(5000).optional() })) }, responses: { 200: jsonContent(AdminLoose), ...errorResponses } }),
    async (c) => c.json(await svc.updateLegal(await adminCtx(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );
  r.openapi(
    createRoute({ method: 'post', path: '/v1/admin/legal-documents/{id}/publish', tags: legalTags, security: bearer, summary: 'Publish (immutable afterwards); previous published version retired by default', middleware: adminGuard(['legal.documents.manage'], { mfa: true }), request: { params: IdParam, ...jsonBody(z.object({ retirePrevious: z.boolean().default(true) })) }, responses: { 200: jsonContent(AdminLoose), ...errorResponses } }),
    async (c) => c.json(await svc.publishLegal(await adminCtx(c), c.req.valid('param').id, c.req.valid('json').retirePrevious), 200),
  );
  r.openapi(
    createRoute({ method: 'post', path: '/v1/admin/legal-documents/{id}/retire', tags: legalTags, security: bearer, summary: 'Retire a published version', middleware: adminGuard(['legal.documents.manage'], { mfa: true }), request: { params: IdParam, ...jsonBody(ReasonBody) }, responses: { 200: jsonContent(AdminLoose), ...errorResponses } }),
    async (c) => c.json(await svc.retireLegal(await adminCtx(c), c.req.valid('param').id, c.req.valid('json').reason), 200),
  );
  app.route('/', r);
}
