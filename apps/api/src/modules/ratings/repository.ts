import type { Db, TxSql } from '../../db/sql';

export interface RatingRow {
  id: string;
  transaction_id: string;
  rater_id: string;
  ratee_id: string;
  direction: 'BUYER_TO_TRAVELER' | 'TRAVELER_TO_BUYER';
  overall: number;
  communication: number | null;
  accuracy: number | null;
  timeliness: number | null;
  comment: string | null;
  status: string;
  weight: string;
  moderation_reason: string | null;
  created_at: Date;
}

export async function transactionForRating(db: Db, txId: string) {
  const [t] = await db<{ id: string; buyer_id: string; traveler_id: string | null; status: string; completed_at: Date | null; total_idr: number | null }[]>`
    SELECT id, buyer_id, traveler_id, status, completed_at, total_idr FROM transactions WHERE id = ${txId}`;
  return t ?? null;
}

export async function hasRated(db: Db, txId: string, raterId: string): Promise<boolean> {
  const r = await db`SELECT 1 FROM ratings WHERE transaction_id = ${txId} AND rater_id = ${raterId}`;
  return r.length > 0;
}

export async function insertRating(
  tx: TxSql,
  r: Omit<RatingRow, 'id' | 'created_at' | 'status' | 'weight'> & { weight: number; now: Date },
): Promise<RatingRow> {
  const [row] = await tx<RatingRow[]>`
    INSERT INTO ratings (transaction_id, rater_id, ratee_id, direction, overall, communication, accuracy, timeliness, comment, weight, moderation_reason, created_at)
    VALUES (${r.transaction_id}, ${r.rater_id}, ${r.ratee_id}, ${r.direction}, ${r.overall}, ${r.communication}, ${r.accuracy}, ${r.timeliness},
            ${r.comment}, ${r.weight}, ${r.moderation_reason}, ${r.now})
    RETURNING *`;
  return row!;
}

export function ratingsOfRatee(tx: Db, rateeId: string, direction: string) {
  return tx<{ id: string; rater_id: string; overall: number; weight: string; moderation_reason: string | null; total_idr: number | null }[]>`
    SELECT r.id, r.rater_id, r.overall, r.weight, r.moderation_reason, t.total_idr
      FROM ratings r JOIN transactions t ON t.id = r.transaction_id
     WHERE r.ratee_id = ${rateeId} AND r.direction = ${direction} AND r.status = 'PUBLISHED'
     ORDER BY r.created_at`;
}

/** Raters confirmed as fraud by RISK (subject USER). */
export async function flaggedRaters(db: Db, raterIds: string[]): Promise<string[]> {
  if (raterIds.length === 0) return [];
  const rows = await db<{ subject_id: string }[]>`
    SELECT DISTINCT subject_id FROM risk_reviews
     WHERE subject_type = 'USER' AND status = 'CONFIRMED_FRAUD' AND subject_id = ANY(${db.array(raterIds)}::uuid[])`;
  return rows.map((r) => r.subject_id);
}

export async function setWeight(tx: TxSql, ratingId: string, weight: number) {
  await tx`UPDATE ratings SET weight = ${weight} WHERE id = ${ratingId} AND weight <> ${weight}`;
}

export async function setBayesian(tx: TxSql, userId: string, side: 'TRAVELER' | 'BUYER', bayesian: number, effective: number) {
  await tx`SELECT jk_refresh_rating_summary(${userId})`;
  if (side === 'TRAVELER') {
    await tx`UPDATE user_rating_summaries SET as_traveler_bayesian = ${bayesian.toFixed(2)}, as_traveler_effective = ${effective.toFixed(2)} WHERE user_id = ${userId}`;
  } else {
    await tx`UPDATE user_rating_summaries SET as_buyer_bayesian = ${bayesian.toFixed(2)}, as_buyer_effective = ${effective.toFixed(2)} WHERE user_id = ${userId}`;
  }
}

export async function summary(db: Db, userId: string) {
  const [s] = await db<
    {
      as_traveler_count: number;
      as_traveler_avg: string | null;
      as_traveler_weighted: string | null;
      as_traveler_bayesian: string | null;
      as_traveler_effective: string | null;
      as_buyer_count: number;
      as_buyer_avg: string | null;
      as_buyer_weighted: string | null;
      as_buyer_bayesian: string | null;
      as_buyer_effective: string | null;
      updated_at: Date;
    }[]
  >`SELECT * FROM user_rating_summaries WHERE user_id = ${userId}`;
  return s ?? null;
}

export async function activeUser(db: Db, userId: string): Promise<boolean> {
  const r = await db`SELECT 1 FROM users WHERE id = ${userId} AND status <> 'DELETED'`;
  return r.length > 0;
}
