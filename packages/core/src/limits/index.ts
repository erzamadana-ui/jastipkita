import type { KycLevelKey, TransactionLimitsConfig } from '../config';
import { type RiskLevel, isKycLevel } from '../domain';
import { CoreError, type Reason } from '../errors';
import { assertNonNegativeInteger, floorTo, formatDecimal, formatIdr, mulByRates } from '../money';

export type LimitRole = 'BUYER' | 'TRAVELER';

export interface LimitInput {
  readonly kycLevel: number;
  readonly trustScore: number;
  readonly completedTransactions: number;
  readonly productRisk: RiskLevel;
  readonly countryRisk: RiskLevel;
  readonly role: LimitRole;
  /** Transaction value already used this calendar month (IDR). */
  readonly monthUsedIdr: number;
}

export interface LimitResult {
  /** Per-transaction ceiling after multipliers & caps (floored to Rp1.000). */
  readonly perTransactionMaxIdr: number;
  readonly monthlyMaxIdr: number;
  readonly monthlyRemainingIdr: number;
  /** min(perTransactionMax, monthlyRemaining) — the amount that can actually be transacted now. */
  readonly effectiveMaxIdr: number;
  readonly baseIdr: number;
  readonly trustMultiplier: number;
  readonly productRiskMultiplier: number;
  readonly countryRiskMultiplier: number;
  readonly newTravelerCapApplied: boolean;
  readonly reasons: readonly Reason[];
}

export function trustMultiplierFor(trustScore: number, cfg: TransactionLimitsConfig): number {
  let m = cfg.trustMultipliers[0]?.multiplier ?? 1;
  for (const tier of cfg.trustMultipliers) if (trustScore >= tier.minScore) m = tier.multiplier;
  return m;
}

/**
 * Limit = floor₁₀₀₀(base[KYC, role] × trust × productRisk × countryRisk), then the new-traveler cap
 * (TRAVELER with completedTransactions < threshold). The monthly remaining budget is reported
 * separately and folded into `effectiveMaxIdr`.
 */
export function computeTransactionLimit(input: LimitInput, cfg: TransactionLimitsConfig): LimitResult {
  if (!isKycLevel(input.kycLevel)) throw new CoreError('INVALID_KYC_LEVEL', `KYC level must be 1–5, got ${input.kycLevel}`);
  assertNonNegativeInteger(input.monthUsedIdr, 'monthUsedIdr');
  const key = String(input.kycLevel) as KycLevelKey;
  const baseIdr = input.role === 'BUYER' ? cfg.byKycLevel[key] : cfg.travelerByKycLevel[key];
  const trustMultiplier = trustMultiplierFor(input.trustScore, cfg);
  const productRiskMultiplier = cfg.productRiskMultiplier[input.productRisk];
  const countryRiskMultiplier = cfg.countryRiskMultiplier[input.countryRisk];
  const reasons: Reason[] = [];

  reasons.push({
    code: 'KYC_BASE',
    message: `Batas dasar ${input.role === 'BUYER' ? 'pembeli' : 'traveler'} KYC level ${input.kycLevel}: ${formatIdr(baseIdr)}`,
  });
  if (baseIdr === 0) {
    reasons.push({ code: 'KYC_LEVEL_TOO_LOW', message: `KYC level ${input.kycLevel} belum dapat bertransaksi sebagai ${input.role}` });
  }
  reasons.push({ code: 'TRUST_MULTIPLIER', message: `Trust Score ${input.trustScore} → ×${formatDecimal(trustMultiplier)}` });
  if (productRiskMultiplier !== 1) {
    reasons.push({ code: 'PRODUCT_RISK', message: `Risiko produk ${input.productRisk} → ×${formatDecimal(productRiskMultiplier)}` });
  }
  if (countryRiskMultiplier !== 1) {
    reasons.push({ code: 'COUNTRY_RISK', message: `Risiko negara ${input.countryRisk} → ×${formatDecimal(countryRiskMultiplier)}` });
  }

  let perTx = floorTo(mulByRates(baseIdr, [trustMultiplier, productRiskMultiplier, countryRiskMultiplier], 'FLOOR'), 1000);
  let newTravelerCapApplied = false;
  if (input.role === 'TRAVELER' && input.completedTransactions < cfg.newTravelerCompletedThreshold && perTx > cfg.newTravelerMaxIdr) {
    perTx = cfg.newTravelerMaxIdr;
    newTravelerCapApplied = true;
    reasons.push({
      code: 'NEW_TRAVELER_CAP',
      message: `Traveler baru (< ${cfg.newTravelerCompletedThreshold} transaksi selesai): maks ${formatIdr(cfg.newTravelerMaxIdr)}`,
    });
  }

  const monthlyMaxIdr = input.role === 'BUYER' ? cfg.monthlyBuyerMaxIdr : cfg.monthlyTravelerMaxIdr;
  const monthlyRemainingIdr = Math.max(0, monthlyMaxIdr - input.monthUsedIdr);
  const effectiveMaxIdr = Math.min(perTx, monthlyRemainingIdr);
  if (monthlyRemainingIdr < perTx) {
    reasons.push({ code: 'MONTHLY_REMAINING', message: `Sisa limit bulanan ${formatIdr(monthlyRemainingIdr)}` });
  }

  return {
    perTransactionMaxIdr: perTx,
    monthlyMaxIdr,
    monthlyRemainingIdr,
    effectiveMaxIdr,
    baseIdr,
    trustMultiplier,
    productRiskMultiplier,
    countryRiskMultiplier,
    newTravelerCapApplied,
    reasons,
  };
}

export type LimitCheck =
  | { readonly ok: true; readonly limit: LimitResult }
  | { readonly ok: false; readonly code: string; readonly message: string; readonly limit: LimitResult };

export function checkLimit(amountIdr: number, input: LimitInput, cfg: TransactionLimitsConfig): LimitCheck {
  assertNonNegativeInteger(amountIdr, 'amountIdr');
  const limit = computeTransactionLimit(input, cfg);
  if (limit.baseIdr === 0) {
    return { ok: false, code: 'KYC_LEVEL_TOO_LOW', message: 'Tingkatkan verifikasi akun untuk bertransaksi.', limit };
  }
  if (amountIdr > limit.perTransactionMaxIdr) {
    return {
      ok: false,
      code: 'PER_TRANSACTION_LIMIT_EXCEEDED',
      message: `Nilai ${formatIdr(amountIdr)} melebihi limit per transaksi ${formatIdr(limit.perTransactionMaxIdr)}.`,
      limit,
    };
  }
  if (amountIdr > limit.monthlyRemainingIdr) {
    return {
      ok: false,
      code: 'MONTHLY_LIMIT_EXCEEDED',
      message: `Nilai ${formatIdr(amountIdr)} melebihi sisa limit bulanan ${formatIdr(limit.monthlyRemainingIdr)}.`,
      limit,
    };
  }
  return { ok: true, limit };
}
