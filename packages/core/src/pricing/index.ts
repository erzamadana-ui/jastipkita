import type { BusinessConfig, FeeRateConfig, PaymentChannelConfig, TravelerFeeBoundsConfig } from '../config';
import type { CustomsEstimate } from '../customs';
import { customsRuleRef } from '../customs';
import {
  FUND_BUCKETS,
  type FundBucket,
  PRICE_LINE_BUCKET,
  PRICE_LINE_TYPES,
  type PriceLineType,
} from '../domain';
import { CoreError } from '../errors';
import { type FxLock, convert, isLockValid } from '../fx';
import {
  applyBps,
  assertBps,
  assertNonNegativeInteger,
  bigintToSafeNumber,
  clampAmount,
  divRound,
  formatIdr,
  mulByRate,
  mulByRates,
  sumMinor,
} from '../money';

export type PricingConfig = Pick<
  BusinessConfig,
  | 'pricing.platform_fee'
  | 'pricing.protection_fee'
  | 'pricing.service_tax'
  | 'pricing.payment_fees'
  | 'pricing.traveler_fee_bounds'
  | 'pricing.minimum_transaction'
>;

export type TravelerFeeSpec =
  | { readonly type: 'FIXED'; readonly amountIdr: number }
  | { readonly type: 'PERCENT'; readonly rateBps: number }
  | { readonly type: 'PER_KG'; readonly perKgIdr: number };

export interface QuoteItem {
  /** Unit price in `currency` minor units. */
  readonly unitPriceMinor: number;
  readonly currency: string;
  readonly quantity: number;
  /** Per-unit weight (kg) — required for PER_KG traveler fees. */
  readonly unitWeightKg?: number;
}

/** Structural subset of the promotions engine output. */
export interface QuotePromotionInput {
  readonly discountIdr: number;
  readonly freePlatformFee?: boolean;
  readonly promoIds?: readonly string[];
}

export interface QuoteInput {
  readonly item: QuoteItem;
  /** Required unless the item currency is IDR. */
  readonly fxLock?: FxLock | null;
  readonly fxLockRef?: string;
  readonly travelerFee: TravelerFeeSpec;
  /** Output of `estimateCustoms` (same FX). Missing → blocking issue. */
  readonly customs?: CustomsEstimate | null;
  /** Defaults to `pricing.payment_fees.defaultChannel`. */
  readonly paymentChannel?: string;
  readonly promotion?: QuotePromotionInput | null;
  /** Buyer's available JastipKita Credit. */
  readonly referralCreditAvailableIdr?: number;
  readonly now: Date;
  /** Business config version for `ruleRef` (e.g. 1). */
  readonly configVersion?: string | number;
}

export interface PriceLine {
  readonly type: PriceLineType;
  readonly labelId: string;
  readonly labelEn: string;
  /** DISCOUNT and REFERRAL_CREDIT are negative. */
  readonly amountIdr: number;
  readonly bucket: FundBucket;
  readonly isEstimate: boolean;
  readonly ruleRef?: string;
  /** Pre-waiver amount when a promotion waived the line (e.g. FREE_PLATFORM_FEE). */
  readonly originalAmountIdr?: number;
}

export interface QuoteIssue {
  readonly code: string;
  readonly message: string;
  readonly blocking: boolean;
}

export interface QuoteAdjustment {
  readonly line: PriceLineType;
  readonly code: string;
  readonly fromIdr: number;
  readonly toIdr: number;
}

export interface Quote {
  readonly currency: 'IDR';
  readonly lines: readonly PriceLine[];
  readonly totalIdr: number;
  readonly amounts: Readonly<Record<PriceLineType, number>>;
  readonly item: QuoteItem & { readonly totalForeignMinor: number };
  readonly fxRate: string | null;
  readonly expiresAt: Date | null;
  readonly paymentChannel: string;
  readonly paymentFeeBearer: PaymentChannelConfig['bearer'];
  /** Gateway fee absorbed by the platform (bearer PLATFORM, or no gross-up shortfall). */
  readonly platformBornePaymentFeeIdr: number;
  readonly adjustments: readonly QuoteAdjustment[];
  readonly issues: readonly QuoteIssue[];
  readonly blocksCheckout: boolean;
  readonly computedAt: Date;
}

const LABELS: Readonly<Record<PriceLineType, readonly [string, string]>> = {
  ITEM_PRICE: ['Harga Barang', 'Item Price'],
  TRAVELER_FEE: ['Traveler Fee', 'Traveler Fee'],
  CUSTOMS_DUTY: ['Bea Masuk (estimasi)', 'Import Duty (estimate)'],
  IMPORT_TAX: ['Pajak Impor (estimasi)', 'Import Tax (estimate)'],
  PROTECTION_FEE: ['JastipKita Protection', 'JastipKita Protection'],
  PLATFORM_FEE: ['Platform Fee', 'Platform Fee'],
  SERVICE_TAX: ['PPN atas layanan', 'VAT on services'],
  PAYMENT_FEE: ['Biaya Pembayaran', 'Payment Fee'],
  DISCOUNT: ['Diskon Promo', 'Promo Discount'],
  REFERRAL_CREDIT: ['JastipKita Credit', 'JastipKita Credit'],
  TOTAL: ['Total Landed Cost', 'Total Landed Cost'],
};

// ===========================================================================
// Fee building blocks (exported for offer validation & promotions)
// ===========================================================================

/** clamp(base × rateBps, min, max) — used for platform & protection fees. */
export function computeRateFee(baseIdr: number, cfg: FeeRateConfig): number {
  assertNonNegativeInteger(baseIdr, 'baseIdr');
  return clampAmount(applyBps(baseIdr, cfg.rateBps, 'HALF_UP'), cfg.minIdr, cfg.maxIdr);
}

export interface TravelerFeeResult {
  readonly amountIdr: number;
  readonly rawAmountIdr: number;
  readonly minIdr: number;
  readonly maxIdr: number;
  readonly adjustment: 'RAISED_TO_MIN' | 'CAPPED_AT_MAX_RATE' | null;
}

/**
 * Traveler fee with bounds: at least `minIdr`, at most `maxRateBps` of the item value.
 * If the bounds conflict (tiny items), the minimum wins.
 */
export function computeTravelerFee(
  spec: TravelerFeeSpec,
  itemIdr: number,
  totalWeightKg: number | null,
  bounds: TravelerFeeBoundsConfig,
): TravelerFeeResult {
  assertNonNegativeInteger(itemIdr, 'itemIdr');
  let raw: number;
  switch (spec.type) {
    case 'FIXED':
      assertNonNegativeInteger(spec.amountIdr, 'travelerFee.amountIdr');
      raw = spec.amountIdr;
      break;
    case 'PERCENT':
      assertBps(spec.rateBps, 'travelerFee.rateBps');
      raw = applyBps(itemIdr, spec.rateBps, 'HALF_UP');
      break;
    case 'PER_KG':
      assertNonNegativeInteger(spec.perKgIdr, 'travelerFee.perKgIdr');
      if (totalWeightKg === null || !(totalWeightKg >= 0)) {
        throw new CoreError('WEIGHT_REQUIRED', 'PER_KG traveler fee needs item.unitWeightKg');
      }
      raw = mulByRate(spec.perKgIdr, totalWeightKg, 'HALF_UP');
      break;
  }
  const maxIdr = applyBps(itemIdr, bounds.maxRateBps, 'FLOOR');
  const minIdr = bounds.minIdr;
  let amount = raw;
  let adjustment: TravelerFeeResult['adjustment'] = null;
  if (amount > maxIdr) {
    amount = maxIdr;
    adjustment = 'CAPPED_AT_MAX_RATE';
  }
  if (amount < minIdr) {
    amount = minIdr;
    adjustment = 'RAISED_TO_MIN';
  }
  return { amountIdr: amount, rawAmountIdr: raw, minIdr, maxIdr, adjustment };
}

/** What the gateway charges on a captured amount: fixed + ceil(amount × rate). */
export function gatewayFee(amountIdr: number, channel: Pick<PaymentChannelConfig, 'fixedIdr' | 'rateBps'>): number {
  assertNonNegativeInteger(amountIdr, 'amountIdr');
  if (amountIdr === 0) return 0;
  return channel.fixedIdr + applyBps(amountIdr, channel.rateBps, 'CEIL');
}

export interface PaymentFeeResult {
  /** Amount shown on the PAYMENT_FEE line (charged to the buyer). */
  readonly chargedIdr: number;
  /** Gateway fee on the final captured amount. */
  readonly gatewayFeeIdr: number;
  /** Portion of the gateway fee the platform absorbs. */
  readonly platformBorneIdr: number;
}

/**
 * Payment fee on a pre-fee `payableIdr`.
 * bearer BUYER + grossUp (default): smallest total T with T − payable ≥ fixed + ceil(T × r), i.e.
 *   T = ceil((payable + fixed) × 10 000 / (10 000 − rBps)) — the fee covers the gateway fee on itself.
 * bearer BUYER without grossUp: fee = gatewayFee(payable); any shortfall is platform-borne.
 * bearer PLATFORM: no buyer line; the platform absorbs gatewayFee(payable).
 */
export function computePaymentFee(payableIdr: number, channel: PaymentChannelConfig): PaymentFeeResult {
  assertNonNegativeInteger(payableIdr, 'payableIdr');
  if (payableIdr === 0) return { chargedIdr: 0, gatewayFeeIdr: 0, platformBorneIdr: 0 };
  if (channel.rateBps >= 10_000) throw new CoreError('INVALID_PAYMENT_RATE', 'Payment fee rate must be < 100%');
  if (channel.bearer === 'PLATFORM') {
    const g = gatewayFee(payableIdr, channel);
    return { chargedIdr: 0, gatewayFeeIdr: g, platformBorneIdr: g };
  }
  if (channel.grossUp === false) {
    const fee = gatewayFee(payableIdr, channel);
    const g = gatewayFee(payableIdr + fee, channel);
    return { chargedIdr: fee, gatewayFeeIdr: g, platformBorneIdr: Math.max(0, g - fee) };
  }
  const total = bigintToSafeNumber(
    divRound(BigInt(payableIdr + channel.fixedIdr) * 10_000n, BigInt(10_000 - channel.rateBps), 'CEIL'),
  );
  const fee = total - payableIdr;
  const g = gatewayFee(total, channel);
  return { chargedIdr: fee, gatewayFeeIdr: g, platformBorneIdr: Math.max(0, g - fee) };
}

// ===========================================================================
// Quote
// ===========================================================================

/** Negates without producing -0 (keeps JSON/equality clean). */
function negate(amount: number): number {
  return amount === 0 ? 0 : -amount;
}

function line(type: PriceLineType, amountIdr: number, extra: Partial<PriceLine> = {}): PriceLine {
  const [labelId, labelEn] = LABELS[type];
  return {
    type,
    labelId,
    labelEn,
    amountIdr,
    bucket: PRICE_LINE_BUCKET[type],
    isEstimate: false,
    ...extra,
  };
}

/**
 * Builds the ordered price breakdown (docs/00-domain-model.md §10). Every fee that the buyer pays
 * appears as a line; sum(lines except TOTAL) === TOTAL, and TOTAL >= 0.
 *
 * Computation order (differs from display order because the payment fee depends on the amount
 * actually charged): item → traveler fee → customs → protection → platform → service tax →
 * discount → referral credit → payment fee → total.
 */
export function buildQuote(input: QuoteInput, config: PricingConfig): Quote {
  const { item } = input;
  assertNonNegativeInteger(item.unitPriceMinor, 'item.unitPriceMinor');
  if (!Number.isSafeInteger(item.quantity) || item.quantity < 1) {
    throw new CoreError('INVALID_QUANTITY', `quantity must be a positive integer, got ${item.quantity}`);
  }
  const issues: QuoteIssue[] = [];
  const adjustments: QuoteAdjustment[] = [];
  const v = input.configVersion ?? 'default';
  const cfgRef = (key: string): string => `business_configs:${key}@v${v}`;

  // 1. ITEM_PRICE
  const totalForeignMinor = bigintToSafeNumber(BigInt(item.unitPriceMinor) * BigInt(item.quantity), 'item total');
  let itemIdr: number;
  let fxRate: string | null = null;
  let itemRef: string | undefined;
  if (item.currency === 'IDR') {
    itemIdr = totalForeignMinor;
  } else {
    const lock = input.fxLock;
    if (!lock) throw new CoreError('FX_LOCK_REQUIRED', `An FX lock is required for ${item.currency} items`);
    if (lock.base !== item.currency || lock.quote !== 'IDR') {
      throw new CoreError('FX_LOCK_MISMATCH', `FX lock ${lock.base}→${lock.quote} does not match ${item.currency}→IDR`);
    }
    if (!isLockValid(lock, input.now)) {
      issues.push({ code: 'FX_LOCK_EXPIRED', message: 'Kurs terkunci sudah kedaluwarsa; perlu re-quote.', blocking: true });
    }
    itemIdr = convert(totalForeignMinor, lock.base, 'IDR', lock.lockedRate);
    fxRate = lock.lockedRate;
    itemRef = input.fxLockRef ?? `fx_lock:${lock.base}${lock.quote}@${lock.lockedRate}`;
  }
  const minItem = config['pricing.minimum_transaction'].minItemValueIdr;
  if (itemIdr < minItem) {
    issues.push({
      code: 'BELOW_MINIMUM_TRANSACTION',
      message: `Nilai barang minimal ${formatIdr(minItem)}.`,
      blocking: true,
    });
  }

  // 2. TRAVELER_FEE
  const totalWeightKg = item.unitWeightKg === undefined ? null : item.unitWeightKg * item.quantity;
  const tf = computeTravelerFee(input.travelerFee, itemIdr, totalWeightKg, config['pricing.traveler_fee_bounds']);
  if (tf.adjustment) {
    adjustments.push({ line: 'TRAVELER_FEE', code: tf.adjustment, fromIdr: tf.rawAmountIdr, toIdr: tf.amountIdr });
  }

  // 3–4. CUSTOMS_DUTY & IMPORT_TAX
  const customs = input.customs ?? null;
  let dutyIdr = 0;
  let importTaxIdr = 0;
  let customsRef: string | undefined;
  if (!customs) {
    issues.push({ code: 'CUSTOMS_ESTIMATE_MISSING', message: 'Estimasi bea & pajak belum dihitung.', blocking: true });
  } else if (customs.ruleId === null) {
    issues.push({ code: 'CUSTOMS_NO_RULE', message: 'Aturan bea & pajak untuk barang ini belum tersedia.', blocking: true });
  } else {
    dutyIdr = customs.dutyIdr;
    importTaxIdr = customs.importTaxIdr;
    customsRef = customsRuleRef(customs);
  }

  // 5–6. PROTECTION_FEE & PLATFORM_FEE
  const protectionIdr = computeRateFee(itemIdr, config['pricing.protection_fee']);
  const platformGrossIdr = computeRateFee(itemIdr, config['pricing.platform_fee']);
  const freePlatformFee = input.promotion?.freePlatformFee === true;
  const platformIdr = freePlatformFee ? 0 : platformGrossIdr;

  // 7. SERVICE_TAX = Σ(appliesTo lines) × dppFactor × rate
  const st = config['pricing.service_tax'];
  const lineAmountsSoFar: Partial<Record<PriceLineType, number>> = {
    TRAVELER_FEE: tf.amountIdr,
    PROTECTION_FEE: protectionIdr,
    PLATFORM_FEE: platformIdr,
  };
  const serviceTaxBase = sumMinor(st.appliesTo.map((t) => lineAmountsSoFar[t] ?? 0));
  const serviceTaxIdr = st.enabled ? mulByRates(serviceTaxBase, [st.dppFactor, st.rate], 'HALF_UP') : 0;

  const grossIdr = sumMinor([itemIdr, tf.amountIdr, dutyIdr, importTaxIdr, protectionIdr, platformIdr, serviceTaxIdr]);

  // 9. DISCOUNT — capped at the eligible base (item + traveler + protection + platform; never taxes)
  const requestedDiscount = input.promotion?.discountIdr ?? 0;
  assertNonNegativeInteger(requestedDiscount, 'promotion.discountIdr');
  const eligibleBase = sumMinor([itemIdr, tf.amountIdr, protectionIdr, platformIdr]);
  const discountIdr = Math.min(requestedDiscount, eligibleBase);
  if (discountIdr < requestedDiscount) {
    adjustments.push({ line: 'DISCOUNT', code: 'CAPPED_AT_ELIGIBLE_BASE', fromIdr: requestedDiscount, toIdr: discountIdr });
  }
  const afterDiscount = grossIdr - discountIdr;

  // 10. REFERRAL_CREDIT — cannot exceed the remaining payable
  const creditAvailable = input.referralCreditAvailableIdr ?? 0;
  assertNonNegativeInteger(creditAvailable, 'referralCreditAvailableIdr');
  const referralCreditIdr = Math.min(creditAvailable, afterDiscount);
  if (referralCreditIdr < creditAvailable && creditAvailable > 0) {
    adjustments.push({ line: 'REFERRAL_CREDIT', code: 'CAPPED_AT_PAYABLE', fromIdr: creditAvailable, toIdr: referralCreditIdr });
  }
  const payableBeforeFee = afterDiscount - referralCreditIdr;

  // 8. PAYMENT_FEE — zero when nothing is left to pay
  const fees = config['pricing.payment_fees'];
  const channelName = input.paymentChannel ?? fees.defaultChannel;
  const channel = fees.channels[channelName];
  if (!channel) throw new CoreError('UNKNOWN_PAYMENT_CHANNEL', `Unknown payment channel ${channelName}`);
  const pf = computePaymentFee(payableBeforeFee, channel);

  const totalIdr = payableBeforeFee + pf.chargedIdr;
  const hasEstimate = dutyIdr > 0 || importTaxIdr > 0;

  const lines: PriceLine[] = [
    line('ITEM_PRICE', itemIdr, itemRef ? { ruleRef: itemRef } : {}),
    line('TRAVELER_FEE', tf.amountIdr, { ruleRef: cfgRef('pricing.traveler_fee_bounds') }),
    line('CUSTOMS_DUTY', dutyIdr, { isEstimate: true, ...(customsRef ? { ruleRef: customsRef } : {}) }),
    line('IMPORT_TAX', importTaxIdr, { isEstimate: true, ...(customsRef ? { ruleRef: customsRef } : {}) }),
    line('PROTECTION_FEE', protectionIdr, { ruleRef: cfgRef('pricing.protection_fee') }),
    line('PLATFORM_FEE', platformIdr, {
      ruleRef: cfgRef('pricing.platform_fee'),
      ...(freePlatformFee ? { originalAmountIdr: platformGrossIdr } : {}),
    }),
    line('SERVICE_TAX', serviceTaxIdr, { labelId: st.label, ruleRef: cfgRef('pricing.service_tax') }),
    line('PAYMENT_FEE', pf.chargedIdr, { ruleRef: cfgRef(`pricing.payment_fees.${channelName}`) }),
    line('DISCOUNT', negate(discountIdr), input.promotion?.promoIds?.length ? { ruleRef: `promotions:${input.promotion.promoIds.join(',')}` } : {}),
    line('REFERRAL_CREDIT', negate(referralCreditIdr)),
    line('TOTAL', totalIdr, { isEstimate: hasEstimate }),
  ];

  const amounts = Object.fromEntries(PRICE_LINE_TYPES.map((t) => [t, 0])) as Record<PriceLineType, number>;
  for (const l of lines) amounts[l.type] = l.amountIdr;

  return {
    currency: 'IDR',
    lines,
    totalIdr,
    amounts,
    item: { ...item, totalForeignMinor },
    fxRate,
    expiresAt: input.fxLock && item.currency !== 'IDR' ? new Date(input.fxLock.expiresAt.getTime()) : null,
    paymentChannel: channelName,
    paymentFeeBearer: channel.bearer,
    platformBornePaymentFeeIdr: pf.platformBorneIdr,
    adjustments,
    issues,
    blocksCheckout: issues.some((i) => i.blocking),
    computedAt: new Date(input.now.getTime()),
  };
}

export function quoteLineAmount(quote: Pick<Quote, 'lines'>, type: PriceLineType): number {
  return quote.lines.find((l) => l.type === type)?.amountIdr ?? 0;
}

// ===========================================================================
// Fund allocation
// ===========================================================================

export interface FundAllocation {
  /** Net amount per bucket; PROMOTION_CREDIT is negative (platform-funded promos). */
  readonly byBucket: Readonly<Record<FundBucket, number>>;
  /** Cash the buyer pays (= TOTAL). */
  readonly cashInIdr: number;
  /** Discount + referral credit funded from the promotion budget. */
  readonly promotionFundingIdr: number;
  /** Sum of obligation buckets (everything except PROMOTION_CREDIT/CLEARING/REFUND). */
  readonly obligationsIdr: number;
  /** obligations === cashIn + promotionFunding and Σ byBucket === TOTAL */
  readonly balanced: boolean;
}

/**
 * Maps quote lines to ledger buckets. Platform-borne gateway fees move from PLATFORM_REVENUE to
 * PAYMENT_FEE (net view), so the per-bucket totals always sum to TOTAL.
 */
export function allocateFunds(
  quote: Pick<Quote, 'lines' | 'totalIdr' | 'platformBornePaymentFeeIdr'>,
): FundAllocation {
  const byBucket = Object.fromEntries(FUND_BUCKETS.map((b) => [b, 0])) as Record<FundBucket, number>;
  for (const l of quote.lines) {
    if (l.type === 'TOTAL') continue;
    byBucket[l.bucket] += l.amountIdr;
  }
  if (quote.platformBornePaymentFeeIdr > 0) {
    byBucket.PAYMENT_FEE += quote.platformBornePaymentFeeIdr;
    byBucket.PLATFORM_REVENUE -= quote.platformBornePaymentFeeIdr;
  }
  const promotionFundingIdr = -byBucket.PROMOTION_CREDIT;
  const obligationsIdr = sumMinor(
    FUND_BUCKETS.filter((b) => b !== 'PROMOTION_CREDIT' && b !== 'CLEARING' && b !== 'REFUND').map((b) => byBucket[b]),
  );
  const net = sumMinor(FUND_BUCKETS.map((b) => byBucket[b]));
  return {
    byBucket,
    cashInIdr: quote.totalIdr,
    promotionFundingIdr,
    obligationsIdr,
    balanced: net === quote.totalIdr && obligationsIdr === quote.totalIdr + promotionFundingIdr,
  };
}
