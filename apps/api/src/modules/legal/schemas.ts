import { z } from '@hono/zod-openapi';
import { LEGAL_LOCALES, LEGAL_TYPES } from './catalog';

export const LegalTypeEnum = z.enum(LEGAL_TYPES);
export const LegalLocaleEnum = z.enum(LEGAL_LOCALES);

export const LegalDocumentSummarySchema = z
  .object({
    type: LegalTypeEnum,
    version: z.string().openapi({ example: '0.1-template' }),
    locale: LegalLocaleEnum,
    title: z.string().openapi({ example: 'Syarat & Ketentuan Penggunaan' }),
    summary: z.string().nullable(),
    effectiveAt: z.string().openapi({ description: 'effective_at, or published_at when not set (ISO-8601 UTC)' }),
    publishedAt: z.string(),
    slug: z.string().openapi({ example: 'terms-of-service' }),
    url: z.string().openapi({ description: 'Absolute web page URL', example: 'https://jastipkita.com/legal/terms-of-service/' }),
    contentUrl: z.string().openapi({ description: 'Absolute API URL of this exact version (markdown body)' }),
    isTemplate: z.boolean().openapi({ description: 'true while the text is an unreviewed TEMPLATE (show the banner)' }),
    consentType: z.boolean().openapi({ description: 'true when users record consent to this document (POST /v1/me/consents)' }),
  })
  .openapi('LegalDocumentSummary');

export const LegalDocumentListSchema = z.object({ data: z.array(LegalDocumentSummarySchema) }).openapi('LegalDocumentList');

export const LegalDocumentSchema = LegalDocumentSummarySchema.extend({
  bodyMd: z.string().openapi({ description: 'Markdown body (TEMPLATE banner included verbatim)' }),
  retiredAt: z.string().nullable().openapi({ description: 'Set when a newer version replaced this one' }),
  requestedLocale: LegalLocaleEnum.openapi({ description: 'Locale asked for; differs from `locale` when the document fell back to Indonesian' }),
}).openapi('LegalDocument');

export const LegalListQuery = z.object({
  locale: LegalLocaleEnum.optional().openapi({ description: 'Only this locale (default: all locales)' }),
  type: LegalTypeEnum.optional(),
});

export const LegalDocQuery = z.object({
  locale: LegalLocaleEnum.default('id').openapi({ description: 'Falls back to `id` when the document has no version in this locale' }),
  version: z
    .string()
    .regex(/^[0-9A-Za-z._-]{1,40}$/)
    .optional()
    .openapi({ description: 'A specific published version (also retired ones, e.g. the version a user consented to). Default: current' }),
});

export const LegalTypeParam = z.object({
  type: z
    .string()
    .regex(/^[A-Za-z_-]{2,40}$/)
    .openapi({ param: { name: 'type', in: 'path' }, description: 'Document type (TOS, PRIVACY, …) or slug (terms-of-service, …)', example: 'TOS' }),
});

const ConsentTypeEnum = z.enum(['TOS', 'PRIVACY', 'KYC', 'MARKETING', 'COOKIES', 'TRAVELER_AGREEMENT', 'PAYMENT_TERMS']);

export const ConsentRequirementSchema = z
  .object({
    type: ConsentTypeEnum,
    required: z.boolean(),
    version: z
      .string()
      .nullable()
      .openapi({ description: 'Version to show and submit (current published version); null = no published document yet (any version accepted)' }),
    acceptedVersions: z.array(z.string()).openapi({ description: 'Every version POST /v1/me/consents accepts right now (empty = not enforced yet)' }),
    versionEnforced: z.boolean(),
    title: z.string().nullable(),
    summary: z.string().nullable(),
    url: z.string().nullable().openapi({ description: 'Absolute web page URL of the document' }),
    documentUrl: z.string().nullable().openapi({ description: 'Absolute API URL of the markdown body (GET /v1/legal/documents/{type})' }),
    granted: z.boolean().nullable().openapi({ description: "Signed-in caller: current decision is granted (null when anonymous)" }),
    grantedVersion: z.string().nullable().openapi({ description: 'Signed-in caller: version of the current decision' }),
    upToDate: z
      .boolean()
      .nullable()
      .openapi({ description: 'Signed-in caller: granted AND the granted version is still accepted (null when anonymous)' }),
  })
  .openapi('ConsentRequirement');

const Stage = z.object({
  required: z.array(ConsentRequirementSchema),
  optional: z.array(ConsentRequirementSchema),
  satisfied: z.boolean().nullable().openapi({ description: 'Signed-in caller: every required consent is upToDate (null when anonymous)' }),
});

export const ConsentRequirementsSchema = z
  .object({
    locale: LegalLocaleEnum,
    signup: Stage.openapi({ description: 'Sent as `consents` with OTP verify / Google / Apple sign-in for a new account' }),
    kyc: Stage.openapi({ description: 'Recorded with POST /v1/me/consents before POST /v1/kyc/submissions' }),
  })
  .openapi('ConsentRequirements');
