import type { Db } from '../../db/sql';

export interface CountryRow {
  code: string;
  name_id: string;
  name_en: string;
  currency_code: string;
  is_origin: boolean;
  is_destination: boolean;
  risk_level: 'LOW' | 'MEDIUM' | 'HIGH';
  activation: 'ACTIVE' | 'SOFT_LAUNCH' | 'INACTIVE';
  slug: string;
  sort_order: number;
}

/** Origins need SOFT_LAUNCH/ACTIVE; destinations need ACTIVE (INACTIVE rows are never shown). */
export async function listVisibleCountries(db: Db): Promise<CountryRow[]> {
  return db<CountryRow[]>`
    SELECT code, name_id, name_en, currency_code, is_origin, is_destination, risk_level, activation, slug, sort_order
      FROM countries
     WHERE (is_origin AND activation IN ('SOFT_LAUNCH','ACTIVE'))
        OR (is_destination AND activation = 'ACTIVE')
     ORDER BY sort_order, code`;
}

export async function getCountry(db: Db, code: string): Promise<CountryRow | null> {
  const [row] = await db<CountryRow[]>`
    SELECT code, name_id, name_en, currency_code, is_origin, is_destination, risk_level, activation, slug, sort_order
      FROM countries WHERE code = ${code}`;
  return row ?? null;
}

export interface CategoryRow {
  code: string;
  parent_code: string | null;
  name_id: string;
  name_en: string;
  risk_level: 'LOW' | 'MEDIUM' | 'HIGH';
  requires_serial: boolean;
  requires_video: boolean;
  default_weight_kg: string | null;
  default_hs_code: string | null;
  sort_order: number;
}

export async function listActiveCategories(db: Db): Promise<CategoryRow[]> {
  return db<CategoryRow[]>`
    SELECT code, parent_code, name_id, name_en, risk_level, requires_serial, requires_video,
           default_weight_kg::text AS default_weight_kg, default_hs_code, sort_order
      FROM product_categories WHERE is_active ORDER BY sort_order, code`;
}

export async function getCategory(db: Db, code: string): Promise<(CategoryRow & { is_active: boolean }) | null> {
  const [row] = await db<(CategoryRow & { is_active: boolean })[]>`
    SELECT code, parent_code, name_id, name_en, risk_level, requires_serial, requires_video,
           default_weight_kg::text AS default_weight_kg, default_hs_code, sort_order, is_active
      FROM product_categories WHERE code = ${code}`;
  return row ?? null;
}

export async function existingCategoryCodes(db: Db, codes: string[]): Promise<Set<string>> {
  if (codes.length === 0) return new Set();
  const rows = await db<{ code: string }[]>`SELECT code FROM product_categories WHERE is_active AND code IN ${db(codes)}`;
  return new Set(rows.map((r) => r.code));
}

export interface CurrencyRow {
  code: string;
  minor_units: number;
  name: string;
  symbol: string;
  ecb_reference: boolean;
}

export async function listActiveCurrencies(db: Db): Promise<CurrencyRow[]> {
  return db<CurrencyRow[]>`SELECT code, minor_units, name, symbol, ecb_reference FROM currencies WHERE is_active ORDER BY code`;
}

export async function getCurrencyRow(db: Db, code: string): Promise<(CurrencyRow & { is_active: boolean }) | null> {
  const [row] = await db<(CurrencyRow & { is_active: boolean })[]>`
    SELECT code, minor_units, name, symbol, ecb_reference, is_active FROM currencies WHERE code = ${code}`;
  return row ?? null;
}
