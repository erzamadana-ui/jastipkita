import type { PriceLineType } from '@jastipkita/core';
import { camel, type Db } from '../../db/sql';
import type { QuoteAmounts } from '../ledger/service';

export interface QuoteLineRow {
  id: string;
  lineType: PriceLineType;
  labelId: string;
  labelEn: string;
  amountIdr: number;
  bucket: string | null;
  isEstimate: boolean;
  ruleRef: string | null;
  meta: Record<string, unknown>;
  sort: number;
}

export interface FxLockRow {
  id: string;
  base: string;
  quote: string;
  spotRate: string;
  markupBps: number;
  lockedRate: string;
  lockedAt: Date;
  expiresAt: Date;
  status: 'ACTIVE' | 'CONSUMED' | 'EXPIRED';
  consumedAt: Date | null;
}

export interface QuoteMeta {
  paymentChannel: string;
  platformBornePaymentFeeIdr: number;
  itemCurrency: string;
  itemTotalMinor: number;
  quantity: number;
  unitPriceMinor: number;
  restricted: {
    classification: string;
    requiresAcknowledgement: boolean;
    blocksCheckout: boolean;
    messagesId: string[];
    messagesEn: string[];
    ruleCodes: string[];
    airlineDg: boolean;
  };
  promotion: { promoIds: string[]; discountIdr: number; cashbackIdr: number; freePlatformFee: boolean; applied: unknown[]; rejected: unknown[] };
  credit: { requested: boolean; availableIdr: number; appliedIdr: number };
  limits: { buyer: { effectiveMaxIdr: number; perTransactionMaxIdr: number }; traveler: { effectiveMaxIdr: number; perTransactionMaxIdr: number } };
  fx: { spotRate: string; lockedRate: string; markupBps: number; source: string | null; rateAsOf: string | null } | null;
  adjustments: unknown[];
  customsWarnings: unknown[];
  /** Fee & total per configured channel (absent on quotes created before paymentOptions existed). */
  paymentOptions?: PaymentOptionView[];
}

export interface PaymentOptionView {
  channel: string;
  label: string;
  feeIdr: number;
  totalIdr: number;
  bearer: 'BUYER' | 'PLATFORM';
  refundable: boolean;
  minAmountIdr: number | null;
  maxAmountIdr: number | null;
  available: boolean;
  unavailableReason: 'ABOVE_CHANNEL_MAX' | 'BELOW_CHANNEL_MIN' | null;
  selected: boolean;
}

export interface QuoteRow {
  id: string;
  transactionId: string;
  fxLockId: string | null;
  totalIdr: number;
  customs: Record<string, unknown>;
  configVersions: Record<string, number>;
  ruleRefs: string[];
  status: 'ACTIVE' | 'ACCEPTED' | 'EXPIRED' | 'SUPERSEDED';
  expiresAt: Date;
  acceptedAt: Date | null;
  supersededBy: string | null;
  meta: QuoteMeta;
  createdAt: Date;
}

export interface LoadedQuote {
  quote: QuoteRow;
  lines: QuoteLineRow[];
  fxLock: FxLockRow | null;
  amounts: QuoteAmounts;
}

export function amountsFromLines(lines: readonly { lineType: string; amountIdr: number }[]): QuoteAmounts {
  const a: QuoteAmounts = {
    ITEM_PRICE: 0,
    TRAVELER_FEE: 0,
    CUSTOMS_DUTY: 0,
    IMPORT_TAX: 0,
    PROTECTION_FEE: 0,
    PLATFORM_FEE: 0,
    SERVICE_TAX: 0,
    PAYMENT_FEE: 0,
    DISCOUNT: 0,
    REFERRAL_CREDIT: 0,
    TOTAL: 0,
  };
  for (const l of lines) a[l.lineType as keyof QuoteAmounts] += Number(l.amountIdr);
  return a;
}

export async function loadQuote(db: Db, quoteId: string, opts: { forUpdate?: boolean } = {}): Promise<LoadedQuote | null> {
  const qs = opts.forUpdate
    ? await db<Record<string, unknown>[]>`SELECT * FROM quotes WHERE id = ${quoteId} FOR UPDATE`
    : await db<Record<string, unknown>[]>`SELECT * FROM quotes WHERE id = ${quoteId}`;
  if (!qs[0]) return null;
  const quote = camel<QuoteRow>(qs[0]);
  const lineRows = await db<Record<string, unknown>[]>`SELECT * FROM quote_lines WHERE quote_id = ${quoteId} ORDER BY sort`;
  const lines = lineRows.map((r) => camel<QuoteLineRow>(r));
  let fxLock: FxLockRow | null = null;
  if (quote.fxLockId) {
    const fx = await db<Record<string, unknown>[]>`
      SELECT id, base, quote, spot_rate::text AS spot_rate, markup_bps, locked_rate::text AS locked_rate, locked_at, expires_at, status, consumed_at
        FROM fx_locks WHERE id = ${quote.fxLockId}`;
    fxLock = fx[0] ? camel<FxLockRow>(fx[0]) : null;
  }
  return { quote, lines, fxLock, amounts: amountsFromLines(lines) };
}

export async function loadActiveOrAcceptedQuote(db: Db, transactionId: string, activeQuoteId: string | null): Promise<LoadedQuote | null> {
  if (!activeQuoteId) return null;
  return loadQuote(db, activeQuoteId);
}

export interface RequestRow {
  id: string;
  buyerId: string;
  productName: string;
  productUrl: string | null;
  merchantName: string | null;
  merchantCountry: string | null;
  categoryCode: string | null;
  hsCode: string | null;
  quantity: number;
  variant: string | null;
  unitPriceMinor: number | null;
  priceCurrency: string | null;
  estWeightKg: string | null;
  maxBudgetIdr: number | null;
  destinationCountry: string;
  destinationCity: string | null;
  deliveryPreference: string | null;
}

export async function loadRequest(db: Db, requestId: string): Promise<RequestRow | null> {
  const rows = await db<Record<string, unknown>[]>`
    SELECT id, buyer_id, product_name, product_url, merchant_name, merchant_country, category_code, hs_code, quantity, variant,
           unit_price_minor, price_currency, est_weight_kg::text AS est_weight_kg, max_budget_idr, destination_country,
           destination_city, delivery_preference
      FROM requests WHERE id = ${requestId}`;
  if (!rows[0]) return null;
  const r = camel<RequestRow>(rows[0]);
  return { ...r, merchantCountry: r.merchantCountry?.trim() ?? null, priceCurrency: r.priceCurrency?.trim() ?? null, destinationCountry: r.destinationCountry.trim() };
}

export interface TripRow {
  id: string;
  travelerId: string;
  originCountry: string;
  originCity: string;
  destinationCountry: string;
  destinationCity: string;
  departureDate: string;
  arrivalDate: string;
  status: string;
}

export async function loadTrip(db: Db, tripId: string): Promise<TripRow | null> {
  const rows = await db<Record<string, unknown>[]>`
    SELECT id, traveler_id, origin_country, origin_city, destination_country, destination_city,
           departure_date::text AS departure_date, arrival_date::text AS arrival_date, status
      FROM trips WHERE id = ${tripId}`;
  if (!rows[0]) return null;
  const t = camel<TripRow>(rows[0]);
  return { ...t, originCountry: t.originCountry.trim(), destinationCountry: t.destinationCountry.trim() };
}
