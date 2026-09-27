/**
 * Restricted / prohibited item classification (§7, §16) with ACTIVE rules in force and
 * @jastipkita/core `classifyItem`.
 *
 * Exported for the money group:
 *   classifyRequestItem(db, deps, input) → ItemClassification (core ClassificationResult + ruleRef)
 */
import { type ClassificationResult, CoreError, classifyItem, convert, fromMinor, getCurrency } from '@jastipkita/core';
import type { Db } from '../../db/sql';
import { AppError } from '../../lib/errors';
import { assertCategory, assertDestinationCountry, assertOriginCountry } from '../catalog/service';
import { core, wibDate } from '../catalog/shared';
import { type FxDeps, getSpotRate } from '../fx/service';
import * as repo from './repository';

export interface ClassifyRequestItemInput {
  originCountry: string;
  destinationCountry?: string;
  categoryCode: string;
  hsCode?: string | null;
  productName: string;
  quantity: number;
  /** Total value in USD (decimal string); derived from unitPriceMinor × quantity when omitted. */
  valueUsd?: string | number | null;
  unitPriceMinor?: number | null;
  currency?: string | null;
  date?: Date;
}

export interface ItemClassification extends ClassificationResult {
  /** `restricted_items:<CODE>@v<version>` of every matching rule (most severe first), comma-joined; null = no match. */
  ruleRef: string | null;
  valueUsd: string | null;
  checkedAt: string;
}

async function totalValueUsd(db: Db, deps: FxDeps, input: ClassifyRequestItemInput): Promise<string | null> {
  if (input.valueUsd !== undefined && input.valueUsd !== null) return String(input.valueUsd);
  if (input.unitPriceMinor === undefined || input.unitPriceMinor === null || !input.currency) return null;
  try {
    getCurrency(input.currency);
    const total = input.unitPriceMinor * input.quantity;
    if (!Number.isSafeInteger(total)) return null;
    if (input.currency === 'USD') return fromMinor(total, 'USD');
    const rate = await getSpotRate(db, deps, input.currency, 'USD');
    return fromMinor(convert(total, input.currency, 'USD', rate.spotRate), 'USD');
  } catch (err) {
    // No FX → value-based limits are reported as skipped (valueCheckSkipped) instead of failing.
    if (err instanceof AppError || err instanceof CoreError) return null;
    throw err;
  }
}

export async function classifyRequestItem(db: Db, deps: FxDeps, input: ClassifyRequestItemInput): Promise<ItemClassification> {
  const date = input.date ?? deps.clock.now();
  const destination = input.destinationCountry ?? 'ID';
  const rules = await repo.rulesInForce(db, wibDate(date), destination);
  const valueUsd = await totalValueUsd(db, deps, input);
  const result = await core(() =>
    classifyItem(
      {
        origin: input.originCountry,
        destination,
        categoryCode: input.categoryCode,
        hsCode: input.hsCode ?? null,
        productName: input.productName,
        quantity: input.quantity,
        valueUsd,
      },
      rules,
      date,
    ),
  );
  const refs = result.matches.slice(0, 5).map((m) => `restricted_items:${m.code}@v${m.version}`);
  return { ...result, ruleRef: refs.length ? refs.join(',') : null, valueUsd, checkedAt: date.toISOString() };
}

export type Locale = 'id' | 'en';

export interface RestrictedCheckDto {
  classification: ClassificationResult['classification'];
  blocksCheckout: boolean;
  requiresAcknowledgement: boolean;
  locale: Locale;
  messages: string[];
  permitAuthorities: string[];
  airlineDg: boolean;
  matches: {
    code: string;
    version: number;
    classification: ClassificationResult['classification'];
    ruleClassification: ClassificationResult['classification'];
    matchedOn: string[];
    matchedKeyword: string | null;
    limitExceeded: { kind: 'QUANTITY' | 'VALUE_USD'; limit: string; actual: string } | null;
    valueCheckSkipped: boolean;
    message: string;
    permitAuthority: string | null;
    airlineDg: boolean;
    sourceReference: string;
  }[];
  ruleRef: string | null;
  valueUsd: string | null;
  disclaimer: string;
}

export function restrictedDto(r: ItemClassification, locale: Locale): RestrictedCheckDto {
  return {
    classification: r.classification,
    blocksCheckout: r.blocksCheckout,
    requiresAcknowledgement: r.requiresAcknowledgement,
    locale,
    messages: [...(locale === 'en' ? r.messagesEn : r.messagesId)],
    permitAuthorities: [...r.permitAuthorities],
    airlineDg: r.airlineDg,
    matches: r.matches.map((m) => ({
      code: m.code,
      version: m.version,
      classification: m.classification,
      ruleClassification: m.ruleClassification,
      matchedOn: [...m.matchedOn],
      matchedKeyword: m.matchedKeyword,
      limitExceeded: m.limitExceeded ? { ...m.limitExceeded } : null,
      valueCheckSkipped: m.valueCheckSkipped,
      message: locale === 'en' ? m.messageEn : m.messageId,
      permitAuthority: m.permitAuthority,
      airlineDg: m.airlineDg,
      sourceReference: m.sourceReference,
    })),
    ruleRef: r.ruleRef,
    valueUsd: r.valueUsd,
    disclaimer:
      locale === 'en'
        ? 'Guidance only — Indonesian Customs (Bea Cukai) and the relevant agencies make the final decision.'
        : 'Panduan saja — keputusan akhir ada di Bea Cukai dan instansi terkait.',
  };
}

export async function publicCheck(db: Db, deps: FxDeps, input: ClassifyRequestItemInput, locale: Locale): Promise<RestrictedCheckDto> {
  await assertOriginCountry(db, input.originCountry);
  await assertDestinationCountry(db, input.destinationCountry ?? 'ID');
  await assertCategory(db, input.categoryCode);
  return restrictedDto(await classifyRequestItem(db, deps, input), locale);
}
