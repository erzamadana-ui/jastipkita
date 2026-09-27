/**
 * OFFLINE FALLBACK of the customs & import-tax estimate (used only when POST /v1/customs/estimate is unreachable).
 *
 * Mirrors packages/core `estimateCustoms` with formula ID_PASSENGER_V2025 and the seed rules in
 * db/seeds/0100_customs_rules.sql (ID_PAX_NON_PERSONAL v1 ACTIVE, ID_PAX_PERSONAL v1 ACTIVE):
 *   value   = FOB × qty × kurs                          (half-up to rupiah)
 *   taxable = NON_PERSONAL ? value : max(0, value − USD 500 × kurs USD)
 *   duty    = CEIL_1000(half_up(taxable × 10%))
 *   importV = taxable + duty
 *   PPN     = CEIL_1000(half_up(importV × 0.916667 × 12%))      (PMK 131/2024: 12% × DPP 11/12)
 *   PPh 22  = CEIL_1000(half_up(importV × 5%))  — NON_PERSONAL only; PERSONAL: excluded (0)
 * Legal basis: PMK 34 Tahun 2025 Pasal 24 ayat (3) (jastip = barang bukan barang pribadi) & ayat (1) (pribadi).
 * The build (src/pages/kalkulator-bea-cukai) cross-checks these numbers against @jastipkita/core.
 *
 * Pure module: no DOM, no Intl — runs in the browser, at build time and under `node --test`.
 */
import { ceilTo, mulHalfUp } from './money.ts';

export interface CustomsRuleParams {
  readonly code: string;
  readonly version: number;
  readonly treatment: 'NON_PERSONAL' | 'PERSONAL';
  readonly dutyRate: string;
  readonly vatRate: string;
  readonly vatDppFactor: string;
  readonly incomeTaxRate: string;
  /** DRAFT scenario only (v2): PPh 22 without NPWP — NEEDS_VERIFICATION. */
  readonly incomeTaxRateNoNpwp: string | null;
  readonly exemptionUsd: string | null;
  readonly rounding: 'CEIL_1000';
  readonly effectiveFrom: string;
  readonly lastVerifiedAt: string;
  readonly sourceReference: string;
  readonly sourceUrl: string;
}

export const RULE_NON_PERSONAL: CustomsRuleParams = {
  code: 'ID_PAX_NON_PERSONAL',
  version: 1,
  treatment: 'NON_PERSONAL',
  dutyRate: '0.10',
  vatRate: '0.12',
  vatDppFactor: '0.916667',
  incomeTaxRate: '0.05',
  incomeTaxRateNoNpwp: '0.10',
  exemptionUsd: null,
  rounding: 'CEIL_1000',
  effectiveFrom: '2025-06-06',
  lastVerifiedAt: '2026-09-27',
  sourceReference:
    'PMK 34 Tahun 2025 Pasal 24 ayat (3) jo Pasal 7 ayat (1) huruf b; PPN: PMK 131/2024 Pasal 3 (12% × DPP 11/12); pembulatan BM: PMK 190/2022 Pasal 22 ayat (4)',
  sourceUrl: 'https://jdih.kemenkeu.go.id/dok/pmk-34-tahun-2025',
};

export const RULE_PERSONAL: CustomsRuleParams = {
  code: 'ID_PAX_PERSONAL',
  version: 1,
  treatment: 'PERSONAL',
  dutyRate: '0.10',
  vatRate: '0.12',
  vatDppFactor: '0.916667',
  incomeTaxRate: '0',
  incomeTaxRateNoNpwp: null,
  exemptionUsd: '500',
  rounding: 'CEIL_1000',
  effectiveFrom: '2025-06-06',
  lastVerifiedAt: '2026-09-27',
  sourceReference: 'PMK 34 Tahun 2025 Pasal 12 ayat (1) & (5), Pasal 24 ayat (1); PPN: PMK 131/2024 Pasal 3',
  sourceUrl: 'https://jdih.kemenkeu.go.id/dok/pmk-34-tahun-2025',
};

export interface FallbackInput {
  /** Unit price in MAJOR units of the item currency as a decimal string, e.g. "129.90" or "60000". */
  readonly unitPrice: string;
  readonly quantity: number;
  /** Rupiah per 1 unit of the item currency (decimal string). Use "1" for IDR. */
  readonly itemToIdr: string;
  /** Rupiah per 1 USD — needed for the PERSONAL comparison only. */
  readonly usdToIdr: string;
  /** Scenario: apply the DRAFT PPh 22 rate for travelers without NPWP (10%, NEEDS_VERIFICATION). */
  readonly noNpwpScenario?: boolean;
}

export interface FallbackEstimate {
  readonly treatment: 'NON_PERSONAL' | 'PERSONAL';
  readonly ruleCode: string;
  readonly ruleVersion: number;
  readonly customsValueIdr: number;
  readonly exemptionAppliedIdr: number;
  readonly taxableValueIdr: number;
  readonly dutyIdr: number;
  readonly importValueIdr: number;
  readonly vatIdr: number;
  readonly luxuryTaxIdr: number;
  readonly incomeTaxIdr: number;
  readonly importTaxIdr: number;
  readonly totalIdr: number;
  readonly incomeTaxRate: string;
  readonly isEstimate: true;
}

function assertInput(input: FallbackInput): void {
  if (!Number.isSafeInteger(input.quantity) || input.quantity < 1 || input.quantity > 999) {
    throw new Error('quantity must be an integer between 1 and 999');
  }
}

function round(rule: CustomsRuleParams, amount: number): number {
  return rule.rounding === 'CEIL_1000' ? ceilTo(amount, 1000) : amount;
}

export function customsValueIdr(input: FallbackInput): number {
  assertInput(input);
  return mulHalfUp(input.unitPrice, input.quantity, input.itemToIdr);
}

/** Jastip (titipan) goods: NOT personal goods of the traveler — no USD 500 exemption. */
export function estimateNonPersonal(input: FallbackInput, rule: CustomsRuleParams = RULE_NON_PERSONAL): FallbackEstimate {
  const value = customsValueIdr(input);
  const incomeRate = input.noNpwpScenario && rule.incomeTaxRateNoNpwp ? rule.incomeTaxRateNoNpwp : rule.incomeTaxRate;
  const duty = round(rule, mulHalfUp(value, rule.dutyRate));
  const importValue = value + duty;
  const vat = round(rule, mulHalfUp(importValue, rule.vatDppFactor, rule.vatRate));
  const income = round(rule, mulHalfUp(importValue, incomeRate));
  return {
    treatment: 'NON_PERSONAL',
    ruleCode: rule.code,
    ruleVersion: input.noNpwpScenario ? 2 : rule.version,
    customsValueIdr: value,
    exemptionAppliedIdr: 0,
    taxableValueIdr: value,
    dutyIdr: duty,
    importValueIdr: importValue,
    vatIdr: vat,
    luxuryTaxIdr: 0,
    incomeTaxIdr: income,
    importTaxIdr: vat + income,
    totalIdr: duty + vat + income,
    incomeTaxRate: incomeRate,
    isEstimate: true,
  };
}

/** Comparison only: the SAME goods if they were the traveler's own personal goods (FOB USD 500 exemption). */
export function estimatePersonal(input: FallbackInput, rule: CustomsRuleParams = RULE_PERSONAL): FallbackEstimate {
  const value = customsValueIdr(input);
  const exemptionIdr = mulHalfUp(rule.exemptionUsd ?? '0', input.usdToIdr);
  const exemption = Math.min(value, exemptionIdr);
  const taxable = value - exemption;
  let duty = 0;
  let vat = 0;
  if (taxable > 0) {
    duty = round(rule, mulHalfUp(taxable, rule.dutyRate));
    vat = round(rule, mulHalfUp(taxable + duty, rule.vatDppFactor, rule.vatRate));
  }
  return {
    treatment: 'PERSONAL',
    ruleCode: rule.code,
    ruleVersion: rule.version,
    customsValueIdr: value,
    exemptionAppliedIdr: exemption,
    taxableValueIdr: taxable,
    dutyIdr: duty,
    importValueIdr: taxable + duty,
    vatIdr: vat,
    luxuryTaxIdr: 0,
    incomeTaxIdr: 0,
    importTaxIdr: vat,
    totalIdr: duty + vat,
    incomeTaxRate: '0',
    isEstimate: true,
  };
}

/** Effective burden as a percentage string with 1 decimal, e.g. "27,6". */
export function effectiveRatePct(total: number, value: number, locale: 'id' | 'en' = 'id'): string {
  if (value <= 0) return '0';
  const pct = Math.round((total / value) * 1000) / 10;
  const s = pct.toFixed(1);
  return locale === 'id' ? s.replace('.', ',') : s;
}
