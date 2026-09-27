import { type TrustPenaltyWeightKey, type TrustPositiveWeightKey, type TrustWeights, TRUST_POSITIVE_WEIGHT_KEYS } from '../config';
import { CoreError } from '../errors';
import { clamp, clamp01, logSaturate, roundScore } from '../internal/math';
import { DAY_MS } from '../internal/time';
import { formatDecimal, formatIdr, roundHalfUp } from '../money';
import { bayesianAverage } from '../rating';

export const TRUST_SCORE_VERSION = 'trust-v1';

export type FraudSeverity = 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface TrustSignals {
  readonly kycLevel: number;
  readonly completedTransactions: number;
  readonly totalCompletedValueIdr: number;
  readonly accountCreatedAt: Date;
  readonly cancellations: { readonly count: number; readonly rate: number };
  /** Disputes decided against this user. */
  readonly disputesLost: { readonly count: number; readonly rate: number };
  /** null/undefined = not applicable (never delivered as traveler) → excluded from normalization. */
  readonly onTimeDeliveryRate?: number | null;
  /** null/undefined = not a traveler → excluded. */
  readonly verifiedTrips?: number | null;
  readonly fraudSignals: { readonly count: number; readonly maxSeverity: FraudSeverity };
  readonly paymentHistory: { readonly failedPayments: number; readonly chargebacks: number };
  readonly ratingAvg: number | null;
  readonly ratingCount: number;
}

export type TrustComponentKey = TrustPositiveWeightKey | TrustPenaltyWeightKey;

export interface TrustComponent {
  readonly key: TrustComponentKey;
  /** Normalized signal 0–1 (for penalties: severity 0–1). */
  readonly value: number;
  readonly weight: number;
  /** Points added (positive) or removed (negative), 2 decimals. */
  readonly contribution: number;
  readonly applicable: boolean;
  readonly explanation: string;
}

export interface TrustScoreResult {
  readonly score: number;
  readonly components: readonly TrustComponent[];
  readonly version: string;
}

const FRAUD_SEVERITY: Readonly<Record<FraudSeverity, number>> = { NONE: 0, LOW: 0.2, MEDIUM: 0.5, HIGH: 0.8, CRITICAL: 1 };

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

/**
 * Trust Score 0–100 (integer).
 * - Positive components use saturating curves (log) and are normalized over the *applicable*
 *   positive weights so a perfect profile reaches 100 (buyers are not penalized for missing
 *   traveler-only signals).
 * - Penalties subtract up to their full weight (severity × weight), each capped.
 * - Result clamped to [0, 100] and rounded half-up.
 */
export function computeTrustScore(signals: TrustSignals, weights: TrustWeights, now: Date): TrustScoreResult {
  const kyc = clamp01((signals.kycLevel - 1) / 4);
  const accountAgeDays = Math.max(0, (now.getTime() - signals.accountCreatedAt.getTime()) / DAY_MS);
  const ratingMean = bayesianAverage((signals.ratingAvg ?? 0) * signals.ratingCount, signals.ratingCount, 4, 5);
  const paymentPenalty = clamp01(signals.paymentHistory.failedPayments * 0.1 + signals.paymentHistory.chargebacks * 0.5);
  const onTime = signals.onTimeDeliveryRate ?? null;
  const trips = signals.verifiedTrips ?? null;

  const positives: Record<TrustPositiveWeightKey, { value: number; applicable: boolean; explanation: string }> = {
    kyc: { value: kyc, applicable: true, explanation: `KYC level ${signals.kycLevel} dari 5` },
    completedTransactions: {
      value: logSaturate(signals.completedTransactions, 50),
      applicable: true,
      explanation: `${signals.completedTransactions} transaksi selesai`,
    },
    transactionValue: {
      value: logSaturate(signals.totalCompletedValueIdr / 100_000, 1_000),
      applicable: true,
      explanation: `Total nilai transaksi ${formatIdr(Math.max(0, Math.round(signals.totalCompletedValueIdr)))}`,
    },
    accountAge: { value: logSaturate(accountAgeDays, 730), applicable: true, explanation: `Umur akun ${Math.floor(accountAgeDays)} hari` },
    onTimeDelivery: {
      value: onTime === null ? 0 : clamp01(onTime),
      applicable: onTime !== null,
      explanation: onTime === null ? 'Belum ada pengiriman (tidak dihitung)' : `Tepat waktu ${pct(onTime)}`,
    },
    tripVerification: {
      value: trips === null ? 0 : logSaturate(trips, 10),
      applicable: trips !== null,
      explanation: trips === null ? 'Bukan traveler (tidak dihitung)' : `${trips} trip terverifikasi`,
    },
    paymentHistory: {
      value: 1 - paymentPenalty,
      applicable: true,
      explanation: `${signals.paymentHistory.failedPayments} pembayaran gagal, ${signals.paymentHistory.chargebacks} chargeback`,
    },
    rating: {
      value: clamp01((ratingMean - 1) / 4),
      applicable: true,
      explanation:
        signals.ratingCount > 0
          ? `Rating ${formatDecimal(roundHalfUp(signals.ratingAvg ?? 0, 1))} (${signals.ratingCount} ulasan, Bayesian ${formatDecimal(roundHalfUp(ratingMean, 2))})`
          : 'Belum ada rating (nilai awal 4,0)',
    },
  };

  const cancellationSeverity = clamp01(
    0.6 * clamp01(signals.cancellations.rate / 0.2) + 0.4 * clamp01(signals.cancellations.count / 10),
  );
  const disputeSeverity = clamp01(0.6 * clamp01(signals.disputesLost.rate / 0.1) + 0.4 * clamp01(signals.disputesLost.count / 5));
  const fraudSeverity = Math.max(FRAUD_SEVERITY[signals.fraudSignals.maxSeverity], clamp01(signals.fraudSignals.count / 5));

  const penalties: Record<TrustPenaltyWeightKey, { value: number; explanation: string }> = {
    cancellationPenalty: {
      value: cancellationSeverity,
      explanation: `${signals.cancellations.count} pembatalan (${pct(signals.cancellations.rate)})`,
    },
    disputePenalty: {
      value: disputeSeverity,
      explanation: `${signals.disputesLost.count} dispute kalah (${pct(signals.disputesLost.rate)})`,
    },
    fraudPenalty: {
      value: fraudSeverity,
      explanation: `${signals.fraudSignals.count} sinyal fraud (tertinggi ${signals.fraudSignals.maxSeverity})`,
    },
  };

  const applicableWeight = TRUST_POSITIVE_WEIGHT_KEYS.reduce(
    (sum, k) => sum + (positives[k].applicable ? weights[k] : 0),
    0,
  );
  if (!(applicableWeight > 0)) throw new CoreError('INVALID_TRUST_WEIGHTS', 'Applicable positive weights must sum to > 0');
  const scale = 100 / applicableWeight;

  const components: TrustComponent[] = [];
  let raw = 0;
  for (const key of TRUST_POSITIVE_WEIGHT_KEYS) {
    const p = positives[key];
    const contribution = p.applicable ? p.value * weights[key] * scale : 0;
    raw += contribution;
    components.push({
      key,
      value: roundScore(p.value, 4),
      weight: weights[key],
      contribution: roundScore(contribution),
      applicable: p.applicable,
      explanation: p.explanation,
    });
  }
  for (const key of ['cancellationPenalty', 'disputePenalty', 'fraudPenalty'] as const) {
    const p = penalties[key];
    const contribution = -p.value * weights[key];
    raw += contribution;
    components.push({
      key,
      value: roundScore(p.value, 4),
      weight: weights[key],
      contribution: roundScore(contribution),
      applicable: true,
      explanation: p.explanation,
    });
  }
  return { score: Math.round(clamp(raw, 0, 100)), components, version: TRUST_SCORE_VERSION };
}

// ---------------------------------------------------------------------------
// Admin override (reason + approval + audit mandatory — §12)
// ---------------------------------------------------------------------------

export interface TrustOverride {
  readonly newScore: number;
  /** Mandatory, ≥ 10 characters. */
  readonly reason: string;
  readonly requestedBy: string;
  /** Must differ from `requestedBy` (four-eyes). */
  readonly approvedBy: string;
  readonly approvedAt: Date;
  readonly expiresAt: Date | null;
  readonly ticketRef?: string;
}

export interface TrustOverrideAudit {
  readonly action: 'TRUST_SCORE_OVERRIDE';
  readonly before: number;
  readonly after: number;
  readonly computedVersion: string;
  readonly reason: string;
  readonly requestedBy: string;
  readonly approvedBy: string;
  readonly approvedAt: string;
  readonly expiresAt: string | null;
  readonly ticketRef: string | null;
}

export interface TrustOverrideResult {
  readonly score: number;
  readonly previousScore: number;
  readonly overridden: true;
  readonly audit: TrustOverrideAudit;
}

export function applyOverride(computed: Pick<TrustScoreResult, 'score' | 'version'>, override: TrustOverride): TrustOverrideResult {
  if (!Number.isInteger(override.newScore) || override.newScore < 0 || override.newScore > 100) {
    throw new CoreError('INVALID_OVERRIDE_SCORE', 'Override score must be an integer 0–100');
  }
  if (override.reason.trim().length < 10) {
    throw new CoreError('OVERRIDE_REASON_REQUIRED', 'Override reason must be at least 10 characters');
  }
  if (!override.requestedBy.trim() || !override.approvedBy.trim()) {
    throw new CoreError('OVERRIDE_APPROVER_REQUIRED', 'requestedBy and approvedBy are required');
  }
  if (override.requestedBy === override.approvedBy) {
    throw new CoreError('OVERRIDE_SELF_APPROVAL', 'Override must be approved by a different admin');
  }
  if (override.expiresAt && override.expiresAt.getTime() <= override.approvedAt.getTime()) {
    throw new CoreError('OVERRIDE_EXPIRY_INVALID', 'expiresAt must be after approvedAt');
  }
  return {
    score: override.newScore,
    previousScore: computed.score,
    overridden: true,
    audit: {
      action: 'TRUST_SCORE_OVERRIDE',
      before: computed.score,
      after: override.newScore,
      computedVersion: computed.version,
      reason: override.reason.trim(),
      requestedBy: override.requestedBy,
      approvedBy: override.approvedBy,
      approvedAt: override.approvedAt.toISOString(),
      expiresAt: override.expiresAt ? override.expiresAt.toISOString() : null,
      ticketRef: override.ticketRef ?? null,
    },
  };
}

/** Score in effect: an unexpired override wins over the computed score. */
export function effectiveTrustScore(
  computedScore: number,
  override: Pick<TrustOverride, 'newScore' | 'expiresAt'> | null,
  now: Date,
): number {
  if (!override) return computedScore;
  if (override.expiresAt && now.getTime() >= override.expiresAt.getTime()) return computedScore;
  return override.newScore;
}
