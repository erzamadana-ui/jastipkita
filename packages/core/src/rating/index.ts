import type { TransactionStatus } from '../domain';
import { CoreError, type Reason } from '../errors';
import { DAY_MS } from '../internal/time';

export type RaterRole = 'BUYER' | 'TRAVELER';

/** BUYER rates the traveler; TRAVELER rates the buyer. OVERALL is mandatory. */
export const RATING_DIMENSIONS: Readonly<Record<RaterRole, readonly string[]>> = {
  BUYER: ['OVERALL', 'ACCURACY', 'COMMUNICATION', 'TIMELINESS', 'ITEM_CONDITION'],
  TRAVELER: ['OVERALL', 'COMMUNICATION', 'RESPONSIVENESS'],
};

export interface RatingInput {
  readonly transactionStatus: TransactionStatus;
  readonly raterRole: RaterRole;
  readonly raterId: string;
  readonly transactionBuyerId: string;
  readonly transactionTravelerId: string;
  readonly scores: Readonly<Record<string, number>>;
  /** Whether this side already rated this transaction (one rating per side). */
  readonly alreadyRatedBySide: boolean;
  readonly completedAt: Date | null;
  readonly now: Date;
  /** Rating window after COMPLETED (default 14 days). */
  readonly windowDays?: number;
  readonly comment?: string | null;
}

export interface RatingValidation {
  readonly ok: boolean;
  readonly errors: readonly Reason[];
  readonly rateeId: string;
}

export const MAX_RATING_COMMENT_LENGTH = 1000;

export function validateRating(input: RatingInput): RatingValidation {
  const errors: Reason[] = [];
  const rateeId = input.raterRole === 'BUYER' ? input.transactionTravelerId : input.transactionBuyerId;
  if (input.transactionStatus !== 'COMPLETED') {
    errors.push({ code: 'TRANSACTION_NOT_COMPLETED', message: 'Rating hanya setelah transaksi COMPLETED.' });
  }
  const expectedRater = input.raterRole === 'BUYER' ? input.transactionBuyerId : input.transactionTravelerId;
  if (input.raterId !== expectedRater) errors.push({ code: 'NOT_A_PARTY', message: 'Pemberi rating bukan pihak transaksi.' });
  if (input.transactionBuyerId === input.transactionTravelerId) {
    errors.push({ code: 'SELF_RATING', message: 'Tidak dapat menilai diri sendiri.' });
  }
  if (input.alreadyRatedBySide) errors.push({ code: 'ALREADY_RATED', message: 'Sisi ini sudah memberi rating.' });
  if (input.completedAt) {
    const windowDays = input.windowDays ?? 14;
    if (input.now.getTime() > input.completedAt.getTime() + windowDays * DAY_MS) {
      errors.push({ code: 'RATING_WINDOW_CLOSED', message: `Batas waktu rating ${windowDays} hari sudah lewat.` });
    }
  } else if (input.transactionStatus === 'COMPLETED') {
    errors.push({ code: 'COMPLETED_AT_MISSING', message: 'completedAt wajib untuk transaksi COMPLETED.' });
  }
  const allowed = RATING_DIMENSIONS[input.raterRole];
  if (!('OVERALL' in input.scores)) errors.push({ code: 'OVERALL_REQUIRED', message: 'Nilai OVERALL wajib.' });
  for (const [dim, value] of Object.entries(input.scores)) {
    if (!allowed.includes(dim)) errors.push({ code: 'UNKNOWN_DIMENSION', message: `Dimensi ${dim} tidak dikenal.` });
    else if (!Number.isInteger(value) || value < 1 || value > 5) {
      errors.push({ code: 'SCORE_OUT_OF_RANGE', message: `${dim} harus bilangan bulat 1–5.` });
    }
  }
  if (input.comment && input.comment.length > MAX_RATING_COMMENT_LENGTH) {
    errors.push({ code: 'COMMENT_TOO_LONG', message: `Komentar maks. ${MAX_RATING_COMMENT_LENGTH} karakter.` });
  }
  return { ok: errors.length === 0, errors, rateeId };
}

/** (priorMean × priorWeight + sum) / (priorWeight + count) */
export function bayesianAverage(sum: number, count: number, priorMean: number, priorWeight: number): number {
  if (count < 0 || priorWeight < 0 || priorWeight + count === 0) {
    throw new CoreError('INVALID_BAYES_INPUT', 'count and priorWeight must be >= 0 and not both 0');
  }
  return (priorMean * priorWeight + sum) / (priorWeight + count);
}

export interface RatingRecord {
  readonly id: string;
  readonly raterId: string;
  readonly overall: number;
  readonly transactionValueIdr: number;
}

export interface RatingAbuseSignals {
  /** Raters flagged by risk (fraud rings, rating farms). */
  readonly flaggedRaterIds?: readonly string[];
  /** Raters linked to the ratee (shared device/payment/identity) — excluded. */
  readonly linkedRaterIds?: readonly string[];
}

export interface AggregateOptions {
  readonly priorMean?: number;
  readonly priorWeight?: number;
  readonly flaggedWeight?: number;
  readonly lowValueThresholdIdr?: number;
  readonly lowValueOutlierWeight?: number;
  /** |rating − median| ≥ this counts as an outlier. */
  readonly outlierDistance?: number;
}

export interface RatingAggregate {
  readonly count: number;
  readonly rawAverage: number | null;
  readonly weightedAverage: number | null;
  /** Σ weights */
  readonly effectiveCount: number;
  /** Bayesian average over weighted ratings (what ranking/trust use). */
  readonly bayesianScore: number;
  readonly adjustments: readonly { readonly ratingId: string; readonly weight: number; readonly reason: string }[];
}

function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/**
 * Weighted aggregation resistant to abuse:
 * - linked accounts → weight 0 (collusion)
 * - flagged raters → `flaggedWeight` (default 0.25)
 * - outliers (|r − median| ≥ 2) on very-low-value transactions (< Rp250.000) → `lowValueOutlierWeight` (0.25)
 */
export function aggregateRatings(
  ratings: readonly RatingRecord[],
  abuseSignals: RatingAbuseSignals = {},
  options: AggregateOptions = {},
): RatingAggregate {
  const priorMean = options.priorMean ?? 4;
  const priorWeight = options.priorWeight ?? 5;
  const flaggedWeight = options.flaggedWeight ?? 0.25;
  const lowValueThreshold = options.lowValueThresholdIdr ?? 250_000;
  const outlierWeight = options.lowValueOutlierWeight ?? 0.25;
  const outlierDistance = options.outlierDistance ?? 2;
  const flagged = new Set(abuseSignals.flaggedRaterIds ?? []);
  const linked = new Set(abuseSignals.linkedRaterIds ?? []);

  for (const r of ratings) {
    if (!Number.isInteger(r.overall) || r.overall < 1 || r.overall > 5) {
      throw new CoreError('INVALID_RATING', `Rating ${r.id} overall must be 1–5`);
    }
  }
  const med = ratings.length > 0 ? median(ratings.map((r) => r.overall)) : priorMean;
  const adjustments: { ratingId: string; weight: number; reason: string }[] = [];
  let wSum = 0;
  let wTotal = 0;
  let rawSum = 0;
  for (const r of ratings) {
    rawSum += r.overall;
    let weight = 1;
    let reason = '';
    if (linked.has(r.raterId)) {
      weight = 0;
      reason = 'LINKED_ACCOUNT';
    } else if (flagged.has(r.raterId)) {
      weight = flaggedWeight;
      reason = 'FLAGGED_RATER';
    } else if (r.transactionValueIdr < lowValueThreshold && Math.abs(r.overall - med) >= outlierDistance) {
      weight = outlierWeight;
      reason = 'LOW_VALUE_OUTLIER';
    }
    if (weight !== 1) adjustments.push({ ratingId: r.id, weight, reason });
    wSum += weight * r.overall;
    wTotal += weight;
  }
  return {
    count: ratings.length,
    rawAverage: ratings.length > 0 ? rawSum / ratings.length : null,
    weightedAverage: wTotal > 0 ? wSum / wTotal : null,
    effectiveCount: wTotal,
    bayesianScore: bayesianAverage(wSum, wTotal, priorMean, priorWeight),
    adjustments,
  };
}
