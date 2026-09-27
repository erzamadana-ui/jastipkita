import type { CustomsRule } from '@jastipkita/core';
import type { Db } from '../../db/sql';

interface CustomsRuleRow {
  id: string;
  code: string;
  version: number;
  origin_country: string | null;
  destination_country: string;
  hs_code_prefix: string | null;
  category_code: string | null;
  treatment: CustomsRule['treatment'];
  formula_code: CustomsRule['formulaCode'];
  exemption_usd: string | null;
  duty_rate: string;
  vat_rate: string;
  vat_dpp_factor: string;
  luxury_tax_rate: string;
  income_tax_rate: string;
  income_tax_rate_no_npwp: string | null;
  rounding: CustomsRule['rounding'];
  priority: number;
  effective_from: string;
  effective_until: string | null;
  source_reference: string;
  source_url: string | null;
  last_verified_at: string;
  status: CustomsRule['status'];
}

export function mapCustomsRule(r: CustomsRuleRow): CustomsRule {
  return {
    id: r.id,
    code: r.code,
    version: r.version,
    originCountry: r.origin_country,
    destinationCountry: r.destination_country,
    hsCodePrefix: r.hs_code_prefix,
    categoryCode: r.category_code,
    treatment: r.treatment,
    formulaCode: r.formula_code,
    exemptionUsd: r.exemption_usd,
    dutyRate: r.duty_rate,
    vatRate: r.vat_rate,
    vatDppFactor: r.vat_dpp_factor,
    luxuryTaxRate: r.luxury_tax_rate,
    incomeTaxRate: r.income_tax_rate,
    incomeTaxRateNoNpwp: r.income_tax_rate_no_npwp,
    rounding: r.rounding,
    priority: r.priority,
    effectiveFrom: r.effective_from,
    effectiveUntil: r.effective_until,
    sourceReference: r.source_reference,
    sourceUrl: r.source_url,
    lastVerifiedAt: r.last_verified_at,
    status: r.status,
  };
}

/**
 * ACTIVE rules in force on `date` (WIB calendar date, §16 inclusive) for a destination —
 * via customs_rules_in_force() from migration 0017. Dates are selected as text so the engine sees
 * exact calendar dates (no timezone shifts).
 */
export async function rulesInForce(db: Db, date: string, destinationCountry: string): Promise<CustomsRule[]> {
  const rows = await db<CustomsRuleRow[]>`
    SELECT id, code, version, origin_country, destination_country, hs_code_prefix, category_code, treatment, formula_code,
           exemption_usd::text AS exemption_usd, duty_rate::text AS duty_rate, vat_rate::text AS vat_rate,
           vat_dpp_factor::text AS vat_dpp_factor, luxury_tax_rate::text AS luxury_tax_rate,
           income_tax_rate::text AS income_tax_rate, income_tax_rate_no_npwp::text AS income_tax_rate_no_npwp,
           rounding, priority, effective_from::text AS effective_from, effective_until::text AS effective_until,
           source_reference, source_url, last_verified_at::text AS last_verified_at, status
      FROM customs_rules_in_force(${date}::date)
     WHERE destination_country = ${destinationCountry}`;
  return rows.map(mapCustomsRule);
}

export async function ruleSourceUrls(db: Db, ids: string[]): Promise<Map<string, string | null>> {
  if (ids.length === 0) return new Map();
  const rows = await db<{ id: string; source_url: string | null }[]>`SELECT id, source_url FROM customs_rules WHERE id IN ${db(ids)}`;
  return new Map(rows.map((r) => [r.id, r.source_url]));
}
