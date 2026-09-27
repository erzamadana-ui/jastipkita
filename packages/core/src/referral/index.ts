import type { BusinessConfig, ReferralGuardrailsConfig } from '../config';
import type { RiskDecision, TransactionStatus } from '../domain';
import { CoreError, type Reason } from '../errors';
import { addDays } from '../internal/time';
import { assertNonNegativeInteger, formatIdr } from '../money';

export type ReferralProgram = 'BUYER' | 'TRAVELER';
export type ReferralConfig = Pick<BusinessConfig, 'referral.buyer' | 'referral.traveler'>;

export interface ReferralRewardInput {
  readonly program: ReferralProgram;
  readonly referrer: { readonly userId: string };
  readonly referee: { readonly userId: string; readonly completedTransactions: number };
  readonly qualifyingTransaction: {
    readonly id: string;
    readonly status: TransactionStatus;
    /** Transaction value (TOTAL before credits) in IDR. */
    readonly valueIdr: number;
    readonly isRefereeFirstTransaction: boolean;
  };
  /** Referral credit already granted to the referrer this calendar month for this program. */
  readonly monthRewardedIdr: number;
  readonly alreadyRewarded?: boolean;
  /** Output of the fraud engine for the REFERRAL subject. */
  readonly signals: { readonly decision: RiskDecision };
  readonly now: Date;
}

export interface ReferralRewardResult {
  /** GRANTED: release now; PENDING_REVIEW: computed but held for RISK review; REJECTED: nothing. */
  readonly status: 'GRANTED' | 'PENDING_REVIEW' | 'REJECTED';
  readonly referrerRewardIdr: number;
  readonly refereeRewardIdr: number;
  readonly cappedByMonthlyLimit: boolean;
  readonly variant: string | null;
  readonly expiresAt: Date | null;
  readonly withdrawable: boolean;
  readonly reasons: readonly Reason[];
}

/** FNV-1a 32-bit — stable across runtimes. */
export function fnv1a32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Deterministic, uniform experiment bucketing: same user + key → same variant (variants sorted first). */
export function assignVariant(userId: string, experimentKey: string, variants: readonly string[]): string {
  if (variants.length === 0) throw new CoreError('NO_VARIANTS', 'At least one variant is required');
  const sorted = [...variants].sort();
  return sorted[fnv1a32(`${experimentKey}:${userId}`) % sorted.length] as string;
}

function rejected(reasons: Reason[], withdrawable: boolean): ReferralRewardResult {
  return {
    status: 'REJECTED',
    referrerRewardIdr: 0,
    refereeRewardIdr: 0,
    cappedByMonthlyLimit: false,
    variant: null,
    expiresAt: null,
    withdrawable,
    reasons,
  };
}

/**
 * Buyer program: referrer & referee each get credit (default Rp25.000) when the referee's FIRST
 * transaction is COMPLETED with value ≥ minFirstTransactionIdr.
 * Traveler program: referrer gets credit (default Rp50.000) once the referee has completed N transactions.
 * Referrer credit is partially capped by the monthly cap; fraud HOLD/BLOCK → no reward.
 */
export function evaluateReferralReward(input: ReferralRewardInput, config: ReferralConfig): ReferralRewardResult {
  assertNonNegativeInteger(input.monthRewardedIdr, 'monthRewardedIdr');
  assertNonNegativeInteger(input.qualifyingTransaction.valueIdr, 'valueIdr');
  const reasons: Reason[] = [];
  const tx = input.qualifyingTransaction;

  if (input.program === 'BUYER') {
    const cfg = config['referral.buyer'];
    if (!cfg.enabled) return rejected([{ code: 'PROGRAM_DISABLED', message: 'Program referral pembeli nonaktif' }], cfg.withdrawable);
    if (input.referrer.userId === input.referee.userId) reasons.push({ code: 'SELF_REFERRAL', message: 'Tidak bisa mereferensikan diri sendiri' });
    if (input.alreadyRewarded) reasons.push({ code: 'ALREADY_REWARDED', message: 'Referral ini sudah diberi reward' });
    if (tx.status !== cfg.requiredStatus) reasons.push({ code: 'TRANSACTION_NOT_COMPLETED', message: `Transaksi harus ${cfg.requiredStatus}` });
    if (!tx.isRefereeFirstTransaction) reasons.push({ code: 'NOT_FIRST_TRANSACTION', message: 'Bukan transaksi pertama referee' });
    if (tx.valueIdr < cfg.minFirstTransactionIdr) {
      reasons.push({ code: 'BELOW_MIN_VALUE', message: `Nilai transaksi pertama minimal ${formatIdr(cfg.minFirstTransactionIdr)}` });
    }
    if (input.signals.decision === 'HOLD' || input.signals.decision === 'BLOCK') {
      reasons.push({ code: 'FRAUD_GATE', message: `Risk decision ${input.signals.decision}` });
    }
    if (reasons.length > 0) return rejected(reasons, cfg.withdrawable);

    let variant: string | null = null;
    let referrerBase = cfg.referrerCreditIdr;
    let refereeBase = cfg.refereeCreditIdr;
    if (cfg.experiment.enabled) {
      variant = assignVariant(input.referrer.userId, cfg.experiment.key, Object.keys(cfg.experiment.variants));
      const amount = cfg.experiment.variants[variant] as number;
      referrerBase = amount;
      refereeBase = amount;
      reasons.push({ code: 'EXPERIMENT_VARIANT', message: `Varian ${variant}: ${formatIdr(amount)}` });
    }
    const remaining = Math.max(0, cfg.monthlyCapIdr - input.monthRewardedIdr);
    const referrerReward = Math.min(referrerBase, remaining);
    const capped = referrerReward < referrerBase;
    if (capped) reasons.push({ code: 'MONTHLY_CAP', message: `Sisa kuota bulanan referrer ${formatIdr(remaining)}` });
    const review = input.signals.decision === 'REVIEW';
    if (review) reasons.push({ code: 'RISK_REVIEW', message: 'Reward ditahan menunggu review risiko' });
    return {
      status: review ? 'PENDING_REVIEW' : 'GRANTED',
      referrerRewardIdr: referrerReward,
      refereeRewardIdr: refereeBase,
      cappedByMonthlyLimit: capped,
      variant,
      expiresAt: addDays(input.now, cfg.creditExpiryDays),
      withdrawable: cfg.withdrawable,
      reasons,
    };
  }

  const cfg = config['referral.traveler'];
  if (!cfg.enabled) return rejected([{ code: 'PROGRAM_DISABLED', message: 'Program referral traveler nonaktif' }], cfg.withdrawable);
  if (input.referrer.userId === input.referee.userId) reasons.push({ code: 'SELF_REFERRAL', message: 'Tidak bisa mereferensikan diri sendiri' });
  if (input.alreadyRewarded) reasons.push({ code: 'ALREADY_REWARDED', message: 'Referral ini sudah diberi reward' });
  if (tx.status !== 'COMPLETED') reasons.push({ code: 'TRANSACTION_NOT_COMPLETED', message: 'Transaksi harus COMPLETED' });
  if (input.referee.completedTransactions < cfg.requiredCompletedTransactions) {
    reasons.push({
      code: 'NOT_ENOUGH_COMPLETED',
      message: `Traveler baru perlu ${cfg.requiredCompletedTransactions} transaksi selesai (baru ${input.referee.completedTransactions})`,
    });
  }
  if (input.signals.decision === 'HOLD' || input.signals.decision === 'BLOCK') {
    reasons.push({ code: 'FRAUD_GATE', message: `Risk decision ${input.signals.decision}` });
  }
  if (reasons.length > 0) return rejected(reasons, cfg.withdrawable);
  const remaining = Math.max(0, cfg.monthlyCapIdr - input.monthRewardedIdr);
  const referrerReward = Math.min(cfg.referrerCreditIdr, remaining);
  const capped = referrerReward < cfg.referrerCreditIdr;
  if (capped) reasons.push({ code: 'MONTHLY_CAP', message: `Sisa kuota bulanan referrer ${formatIdr(remaining)}` });
  const review = input.signals.decision === 'REVIEW';
  if (review) reasons.push({ code: 'RISK_REVIEW', message: 'Reward ditahan menunggu review risiko' });
  return {
    status: review ? 'PENDING_REVIEW' : 'GRANTED',
    referrerRewardIdr: referrerReward,
    refereeRewardIdr: 0,
    cappedByMonthlyLimit: capped,
    variant: null,
    expiresAt: addDays(input.now, cfg.creditExpiryDays),
    withdrawable: cfg.withdrawable,
    reasons,
  };
}

export interface UnitEconomicsInput {
  /** Customer acquisition cost per referred user (IDR). */
  readonly cac: number;
  /** Expected lifetime value (contribution margin, IDR). */
  readonly ltv: number;
  /** Share of referrals flagged as fraud (0–1). */
  readonly fraudRate: number;
}

export interface UnitEconomicsVerdict {
  readonly allowIncrease: boolean;
  readonly pause: boolean;
  readonly cacToLtv: number;
  readonly reasons: readonly Reason[];
}

/** Guardrail before raising referral amounts: pause when CAC/LTV or fraud rate exceed config. */
export function unitEconomicsGuardrail(input: UnitEconomicsInput, guardrails: ReferralGuardrailsConfig): UnitEconomicsVerdict {
  const reasons: Reason[] = [];
  const cacToLtv = input.ltv > 0 ? input.cac / input.ltv : Number.POSITIVE_INFINITY;
  if (!(input.ltv > 0)) reasons.push({ code: 'LTV_NOT_POSITIVE', message: 'LTV ≤ 0: program tidak ekonomis' });
  else if (cacToLtv > guardrails.pauseIfCacAboveLtvRatio) {
    reasons.push({
      code: 'CAC_LTV_TOO_HIGH',
      message: `CAC/LTV ${cacToLtv.toFixed(2)} > ${guardrails.pauseIfCacAboveLtvRatio}`,
    });
  }
  if (input.fraudRate > guardrails.pauseIfFraudRateAbove) {
    reasons.push({
      code: 'FRAUD_RATE_TOO_HIGH',
      message: `Fraud rate ${(input.fraudRate * 100).toFixed(1)}% > ${(guardrails.pauseIfFraudRateAbove * 100).toFixed(1)}%`,
    });
  }
  const pause = reasons.length > 0;
  return { allowIncrease: !pause, pause, cacToLtv, reasons };
}
