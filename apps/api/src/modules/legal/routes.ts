import { createRoute, z } from '@hono/zod-openapi';
import type { App } from '../../context';
import { createRouter, errorResponses, jsonContent } from '../../lib/openapi';
import { optionalAuth } from '../../middleware/auth';
import { rateLimit } from '../../middleware/rate-limit';
import {
  ConsentRequirementsSchema,
  LegalDocQuery,
  LegalDocumentListSchema,
  LegalDocumentSchema,
  LegalListQuery,
  LegalLocaleEnum,
  LegalTypeParam,
} from './schemas';
import * as svc from './service';

const tags = ['Legal'];
const publicLimit = rateLimit({ name: 'legal.public', limit: 120, windowSec: 60, key: 'ip' });

/**
 * Public legal documents + consent requirements. Registered by the identity group (consents live there);
 * documents are managed via /v1/admin/legal-documents (admin group).
 */
export function registerLegal(app: App): void {
  const r = createRouter();

  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/legal/documents',
      tags,
      summary: 'Current legal documents (latest published version per type & locale)',
      description: 'Public. Seeded templates carry version `0.1-template` and `isTemplate: true` (show the TEMPLATE banner).',
      middleware: [publicLimit] as const,
      request: { query: LegalListQuery },
      responses: { 200: jsonContent(LegalDocumentListSchema), ...errorResponses },
    }),
    async (c) => {
      c.header('cache-control', 'public, max-age=300');
      return c.json(await svc.listDocuments(c.get('deps'), c.req.valid('query')), 200);
    },
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/legal/documents/{type}',
      tags,
      summary: 'One legal document with its markdown body (current version, or ?version=)',
      description: '`type` accepts the type code (TOS) or the slug (terms-of-service). Falls back to Indonesian when the locale has no version.',
      middleware: [publicLimit] as const,
      request: { params: LegalTypeParam, query: LegalDocQuery },
      responses: { 200: jsonContent(LegalDocumentSchema), ...errorResponses },
    }),
    async (c) => {
      c.header('cache-control', 'public, max-age=300');
      return c.json(await svc.getDocument(c.get('deps'), c.req.valid('param').type, c.req.valid('query')), 200);
    },
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/consents/requirements',
      tags,
      summary: 'Consents (type + version) to collect at signup and before KYC',
      description:
        'Public; with a bearer token the caller\'s current decisions are included (granted / upToDate / satisfied). ' +
        '`version` and `acceptedVersions` are exactly what POST /v1/me/consents and signup `consents` accept (422 CONSENT_VERSION_INVALID otherwise).',
      middleware: [publicLimit, optionalAuth] as const,
      request: { query: z.object({ locale: LegalLocaleEnum.default('id') }) },
      responses: { 200: jsonContent(ConsentRequirementsSchema), ...errorResponses },
    }),
    async (c) => {
      c.header('cache-control', 'private, no-cache');
      return c.json(await svc.consentRequirements(c.get('deps'), c.get('auth'), c.req.valid('query').locale), 200);
    },
  );

  app.route('/', r);
}
