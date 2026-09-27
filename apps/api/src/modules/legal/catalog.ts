/**
 * Legal document catalogue: DB type ↔ public slug (= docs/legal/<slug>.md = web page /legal/<slug>/) and list order.
 * Shared by the public legal API and scripts/gen-legal-seed.ts.
 */
export const LEGAL_TYPES = [
  'TOS',
  'PRIVACY',
  'KYC',
  'MARKETING',
  'COOKIES',
  'TRAVELER_AGREEMENT',
  'PAYMENT_TERMS',
  'REFUND_POLICY',
  'PROHIBITED_ITEMS',
  'COMMUNITY_GUIDELINES',
] as const;
export type LegalType = (typeof LEGAL_TYPES)[number];

export const LEGAL_LOCALES = ['id', 'en'] as const;
export type LegalLocale = (typeof LEGAL_LOCALES)[number];

/** slug = file name in docs/legal and path segment on the website (`${WEB_BASE_URL}/legal/<slug>/`). */
export const LEGAL_SLUGS: Readonly<Record<LegalType, string>> = {
  TOS: 'terms-of-service',
  PRIVACY: 'privacy-policy',
  PAYMENT_TERMS: 'payment-terms',
  REFUND_POLICY: 'refund-policy',
  TRAVELER_AGREEMENT: 'traveler-agreement',
  PROHIBITED_ITEMS: 'prohibited-items-policy',
  KYC: 'kyc-consent',
  MARKETING: 'marketing-consent',
  COOKIES: 'cookie-policy',
  COMMUNITY_GUIDELINES: 'community-guidelines',
};

/** Display order (frontmatter `order` of docs/legal/*.md). */
export const LEGAL_ORDER: Readonly<Record<LegalType, number>> = {
  TOS: 1,
  PRIVACY: 2,
  TRAVELER_AGREEMENT: 3,
  REFUND_POLICY: 4,
  PROHIBITED_ITEMS: 5,
  PAYMENT_TERMS: 6,
  KYC: 7,
  MARKETING: 8,
  COOKIES: 9,
  COMMUNITY_GUIDELINES: 10,
};

export function legalTypeFromSlugOrType(v: string): LegalType | null {
  const upper = v.toUpperCase().replace(/-/g, '_');
  if ((LEGAL_TYPES as readonly string[]).includes(upper)) return upper as LegalType;
  const bySlug = (Object.entries(LEGAL_SLUGS) as [LegalType, string][]).find(([, slug]) => slug === v.toLowerCase());
  return bySlug ? bySlug[0] : null;
}

/** Version of the seeded templates (db/seeds/0200_legal_documents.sql). */
export const LEGAL_TEMPLATE_VERSION = '0.1-template';
/** The banner every template carries (kept verbatim in the published body). */
export const LEGAL_TEMPLATE_BANNER = 'TEMPLATE — wajib direview konsultan hukum sebelum production launch; bukan nasihat hukum.';
