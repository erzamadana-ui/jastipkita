import type { Db, TxSql } from '../../db/sql';

export interface ReferralRow {
  id: string;
  referrer_id: string;
  referee_id: string;
  program: 'BUYER' | 'TRAVELER';
  variant: string | null;
  status: string;
  qualifying_transaction_id: string | null;
  referrer_reward_idr: number;
  referee_reward_idr: number;
  fraud_reasons: unknown[];
  qualified_at: Date | null;
  rewarded_at: Date | null;
  expires_at: Date | null;
  created_at: Date;
}

export async function userByReferralCode(db: Db, code: string) {
  const [u] = await db<{ id: string; status: string }[]>`SELECT id, status FROM users WHERE referral_code = ${code}`;
  return u ?? null;
}

export async function userBasics(db: Db, userId: string) {
  const [u] = await db<{ id: string; referral_code: string; created_at: Date; active_mode: string; status: string; display_name: string | null }[]>`
    SELECT id, referral_code, created_at, active_mode, status, display_name FROM users WHERE id = ${userId}`;
  return u ?? null;
}

export async function referralOfReferee(db: Db, refereeId: string): Promise<ReferralRow | null> {
  const [r] = await db<ReferralRow[]>`SELECT * FROM referrals WHERE referee_id = ${refereeId}`;
  return r ?? null;
}

export async function hasSecuredPayment(db: Db, userId: string): Promise<boolean> {
  const r = await db`
    SELECT 1 FROM transaction_events te JOIN transactions t ON t.id = te.transaction_id
     WHERE t.buyer_id = ${userId} AND te.to_status = 'PAYMENT_SECURED' LIMIT 1`;
  return r.length > 0;
}

export async function referralsSince(db: Db, referrerId: string, since: Date): Promise<number> {
  const [r] = await db<{ n: number }[]>`SELECT count(*)::int AS n FROM referrals WHERE referrer_id = ${referrerId} AND created_at > ${since}`;
  return r?.n ?? 0;
}

export async function insertReferral(
  tx: TxSql,
  r: { referrerId: string; refereeId: string; program: string; variant: string | null; configVersion: number; fraudReasons: unknown[]; expiresAt: Date; now: Date },
): Promise<ReferralRow> {
  const [row] = await tx<ReferralRow[]>`
    INSERT INTO referrals (referrer_id, referee_id, program, variant, config_version, fraud_reasons, expires_at, created_at)
    VALUES (${r.referrerId}, ${r.refereeId}, ${r.program}, ${r.variant}, ${r.configVersion}, ${tx.json(r.fraudReasons as never)}, ${r.expiresAt}, ${r.now})
    RETURNING *`;
  return row!;
}

export async function pendingReferralForUpdate(tx: TxSql, refereeId: string, program: 'BUYER' | 'TRAVELER'): Promise<ReferralRow | null> {
  const [r] = await tx<ReferralRow[]>`
    SELECT * FROM referrals WHERE referee_id = ${refereeId} AND program = ${program} AND status = 'PENDING' FOR UPDATE`;
  return r ?? null;
}

/** Referrer credit already granted this calendar month (WIB) for the program — monthly cap input. */
export async function monthRewarded(tx: Db, referrerId: string, program: string, now: Date): Promise<number> {
  const [r] = await tx<{ s: number | null }[]>`
    SELECT coalesce(sum(referrer_reward_idr), 0)::bigint AS s FROM referrals
     WHERE referrer_id = ${referrerId} AND program = ${program} AND status = 'REWARDED'
       AND date_trunc('month', rewarded_at AT TIME ZONE 'Asia/Jakarta') = date_trunc('month', ${now}::timestamptz AT TIME ZONE 'Asia/Jakarta')`;
  return Number(r?.s ?? 0);
}

export async function firstCompletedAsBuyer(tx: Db, buyerId: string): Promise<string | null> {
  const [r] = await tx<{ id: string }[]>`
    SELECT id FROM transactions WHERE buyer_id = ${buyerId} AND status = 'COMPLETED' ORDER BY completed_at, id LIMIT 1`;
  return r?.id ?? null;
}

export async function completedAsTraveler(tx: Db, travelerId: string): Promise<number> {
  const [r] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM transactions WHERE traveler_id = ${travelerId} AND status = 'COMPLETED'`;
  return r?.n ?? 0;
}

/** Transaction value before credits/discounts (Σ positive price lines), fallback total_idr. */
export async function valueBeforeCredits(tx: Db, txId: string): Promise<number> {
  const [r] = await tx<{ v: number | null; total: number | null }[]>`
    SELECT (SELECT sum(ql.amount_idr) FROM quote_lines ql WHERE ql.quote_id = t.active_quote_id AND ql.line_type <> 'TOTAL' AND ql.amount_idr > 0)::bigint AS v,
           t.total_idr AS total
      FROM transactions t WHERE t.id = ${txId}`;
  return Number(r?.v ?? r?.total ?? 0);
}

export async function updateOutcome(
  tx: TxSql,
  id: string,
  o: { status: string; qualifyingTransactionId: string | null; referrerRewardIdr: number; refereeRewardIdr: number; reasons: unknown[]; now: Date; rewarded: boolean; qualified: boolean },
) {
  await tx`
    UPDATE referrals
       SET status = ${o.status},
           qualifying_transaction_id = coalesce(${o.qualifyingTransactionId}::uuid, qualifying_transaction_id),
           referrer_reward_idr = ${o.referrerRewardIdr},
           referee_reward_idr = ${o.refereeRewardIdr},
           fraud_reasons = ${tx.json(o.reasons as never)},
           qualified_at = CASE WHEN ${o.qualified} THEN coalesce(qualified_at, ${o.now}) ELSE qualified_at END,
           rewarded_at = CASE WHEN ${o.rewarded} THEN ${o.now}::timestamptz ELSE rewarded_at END
     WHERE id = ${id}`;
}

export function referralsOfReferrer(db: Db, referrerId: string) {
  return db<(ReferralRow & { referee_name: string | null })[]>`
    SELECT r.*, u.display_name AS referee_name FROM referrals r JOIN users u ON u.id = r.referee_id
     WHERE r.referrer_id = ${referrerId} ORDER BY r.created_at DESC LIMIT 50`;
}

export async function referrerStats(db: Db, referrerId: string, now: Date) {
  const [r] = await db<{ invited: number; pending: number; qualified: number; rewarded: number; rejected: number; expired: number; total: number | null; month: number | null }[]>`
    SELECT count(*)::int AS invited,
           count(*) FILTER (WHERE status = 'PENDING')::int AS pending,
           count(*) FILTER (WHERE status = 'QUALIFIED')::int AS qualified,
           count(*) FILTER (WHERE status = 'REWARDED')::int AS rewarded,
           count(*) FILTER (WHERE status = 'REJECTED')::int AS rejected,
           count(*) FILTER (WHERE status = 'EXPIRED')::int AS expired,
           coalesce(sum(referrer_reward_idr) FILTER (WHERE status = 'REWARDED'), 0)::bigint AS total,
           coalesce(sum(referrer_reward_idr) FILTER (WHERE status = 'REWARDED'
             AND date_trunc('month', rewarded_at AT TIME ZONE 'Asia/Jakarta') = date_trunc('month', ${now}::timestamptz AT TIME ZONE 'Asia/Jakarta')), 0)::bigint AS month
      FROM referrals WHERE referrer_id = ${referrerId}`;
  return r!;
}

export async function expirePending(db: Db, now: Date): Promise<number> {
  const r = await db`UPDATE referrals SET status = 'EXPIRED' WHERE status = 'PENDING' AND expires_at IS NOT NULL AND expires_at <= ${now}`;
  return r.count;
}
