/**
 * OFFLINE FALLBACK of the restricted-items check (used only when POST /v1/restricted/check is unreachable).
 * Mirrors packages/core `classifyItem` semantics on the ACTIVE rules of db/seeds/0101_restricted_items.sql:
 *  - every selector present on a rule must match (category AND HS prefix AND any keyword);
 *  - keywords match on word boundaries after normalisation (lowercase, accents & punctuation stripped);
 *  - max_quantity exceeded → PROHIBITED; value limits are skipped offline (no FX) and reported;
 *  - the most severe classification wins: PROHIBITED > PERMIT_REQUIRED > RESTRICTED > DECLARATION_REQUIRED > ALLOWED.
 * Pure module (no imports).
 */

export type Classification = 'ALLOWED' | 'RESTRICTED' | 'DECLARATION_REQUIRED' | 'PERMIT_REQUIRED' | 'PROHIBITED';

export interface RestrictedRule {
  code: string;
  version: number;
  originCountry: string | null;
  destinationCountry: string;
  categoryCode: string | null;
  hsCodePrefix: string | null;
  keywords: string[];
  classification: Classification;
  maxQuantity: number | null;
  maxValueUsd: number | string | null;
  permitAuthority: string | null;
  airlineDg: boolean;
  messageId: string;
  messageEn: string;
  sourceReference: string;
  sourceUrl: string | null;
  status: string;
}

export interface CheckInput {
  origin: string;
  destination?: string;
  categoryCode: string;
  productName: string;
  quantity: number;
}

export interface CheckMatch {
  code: string;
  classification: Classification;
  ruleClassification: Classification;
  matchedKeyword: string | null;
  quantityExceeded: { limit: number; actual: number } | null;
  valueCheckSkipped: boolean;
  messageId: string;
  messageEn: string;
  permitAuthority: string | null;
  airlineDg: boolean;
  sourceReference: string;
}

export interface CheckResult {
  classification: Classification;
  blocksCheckout: boolean;
  requiresAcknowledgement: boolean;
  matches: CheckMatch[];
  airlineDg: boolean;
  permitAuthorities: string[];
}

export const SEVERITY: Record<Classification, number> = {
  ALLOWED: 0,
  DECLARATION_REQUIRED: 1,
  RESTRICTED: 2,
  PERMIT_REQUIRED: 3,
  PROHIBITED: 4,
};

const DENSE_SCRIPT_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u;

export function normalizeText(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function keywordMatches(text: string, keyword: string): boolean {
  const k = normalizeText(keyword);
  if (k === '') return false;
  const t = normalizeText(text);
  if (DENSE_SCRIPT_RE.test(k)) return t.replace(/ /g, '').includes(k.replace(/ /g, ''));
  return ` ${t} `.includes(` ${k} `);
}

export function classifyOffline(input: CheckInput, rules: readonly RestrictedRule[]): CheckResult {
  const destination = input.destination ?? 'ID';
  const matches: CheckMatch[] = [];
  for (const rule of rules) {
    if (rule.status !== 'ACTIVE') continue;
    if (rule.destinationCountry !== destination) continue;
    if (rule.originCountry !== null && rule.originCountry !== input.origin) continue;
    if (rule.categoryCode !== null && rule.categoryCode !== input.categoryCode) continue;
    if (rule.hsCodePrefix !== null) continue; // HS-code rules need an HS code — not collected by the public form
    let matchedKeyword: string | null = null;
    if (rule.keywords.length > 0) {
      matchedKeyword = rule.keywords.find((k) => keywordMatches(input.productName, k)) ?? null;
      if (matchedKeyword === null) continue;
    }
    const exceeded =
      rule.maxQuantity !== null && input.quantity > rule.maxQuantity
        ? { limit: rule.maxQuantity, actual: input.quantity }
        : null;
    matches.push({
      code: rule.code,
      classification: exceeded ? 'PROHIBITED' : rule.classification,
      ruleClassification: rule.classification,
      matchedKeyword,
      quantityExceeded: exceeded,
      valueCheckSkipped: !exceeded && rule.maxValueUsd !== null,
      messageId: rule.messageId,
      messageEn: rule.messageEn,
      permitAuthority: rule.permitAuthority,
      airlineDg: rule.airlineDg,
      sourceReference: rule.sourceReference,
    });
  }
  matches.sort((a, b) => SEVERITY[b.classification] - SEVERITY[a.classification] || a.code.localeCompare(b.code));
  const classification: Classification = matches[0]?.classification ?? 'ALLOWED';
  const authorities = [...new Set(matches.map((m) => m.permitAuthority).filter((a): a is string => !!a))];
  return {
    classification,
    blocksCheckout: classification === 'PROHIBITED',
    requiresAcknowledgement: classification !== 'ALLOWED' && classification !== 'PROHIBITED',
    matches,
    airlineDg: matches.some((m) => m.airlineDg),
    permitAuthorities: authorities,
  };
}

/** Category-level summary for the static list: the strongest ACTIVE category rule per category code. */
export function categoryRuleMap(rules: readonly RestrictedRule[]): Record<string, RestrictedRule> {
  const out: Record<string, RestrictedRule> = {};
  for (const r of rules) {
    if (r.status !== 'ACTIVE' || !r.categoryCode || r.keywords.length > 0 || r.originCountry) continue;
    const prev = out[r.categoryCode];
    if (!prev || SEVERITY[r.classification] > SEVERITY[prev.classification]) out[r.categoryCode] = r;
  }
  return out;
}
