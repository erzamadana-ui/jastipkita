import { createRoute, z } from '@hono/zod-openapi';
import type { App } from '../../../context';
import { bearer, createRouter, errorResponses, jsonBody, jsonContent } from '../../../lib/openapi';
import { AdminLoose, AdminPage, adminCtx, adminGuard, IdParam, ReasonBody, StatusCsvQuery } from '../common';
import * as svc from './service';

const Rate = z.string().regex(/^(0(\.\d{1,6})?|1(\.0{1,6})?)$/).openapi({ description: 'Decimal rate within [0, 1] as a string', example: '0.075' });
const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Country = z.string().regex(/^[A-Z]{2}$/);
const Code = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{1,63}$/);

const commonFields = (d: boolean) => ({
  originCountry: Country.nullable().optional(),
  destinationCountry: d ? Country.default('ID') : Country.optional(),
  categoryCode: z.string().regex(/^[A-Z][A-Z0-9_]*$/).nullable().optional(),
  hsCodePrefix: z.string().regex(/^[0-9]{2,10}$/).nullable().optional(),
  effectiveFrom: d ? DateStr.openapi({ description: 'Inclusive first day (§16)' }) : DateStr.optional(),
  effectiveUntil: DateStr.nullable().optional().openapi({ description: 'Inclusive last day (§16); null = open-ended' }),
  sourceReference: d ? z.string().trim().min(3).max(500).openapi({ description: 'Mandatory legal/regulatory source (e.g. PMK 34/2025 Pasal 24)' }) : z.string().trim().min(3).max(500).optional(),
  sourceUrl: z.string().url().max(1000).nullable().optional(),
  lastVerifiedAt: d ? DateStr : DateStr.optional(),
  verifiedBy: z.string().trim().max(200).nullable().optional(),
  notes: z.string().trim().max(4000).nullable().optional(),
});

// Defaults only on create: a PATCH must never reset fields that were not sent.
const opt = <T extends z.ZodTypeAny>(d: boolean, schema: T, def: z.input<T>) => (d ? schema.default(def as never) : schema.optional());
const customsFields = (d: boolean) =>
  z.object({
    ...commonFields(d),
    treatment: opt(d, z.enum(['PERSONAL', 'NON_PERSONAL', 'ANY']), 'ANY'),
    formulaCode: d ? z.enum(['ID_PASSENGER_V2025', 'FLAT_RATES', 'EXEMPT']) : z.enum(['ID_PASSENGER_V2025', 'FLAT_RATES', 'EXEMPT']).optional(),
    exemptionUsd: z.string().regex(/^\d{1,12}(\.\d{1,2})?$/).nullable().optional(),
    dutyRate: opt(d, Rate, '0'),
    vatRate: opt(d, Rate, '0'),
    vatDppFactor: opt(d, z.string().regex(/^(0\.\d{1,6}|1(\.0{1,6})?)$/), '1'),
    luxuryTaxRate: opt(d, Rate, '0'),
    incomeTaxRate: opt(d, Rate, '0'),
    incomeTaxRateNoNpwp: Rate.nullable().optional(),
    rounding: opt(d, z.enum(['NONE', 'CEIL_1000', 'ROUND_1000', 'CEIL_100']), 'NONE'),
    priority: opt(d, z.number().int().min(0).max(10000), 100),
  });
const CustomsCreate = customsFields(true).extend({ code: Code }).openapi('AdminCustomsRuleCreate');
const CustomsPatch = customsFields(false).openapi('AdminCustomsRulePatch');

const restrictedFields = (d: boolean) =>
  z.object({
    ...commonFields(d),
    keywords: opt(d, z.array(z.string().trim().min(1).max(80)).max(100), []),
    classification: d
      ? z.enum(['ALLOWED', 'RESTRICTED', 'DECLARATION_REQUIRED', 'PERMIT_REQUIRED', 'PROHIBITED'])
      : z.enum(['ALLOWED', 'RESTRICTED', 'DECLARATION_REQUIRED', 'PERMIT_REQUIRED', 'PROHIBITED']).optional(),
    maxQuantity: z.number().int().positive().nullable().optional(),
    maxValueUsd: z.string().regex(/^\d{1,12}(\.\d{1,2})?$/).nullable().optional(),
    permitAuthority: z.string().trim().max(200).nullable().optional(),
    airlineDg: opt(d, z.boolean(), false),
    messageId: d ? z.string().trim().min(3).max(2000) : z.string().trim().min(3).max(2000).optional(),
    messageEn: d ? z.string().trim().min(3).max(2000) : z.string().trim().min(3).max(2000).optional(),
  });
const RestrictedCreate = restrictedFields(true).extend({ code: Code }).openapi('AdminRestrictedItemCreate');
const RestrictedPatch = restrictedFields(false).openapi('AdminRestrictedItemPatch');

const PreviewBody = z
  .object({
    originCountry: Country,
    destinationCountry: Country.optional(),
    categoryCode: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    hsCode: z.string().regex(/^[0-9]{2,10}$/).nullable().optional(),
    productName: z.string().max(300).optional(),
    unitPriceMinor: z.number().int().nonnegative(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    quantity: z.number().int().min(1).max(999).default(1),
    date: DateStr.optional(),
    fx: z.object({ itemToIdr: z.string().optional(), usdToIdr: z.string().optional(), itemToUsd: z.string().optional() }).optional().openapi({ description: 'Optional fixed rates (default: latest spot)' }),
  })
  .openapi('AdminRulePreview');
const ReverifyBody = z.object({ lastVerifiedAt: DateStr, verifiedBy: z.string().trim().min(2).max(200), sourceNote: z.string().trim().max(1000).optional() });
const ListQuery = z.object({ status: StatusCsvQuery, code: z.string().max(64).optional(), limit: z.coerce.number().int().min(1).max(500).default(200) });

function registerKind(app: App, kind: svc.RuleKind) {
  const r = createRouter();
  const base = kind === 'customs' ? '/v1/admin/customs-rules' : '/v1/admin/restricted-items';
  const perm = kind === 'customs' ? 'customs.rules.manage' : 'restricted.rules.manage';
  const tags = [kind === 'customs' ? 'Admin · Customs rules' : 'Admin · Restricted items'];
  const Create = kind === 'customs' ? CustomsCreate : RestrictedCreate;
  const Patch = kind === 'customs' ? CustomsPatch : RestrictedPatch;

  r.openapi(
    createRoute({ method: 'get', path: base, tags, security: bearer, summary: 'Versions (all statuses) with last_verified_at and needsVerification', middleware: adminGuard([perm]), request: { query: ListQuery }, responses: { 200: jsonContent(AdminPage), ...errorResponses } }),
    async (c) => c.json(await svc.listRules(await adminCtx(c), kind, c.req.valid('query')), 200),
  );
  r.openapi(
    createRoute({ method: 'get', path: `${base}/{id}`, tags, security: bearer, summary: 'Version detail + sibling versions of the same code', middleware: adminGuard([perm]), request: { params: IdParam }, responses: { 200: jsonContent(AdminLoose), ...errorResponses } }),
    async (c) => c.json(await svc.ruleDetail(await adminCtx(c), kind, c.req.valid('param').id), 200),
  );
  r.openapi(
    createRoute({ method: 'post', path: base, tags, security: bearer, summary: 'Create a NEW version (DRAFT; version = max + 1 per code; source reference required)', middleware: adminGuard([perm]), request: jsonBody(Create), responses: { 201: jsonContent(AdminLoose, 'Draft created'), ...errorResponses } }),
    async (c) => c.json(await svc.createRule(await adminCtx(c), kind, c.req.valid('json') as never), 201),
  );
  r.openapi(
    createRoute({ method: 'patch', path: `${base}/{id}`, tags, security: bearer, summary: 'Edit a DRAFT version (ACTIVE rows are immutable)', middleware: adminGuard([perm]), request: { params: IdParam, ...jsonBody(Patch) }, responses: { 200: jsonContent(AdminLoose), ...errorResponses } }),
    async (c) => c.json(await svc.updateRule(await adminCtx(c), kind, c.req.valid('param').id, c.req.valid('json') as Record<string, unknown>), 200),
  );
  r.openapi(
    createRoute({ method: 'post', path: `${base}/{id}/discard`, tags, security: bearer, summary: 'Discard a DRAFT version (rule tables are append-only: the draft becomes RETIRED, never in force)', middleware: adminGuard([perm]), request: { params: IdParam, ...jsonBody(ReasonBody) }, responses: { 200: jsonContent(AdminLoose), ...errorResponses } }),
    async (c) => c.json(await svc.discardDraft(await adminCtx(c), kind, c.req.valid('param').id, c.req.valid('json').reason), 200),
  );
  r.openapi(
    createRoute({ method: 'post', path: `${base}/{id}/submit`, tags, security: bearer, summary: 'DRAFT → PENDING_APPROVAL', middleware: adminGuard([perm]), request: { params: IdParam }, responses: { 200: jsonContent(AdminLoose), ...errorResponses } }),
    async (c) => c.json(await svc.submitRule(await adminCtx(c), kind, c.req.valid('param').id), 200),
  );
  r.openapi(
    createRoute({ method: 'post', path: `${base}/{id}/approve`, tags, security: bearer, summary: 'PENDING_APPROVAL → ACTIVE (different admin, fresh MFA); overlapping ACTIVE version closed/retired', middleware: adminGuard([perm], { mfa: true }), request: { params: IdParam }, responses: { 200: jsonContent(AdminLoose), ...errorResponses } }),
    async (c) => c.json(await svc.approveRule(await adminCtx(c), kind, c.req.valid('param').id), 200),
  );
  r.openapi(
    createRoute({ method: 'post', path: `${base}/{id}/reject`, tags, security: bearer, summary: 'PENDING_APPROVAL → DRAFT with reason', middleware: adminGuard([perm]), request: { params: IdParam, ...jsonBody(ReasonBody) }, responses: { 200: jsonContent(AdminLoose), ...errorResponses } }),
    async (c) => c.json(await svc.rejectRule(await adminCtx(c), kind, c.req.valid('param').id, c.req.valid('json').reason), 200),
  );
  r.openapi(
    createRoute({ method: 'post', path: `${base}/{id}/retire`, tags, security: bearer, summary: 'ACTIVE → RETIRED', middleware: adminGuard([perm], { mfa: true }), request: { params: IdParam, ...jsonBody(ReasonBody) }, responses: { 200: jsonContent(AdminLoose), ...errorResponses } }),
    async (c) => c.json(await svc.retireRule(await adminCtx(c), kind, c.req.valid('param').id, c.req.valid('json').reason), 200),
  );
  r.openapi(
    createRoute({ method: 'post', path: `${base}/{id}/reverify`, tags, security: bearer, summary: 'Record a re-verification (last_verified_at, verified_by — metadata allowed on ACTIVE)', middleware: adminGuard([perm]), request: { params: IdParam, ...jsonBody(ReverifyBody) }, responses: { 200: jsonContent(AdminLoose), ...errorResponses } }),
    async (c) => c.json(await svc.reverifyRule(await adminCtx(c), kind, c.req.valid('param').id, c.req.valid('json')), 200),
  );
  r.openapi(
    createRoute({ method: 'post', path: `${base}/{id}/preview`, tags, security: bearer, summary: 'Impact preview: sample item with rules in force vs. with this version replacing its code', middleware: adminGuard([perm]), request: { params: IdParam, ...jsonBody(PreviewBody) }, responses: { 200: jsonContent(AdminLoose), ...errorResponses } }),
    async (c) => c.json(await svc.previewRule(await adminCtx(c), kind, c.req.valid('param').id, c.req.valid('json')), 200),
  );
  app.route('/', r);
}

export function registerAdminRules(app: App) {
  registerKind(app, 'customs');
  registerKind(app, 'restricted');
}
