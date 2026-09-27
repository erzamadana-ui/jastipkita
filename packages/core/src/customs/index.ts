import { findCategory } from '../config';
import { CoreError, type Reason } from '../errors';
import { convert, normalizeRate, type RateInput } from '../fx';
import { compareStrings, sortBy } from '../internal/math';
import { DAY_MS, type DateInput, isWithinInclusiveDates, toDate, toTime } from '../internal/time';
import type { RuleStatus } from '../domain';
import {
  type AmountRoundingRule,
  applyRoundingRule,
  assertNonNegativeInteger,
  bigintToSafeNumber,
  compareDecimal,
  decimalToBigInt,
  formatDecimal,
  formatIdr,
  formatMoney,
  mulDecimal,
  parseDecimal,
} from '../money';

// ===========================================================================
// Rule shape — mirrors DB table `customs_rules`
// ===========================================================================

export const CUSTOMS_TREATMENTS = ['PERSONAL', 'NON_PERSONAL'] as const;
export type CustomsTreatment = (typeof CUSTOMS_TREATMENTS)[number];
export type CustomsRuleTreatment = CustomsTreatment | 'ANY';
export const CUSTOMS_FORMULA_CODES = ['ID_PASSENGER_V2025', 'FLAT_RATES', 'EXEMPT'] as const;
export type CustomsFormulaCode = (typeof CUSTOMS_FORMULA_CODES)[number];
export type TaxRoundingRule = AmountRoundingRule;
/** DB `numeric` columns arrive as strings from pg; numbers are accepted for fixtures. */
export type NumericLike = string | number;

export interface CustomsRule {
  readonly id: string;
  readonly code: string;
  readonly version: number;
  readonly originCountry: string | null;
  readonly destinationCountry: string;
  readonly hsCodePrefix: string | null;
  readonly categoryCode: string | null;
  readonly treatment: CustomsRuleTreatment;
  readonly formulaCode: CustomsFormulaCode;
  readonly exemptionUsd: NumericLike | null;
  readonly dutyRate: NumericLike;
  readonly vatRate: NumericLike;
  readonly vatDppFactor: NumericLike;
  readonly luxuryTaxRate: NumericLike;
  readonly incomeTaxRate: NumericLike;
  readonly incomeTaxRateNoNpwp: NumericLike | null;
  readonly rounding: TaxRoundingRule;
  /** Higher value wins when specificity ties. */
  readonly priority: number;
  /** Inclusive first day (§16). `YYYY-MM-DD` or a timestamp (→ Asia/Jakarta calendar date). */
  readonly effectiveFrom: DateInput;
  /** Inclusive last day (§16); null = open-ended. */
  readonly effectiveUntil: DateInput | null;
  readonly sourceReference: string;
  readonly sourceUrl: string | null;
  readonly lastVerifiedAt: DateInput;
  readonly status: RuleStatus;
}

export interface CustomsSelectionContext {
  readonly originCountry: string;
  readonly destinationCountry: string;
  readonly hsCode?: string | null;
  readonly categoryCode?: string | null;
  readonly treatment: CustomsTreatment;
  readonly date: Date;
}

export function normalizeHsCode(hs: string | null | undefined): string | null {
  if (hs === null || hs === undefined) return null;
  const digits = hs.replace(/[^0-9]/g, '');
  return digits.length > 0 ? digits : null;
}

/**
 * §16: a rule applies on calendar date d when effectiveFrom ≤ d ≤ effectiveUntil (inclusive), with d
 * taken in Asia/Jakarta (fixed +07:00) — the business calendar of an Indonesian import.
 */
export function isRuleEffective(
  rule: Pick<CustomsRule, 'effectiveFrom' | 'effectiveUntil'>,
  date: Date,
): boolean {
  return isWithinInclusiveDates(date, rule.effectiveFrom, rule.effectiveUntil);
}

/** Specificity tuple: [hsPrefixLength, hasCategory, hasOrigin, exactTreatment]. */
function specificity(rule: CustomsRule): readonly [number, number, number, number] {
  return [
    normalizeHsCode(rule.hsCodePrefix)?.length ?? 0,
    rule.categoryCode ? 1 : 0,
    rule.originCountry ? 1 : 0,
    rule.treatment === 'ANY' ? 0 : 1,
  ];
}

function ruleMatches(rule: CustomsRule, ctx: CustomsSelectionContext): boolean {
  if (rule.status !== 'ACTIVE') return false;
  if (!isRuleEffective(rule, ctx.date)) return false;
  if (rule.destinationCountry !== ctx.destinationCountry) return false;
  if (rule.originCountry !== null && rule.originCountry !== ctx.originCountry) return false;
  if (rule.categoryCode !== null && rule.categoryCode !== ctx.categoryCode) return false;
  if (rule.treatment !== 'ANY' && rule.treatment !== ctx.treatment) return false;
  const prefix = normalizeHsCode(rule.hsCodePrefix);
  if (prefix !== null) {
    const hs = normalizeHsCode(ctx.hsCode);
    if (hs === null || !hs.startsWith(prefix)) return false;
  }
  return true;
}

/**
 * All matching rules, best first: most specific (HS prefix length > category > origin > exact
 * treatment), then higher `priority`, then latest `effectiveFrom`, then `id` (deterministic).
 */
export function rankCustomsRules(rules: readonly CustomsRule[], ctx: CustomsSelectionContext): CustomsRule[] {
  const matching = rules.filter((r) => ruleMatches(r, ctx));
  return sortBy(matching, (a, b) => {
    const sa = specificity(a);
    const sb = specificity(b);
    for (let i = 0; i < sa.length; i++) {
      const d = (sb[i] ?? 0) - (sa[i] ?? 0);
      if (d !== 0) return d;
    }
    if (a.priority !== b.priority) return b.priority - a.priority;
    const ea = toTime(a.effectiveFrom);
    const eb = toTime(b.effectiveFrom);
    if (ea !== eb) return eb - ea;
    return compareStrings(a.id, b.id);
  });
}

export function selectRule(rules: readonly CustomsRule[], ctx: CustomsSelectionContext): CustomsRule | null {
  return rankCustomsRules(rules, ctx)[0] ?? null;
}

// ===========================================================================
// Estimation
// ===========================================================================

export interface CustomsEstimateInput {
  readonly originCountry: string;
  readonly destinationCountry: string;
  /** Falls back to the category's default HS (with a warning) when omitted. */
  readonly hsCode?: string | null;
  readonly categoryCode: string;
  /** Unit value (FOB) in `currency` minor units. */
  readonly itemValueMinor: number;
  readonly currency: string;
  readonly quantity: number;
  /** Reserved for weight-based formulas; not used by ID_PASSENGER_V2025. */
  readonly weightKg?: number;
  /** Remaining passenger allowance in USD; caps the rule's exemption (PERSONAL only). */
  readonly travelerAllowanceUsd?: NumericLike | null;
  /** Default NON_PERSONAL — jastip goods are commercial. */
  readonly treatment?: CustomsTreatment;
  /** Default false → use `incomeTaxRateNoNpwp` when defined. */
  readonly hasNpwp?: boolean;
  readonly fx: {
    /** item currency → IDR (omit when currency is IDR) */
    readonly itemToIdr?: RateInput;
    /** USD → IDR (needed to convert the USD exemption) */
    readonly usdToIdr?: RateInput;
  };
  readonly date: Date;
  readonly rules: readonly CustomsRule[];
  /** Warn when `lastVerifiedAt` is older than this (default 180 days). */
  readonly verificationMaxAgeDays?: number;
}

export interface CustomsBreakdownStep {
  readonly label: string;
  readonly formula: string;
  readonly amount: number;
}

export interface CustomsEstimate {
  readonly ruleId: string | null;
  readonly ruleCode: string | null;
  readonly ruleVersion: number | null;
  readonly formulaCode: CustomsFormulaCode | null;
  readonly treatment: CustomsTreatment;
  readonly hsCodeUsed: string | null;
  readonly customsValueIdr: number;
  readonly exemptionAppliedIdr: number;
  readonly taxableValueIdr: number;
  readonly dutyIdr: number;
  readonly vatIdr: number;
  readonly luxuryTaxIdr: number;
  readonly incomeTaxIdr: number;
  /** vat + luxury + income */
  readonly importTaxIdr: number;
  /** duty + importTax */
  readonly totalIdr: number;
  readonly isEstimate: true;
  readonly breakdownSteps: readonly CustomsBreakdownStep[];
  readonly sourceReference: string | null;
  readonly lastVerifiedAt: Date | null;
  readonly warnings: readonly Reason[];
}

function pct(rate: NumericLike): string {
  return `${formatDecimal(mulDecimal(rate, 100), 'id-ID', 6)}%`;
}

function mulIdr(amount: number, rates: readonly NumericLike[]): number {
  let d = parseDecimal(amount);
  for (const r of rates) d = mulDecimal(d, r);
  return bigintToSafeNumber(decimalToBigInt(d, 'HALF_UP'));
}

function assertRate(value: NumericLike, label: string): void {
  const c = compareDecimal(value, 0);
  if (c < 0 || compareDecimal(value, 1) > 0) {
    throw new CoreError('INVALID_RULE_RATE', `${label} must be within [0, 1]`, { value: String(value) });
  }
}

function zeroEstimate(
  treatment: CustomsTreatment,
  customsValueIdr: number,
  hsCodeUsed: string | null,
  steps: CustomsBreakdownStep[],
  warnings: Reason[],
): CustomsEstimate {
  return {
    ruleId: null,
    ruleCode: null,
    ruleVersion: null,
    formulaCode: null,
    treatment,
    hsCodeUsed,
    customsValueIdr,
    exemptionAppliedIdr: 0,
    taxableValueIdr: 0,
    dutyIdr: 0,
    vatIdr: 0,
    luxuryTaxIdr: 0,
    incomeTaxIdr: 0,
    importTaxIdr: 0,
    totalIdr: 0,
    isEstimate: true,
    breakdownSteps: steps,
    sourceReference: null,
    lastVerifiedAt: null,
    warnings,
  };
}

/**
 * Estimates import duty & taxes. Always an estimate (`isEstimate: true`) — Bea Cukai decides.
 *
 * ID_PASSENGER_V2025:
 *   value   = FOB × qty in IDR
 *   taxable = PERSONAL ? max(0, value − exemption) : value
 *   duty    = R(taxable × dutyRate)
 *   importV = taxable + duty
 *   VAT     = R(importV × vatDppFactor × vatRate)
 *   luxury  = R(importV × luxuryTaxRate)
 *   income  = R(importV × (hasNpwp ? incomeTaxRate : incomeTaxRateNoNpwp ?? incomeTaxRate))
 *   R = half-up to rupiah, then the rule's rounding (NONE / CEIL_1000 / ROUND_1000 / CEIL_100).
 * FLAT_RATES: every rate applies directly to the full customs value (no exemption, no cascade).
 * EXEMPT: zero duty/tax.
 */
export function estimateCustoms(input: CustomsEstimateInput): CustomsEstimate {
  assertNonNegativeInteger(input.itemValueMinor, 'itemValueMinor');
  if (!Number.isSafeInteger(input.quantity) || input.quantity < 1) {
    throw new CoreError('INVALID_QUANTITY', `quantity must be a positive integer, got ${input.quantity}`);
  }
  const treatment: CustomsTreatment = input.treatment ?? 'NON_PERSONAL';
  const hasNpwp = input.hasNpwp ?? false;
  const warnings: Reason[] = [];
  const steps: CustomsBreakdownStep[] = [];

  let hsCodeUsed = normalizeHsCode(input.hsCode);
  if (hsCodeUsed === null) {
    const fallback = normalizeHsCode(findCategory(input.categoryCode)?.defaultHs ?? null);
    if (fallback !== null) {
      hsCodeUsed = fallback;
      warnings.push({
        code: 'HS_CODE_DEFAULTED',
        message: `Kode HS tidak diisi; memakai HS default kategori (${fallback}).`,
      });
    }
  }

  // 1. Customs value (FOB × qty → IDR)
  const totalForeign = bigintToSafeNumber(BigInt(input.itemValueMinor) * BigInt(input.quantity), 'itemValue×qty');
  let customsValueIdr: number;
  if (input.currency === 'IDR') {
    customsValueIdr = totalForeign;
    steps.push({ label: 'Nilai pabean (FOB)', formula: `${formatIdr(input.itemValueMinor)} × ${input.quantity}`, amount: customsValueIdr });
  } else {
    if (input.fx.itemToIdr === undefined) {
      throw new CoreError('FX_RATE_MISSING', `Missing ${input.currency}→IDR rate for customs value`);
    }
    const rate = normalizeRate(input.fx.itemToIdr, 'itemToIdr');
    customsValueIdr = convert(totalForeign, input.currency, 'IDR', rate);
    steps.push({
      label: 'Nilai pabean (FOB)',
      formula: `${formatMoney(input.itemValueMinor, input.currency)} × ${input.quantity} × kurs ${formatDecimal(rate)}`,
      amount: customsValueIdr,
    });
  }

  const rule = selectRule(input.rules, {
    originCountry: input.originCountry,
    destinationCountry: input.destinationCountry,
    hsCode: hsCodeUsed,
    categoryCode: input.categoryCode,
    treatment,
    date: input.date,
  });

  if (!rule) {
    warnings.push({
      code: 'NO_RULE',
      message: 'Tidak ada aturan bea & pajak aktif yang cocok; checkout diblokir sampai aturan tersedia.',
    });
    return zeroEstimate(treatment, customsValueIdr, hsCodeUsed, steps, warnings);
  }

  for (const [label, v] of [
    ['dutyRate', rule.dutyRate],
    ['vatRate', rule.vatRate],
    ['vatDppFactor', rule.vatDppFactor],
    ['luxuryTaxRate', rule.luxuryTaxRate],
    ['incomeTaxRate', rule.incomeTaxRate],
  ] as const) {
    assertRate(v, label);
  }
  if (rule.incomeTaxRateNoNpwp !== null) assertRate(rule.incomeTaxRateNoNpwp, 'incomeTaxRateNoNpwp');

  const maxAgeDays = input.verificationMaxAgeDays ?? 180;
  const verifiedAt = toDate(rule.lastVerifiedAt, 'lastVerifiedAt');
  if (input.date.getTime() - verifiedAt.getTime() > maxAgeDays * DAY_MS) {
    warnings.push({
      code: 'RULE_VERIFICATION_STALE',
      message: `Aturan terakhir diverifikasi ${verifiedAt.toISOString().slice(0, 10)} (> ${maxAgeDays} hari).`,
    });
  }

  const round = (amount: number): number => applyRoundingRule(amount, rule.rounding);
  const roundingNote = rule.rounding === 'NONE' ? '' : ` → ${rule.rounding}`;

  let exemptionAppliedIdr = 0;
  let taxable = customsValueIdr;
  let duty = 0;
  let vat = 0;
  let luxury = 0;
  let income = 0;
  const incomeRate: NumericLike = hasNpwp ? rule.incomeTaxRate : (rule.incomeTaxRateNoNpwp ?? rule.incomeTaxRate);

  if (rule.formulaCode === 'EXEMPT') {
    exemptionAppliedIdr = customsValueIdr;
    taxable = 0;
    steps.push({ label: 'Dibebaskan', formula: `Aturan ${rule.code} membebaskan bea & pajak`, amount: 0 });
  } else if (rule.formulaCode === 'ID_PASSENGER_V2025') {
    if (treatment === 'PERSONAL' && rule.exemptionUsd !== null) {
      if (input.fx.usdToIdr === undefined) {
        throw new CoreError('FX_RATE_MISSING', 'Missing USD→IDR rate for the passenger exemption');
      }
      let exemptUsd = parseDecimal(rule.exemptionUsd);
      if (input.travelerAllowanceUsd !== undefined && input.travelerAllowanceUsd !== null) {
        const allowance = compareDecimal(input.travelerAllowanceUsd, 0) < 0 ? parseDecimal(0) : parseDecimal(input.travelerAllowanceUsd);
        if (compareDecimal(allowance, exemptUsd) < 0) {
          exemptUsd = allowance;
          warnings.push({
            code: 'ALLOWANCE_CAPPED',
            message: `Sisa pembebasan traveler USD ${formatDecimal(allowance)} lebih kecil dari batas aturan.`,
          });
        }
      }
      const usdRate = normalizeRate(input.fx.usdToIdr, 'usdToIdr');
      const exemptionIdr = bigintToSafeNumber(decimalToBigInt(mulDecimal(exemptUsd, usdRate), 'HALF_UP'));
      exemptionAppliedIdr = Math.min(customsValueIdr, exemptionIdr);
      taxable = customsValueIdr - exemptionAppliedIdr;
      steps.push({
        label: 'Pembebasan barang pribadi',
        formula: `min(nilai, USD ${formatDecimal(exemptUsd)} × kurs ${formatDecimal(usdRate)} = ${formatIdr(exemptionIdr)})`,
        amount: -exemptionAppliedIdr,
      });
    } else if (rule.exemptionUsd !== null) {
      warnings.push({
        code: 'EXEMPTION_NOT_APPLIED',
        message: 'Barang titipan (non-pribadi) tidak mendapat pembebasan USD; bea & pajak dihitung dari nilai penuh.',
      });
    }
    steps.push({ label: 'Nilai dasar pengenaan', formula: 'nilai pabean − pembebasan', amount: taxable });
    if (taxable > 0) {
      duty = round(mulIdr(taxable, [rule.dutyRate]));
      const importValue = taxable + duty;
      vat = round(mulIdr(importValue, [rule.vatDppFactor, rule.vatRate]));
      luxury = round(mulIdr(importValue, [rule.luxuryTaxRate]));
      income = round(mulIdr(importValue, [incomeRate]));
      steps.push({ label: 'Bea masuk', formula: `${formatIdr(taxable)} × ${pct(rule.dutyRate)}${roundingNote}`, amount: duty });
      steps.push({ label: 'Nilai impor', formula: `${formatIdr(taxable)} + ${formatIdr(duty)}`, amount: importValue });
      steps.push({
        label: 'PPN impor',
        formula: `${formatIdr(importValue)} × ${formatDecimal(rule.vatDppFactor)} × ${pct(rule.vatRate)}${roundingNote}`,
        amount: vat,
      });
      steps.push({ label: 'PPnBM', formula: `${formatIdr(importValue)} × ${pct(rule.luxuryTaxRate)}${roundingNote}`, amount: luxury });
      steps.push({
        label: hasNpwp ? 'PPh 22 impor (NPWP)' : 'PPh 22 impor (tanpa NPWP)',
        formula: `${formatIdr(importValue)} × ${pct(incomeRate)}${roundingNote}`,
        amount: income,
      });
    }
  } else {
    // FLAT_RATES
    if (taxable > 0) {
      duty = round(mulIdr(taxable, [rule.dutyRate]));
      vat = round(mulIdr(taxable, [rule.vatDppFactor, rule.vatRate]));
      luxury = round(mulIdr(taxable, [rule.luxuryTaxRate]));
      income = round(mulIdr(taxable, [incomeRate]));
      steps.push({ label: 'Bea masuk (tarif flat)', formula: `${formatIdr(taxable)} × ${pct(rule.dutyRate)}${roundingNote}`, amount: duty });
      steps.push({
        label: 'PPN (tarif flat)',
        formula: `${formatIdr(taxable)} × ${formatDecimal(rule.vatDppFactor)} × ${pct(rule.vatRate)}${roundingNote}`,
        amount: vat,
      });
      steps.push({ label: 'PPnBM (tarif flat)', formula: `${formatIdr(taxable)} × ${pct(rule.luxuryTaxRate)}${roundingNote}`, amount: luxury });
      steps.push({ label: 'PPh (tarif flat)', formula: `${formatIdr(taxable)} × ${pct(incomeRate)}${roundingNote}`, amount: income });
    }
  }

  const importTaxIdr = vat + luxury + income;
  const totalIdr = duty + importTaxIdr;
  steps.push({ label: 'Total bea & pajak impor (estimasi)', formula: 'bea masuk + PPN + PPnBM + PPh', amount: totalIdr });

  return {
    ruleId: rule.id,
    ruleCode: rule.code,
    ruleVersion: rule.version,
    formulaCode: rule.formulaCode,
    treatment,
    hsCodeUsed,
    customsValueIdr,
    exemptionAppliedIdr,
    taxableValueIdr: taxable,
    dutyIdr: duty,
    vatIdr: vat,
    luxuryTaxIdr: luxury,
    incomeTaxIdr: income,
    importTaxIdr,
    totalIdr,
    isEstimate: true,
    breakdownSteps: steps,
    sourceReference: rule.sourceReference,
    lastVerifiedAt: verifiedAt,
    warnings,
  };
}

/** `customs_rules:<id>@v<version>` — used as `ruleRef` on price lines. */
export function customsRuleRef(estimate: Pick<CustomsEstimate, 'ruleId' | 'ruleVersion'>): string | undefined {
  return estimate.ruleId === null ? undefined : `customs_rules:${estimate.ruleId}@v${estimate.ruleVersion ?? 0}`;
}
