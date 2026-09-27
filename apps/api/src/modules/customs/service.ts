/**
 * Customs & import-tax estimates (docs/research/01-customs-tax-indonesia.md) using ACTIVE rules in
 * force (customs_rules_in_force, §16) and @jastipkita/core `estimateCustoms`.
 *
 * Exported for the money group:
 *   estimateCustomsForItem(db, deps, input) → core CustomsEstimate (isEstimate: true)
 */
import { type CustomsEstimate, type CustomsTreatment, customsRuleRef, estimateCustoms } from '@jastipkita/core';
import type { Db } from '../../db/sql';
import { assertCategory, assertCurrency, assertDestinationCountry, assertOriginCountry } from '../catalog/service';
import { core, wibDate } from '../catalog/shared';
import { type FxDeps, getSpotRate } from '../fx/service';
import * as repo from './repository';

export interface EstimateCustomsInput {
  originCountry: string;
  destinationCountry?: string;
  categoryCode: string;
  hsCode?: string | null;
  /** Unit FOB price in `currency` minor units. */
  unitPriceMinor: number;
  currency: string;
  quantity: number;
  /** Default NON_PERSONAL — jastip goods are not the traveler's personal goods (PMK 34/2025 Pasal 24(3)). */
  treatment?: CustomsTreatment;
  /** NPWP of the importer (the traveler on the customs declaration). Default false. */
  hasNpwp?: boolean;
  travelerAllowanceUsd?: string | number | null;
  /** Rule date (default: now). */
  date?: Date;
  /** Reuse known rates (e.g. the transaction's FX context); omitted legs are loaded at spot. */
  fx?: { itemToIdr?: string; usdToIdr?: string };
}

export interface CustomsFxContext {
  itemToIdr: string | null;
  usdToIdr: string | null;
  asOf: string | null;
  source: string | null;
}

async function resolveFx(db: Db, deps: FxDeps, input: EstimateCustomsInput): Promise<CustomsFxContext> {
  let itemToIdr = input.fx?.itemToIdr ?? null;
  let usdToIdr = input.fx?.usdToIdr ?? null;
  let asOf: Date | null = null;
  let source: string | null = input.fx ? 'caller' : null;
  if (itemToIdr === null && input.currency !== 'IDR') {
    const s = await getSpotRate(db, deps, input.currency, 'IDR');
    itemToIdr = s.spotRate;
    asOf = s.asOf;
    source = s.source;
  }
  if (usdToIdr === null) {
    const s = await getSpotRate(db, deps, 'USD', 'IDR');
    usdToIdr = s.spotRate;
    asOf = asOf === null || s.asOf.getTime() < asOf.getTime() ? s.asOf : asOf;
    source = source ?? s.source;
  }
  return { itemToIdr, usdToIdr, asOf: asOf ? asOf.toISOString() : null, source };
}

async function runEstimate(db: Db, deps: FxDeps, input: EstimateCustomsInput, fx: CustomsFxContext): Promise<CustomsEstimate> {
  const date = input.date ?? deps.clock.now();
  const destination = input.destinationCountry ?? 'ID';
  const rules = await repo.rulesInForce(db, wibDate(date), destination);
  return core(() =>
    estimateCustoms({
      originCountry: input.originCountry,
      destinationCountry: destination,
      hsCode: input.hsCode ?? null,
      categoryCode: input.categoryCode,
      itemValueMinor: input.unitPriceMinor,
      currency: input.currency,
      quantity: input.quantity,
      treatment: input.treatment ?? 'NON_PERSONAL',
      hasNpwp: input.hasNpwp ?? false,
      travelerAllowanceUsd: input.travelerAllowanceUsd ?? null,
      fx: {
        ...(fx.itemToIdr !== null ? { itemToIdr: fx.itemToIdr } : {}),
        ...(fx.usdToIdr !== null ? { usdToIdr: fx.usdToIdr } : {}),
      },
      date,
      rules,
    }),
  );
}

/** Internal service for the money group (quote/checkout). Treatment defaults to NON_PERSONAL. */
export async function estimateCustomsForItem(db: Db, deps: FxDeps, input: EstimateCustomsInput): Promise<CustomsEstimate> {
  const fx = await resolveFx(db, deps, input);
  return runEstimate(db, deps, input, fx);
}

export const NON_PERSONAL_EXPLANATION =
  'Barang titipan (jastip) diperlakukan Bea Cukai sebagai barang BUKAN pribadi penumpang (PMK 34/2025 Pasal 24 ayat (3)): ' +
  'tidak ada pembebasan USD 500, bea masuk 10% dari seluruh nilai pabean, PPN 12% × DPP 11/12, dan PPh 22 impor 5%.';

export const PERSONAL_NOTE =
  'Hanya untuk edukasi: perlakuan barang PRIBADI (pembebasan FOB USD 500 per orang per kedatangan) berlaku untuk barang milik traveler sendiri, BUKAN untuk barang titipan.';

export const CUSTOMS_DISCLAIMER =
  'Estimasi — keputusan akhir ada di tangan Bea Cukai. Bea Cukai memakai kurs KMK mingguan pada tanggal kedatangan; estimasi ini memakai kurs referensi pasar (ECB) sehingga dapat berbeda.';

export interface CustomsEstimateDto {
  ruleId: string | null;
  ruleCode: string | null;
  ruleVersion: number | null;
  ruleRef: string | null;
  formulaCode: string | null;
  treatment: CustomsTreatment;
  hsCodeUsed: string | null;
  customsValueIdr: number;
  exemptionAppliedIdr: number;
  taxableValueIdr: number;
  dutyIdr: number;
  vatIdr: number;
  luxuryTaxIdr: number;
  incomeTaxIdr: number;
  importTaxIdr: number;
  totalIdr: number;
  isEstimate: true;
  breakdownSteps: { label: string; formula: string; amount: number }[];
  sourceReference: string | null;
  sourceUrl: string | null;
  lastVerifiedAt: string | null;
  warnings: { code: string; message: string }[];
}

export function customsEstimateDto(e: CustomsEstimate, sourceUrl: string | null): CustomsEstimateDto {
  return {
    ruleId: e.ruleId,
    ruleCode: e.ruleCode,
    ruleVersion: e.ruleVersion,
    ruleRef: customsRuleRef(e) ?? null,
    formulaCode: e.formulaCode,
    treatment: e.treatment,
    hsCodeUsed: e.hsCodeUsed,
    customsValueIdr: e.customsValueIdr,
    exemptionAppliedIdr: e.exemptionAppliedIdr,
    taxableValueIdr: e.taxableValueIdr,
    dutyIdr: e.dutyIdr,
    vatIdr: e.vatIdr,
    luxuryTaxIdr: e.luxuryTaxIdr,
    incomeTaxIdr: e.incomeTaxIdr,
    importTaxIdr: e.importTaxIdr,
    totalIdr: e.totalIdr,
    isEstimate: true,
    breakdownSteps: e.breakdownSteps.map((s) => ({ label: s.label, formula: s.formula, amount: s.amount })),
    sourceReference: e.sourceReference,
    sourceUrl,
    lastVerifiedAt: e.lastVerifiedAt ? e.lastVerifiedAt.toISOString().slice(0, 10) : null,
    warnings: e.warnings.map((w) => ({ code: w.code, message: w.message })),
  };
}

export interface PublicEstimateResult {
  isEstimate: true;
  treatment: CustomsTreatment;
  treatmentExplanation: string;
  estimate: CustomsEstimateDto;
  personalComparison: (CustomsEstimateDto & { note: string }) | null;
  fx: CustomsFxContext & { note: string };
  disclaimer: string;
}

/** Public calculator: NON_PERSONAL by default + PERSONAL comparison for education. */
export async function publicEstimate(db: Db, deps: FxDeps, input: EstimateCustomsInput): Promise<PublicEstimateResult> {
  await assertOriginCountry(db, input.originCountry);
  await assertDestinationCountry(db, input.destinationCountry ?? 'ID');
  await assertCategory(db, input.categoryCode);
  await assertCurrency(db, input.currency);
  const treatment = input.treatment ?? 'NON_PERSONAL';
  const fx = await resolveFx(db, deps, input);
  const main = await runEstimate(db, deps, { ...input, treatment }, fx);
  const comparison = treatment === 'NON_PERSONAL' ? await runEstimate(db, deps, { ...input, treatment: 'PERSONAL' }, fx) : null;
  const urls = await repo.ruleSourceUrls(db, [main.ruleId, comparison?.ruleId].filter((x): x is string => !!x));
  return {
    isEstimate: true,
    treatment,
    treatmentExplanation:
      treatment === 'NON_PERSONAL'
        ? NON_PERSONAL_EXPLANATION
        : 'Perlakuan barang PRIBADI dipilih: hanya berlaku untuk barang milik traveler sendiri, bukan barang titipan.',
    estimate: customsEstimateDto(main, main.ruleId ? (urls.get(main.ruleId) ?? null) : null),
    personalComparison: comparison
      ? { ...customsEstimateDto(comparison, comparison.ruleId ? (urls.get(comparison.ruleId) ?? null) : null), note: PERSONAL_NOTE }
      : null,
    fx: { ...fx, note: 'Kurs spot referensi (tanpa markup) untuk nilai pabean.' },
    disclaimer: CUSTOMS_DISCLAIMER,
  };
}
