import { aggregateRatings, validateRating, type TransactionStatus } from '@jastipkita/core';
import type { AppDeps, AuthContext } from '../../context';
import type { TxSql } from '../../db/sql';
import { AppError, Errors } from '../../lib/errors';
import { emitEvent } from '../../services/outbox';
import { isLinked, linkSignals } from '../trust/links';
import * as repo from './repository';
import { filterComment } from './text-filter';

/** Rating window after COMPLETED (core default 14 days). */
export const RATING_WINDOW_DAYS = 14;

export interface RatingInput {
  overall: number;
  communication?: number | undefined;
  accuracy?: number | undefined;
  timeliness?: number | undefined;
  comment?: string | undefined;
}

const ERROR_STATUS: Record<string, 409 | 422 | 403> = { ALREADY_RATED: 409, NOT_A_PARTY: 403, SELF_RATING: 422 };

function dto(r: repo.RatingRow) {
  return {
    id: r.id,
    transactionId: r.transaction_id,
    direction: r.direction,
    rateeId: r.ratee_id,
    overall: r.overall,
    communication: r.communication,
    accuracy: r.accuracy,
    timeliness: r.timeliness,
    comment: r.comment,
    status: r.status,
    createdAt: r.created_at.toISOString(),
  };
}

/**
 * Re-weights every published rating of the ratee (one direction) with core aggregateRatings
 * (linked accounts → 0, confirmed-fraud raters → 0.25, low-value outliers → 0.25) and stores the
 * Bayesian score in user_rating_summaries. The summary trigger keeps count/avg/weighted in sync.
 */
export async function refreshAggregate(tx: TxSql, rateeId: string, direction: 'BUYER_TO_TRAVELER' | 'TRAVELER_TO_BUYER') {
  const rows = await repo.ratingsOfRatee(tx, rateeId, direction);
  const flagged = await repo.flaggedRaters(tx, [...new Set(rows.map((r) => r.rater_id))]);
  const linked = rows.filter((r) => (r.moderation_reason ?? '').includes('LINKED_ACCOUNT')).map((r) => r.rater_id);
  const agg = aggregateRatings(
    rows.map((r) => ({ id: r.id, raterId: r.rater_id, overall: r.overall, transactionValueIdr: Number(r.total_idr ?? 0) })),
    { flaggedRaterIds: flagged, linkedRaterIds: linked },
  );
  const weights = new Map(agg.adjustments.map((a) => [a.ratingId, a.weight]));
  for (const r of rows) {
    const w = weights.get(r.id) ?? 1;
    if (Number(r.weight) !== w) await repo.setWeight(tx, r.id, w);
  }
  await repo.setBayesian(tx, rateeId, direction === 'BUYER_TO_TRAVELER' ? 'TRAVELER' : 'BUYER', agg.bayesianScore, agg.effectiveCount);
  return agg;
}

export async function createRating(deps: AppDeps, auth: AuthContext, transactionId: string, input: RatingInput) {
  const t = await repo.transactionForRating(deps.sql, transactionId);
  if (!t || !t.traveler_id || (t.buyer_id !== auth.userId && t.traveler_id !== auth.userId)) {
    throw Errors.notFound('Transaksi', 'TRANSACTION_NOT_FOUND');
  }
  const role = t.buyer_id === auth.userId ? 'BUYER' : 'TRAVELER';
  const scores: Record<string, number> = { OVERALL: input.overall };
  if (input.communication !== undefined) scores.COMMUNICATION = input.communication;
  if (role === 'BUYER') {
    if (input.accuracy !== undefined) scores.ACCURACY = input.accuracy;
    if (input.timeliness !== undefined) scores.TIMELINESS = input.timeliness;
  } else {
    // traveler → buyer: "accuracy" does not apply; timeliness = responsiveness at handover
    if (input.accuracy !== undefined) scores.ACCURACY = input.accuracy;
    if (input.timeliness !== undefined) scores.RESPONSIVENESS = input.timeliness;
  }
  const check = validateRating({
    transactionStatus: t.status as TransactionStatus,
    raterRole: role,
    raterId: auth.userId,
    transactionBuyerId: t.buyer_id,
    transactionTravelerId: t.traveler_id,
    scores,
    alreadyRatedBySide: await repo.hasRated(deps.sql, transactionId, auth.userId),
    completedAt: t.completed_at,
    now: deps.clock.now(),
    windowDays: RATING_WINDOW_DAYS,
    comment: input.comment ?? null,
  });
  if (!check.ok) {
    const first = check.errors[0]!;
    const code = first.code === 'UNKNOWN_DIMENSION' ? 'DIMENSION_NOT_APPLICABLE' : first.code;
    throw new AppError(ERROR_STATUS[first.code] ?? 422, code, first.message, { errors: check.errors });
  }

  const comment = filterComment(input.comment);
  const links = await linkSignals(deps.sql, auth.userId, check.rateeId);
  const linked = isLinked(links);
  const reasons = [...comment.reasons, ...(linked ? ['LINKED_ACCOUNT'] : [])];
  const direction = role === 'BUYER' ? 'BUYER_TO_TRAVELER' : 'TRAVELER_TO_BUYER';

  const row = await deps.sql
    .begin(async (tq) => {
      const tx = tq as unknown as TxSql;
      const r = await repo.insertRating(tx, {
        transaction_id: transactionId,
        rater_id: auth.userId,
        ratee_id: check.rateeId,
        direction,
        overall: input.overall,
        communication: input.communication ?? null,
        accuracy: role === 'BUYER' ? (input.accuracy ?? null) : null,
        timeliness: input.timeliness ?? null,
        comment: comment.text,
        weight: linked ? 0 : 1,
        moderation_reason: reasons.length ? reasons.join(',') : null,
        now: deps.clock.now(),
      });
      await refreshAggregate(tx, check.rateeId, direction);
      await emitEvent(tx, 'rating', r.id, 'rating.created', { ratingId: r.id, transactionId, raterId: auth.userId, rateeId: check.rateeId, direction });
      return r;
    })
    .catch((err: unknown) => {
      if ((err as { code?: string }).code === '23505') throw Errors.conflict('ALREADY_RATED', 'Sisi ini sudah memberi rating.');
      throw err;
    });
  return dto(row);
}

export async function ratingSummary(deps: AppDeps, userId: string) {
  if (!(await repo.activeUser(deps.sql, userId))) throw Errors.notFound('Pengguna', 'USER_NOT_FOUND');
  const s = await repo.summary(deps.sql, userId);
  const n = (v: string | null | undefined) => (v === null || v === undefined ? null : Number(v));
  return {
    userId,
    asTraveler: {
      count: s?.as_traveler_count ?? 0,
      average: n(s?.as_traveler_avg),
      weightedAverage: n(s?.as_traveler_weighted),
      bayesianScore: n(s?.as_traveler_bayesian),
      effectiveCount: n(s?.as_traveler_effective) ?? 0,
    },
    asBuyer: {
      count: s?.as_buyer_count ?? 0,
      average: n(s?.as_buyer_avg),
      weightedAverage: n(s?.as_buyer_weighted),
      bayesianScore: n(s?.as_buyer_bayesian),
      effectiveCount: n(s?.as_buyer_effective) ?? 0,
    },
    updatedAt: s?.updated_at.toISOString() ?? null,
  };
}
