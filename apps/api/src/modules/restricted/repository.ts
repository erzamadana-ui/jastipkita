import type { RestrictedItemRule } from '@jastipkita/core';
import type { Db } from '../../db/sql';

interface RestrictedRow {
  id: string;
  code: string;
  version: number;
  origin_country: string | null;
  destination_country: string;
  category_code: string | null;
  hs_code_prefix: string | null;
  keywords: string[];
  classification: RestrictedItemRule['classification'];
  max_quantity: number | null;
  max_value_usd: string | null;
  permit_authority: string | null;
  airline_dg: boolean;
  message_id: string;
  message_en: string;
  source_reference: string;
  effective_from: string;
  effective_until: string | null;
  status: RestrictedItemRule['status'];
}

export function mapRestrictedRule(r: RestrictedRow): RestrictedItemRule {
  return {
    id: r.id,
    code: r.code,
    version: r.version,
    originCountry: r.origin_country,
    destinationCountry: r.destination_country,
    categoryCode: r.category_code,
    hsCodePrefix: r.hs_code_prefix,
    keywords: r.keywords ?? [],
    classification: r.classification,
    maxQuantity: r.max_quantity,
    maxValueUsd: r.max_value_usd,
    permitAuthority: r.permit_authority,
    airlineDg: r.airline_dg,
    dgNote: null,
    messageId: r.message_id,
    messageEn: r.message_en,
    sourceReference: r.source_reference,
    effectiveFrom: r.effective_from,
    effectiveUntil: r.effective_until,
    status: r.status,
  };
}

/** ACTIVE restricted-item rules in force on `date` (WIB, §16 inclusive) via restricted_items_in_force(). */
export async function rulesInForce(db: Db, date: string, destinationCountry: string): Promise<RestrictedItemRule[]> {
  const rows = await db<RestrictedRow[]>`
    SELECT id, code, version, origin_country, destination_country, category_code, hs_code_prefix, keywords,
           classification, max_quantity, max_value_usd::text AS max_value_usd, permit_authority, airline_dg,
           message_id, message_en, source_reference, effective_from::text AS effective_from,
           effective_until::text AS effective_until, status
      FROM restricted_items_in_force(${date}::date)
     WHERE destination_country = ${destinationCountry}`;
  return rows.map(mapRestrictedRule);
}
