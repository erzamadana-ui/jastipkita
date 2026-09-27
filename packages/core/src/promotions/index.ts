import { CoreError } from '../errors';
import { compareStrings, sortBy } from '../internal/math';
import { applyBps, assertBps, assertNonNegativeInteger } from '../money';

export const PROMO_TYPES = [
  'PROMO_CODE',
  'FIRST_TRANSACTION',
  'COUNTRY',
  'TRAVELER',
  'CAMPAIGN',
  'CASHBACK',
  'FREE_PLATFORM_FEE',
] as const;
export type PromoType = (typeof PROMO_TYPES)[number];

export type PromoBase = 'ITEM_PRICE' | 'TRAVELER_FEE' | 'PLATFORM_FEE' | 'SUBTOTAL';

export type PromoBenefit =
  | { readonly kind: 'PERCENT'; readonly rateBps: number; readonly capIdr?: number | null; readonly base?: PromoBase }
  | { readonly kind: 'FIXED'; readonly amountIdr: number }
  | { readonly kind: 'FREE_PLATFORM_FEE' }
  | {
      readonly kind: 'CASHBACK_CREDIT';
      readonly rateBps?: number;
      readonly amountIdr?: number;
      readonly capIdr?: number | null;
      readonly base?: PromoBase;
    };

export interface Promotion {
  readonly id: string;
  readonly code?: string | null;
  readonly type: PromoType;
  readonly name: string;
  readonly status: 'ACTIVE' | 'PAUSED' | 'ENDED' | 'DRAFT';
  readonly startsAt: Date;
  /** Exclusive; null = open-ended. */
  readonly endsAt: Date | null;
  readonly conditions?: {
    readonly minItemValueIdr?: number;
    readonly originCountries?: readonly string[];
    readonly categories?: readonly string[];
    readonly firstTransactionOnly?: boolean;
    readonly travelerIds?: readonly string[];
    readonly userSegments?: readonly string[];
  };
  readonly limits?: {
    readonly perUser?: number | null;
    readonly global?: number | null;
    readonly budgetIdr?: number | null;
  };
  readonly usage?: { readonly globalCount: number; readonly budgetUsedIdr: number };
  readonly benefit: PromoBenefit;
  /** Higher wins ties on value. */
  readonly priority?: number;
}

export interface PromoCart {
  readonly itemValueIdr: number;
  readonly travelerFeeIdr: number;
  /** Estimated platform fee (pricing.computeRateFee) — values FREE_PLATFORM_FEE promos. */
  readonly platformFeeIdr: number;
  readonly originCountry: string;
  readonly categoryCode: string;
  readonly travelerId?: string | null;
  readonly enteredCodes?: readonly string[];
}

export interface PromoUser {
  readonly id: string;
  readonly isFirstTransaction: boolean;
  readonly segments?: readonly string[];
  /** promoId → times this user already used it. */
  readonly usageByPromo?: Readonly<Record<string, number>>;
}

export interface AppliedPromotion {
  readonly promoId: string;
  readonly code: string | null;
  readonly type: PromoType;
  readonly benefitKind: PromoBenefit['kind'];
  readonly discountIdr: number;
  readonly cashbackIdr: number;
  readonly freePlatformFee: boolean;
  /** Value used for ranking (discount, waived fee, or cashback). */
  readonly valueIdr: number;
  readonly budgetCapped: boolean;
}

export interface RejectedPromotion {
  readonly promoId: string;
  readonly code: string;
  readonly reason: string;
}

export interface PromotionEvaluation {
  readonly applied: readonly AppliedPromotion[];
  /** Cash discount for the DISCOUNT line (excludes a waived platform fee). */
  readonly discountIdr: number;
  /** Credit granted after COMPLETED — not a discount. */
  readonly cashbackIdr: number;
  readonly freePlatformFee: boolean;
  readonly promoIds: readonly string[];
  readonly rejected: readonly RejectedPromotion[];
}

function baseAmount(cart: PromoCart, base: PromoBase = 'ITEM_PRICE'): number {
  switch (base) {
    case 'ITEM_PRICE':
      return cart.itemValueIdr;
    case 'TRAVELER_FEE':
      return cart.travelerFeeIdr;
    case 'PLATFORM_FEE':
      return cart.platformFeeIdr;
    case 'SUBTOTAL':
      return cart.itemValueIdr + cart.travelerFeeIdr + cart.platformFeeIdr;
  }
}

function eligibility(p: Promotion, cart: PromoCart, user: PromoUser, now: Date, codes: ReadonlySet<string>): string | null {
  if (p.status !== 'ACTIVE') return 'NOT_ACTIVE';
  if (now.getTime() < p.startsAt.getTime() || (p.endsAt && now.getTime() >= p.endsAt.getTime())) return 'OUTSIDE_DATE_WINDOW';
  const c = p.conditions ?? {};
  switch (p.type) {
    case 'PROMO_CODE':
      if (!p.code || !codes.has(p.code.toUpperCase())) return 'CODE_NOT_ENTERED';
      break;
    case 'FIRST_TRANSACTION':
      if (!user.isFirstTransaction) return 'NOT_FIRST_TRANSACTION';
      break;
    case 'COUNTRY':
      if (!c.originCountries?.includes(cart.originCountry)) return 'ORIGIN_NOT_ELIGIBLE';
      break;
    case 'TRAVELER':
      if (!cart.travelerId || !c.travelerIds?.includes(cart.travelerId)) return 'TRAVELER_NOT_ELIGIBLE';
      break;
    case 'CASHBACK':
      if (p.benefit.kind !== 'CASHBACK_CREDIT') return 'MISCONFIGURED_BENEFIT';
      break;
    case 'FREE_PLATFORM_FEE':
      if (p.benefit.kind !== 'FREE_PLATFORM_FEE') return 'MISCONFIGURED_BENEFIT';
      break;
    case 'CAMPAIGN':
      break;
  }
  if (c.firstTransactionOnly && !user.isFirstTransaction) return 'NOT_FIRST_TRANSACTION';
  if (c.minItemValueIdr !== undefined && cart.itemValueIdr < c.minItemValueIdr) return 'BELOW_MIN_ITEM_VALUE';
  if (c.originCountries && c.originCountries.length > 0 && !c.originCountries.includes(cart.originCountry)) return 'ORIGIN_NOT_ELIGIBLE';
  if (c.categories && c.categories.length > 0 && !c.categories.includes(cart.categoryCode)) return 'CATEGORY_NOT_ELIGIBLE';
  if (c.userSegments && c.userSegments.length > 0 && !c.userSegments.some((s) => user.segments?.includes(s))) return 'SEGMENT_NOT_ELIGIBLE';
  const l = p.limits ?? {};
  const used = user.usageByPromo?.[p.id] ?? 0;
  if (l.perUser !== undefined && l.perUser !== null && used >= l.perUser) return 'PER_USER_LIMIT_REACHED';
  if (l.global !== undefined && l.global !== null && (p.usage?.globalCount ?? 0) >= l.global) return 'GLOBAL_LIMIT_REACHED';
  if (l.budgetIdr !== undefined && l.budgetIdr !== null && (p.usage?.budgetUsedIdr ?? 0) >= l.budgetIdr) return 'BUDGET_EXHAUSTED';
  return null;
}

function computeValue(p: Promotion, cart: PromoCart): AppliedPromotion | string {
  const b = p.benefit;
  let discount = 0;
  let cashback = 0;
  let free = false;
  switch (b.kind) {
    case 'PERCENT': {
      assertBps(b.rateBps, `${p.id}.rateBps`);
      const base = baseAmount(cart, b.base);
      discount = Math.min(applyBps(base, b.rateBps, 'FLOOR'), b.capIdr ?? Number.MAX_SAFE_INTEGER, base);
      break;
    }
    case 'FIXED':
      assertNonNegativeInteger(b.amountIdr, `${p.id}.amountIdr`);
      discount = Math.min(b.amountIdr, baseAmount(cart, 'SUBTOTAL'));
      break;
    case 'FREE_PLATFORM_FEE':
      free = true;
      break;
    case 'CASHBACK_CREDIT': {
      const base = baseAmount(cart, b.base);
      const raw = b.amountIdr ?? (b.rateBps !== undefined ? applyBps(base, b.rateBps, 'FLOOR') : 0);
      cashback = Math.min(raw, b.capIdr ?? Number.MAX_SAFE_INTEGER);
      break;
    }
  }
  let value = free ? cart.platformFeeIdr : discount + cashback;
  let budgetCapped = false;
  const budget = p.limits?.budgetIdr;
  if (budget !== undefined && budget !== null) {
    const remaining = Math.max(0, budget - (p.usage?.budgetUsedIdr ?? 0));
    if (value > remaining) {
      if (free) return 'BUDGET_INSUFFICIENT';
      budgetCapped = true;
      discount = Math.min(discount, remaining);
      cashback = Math.min(cashback, remaining);
      value = discount + cashback;
    }
  }
  if (value <= 0) return 'NO_BENEFIT';
  return {
    promoId: p.id,
    code: p.code ?? null,
    type: p.type,
    benefitKind: b.kind,
    discountIdr: discount,
    cashbackIdr: cashback,
    freePlatformFee: free,
    valueIdr: value,
    budgetCapped,
  };
}

/**
 * Evaluates promotions for a cart. Stacking policy: at most ONE discount-class promo
 * (PERCENT / FIXED / FREE_PLATFORM_FEE — the highest value wins) plus at most ONE cashback;
 * referral credit is applied separately by pricing and always stacks.
 */
export function evaluatePromotions(
  cart: PromoCart,
  promos: readonly Promotion[],
  user: PromoUser,
  now: Date,
): PromotionEvaluation {
  for (const v of [cart.itemValueIdr, cart.travelerFeeIdr, cart.platformFeeIdr]) assertNonNegativeInteger(v, 'cart amount');
  const entered = new Set((cart.enteredCodes ?? []).map((c) => c.trim().toUpperCase()).filter((c) => c !== ''));
  const ids = new Set<string>();
  for (const p of promos) {
    if (ids.has(p.id)) throw new CoreError('DUPLICATE_PROMO', `Duplicate promotion id ${p.id}`);
    ids.add(p.id);
  }

  const rejected: RejectedPromotion[] = [];
  const candidates: (AppliedPromotion & { priority: number })[] = [];
  for (const p of promos) {
    const why = eligibility(p, cart, user, now, entered);
    if (why) {
      // Unentered codes are not "rejections" the user needs to see.
      if (why !== 'CODE_NOT_ENTERED') rejected.push({ promoId: p.id, code: why, reason: why });
      continue;
    }
    const v = computeValue(p, cart);
    if (typeof v === 'string') {
      rejected.push({ promoId: p.id, code: v, reason: v });
      continue;
    }
    candidates.push({ ...v, priority: p.priority ?? 0 });
  }
  for (const code of entered) {
    if (!promos.some((p) => p.code?.toUpperCase() === code)) rejected.push({ promoId: `code:${code}`, code: 'UNKNOWN_CODE', reason: 'UNKNOWN_CODE' });
  }

  const byValue = (a: { valueIdr: number; priority: number; promoId: string }, b: typeof a) =>
    b.valueIdr - a.valueIdr || b.priority - a.priority || compareStrings(a.promoId, b.promoId);
  const discounts = sortBy(
    candidates.filter((c) => c.benefitKind !== 'CASHBACK_CREDIT'),
    byValue,
  );
  const cashbacks = sortBy(
    candidates.filter((c) => c.benefitKind === 'CASHBACK_CREDIT'),
    byValue,
  );
  const applied: AppliedPromotion[] = [];
  for (const [i, c] of discounts.entries()) {
    if (i === 0) applied.push(stripPriority(c));
    else rejected.push({ promoId: c.promoId, code: 'NOT_STACKABLE', reason: 'Only one discount promotion per transaction' });
  }
  for (const [i, c] of cashbacks.entries()) {
    if (i === 0) applied.push(stripPriority(c));
    else rejected.push({ promoId: c.promoId, code: 'NOT_STACKABLE', reason: 'Only one cashback per transaction' });
  }
  return {
    applied,
    discountIdr: applied.reduce((s, a) => s + a.discountIdr, 0),
    cashbackIdr: applied.reduce((s, a) => s + a.cashbackIdr, 0),
    freePlatformFee: applied.some((a) => a.freePlatformFee),
    promoIds: applied.map((a) => a.promoId),
    rejected,
  };
}

function stripPriority(c: AppliedPromotion & { priority: number }): AppliedPromotion {
  const { priority: _priority, ...rest } = c;
  return rest;
}
