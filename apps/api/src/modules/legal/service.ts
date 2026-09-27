/**
 * Public legal documents (latest PUBLISHED version per type & locale, markdown bodies) and the consent requirements
 * clients must collect at signup and before KYC. Versions come from the same query that validates
 * POST /v1/me/consents (me/repository acceptedConsentVersions), so what the app shows is what the API accepts.
 */
import type { AppDeps, AuthContext } from '../../context';
import { Errors } from '../../lib/errors';
import { acceptedConsentVersions, KYC_REQUIRED_CONSENTS, SIGNUP_OPTIONAL_CONSENTS, SIGNUP_REQUIRED_CONSENTS } from '../me/repository';
import { LEGAL_ORDER, LEGAL_SLUGS, LEGAL_TEMPLATE_BANNER, type LegalLocale, type LegalType, legalTypeFromSlugOrType } from './catalog';

/** Consent types recorded via POST /v1/me/consents (consents.type CHECK). */
export const CONSENT_DOCUMENT_TYPES = ['TOS', 'PRIVACY', 'KYC', 'MARKETING', 'COOKIES', 'TRAVELER_AGREEMENT', 'PAYMENT_TERMS'] as const;
type ConsentType = (typeof CONSENT_DOCUMENT_TYPES)[number];

interface LegalRow {
  type: LegalType;
  version: string;
  locale: LegalLocale;
  title: string;
  summary: string | null;
  body_md: string;
  effective_at: Date | null;
  published_at: Date;
  retired_at: Date | null;
}

const trimSlash = (u: string) => u.replace(/\/+$/, '');

function summaryDto(deps: AppDeps, r: LegalRow) {
  const slug = LEGAL_SLUGS[r.type];
  return {
    type: r.type,
    version: r.version,
    locale: r.locale,
    title: r.title,
    summary: r.summary,
    effectiveAt: (r.effective_at ?? r.published_at).toISOString(),
    publishedAt: r.published_at.toISOString(),
    slug,
    url: `${trimSlash(deps.env.WEB_BASE_URL)}/legal/${slug}/`,
    contentUrl: `${trimSlash(deps.env.API_BASE_URL)}/v1/legal/documents/${r.type}?locale=${r.locale}&version=${encodeURIComponent(r.version)}`,
    isTemplate: r.version.endsWith('-template') || r.body_md.includes(LEGAL_TEMPLATE_BANNER),
    consentType: (CONSENT_DOCUMENT_TYPES as readonly string[]).includes(r.type),
  };
}

/** Current = latest published, non-retired version per (type, locale). */
async function currentDocuments(deps: AppDeps, f: { type?: LegalType | undefined; locale?: LegalLocale | undefined } = {}): Promise<LegalRow[]> {
  const db = deps.sql;
  return db<LegalRow[]>`
    SELECT DISTINCT ON (type, locale) type, version, locale, title, summary, body_md, effective_at, published_at, retired_at
      FROM legal_documents
     WHERE published_at IS NOT NULL AND retired_at IS NULL
       ${f.type ? db`AND type = ${f.type}` : db``}
       ${f.locale ? db`AND locale = ${f.locale}` : db``}
     ORDER BY type, locale, published_at DESC, created_at DESC`;
}

export async function listDocuments(deps: AppDeps, q: { type?: LegalType | undefined; locale?: LegalLocale | undefined }) {
  const rows = await currentDocuments(deps, q);
  rows.sort((a, b) => LEGAL_ORDER[a.type] - LEGAL_ORDER[b.type] || a.locale.localeCompare(b.locale));
  return { data: rows.map((r) => summaryDto(deps, r)) };
}

export async function getDocument(deps: AppDeps, typeOrSlug: string, q: { locale: LegalLocale; version?: string | undefined }) {
  const type = legalTypeFromSlugOrType(typeOrSlug);
  if (!type) throw Errors.notFound('Dokumen legal', 'LEGAL_DOCUMENT_NOT_FOUND');
  const db = deps.sql;
  const pick = async (locale: LegalLocale) => {
    const [row] = q.version
      ? await db<LegalRow[]>`
          SELECT type, version, locale, title, summary, body_md, effective_at, published_at, retired_at FROM legal_documents
           WHERE type = ${type} AND locale = ${locale} AND version = ${q.version} AND published_at IS NOT NULL`
      : await currentDocuments(deps, { type, locale });
    return row ?? null;
  };
  const row = (await pick(q.locale)) ?? (q.locale !== 'id' ? await pick('id') : null);
  if (!row) throw Errors.notFound('Dokumen legal', 'LEGAL_DOCUMENT_NOT_FOUND');
  return { ...summaryDto(deps, row), bodyMd: row.body_md, retiredAt: row.retired_at?.toISOString() ?? null, requestedLocale: q.locale };
}

export async function consentRequirements(deps: AppDeps, auth: AuthContext | undefined, locale: LegalLocale) {
  const db = deps.sql;
  const docs = await currentDocuments(deps);
  const current = new Map<string, LegalRow>();
  for (const d of docs) {
    // requested locale first, Indonesian as the fallback
    const prev = current.get(d.type);
    if (!prev || (prev.locale !== locale && d.locale === locale)) current.set(d.type, d);
  }
  const decisions = auth
    ? new Map(
        (
          await db<{ type: string; version: string; granted: boolean }[]>`
            SELECT type, version, granted FROM v_user_consents_current WHERE user_id = ${auth.userId}`
        ).map((c) => [c.type, c]),
      )
    : null;

  const requirement = async (type: ConsentType, required: boolean) => {
    const accepted = await acceptedConsentVersions(db, type);
    const doc = current.get(type) ?? null;
    const decision = decisions?.get(type) ?? null;
    const granted = decisions ? !!decision?.granted : null;
    const summary = doc ? summaryDto(deps, doc) : null;
    return {
      type,
      required,
      version: accepted[0] ?? null,
      acceptedVersions: accepted,
      versionEnforced: accepted.length > 0,
      title: doc?.title ?? null,
      summary: doc?.summary ?? null,
      url: summary?.url ?? `${trimSlash(deps.env.WEB_BASE_URL)}/legal/${LEGAL_SLUGS[type]}/`,
      documentUrl: summary ? `${trimSlash(deps.env.API_BASE_URL)}/v1/legal/documents/${type}?locale=${doc!.locale}` : null,
      granted,
      grantedVersion: decisions ? (decision?.version ?? null) : null,
      upToDate: decisions ? !!decision?.granted && (accepted.length === 0 || accepted.includes(decision.version)) : null,
    };
  };
  const stage = async (required: readonly ConsentType[], optional: readonly ConsentType[]) => {
    const req = await Promise.all(required.map((t) => requirement(t, true)));
    const opt = await Promise.all(optional.map((t) => requirement(t, false)));
    return { required: req, optional: opt, satisfied: auth ? req.every((r) => r.upToDate === true) : null };
  };
  return {
    locale,
    signup: await stage(SIGNUP_REQUIRED_CONSENTS, SIGNUP_OPTIONAL_CONSENTS),
    kyc: await stage(KYC_REQUIRED_CONSENTS, []),
  };
}
