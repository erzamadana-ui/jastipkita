/**
 * Legal document catalogue — mirror of apps/api/src/modules/legal/catalog.ts (DB type ↔ slug ↔ web page
 * /legal/<slug>/ ↔ docs/legal/<slug>.md). Pure module: used at build time and in browser islands.
 */
export type LegalType =
  | 'TOS'
  | 'PRIVACY'
  | 'KYC'
  | 'MARKETING'
  | 'COOKIES'
  | 'TRAVELER_AGREEMENT'
  | 'PAYMENT_TERMS'
  | 'REFUND_POLICY'
  | 'PROHIBITED_ITEMS'
  | 'COMMUNITY_GUIDELINES';

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

export function legalTypeForSlug(slug: string): LegalType | null {
  const hit = (Object.entries(LEGAL_SLUGS) as Array<[LegalType, string]>).find(([, s]) => s === slug);
  return hit ? hit[0] : null;
}

/** Signup consents per the API contract (GET /v1/consents/requirements → signup). Used only as offline fallback. */
export const SIGNUP_REQUIRED: LegalType[] = ['TOS', 'PRIVACY'];
export const SIGNUP_OPTIONAL: LegalType[] = ['MARKETING'];

/** Consent item as the site uses it (API ConsentRequirement subset, or the build-time fallback). */
export interface ConsentItem {
  type: LegalType;
  required: boolean;
  /** Version to submit; null = API says no published document yet (any version accepted). */
  version: string | null;
  acceptedVersions: string[];
  title: string;
  /** Web page URL (absolute from the API, base-relative from the fallback). */
  url: string;
}

const MONTHS_ID = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];

/** "2026-09-27T00:00:00Z" → "27 Sep 2026" (calendar date in WIB). Returns the input when not a date. */
export function formatLegalDate(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const d = new Date(t + 7 * 3600_000); // Asia/Jakarta, fixed +07:00
  return `${d.getUTCDate()} ${MONTHS_ID[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
