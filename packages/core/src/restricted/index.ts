import { type RestrictedClassification, RESTRICTED_CLASSIFICATIONS, type RuleStatus, classificationSeverity } from '../domain';
import { CoreError } from '../errors';
import { compareStrings, sortBy } from '../internal/math';
import { type DateInput, isWithinInclusiveDates } from '../internal/time';
import { compareDecimal, parseDecimal } from '../money';

/** §16 rule status — only ACTIVE rules are used by the engine. */
export type RestrictedRuleStatus = RuleStatus;

/** Mirrors DB table `restricted_items`. */
export interface RestrictedItemRule {
  readonly id?: string;
  readonly code: string;
  readonly version: number;
  readonly originCountry: string | null;
  readonly destinationCountry: string;
  readonly categoryCode: string | null;
  readonly hsCodePrefix: string | null;
  readonly keywords: readonly string[];
  readonly classification: RestrictedClassification;
  /** Allowed maximum under this rule; exceeding it escalates the item to PROHIBITED. */
  readonly maxQuantity: number | null;
  readonly maxValueUsd: string | number | null;
  readonly permitAuthority: string | null;
  /** DB `airline_dg boolean`: aviation dangerous goods (IATA DG). */
  readonly airlineDg: boolean;
  /** Optional free-text DG handling note (e.g. "carry-on only, ≤ 100 Wh"). Not a DB column requirement. */
  readonly dgNote?: string | null;
  readonly messageId: string;
  readonly messageEn: string;
  readonly sourceReference: string;
  /** Inclusive first day (§16). */
  readonly effectiveFrom: DateInput;
  /** Inclusive last day (§16); null = open-ended. */
  readonly effectiveUntil: DateInput | null;
  readonly status: RestrictedRuleStatus;
}

export interface ClassifyItemInput {
  readonly origin: string;
  readonly destination: string;
  readonly categoryCode: string;
  readonly hsCode?: string | null;
  readonly productName: string;
  readonly quantity: number;
  readonly valueUsd?: string | number | null;
}

export type MatchedOn = 'CATEGORY' | 'HS_CODE' | 'KEYWORD' | 'ROUTE';

export interface RestrictedMatch {
  readonly code: string;
  readonly version: number;
  /** Effective classification after quantity/value limits. */
  readonly classification: RestrictedClassification;
  readonly ruleClassification: RestrictedClassification;
  readonly matchedOn: readonly MatchedOn[];
  readonly matchedKeyword: string | null;
  readonly limitExceeded: { readonly kind: 'QUANTITY' | 'VALUE_USD'; readonly limit: string; readonly actual: string } | null;
  readonly valueCheckSkipped: boolean;
  readonly messageId: string;
  readonly messageEn: string;
  readonly permitAuthority: string | null;
  readonly airlineDg: boolean;
  readonly dgNote: string | null;
  readonly sourceReference: string;
}

export interface ClassificationResult {
  readonly classification: RestrictedClassification;
  /** PROHIBITED blocks checkout (§7). */
  readonly blocksCheckout: boolean;
  /** Every non-ALLOWED, non-PROHIBITED classification needs buyer acknowledgement before payment (§7). */
  readonly requiresAcknowledgement: boolean;
  readonly matches: readonly RestrictedMatch[];
  readonly permitAuthorities: readonly string[];
  /** True when any matching rule flags aviation dangerous goods. */
  readonly airlineDg: boolean;
  readonly dgNotes: readonly string[];
  readonly messagesId: readonly string[];
  readonly messagesEn: readonly string[];
}

const DENSE_SCRIPT_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u;

/** Lowercase, accent-insensitive, punctuation → single spaces. */
export function normalizeText(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Word-boundary keyword match ("power bank" matches "Anker Power-Bank 20k" but "vape" does not match
 * "vapers"). Scripts without spaces (CJK, Thai) fall back to substring matching.
 */
export function keywordMatches(text: string, keyword: string): boolean {
  const k = normalizeText(keyword);
  if (k === '') return false;
  const t = normalizeText(text);
  if (DENSE_SCRIPT_RE.test(k)) return t.replace(/ /g, '').includes(k.replace(/ /g, ''));
  return ` ${t} `.includes(` ${k} `);
}

function hsDigits(hs: string | null | undefined): string | null {
  if (!hs) return null;
  const d = hs.replace(/[^0-9]/g, '');
  return d.length > 0 ? d : null;
}

/** §16: inclusive calendar dates, evaluated in Asia/Jakarta (+07:00). */
function isEffective(rule: RestrictedItemRule, date: Date): boolean {
  return isWithinInclusiveDates(date, rule.effectiveFrom, rule.effectiveUntil);
}

function matchRule(rule: RestrictedItemRule, input: ClassifyItemInput): RestrictedMatch | null {
  if (rule.destinationCountry !== input.destination) return null;
  if (rule.originCountry !== null && rule.originCountry !== input.origin) return null;
  const matchedOn: MatchedOn[] = [];
  if (rule.categoryCode !== null) {
    if (rule.categoryCode !== input.categoryCode) return null;
    matchedOn.push('CATEGORY');
  }
  const prefix = hsDigits(rule.hsCodePrefix);
  if (prefix !== null) {
    const hs = hsDigits(input.hsCode);
    if (hs === null || !hs.startsWith(prefix)) return null;
    matchedOn.push('HS_CODE');
  }
  let matchedKeyword: string | null = null;
  if (rule.keywords.length > 0) {
    matchedKeyword = rule.keywords.find((k) => keywordMatches(input.productName, k)) ?? null;
    if (matchedKeyword === null) return null;
    matchedOn.push('KEYWORD');
  }
  if (matchedOn.length === 0) matchedOn.push('ROUTE');

  let limitExceeded: RestrictedMatch['limitExceeded'] = null;
  let valueCheckSkipped = false;
  if (rule.maxQuantity !== null && input.quantity > rule.maxQuantity) {
    limitExceeded = { kind: 'QUANTITY', limit: String(rule.maxQuantity), actual: String(input.quantity) };
  } else if (rule.maxValueUsd !== null) {
    if (input.valueUsd === undefined || input.valueUsd === null) {
      valueCheckSkipped = true;
    } else if (compareDecimal(input.valueUsd, rule.maxValueUsd) > 0) {
      limitExceeded = { kind: 'VALUE_USD', limit: String(rule.maxValueUsd), actual: String(input.valueUsd) };
    }
  }
  return {
    code: rule.code,
    version: rule.version,
    classification: limitExceeded ? 'PROHIBITED' : rule.classification,
    ruleClassification: rule.classification,
    matchedOn,
    matchedKeyword,
    limitExceeded,
    valueCheckSkipped,
    messageId: limitExceeded
      ? `${rule.messageId} (Melebihi batas: ${limitExceeded.actual} > ${limitExceeded.limit}.)`
      : rule.messageId,
    messageEn: limitExceeded ? `${rule.messageEn} (Limit exceeded: ${limitExceeded.actual} > ${limitExceeded.limit}.)` : rule.messageEn,
    permitAuthority: rule.permitAuthority,
    airlineDg: rule.airlineDg,
    dgNote: rule.dgNote ?? null,
    sourceReference: rule.sourceReference,
  };
}

/**
 * Classifies an item against active, effective restricted-item rules.
 * Returns the most severe classification (PROHIBITED > PERMIT_REQUIRED > RESTRICTED >
 * DECLARATION_REQUIRED > ALLOWED) plus every matching rule.
 *
 * Matching: all selectors present on a rule must match (category AND hs-prefix AND any-keyword);
 * a rule with no selectors applies to the whole origin→destination route.
 */
export function classifyItem(
  input: ClassifyItemInput,
  rules: readonly RestrictedItemRule[],
  date: Date,
): ClassificationResult {
  if (!Number.isSafeInteger(input.quantity) || input.quantity < 1) {
    throw new CoreError('INVALID_QUANTITY', `quantity must be a positive integer, got ${input.quantity}`);
  }
  if (input.valueUsd !== undefined && input.valueUsd !== null) parseDecimal(input.valueUsd);

  const matches: RestrictedMatch[] = [];
  for (const rule of rules) {
    if (rule.status !== 'ACTIVE' || !isEffective(rule, date)) continue;
    const m = matchRule(rule, input);
    if (m) matches.push(m);
  }
  const sorted = sortBy(
    matches,
    (a, b) => classificationSeverity(b.classification) - classificationSeverity(a.classification) || compareStrings(a.code, b.code),
  );
  const classification: RestrictedClassification = sorted[0]?.classification ?? 'ALLOWED';
  const uniq = <T>(xs: readonly (T | null)[]): T[] => [...new Set(xs.filter((x): x is T => x !== null))];

  return {
    classification,
    blocksCheckout: classification === 'PROHIBITED',
    requiresAcknowledgement: classification !== 'ALLOWED' && classification !== 'PROHIBITED',
    matches: sorted,
    permitAuthorities: uniq(sorted.map((m) => m.permitAuthority)),
    airlineDg: sorted.some((m) => m.airlineDg),
    dgNotes: uniq(sorted.map((m) => m.dgNote)),
    messagesId: sorted.map((m) => m.messageId),
    messagesEn: sorted.map((m) => m.messageEn),
  };
}

export function mostSevere(a: RestrictedClassification, b: RestrictedClassification): RestrictedClassification {
  return classificationSeverity(a) >= classificationSeverity(b) ? a : b;
}

export { RESTRICTED_CLASSIFICATIONS };
