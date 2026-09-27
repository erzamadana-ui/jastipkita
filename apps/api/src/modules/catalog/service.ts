import type { Db } from '../../db/sql';
import { Errors } from '../../lib/errors';
import { numOrNull } from './shared';
import * as repo from './repository';

export interface CountryDto {
  code: string;
  nameId: string;
  nameEn: string;
  currencyCode: string;
  isOrigin: boolean;
  isDestination: boolean;
  activation: 'ACTIVE' | 'SOFT_LAUNCH' | 'INACTIVE';
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  slug: string;
  sortOrder: number;
}

export interface CategoryDto {
  code: string;
  parentCode: string | null;
  nameId: string;
  nameEn: string;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  requiresSerial: boolean;
  requiresVideo: boolean;
  defaultWeightKg: number | null;
  defaultHsCode: string | null;
  sortOrder: number;
}

export interface CurrencyDto {
  code: string;
  minorUnits: number;
  name: string;
  symbol: string;
  ecbReference: boolean;
}

function countryDto(r: repo.CountryRow): CountryDto {
  return {
    code: r.code,
    nameId: r.name_id,
    nameEn: r.name_en,
    currencyCode: r.currency_code,
    isOrigin: r.is_origin && (r.activation === 'ACTIVE' || r.activation === 'SOFT_LAUNCH'),
    isDestination: r.is_destination && r.activation === 'ACTIVE',
    activation: r.activation,
    riskLevel: r.risk_level,
    slug: r.slug,
    sortOrder: r.sort_order,
  };
}

export async function listCountries(db: Db, role?: 'origin' | 'destination'): Promise<CountryDto[]> {
  const rows = (await repo.listVisibleCountries(db)).map(countryDto);
  if (role === 'origin') return rows.filter((c) => c.isOrigin);
  if (role === 'destination') return rows.filter((c) => c.isDestination);
  return rows;
}

export async function listCategories(db: Db): Promise<CategoryDto[]> {
  return (await repo.listActiveCategories(db)).map((r) => ({
    code: r.code,
    parentCode: r.parent_code,
    nameId: r.name_id,
    nameEn: r.name_en,
    riskLevel: r.risk_level,
    requiresSerial: r.requires_serial,
    requiresVideo: r.requires_video,
    defaultWeightKg: numOrNull(r.default_weight_kg),
    defaultHsCode: r.default_hs_code,
    sortOrder: r.sort_order,
  }));
}

export async function listCurrencies(db: Db): Promise<CurrencyDto[]> {
  return (await repo.listActiveCurrencies(db)).map((r) => ({
    code: r.code,
    minorUnits: r.minor_units,
    name: r.name,
    symbol: r.symbol,
    ecbReference: r.ecb_reference,
  }));
}

// ---------------------------------------------------------------------------- validation helpers

/** Origin (merchant/trip departure) country must be SOFT_LAUNCH or ACTIVE. */
export async function assertOriginCountry(db: Db, code: string, field = 'originCountry'): Promise<repo.CountryRow> {
  const c = await repo.getCountry(db, code);
  if (!c || !c.is_origin || (c.activation !== 'ACTIVE' && c.activation !== 'SOFT_LAUNCH')) {
    throw Errors.unprocessable('COUNTRY_NOT_SUPPORTED', 'Negara asal belum didukung JastipKita', { field, code });
  }
  return c;
}

/** Destination country must be ACTIVE (Indonesia at launch). */
export async function assertDestinationCountry(db: Db, code: string, field = 'destinationCountry'): Promise<repo.CountryRow> {
  const c = await repo.getCountry(db, code);
  if (!c || !c.is_destination || c.activation !== 'ACTIVE') {
    throw Errors.unprocessable('COUNTRY_NOT_SUPPORTED', 'Negara tujuan belum didukung JastipKita', { field, code });
  }
  return c;
}

export async function assertCategory(db: Db, code: string, field = 'categoryCode') {
  const c = await repo.getCategory(db, code);
  if (!c || !c.is_active) throw Errors.unprocessable('CATEGORY_UNKNOWN', 'Kategori tidak dikenal', { field, code });
  return c;
}

export async function assertCategories(db: Db, codes: string[], field = 'excludedCategories'): Promise<void> {
  const uniq = [...new Set(codes)];
  const found = await repo.existingCategoryCodes(db, uniq);
  const missing = uniq.filter((c) => !found.has(c));
  if (missing.length) throw Errors.unprocessable('CATEGORY_UNKNOWN', 'Kategori tidak dikenal', { field, codes: missing });
}

export async function assertCurrency(db: Db, code: string, field = 'currency') {
  const c = await repo.getCurrencyRow(db, code);
  if (!c || !c.is_active) throw Errors.unprocessable('UNKNOWN_CURRENCY', 'Mata uang tidak didukung', { field, code });
  return c;
}
