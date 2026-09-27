import defaultsJson from './business-config.defaults.json' with { type: 'json' };
import categoriesJson from './product-categories.json' with { type: 'json' };
import countriesJson from './countries.json' with { type: 'json' };
import { CoreError } from '../errors';
import {
  ACTORS,
  CANCELLATION_STAGES,
  CHARGE_LINE_TYPES,
  type Actor,
  type CancellationStage,
  type ChargeLineType,
  type RiskLevel,
  RISK_LEVELS,
  isOneOf,
} from '../domain';
import { isSupportedCurrency } from '../money';

export { CURRENCIES, getCurrency, isSupportedCurrency } from '../money';

// ===========================================================================
// Types — one per key in business-config.defaults.json
// ===========================================================================

export interface FeeRateConfig {
  readonly rateBps: number;
  readonly minIdr: number;
  readonly maxIdr: number;
}

/** PAYMENT_FEE is deliberately excluded: it is computed after service tax (would be circular). */
export const SERVICE_TAXABLE_LINES = ['PLATFORM_FEE', 'PROTECTION_FEE', 'TRAVELER_FEE'] as const;
export type ServiceTaxableLine = (typeof SERVICE_TAXABLE_LINES)[number];

export interface ServiceTaxConfig {
  readonly enabled: boolean;
  /** e.g. 0.12 */
  readonly rate: number;
  /** DPP factor, e.g. 11/12 ≈ 0.916667 */
  readonly dppFactor: number;
  readonly appliesTo: readonly ServiceTaxableLine[];
  readonly label: string;
}

export interface FxMarkupConfig {
  readonly defaultBps: number;
  readonly perCurrency: Readonly<Record<string, number>>;
}

export const PAYMENT_FEE_BEARERS = ['BUYER', 'PLATFORM'] as const;
export type PaymentFeeBearer = (typeof PAYMENT_FEE_BEARERS)[number];

export interface PaymentChannelConfig {
  readonly label: string;
  readonly fixedIdr: number;
  readonly rateBps: number;
  readonly bearer: PaymentFeeBearer;
  /** When bearer=BUYER: gross the fee up so it covers the gateway fee on itself. Default true. */
  readonly grossUp?: boolean;
}

export interface PaymentFeesConfig {
  readonly defaultChannel: string;
  readonly channels: Readonly<Record<string, PaymentChannelConfig>>;
}

export interface TravelerFeeBoundsConfig {
  readonly minIdr: number;
  readonly maxRateBps: number;
}

export interface MinimumTransactionConfig {
  readonly minItemValueIdr: number;
}

export interface FxLockConfig {
  readonly lockMinutes: number;
  /** Default 4320 (72 h): ECB/Frankfurter does not publish on weekends & TARGET holidays. */
  readonly maxRateAgeMinutes: number;
  readonly provider: string;
  /** e.g. "none" */
  readonly fallbackProvider?: string;
  readonly note?: string;
}

export const PRICE_CONFIRMATION_EXPIRED_ACTIONS = ['REJECT', 'APPROVE_WITHIN_BUDGET'] as const;
export type PriceConfirmationExpiredAction = (typeof PRICE_CONFIRMATION_EXPIRED_ACTIONS)[number];

export interface PriceConfirmationConfig {
  readonly windowSeconds: number;
  readonly toleranceBps: number;
  readonly toleranceMaxIdr: number;
  readonly expiredAction: PriceConfirmationExpiredAction;
}

export interface DeliveryConfig {
  readonly autoConfirmHours: number;
  readonly pinLength: number;
  readonly maxPinAttempts: number;
  readonly qrTtlMinutes: number;
}

export interface DisputeSlaConfig {
  readonly openWindowHoursAfterDelivery: number;
  readonly evidenceHours: number;
  readonly reviewHours: number;
  readonly appealWindowHours: number;
}

export interface ReferralExperimentConfig {
  readonly key: string;
  readonly enabled: boolean;
  /** variant name → credit amount (IDR) */
  readonly variants: Readonly<Record<string, number>>;
}

export interface ReferralGuardrailsConfig {
  readonly pauseIfCacAboveLtvRatio: number;
  readonly pauseIfFraudRateAbove: number;
}

export interface BuyerReferralConfig {
  readonly enabled: boolean;
  readonly referrerCreditIdr: number;
  readonly refereeCreditIdr: number;
  readonly minFirstTransactionIdr: number;
  readonly requiredStatus: 'COMPLETED';
  readonly monthlyCapIdr: number;
  readonly creditExpiryDays: number;
  readonly withdrawable: boolean;
  readonly experiment: ReferralExperimentConfig;
  readonly guardrails: ReferralGuardrailsConfig;
}

export interface TravelerReferralConfig {
  readonly enabled: boolean;
  readonly referrerCreditIdr: number;
  readonly requiredCompletedTransactions: number;
  readonly monthlyCapIdr: number;
  readonly creditExpiryDays: number;
  readonly withdrawable: boolean;
}

export type KycLevelKey = '1' | '2' | '3' | '4' | '5';
export const KYC_LEVEL_KEYS: readonly KycLevelKey[] = ['1', '2', '3', '4', '5'];

export interface TrustMultiplierTier {
  readonly minScore: number;
  readonly multiplier: number;
}

export interface TransactionLimitsConfig {
  readonly byKycLevel: Readonly<Record<KycLevelKey, number>>;
  readonly travelerByKycLevel: Readonly<Record<KycLevelKey, number>>;
  readonly newTravelerMaxIdr: number;
  readonly newTravelerCompletedThreshold: number;
  readonly trustMultipliers: readonly TrustMultiplierTier[];
  readonly productRiskMultiplier: Readonly<Record<RiskLevel, number>>;
  readonly countryRiskMultiplier: Readonly<Record<RiskLevel, number>>;
  readonly monthlyBuyerMaxIdr: number;
  readonly monthlyTravelerMaxIdr: number;
}

export interface RiskThresholdsConfig {
  readonly review: number;
  readonly hold: number;
  readonly block: number;
}

export const MATCHING_WEIGHT_KEYS = ['date', 'rating', 'trust', 'price', 'capacity', 'history', 'routeExactness'] as const;
export type MatchingWeightKey = (typeof MATCHING_WEIGHT_KEYS)[number];
export type MatchingWeights = Readonly<Record<MatchingWeightKey, number>>;

export const TRUST_POSITIVE_WEIGHT_KEYS = [
  'kyc',
  'completedTransactions',
  'transactionValue',
  'accountAge',
  'onTimeDelivery',
  'tripVerification',
  'paymentHistory',
  'rating',
] as const;
export const TRUST_PENALTY_WEIGHT_KEYS = ['cancellationPenalty', 'disputePenalty', 'fraudPenalty'] as const;
export type TrustPositiveWeightKey = (typeof TRUST_POSITIVE_WEIGHT_KEYS)[number];
export type TrustPenaltyWeightKey = (typeof TRUST_PENALTY_WEIGHT_KEYS)[number];
export type TrustWeights = Readonly<Record<TrustPositiveWeightKey | TrustPenaltyWeightKey, number>>;

export interface TripsConfig {
  readonly allowUnverifiedActive: boolean;
  readonly maxActiveTripsPerTraveler: number;
  readonly maxCapacityKg: number;
}

export type MatrixActor = Actor | 'ANY';
export const MATRIX_ACTORS: readonly MatrixActor[] = [...ACTORS, 'ANY'];

export interface CancellationMatrixRow {
  readonly stage: CancellationStage;
  readonly actor: MatrixActor;
  /** Optional cause (e.g. PRICE_CHANGE_REJECTED). Matching: (stage, actor, cause) → (stage, actor) → (stage, ANY). */
  readonly cause?: string;
  readonly note?: string;
  readonly allowed: boolean;
  readonly reason?: string;
  /** Refund share per charge line, in bps of the amount paid on that line. */
  readonly refund: Readonly<Partial<Record<ChargeLineType, number>>>;
  readonly travelerCompensation: { readonly rateBpsOfTravelerFee: number; readonly minIdr: number };
  readonly trustPenalty: number;
  readonly requiresAdminApproval?: boolean;
}

export type CancellationMatrix = readonly CancellationMatrixRow[];

export interface BusinessConfig {
  readonly 'pricing.platform_fee': FeeRateConfig;
  readonly 'pricing.protection_fee': FeeRateConfig;
  readonly 'pricing.service_tax': ServiceTaxConfig;
  readonly 'pricing.fx_markup': FxMarkupConfig;
  readonly 'pricing.payment_fees': PaymentFeesConfig;
  readonly 'pricing.traveler_fee_bounds': TravelerFeeBoundsConfig;
  readonly 'pricing.minimum_transaction': MinimumTransactionConfig;
  readonly 'fx.lock': FxLockConfig;
  readonly price_confirmation: PriceConfirmationConfig;
  readonly delivery: DeliveryConfig;
  readonly 'dispute.sla': DisputeSlaConfig;
  readonly 'referral.buyer': BuyerReferralConfig;
  readonly 'referral.traveler': TravelerReferralConfig;
  readonly 'limits.transaction': TransactionLimitsConfig;
  readonly 'risk.thresholds': RiskThresholdsConfig;
  readonly 'matching.weights': MatchingWeights;
  readonly 'trust.weights': TrustWeights;
  readonly trips: TripsConfig;
  readonly 'cancellation.matrix': CancellationMatrix;
}

export type BusinessConfigKey = keyof BusinessConfig;

export const BUSINESS_CONFIG_KEYS: readonly BusinessConfigKey[] = [
  'pricing.platform_fee',
  'pricing.protection_fee',
  'pricing.service_tax',
  'pricing.fx_markup',
  'pricing.payment_fees',
  'pricing.traveler_fee_bounds',
  'pricing.minimum_transaction',
  'fx.lock',
  'price_confirmation',
  'delivery',
  'dispute.sla',
  'referral.buyer',
  'referral.traveler',
  'limits.transaction',
  'risk.thresholds',
  'matching.weights',
  'trust.weights',
  'trips',
  'cancellation.matrix',
];

export function isBusinessConfigKey(key: string): key is BusinessConfigKey {
  return (BUSINESS_CONFIG_KEYS as readonly string[]).includes(key);
}

// ===========================================================================
// Validator (hand-written, no zod) — used by Admin when saving a new config version
// ===========================================================================

export interface ConfigIssue {
  readonly path: string;
  readonly message: string;
}

export type ConfigValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly ConfigIssue[] };

const MAX_IDR = 1_000_000_000_000; // Rp1 triliun sanity ceiling for any single config amount

class Checker {
  readonly errors: ConfigIssue[] = [];

  fail(path: string, message: string): void {
    this.errors.push({ path, message });
  }

  object(path: string, v: unknown, allowed?: readonly string[], required?: readonly string[]): Record<string, unknown> | null {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      this.fail(path, 'must be an object');
      return null;
    }
    const obj = v as Record<string, unknown>;
    if (allowed) {
      for (const k of Object.keys(obj)) if (!allowed.includes(k)) this.fail(`${path}.${k}`, 'unknown field');
    }
    for (const k of required ?? allowed ?? []) {
      if (!(k in obj)) this.fail(`${path}.${k}`, 'is required');
    }
    return obj;
  }

  array(path: string, v: unknown): unknown[] | null {
    if (!Array.isArray(v)) {
      this.fail(path, 'must be an array');
      return null;
    }
    return v;
  }

  int(path: string, v: unknown, min: number, max: number): v is number {
    if (typeof v !== 'number' || !Number.isSafeInteger(v)) {
      this.fail(path, 'must be an integer');
      return false;
    }
    if (v < min || v > max) {
      this.fail(path, `must be between ${min} and ${max}`);
      return false;
    }
    return true;
  }

  idr(path: string, v: unknown): v is number {
    return this.int(path, v, 0, MAX_IDR);
  }

  bps(path: string, v: unknown, max = 10_000): v is number {
    return this.int(path, v, 0, max);
  }

  num(path: string, v: unknown, min: number, max: number, opts: { exclusiveMin?: boolean } = {}): v is number {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      this.fail(path, 'must be a finite number');
      return false;
    }
    if ((opts.exclusiveMin ? v <= min : v < min) || v > max) {
      this.fail(path, `must be ${opts.exclusiveMin ? '>' : '>='} ${min} and <= ${max}`);
      return false;
    }
    return true;
  }

  bool(path: string, v: unknown): v is boolean {
    if (typeof v !== 'boolean') {
      this.fail(path, 'must be a boolean');
      return false;
    }
    return true;
  }

  str(path: string, v: unknown): v is string {
    if (typeof v !== 'string' || v.trim() === '') {
      this.fail(path, 'must be a non-empty string');
      return false;
    }
    return true;
  }

  oneOf<T extends string>(path: string, v: unknown, list: readonly T[]): v is T {
    if (!isOneOf(list, v)) {
      this.fail(path, `must be one of ${list.join(', ')}`);
      return false;
    }
    return true;
  }
}

type KeyValidator = (c: Checker, v: unknown, p: string) => void;

function validateFeeRate(c: Checker, v: unknown, p: string): void {
  const o = c.object(p, v, ['rateBps', 'minIdr', 'maxIdr']);
  if (!o) return;
  c.bps(`${p}.rateBps`, o.rateBps);
  const minOk = c.idr(`${p}.minIdr`, o.minIdr);
  const maxOk = c.idr(`${p}.maxIdr`, o.maxIdr);
  if (minOk && maxOk && (o.minIdr as number) > (o.maxIdr as number)) c.fail(`${p}.minIdr`, 'must be <= maxIdr');
}

function validateKycMap(c: Checker, v: unknown, p: string): void {
  const o = c.object(p, v, KYC_LEVEL_KEYS);
  if (!o) return;
  let prev = -1;
  for (const k of KYC_LEVEL_KEYS) {
    if (c.idr(`${p}.${k}`, o[k])) {
      if ((o[k] as number) < prev) c.fail(`${p}.${k}`, 'must be non-decreasing by KYC level');
      prev = o[k] as number;
    }
  }
}

function validateRiskMultiplierMap(c: Checker, v: unknown, p: string): void {
  const o = c.object(p, v, RISK_LEVELS);
  if (!o) return;
  for (const k of RISK_LEVELS) c.num(`${p}.${k}`, o[k], 0, 10);
}

const CAUSE_RE = /^[A-Z][A-Z0-9_]*$/;

function validateMatrixRow(c: Checker, v: unknown, p: string): void {
  const o = c.object(
    p,
    v,
    ['stage', 'actor', 'cause', 'note', 'allowed', 'reason', 'refund', 'travelerCompensation', 'trustPenalty', 'requiresAdminApproval'],
    ['stage', 'actor', 'allowed', 'refund', 'travelerCompensation', 'trustPenalty'],
  );
  if (!o) return;
  c.oneOf(`${p}.stage`, o.stage, CANCELLATION_STAGES);
  c.oneOf(`${p}.actor`, o.actor, MATRIX_ACTORS);
  c.bool(`${p}.allowed`, o.allowed);
  if (o.cause !== undefined && (typeof o.cause !== 'string' || !CAUSE_RE.test(o.cause))) {
    c.fail(`${p}.cause`, 'must be an UPPER_SNAKE_CASE code');
  }
  if (o.note !== undefined) c.str(`${p}.note`, o.note);
  if (o.reason !== undefined) c.str(`${p}.reason`, o.reason);
  if (o.requiresAdminApproval !== undefined) c.bool(`${p}.requiresAdminApproval`, o.requiresAdminApproval);
  c.int(`${p}.trustPenalty`, o.trustPenalty, 0, 100);
  const refund = c.object(`${p}.refund`, o.refund, CHARGE_LINE_TYPES, []);
  if (refund) for (const [k, bps] of Object.entries(refund)) c.bps(`${p}.refund.${k}`, bps);
  const comp = c.object(`${p}.travelerCompensation`, o.travelerCompensation, ['rateBpsOfTravelerFee', 'minIdr']);
  if (comp) {
    c.bps(`${p}.travelerCompensation.rateBpsOfTravelerFee`, comp.rateBpsOfTravelerFee);
    c.idr(`${p}.travelerCompensation.minIdr`, comp.minIdr);
  }
  const paidStage = isOneOf(['AFTER_PAYMENT', 'BEFORE_PURCHASE', 'AFTER_PURCHASE', 'DURING_TRAVEL', 'AFTER_ARRIVAL'] as const, o.stage);
  if (o.allowed === true && paidStage && refund) {
    for (const line of CHARGE_LINE_TYPES) {
      if (!(line in refund)) c.fail(`${p}.refund.${line}`, 'is required for an allowed row after payment');
    }
  }
  if (o.allowed === false && o.reason === undefined) c.fail(`${p}.reason`, 'is required when allowed=false');
}

const VALIDATORS: { readonly [K in BusinessConfigKey]: KeyValidator } = {
  'pricing.platform_fee': validateFeeRate,
  'pricing.protection_fee': validateFeeRate,
  'pricing.service_tax': (c, v, p) => {
    const o = c.object(p, v, ['enabled', 'rate', 'dppFactor', 'appliesTo', 'label']);
    if (!o) return;
    c.bool(`${p}.enabled`, o.enabled);
    c.num(`${p}.rate`, o.rate, 0, 1);
    c.num(`${p}.dppFactor`, o.dppFactor, 0, 1, { exclusiveMin: true });
    c.str(`${p}.label`, o.label);
    const arr = c.array(`${p}.appliesTo`, o.appliesTo);
    if (arr) {
      arr.forEach((x, i) => c.oneOf(`${p}.appliesTo[${i}]`, x, SERVICE_TAXABLE_LINES));
      if (new Set(arr).size !== arr.length) c.fail(`${p}.appliesTo`, 'must not contain duplicates');
    }
  },
  'pricing.fx_markup': (c, v, p) => {
    const o = c.object(p, v, ['defaultBps', 'perCurrency']);
    if (!o) return;
    c.bps(`${p}.defaultBps`, o.defaultBps, 2_000);
    const per = c.object(`${p}.perCurrency`, o.perCurrency);
    if (per) {
      for (const [ccy, bps] of Object.entries(per)) {
        if (!isSupportedCurrency(ccy)) c.fail(`${p}.perCurrency.${ccy}`, 'unsupported currency');
        c.bps(`${p}.perCurrency.${ccy}`, bps, 2_000);
      }
    }
  },
  'pricing.payment_fees': (c, v, p) => {
    const o = c.object(p, v, ['defaultChannel', 'channels']);
    if (!o) return;
    const channels = c.object(`${p}.channels`, o.channels);
    if (channels) {
      if (Object.keys(channels).length === 0) c.fail(`${p}.channels`, 'must define at least one channel');
      for (const [name, ch] of Object.entries(channels)) {
        const cp = `${p}.channels.${name}`;
        const co = c.object(cp, ch, ['label', 'fixedIdr', 'rateBps', 'bearer', 'grossUp'], ['label', 'fixedIdr', 'rateBps', 'bearer']);
        if (!co) continue;
        c.str(`${cp}.label`, co.label);
        c.idr(`${cp}.fixedIdr`, co.fixedIdr);
        // < 100%: a gross-up with rate >= 100% has no finite solution.
        c.bps(`${cp}.rateBps`, co.rateBps, 9_999);
        c.oneOf(`${cp}.bearer`, co.bearer, PAYMENT_FEE_BEARERS);
        if (co.grossUp !== undefined) c.bool(`${cp}.grossUp`, co.grossUp);
      }
    }
    if (c.str(`${p}.defaultChannel`, o.defaultChannel) && channels && !(o.defaultChannel in channels)) {
      c.fail(`${p}.defaultChannel`, 'must reference a configured channel');
    }
  },
  'pricing.traveler_fee_bounds': (c, v, p) => {
    const o = c.object(p, v, ['minIdr', 'maxRateBps']);
    if (!o) return;
    c.idr(`${p}.minIdr`, o.minIdr);
    if (c.bps(`${p}.maxRateBps`, o.maxRateBps) && o.maxRateBps === 0) c.fail(`${p}.maxRateBps`, 'must be > 0');
  },
  'pricing.minimum_transaction': (c, v, p) => {
    const o = c.object(p, v, ['minItemValueIdr']);
    if (o) c.idr(`${p}.minItemValueIdr`, o.minItemValueIdr);
  },
  'fx.lock': (c, v, p) => {
    const o = c.object(
      p,
      v,
      ['lockMinutes', 'maxRateAgeMinutes', 'provider', 'fallbackProvider', 'note'],
      ['lockMinutes', 'maxRateAgeMinutes', 'provider'],
    );
    if (!o) return;
    c.int(`${p}.lockMinutes`, o.lockMinutes, 1, 24 * 60);
    c.int(`${p}.maxRateAgeMinutes`, o.maxRateAgeMinutes, 1, 14 * 24 * 60);
    c.str(`${p}.provider`, o.provider);
    if (o.fallbackProvider !== undefined) c.str(`${p}.fallbackProvider`, o.fallbackProvider);
    if (o.note !== undefined) c.str(`${p}.note`, o.note);
  },
  price_confirmation: (c, v, p) => {
    const o = c.object(p, v, ['windowSeconds', 'toleranceBps', 'toleranceMaxIdr', 'expiredAction']);
    if (!o) return;
    c.int(`${p}.windowSeconds`, o.windowSeconds, 60, 7 * 24 * 3600);
    c.bps(`${p}.toleranceBps`, o.toleranceBps, 5_000);
    c.idr(`${p}.toleranceMaxIdr`, o.toleranceMaxIdr);
    c.oneOf(`${p}.expiredAction`, o.expiredAction, PRICE_CONFIRMATION_EXPIRED_ACTIONS);
  },
  delivery: (c, v, p) => {
    const o = c.object(p, v, ['autoConfirmHours', 'pinLength', 'maxPinAttempts', 'qrTtlMinutes']);
    if (!o) return;
    c.int(`${p}.autoConfirmHours`, o.autoConfirmHours, 1, 24 * 30);
    c.int(`${p}.pinLength`, o.pinLength, 4, 10);
    c.int(`${p}.maxPinAttempts`, o.maxPinAttempts, 1, 20);
    c.int(`${p}.qrTtlMinutes`, o.qrTtlMinutes, 1, 24 * 60);
  },
  'dispute.sla': (c, v, p) => {
    const o = c.object(p, v, ['openWindowHoursAfterDelivery', 'evidenceHours', 'reviewHours', 'appealWindowHours']);
    if (!o) return;
    for (const k of ['openWindowHoursAfterDelivery', 'evidenceHours', 'reviewHours', 'appealWindowHours']) {
      c.int(`${p}.${k}`, o[k], 1, 24 * 90);
    }
  },
  'referral.buyer': (c, v, p) => {
    const o = c.object(p, v, [
      'enabled',
      'referrerCreditIdr',
      'refereeCreditIdr',
      'minFirstTransactionIdr',
      'requiredStatus',
      'monthlyCapIdr',
      'creditExpiryDays',
      'withdrawable',
      'experiment',
      'guardrails',
    ]);
    if (!o) return;
    c.bool(`${p}.enabled`, o.enabled);
    c.idr(`${p}.referrerCreditIdr`, o.referrerCreditIdr);
    c.idr(`${p}.refereeCreditIdr`, o.refereeCreditIdr);
    c.idr(`${p}.minFirstTransactionIdr`, o.minFirstTransactionIdr);
    c.oneOf(`${p}.requiredStatus`, o.requiredStatus, ['COMPLETED'] as const);
    c.idr(`${p}.monthlyCapIdr`, o.monthlyCapIdr);
    c.int(`${p}.creditExpiryDays`, o.creditExpiryDays, 1, 3650);
    c.bool(`${p}.withdrawable`, o.withdrawable);
    const exp = c.object(`${p}.experiment`, o.experiment, ['key', 'enabled', 'variants']);
    if (exp) {
      c.str(`${p}.experiment.key`, exp.key);
      c.bool(`${p}.experiment.enabled`, exp.enabled);
      const variants = c.object(`${p}.experiment.variants`, exp.variants);
      if (variants) {
        if (Object.keys(variants).length === 0) c.fail(`${p}.experiment.variants`, 'must define at least one variant');
        for (const [name, amt] of Object.entries(variants)) c.idr(`${p}.experiment.variants.${name}`, amt);
      }
    }
    const g = c.object(`${p}.guardrails`, o.guardrails, ['pauseIfCacAboveLtvRatio', 'pauseIfFraudRateAbove']);
    if (g) {
      c.num(`${p}.guardrails.pauseIfCacAboveLtvRatio`, g.pauseIfCacAboveLtvRatio, 0, 10, { exclusiveMin: true });
      c.num(`${p}.guardrails.pauseIfFraudRateAbove`, g.pauseIfFraudRateAbove, 0, 1);
    }
  },
  'referral.traveler': (c, v, p) => {
    const o = c.object(p, v, [
      'enabled',
      'referrerCreditIdr',
      'requiredCompletedTransactions',
      'monthlyCapIdr',
      'creditExpiryDays',
      'withdrawable',
    ]);
    if (!o) return;
    c.bool(`${p}.enabled`, o.enabled);
    c.idr(`${p}.referrerCreditIdr`, o.referrerCreditIdr);
    c.int(`${p}.requiredCompletedTransactions`, o.requiredCompletedTransactions, 1, 1000);
    c.idr(`${p}.monthlyCapIdr`, o.monthlyCapIdr);
    c.int(`${p}.creditExpiryDays`, o.creditExpiryDays, 1, 3650);
    c.bool(`${p}.withdrawable`, o.withdrawable);
  },
  'limits.transaction': (c, v, p) => {
    const o = c.object(p, v, [
      'byKycLevel',
      'travelerByKycLevel',
      'newTravelerMaxIdr',
      'newTravelerCompletedThreshold',
      'trustMultipliers',
      'productRiskMultiplier',
      'countryRiskMultiplier',
      'monthlyBuyerMaxIdr',
      'monthlyTravelerMaxIdr',
    ]);
    if (!o) return;
    validateKycMap(c, o.byKycLevel, `${p}.byKycLevel`);
    validateKycMap(c, o.travelerByKycLevel, `${p}.travelerByKycLevel`);
    c.idr(`${p}.newTravelerMaxIdr`, o.newTravelerMaxIdr);
    c.int(`${p}.newTravelerCompletedThreshold`, o.newTravelerCompletedThreshold, 0, 1000);
    const tiers = c.array(`${p}.trustMultipliers`, o.trustMultipliers);
    if (tiers) {
      if (tiers.length === 0) c.fail(`${p}.trustMultipliers`, 'must have at least one tier');
      let prev = -1;
      tiers.forEach((t, i) => {
        const tp = `${p}.trustMultipliers[${i}]`;
        const to = c.object(tp, t, ['minScore', 'multiplier']);
        if (!to) return;
        if (c.int(`${tp}.minScore`, to.minScore, 0, 100)) {
          if ((to.minScore as number) <= prev) c.fail(`${tp}.minScore`, 'tiers must be strictly ascending');
          if (i === 0 && to.minScore !== 0) c.fail(`${tp}.minScore`, 'first tier must start at 0');
          prev = to.minScore as number;
        }
        c.num(`${tp}.multiplier`, to.multiplier, 0, 10);
      });
    }
    validateRiskMultiplierMap(c, o.productRiskMultiplier, `${p}.productRiskMultiplier`);
    validateRiskMultiplierMap(c, o.countryRiskMultiplier, `${p}.countryRiskMultiplier`);
    c.idr(`${p}.monthlyBuyerMaxIdr`, o.monthlyBuyerMaxIdr);
    c.idr(`${p}.monthlyTravelerMaxIdr`, o.monthlyTravelerMaxIdr);
  },
  'risk.thresholds': (c, v, p) => {
    const o = c.object(p, v, ['review', 'hold', 'block']);
    if (!o) return;
    const ok = [c.int(`${p}.review`, o.review, 0, 100), c.int(`${p}.hold`, o.hold, 0, 100), c.int(`${p}.block`, o.block, 0, 100)];
    if (ok.every(Boolean) && !((o.review as number) < (o.hold as number) && (o.hold as number) < (o.block as number))) {
      c.fail(p, 'must satisfy review < hold < block');
    }
  },
  'matching.weights': (c, v, p) => {
    const o = c.object(p, v, MATCHING_WEIGHT_KEYS);
    if (!o) return;
    let sum = 0;
    for (const k of MATCHING_WEIGHT_KEYS) if (c.num(`${p}.${k}`, o[k], 0, 1)) sum += o[k] as number;
    if (!(sum > 0)) c.fail(p, 'weights must sum to > 0');
  },
  'trust.weights': (c, v, p) => {
    const o = c.object(p, v, [...TRUST_POSITIVE_WEIGHT_KEYS, ...TRUST_PENALTY_WEIGHT_KEYS]);
    if (!o) return;
    let positive = 0;
    for (const k of TRUST_POSITIVE_WEIGHT_KEYS) if (c.num(`${p}.${k}`, o[k], 0, 100)) positive += o[k] as number;
    for (const k of TRUST_PENALTY_WEIGHT_KEYS) c.num(`${p}.${k}`, o[k], 0, 100);
    if (!(positive > 0)) c.fail(p, 'positive weights must sum to > 0');
  },
  trips: (c, v, p) => {
    const o = c.object(p, v, ['allowUnverifiedActive', 'maxActiveTripsPerTraveler', 'maxCapacityKg']);
    if (!o) return;
    c.bool(`${p}.allowUnverifiedActive`, o.allowUnverifiedActive);
    c.int(`${p}.maxActiveTripsPerTraveler`, o.maxActiveTripsPerTraveler, 1, 100);
    c.num(`${p}.maxCapacityKg`, o.maxCapacityKg, 0, 200, { exclusiveMin: true });
  },
  'cancellation.matrix': (c, v, p) => {
    const rows = c.array(p, v);
    if (!rows) return;
    const seen = new Set<string>();
    rows.forEach((row, i) => {
      validateMatrixRow(c, row, `${p}[${i}]`);
      if (typeof row === 'object' && row !== null) {
        const r = row as { stage?: unknown; actor?: unknown; cause?: unknown };
        const key = `${String(r.stage)}/${String(r.actor)}${r.cause === undefined ? '' : `/${String(r.cause)}`}`;
        if (seen.has(key)) c.fail(`${p}[${i}]`, `duplicate row for ${key}`);
        seen.add(key);
      }
    });
    // Coverage: every stage must be decidable for the buyer (explicit BUYER row or ANY).
    for (const stage of CANCELLATION_STAGES) {
      if (!seen.has(`${stage}/BUYER`) && !seen.has(`${stage}/ANY`)) {
        c.fail(p, `missing matrix row for stage ${stage} (BUYER or ANY)`);
      }
    }
  },
};

/** Validates one config key's value. Unknown fields, negative fees, bps > 10 000, missing matrix rows → errors. */
export function validateBusinessConfig<K extends BusinessConfigKey>(key: K, value: unknown): ConfigValidationResult<BusinessConfig[K]> {
  const c = new Checker();
  const validator = VALIDATORS[key] as KeyValidator | undefined;
  if (!validator) return { ok: false, errors: [{ path: String(key), message: 'unknown config key' }] };
  validator(c, value, String(key));
  return c.errors.length === 0 ? { ok: true, value: value as BusinessConfig[K] } : { ok: false, errors: c.errors };
}

/** Validates a full config object (all keys required; `_meta` ignored). */
export function validateBusinessConfigSet(value: unknown): ConfigValidationResult<BusinessConfig> {
  const c = new Checker();
  const o = c.object('config', value);
  if (!o) return { ok: false, errors: c.errors };
  const errors: ConfigIssue[] = [];
  for (const k of Object.keys(o)) {
    if (k !== '_meta' && !isBusinessConfigKey(k)) errors.push({ path: k, message: 'unknown config key' });
  }
  for (const key of BUSINESS_CONFIG_KEYS) {
    if (!(key in o)) {
      errors.push({ path: key, message: 'is required' });
      continue;
    }
    const r = validateBusinessConfig(key, o[key]);
    if (!r.ok) errors.push(...r.errors);
  }
  if (errors.length > 0) return { ok: false, errors };
  const out: Record<string, unknown> = {};
  for (const key of BUSINESS_CONFIG_KEYS) out[key] = o[key];
  return { ok: true, value: out as unknown as BusinessConfig };
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

function loadDefaults(): BusinessConfig {
  const copy: unknown = JSON.parse(JSON.stringify(defaultsJson));
  const result = validateBusinessConfigSet(copy);
  if (!result.ok) {
    throw new CoreError('INVALID_DEFAULT_CONFIG', 'business-config.defaults.json failed validation', {
      errors: result.errors,
    });
  }
  return deepFreeze(result.value);
}

/** Validated, deep-frozen defaults from business-config.defaults.json (seeded as version 1). */
export const DEFAULT_BUSINESS_CONFIG: BusinessConfig = loadDefaults();

export interface BusinessConfigMeta {
  readonly description: string;
  readonly currency: string;
  readonly assumptions: readonly string[];
  readonly matrixMatching?: string;
}

export const BUSINESS_CONFIG_META: BusinessConfigMeta = deepFreeze(
  JSON.parse(JSON.stringify(defaultsJson._meta)) as BusinessConfigMeta,
);

// ===========================================================================
// Reference data: product categories & countries
// ===========================================================================

export interface ProductCategory {
  readonly code: string;
  readonly nameId: string;
  readonly nameEn: string;
  readonly risk: RiskLevel;
  readonly requiresSerial: boolean;
  readonly requiresVideo: boolean;
  readonly defaultWeightKg: number;
  readonly defaultHs: string | null;
}

export const COUNTRY_ACTIVATIONS = ['ACTIVE', 'SOFT_LAUNCH', 'INACTIVE'] as const;
export type CountryActivation = (typeof COUNTRY_ACTIVATIONS)[number];

export interface Country {
  readonly code: string;
  readonly nameId: string;
  readonly nameEn: string;
  readonly currency: string;
  readonly origin: boolean;
  readonly destination: boolean;
  readonly risk: RiskLevel;
  readonly activation: CountryActivation;
  readonly slug: string;
  readonly sort: number;
}

export const PRODUCT_CATEGORIES: readonly ProductCategory[] = deepFreeze(
  JSON.parse(JSON.stringify(categoriesJson)) as ProductCategory[],
);
export const COUNTRIES: readonly Country[] = deepFreeze(JSON.parse(JSON.stringify(countriesJson)) as Country[]);

const CATEGORY_BY_CODE = new Map(PRODUCT_CATEGORIES.map((c) => [c.code, c]));
const COUNTRY_BY_CODE = new Map(COUNTRIES.map((c) => [c.code, c]));

export function findCategory(code: string): ProductCategory | undefined {
  return CATEGORY_BY_CODE.get(code);
}

export function getCategory(code: string): ProductCategory {
  const c = CATEGORY_BY_CODE.get(code);
  if (!c) throw new CoreError('UNKNOWN_CATEGORY', `Unknown product category ${code}`, { code });
  return c;
}

export function findCountry(code: string): Country | undefined {
  return COUNTRY_BY_CODE.get(code);
}

export function getCountry(code: string): Country {
  const c = COUNTRY_BY_CODE.get(code);
  if (!c) throw new CoreError('UNKNOWN_COUNTRY', `Unknown country ${code}`, { code });
  return c;
}
