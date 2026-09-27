import type { Db, TxSql } from '../../db/sql';
import type { CreditEntry } from './ledger';

export interface CreditRow {
  id: number;
  amount_idr: number;
  reason: string;
  reference_type: string | null;
  reference_id: string | null;
  expires_at: Date | null;
  idempotency_key: string | null;
  created_at: Date;
}

export async function entriesOf(db: Db, userId: string): Promise<CreditEntry[]> {
  const rows = await db<CreditRow[]>`
    SELECT id, amount_idr, reason, reference_type, reference_id, expires_at, idempotency_key, created_at FROM credit_entries WHERE user_id = ${userId} ORDER BY id`;
  return rows.map((r) => ({ id: Number(r.id), amountIdr: Number(r.amount_idr), reason: r.reason, expiresAt: r.expires_at, createdAt: r.created_at, idempotencyKey: r.idempotency_key }));
}

export function history(db: Db, userId: string, opts: { beforeId: number | null; limit: number }) {
  return db<CreditRow[]>`
    SELECT id, amount_idr, reason, reference_type, reference_id, expires_at, idempotency_key, created_at FROM credit_entries
     WHERE user_id = ${userId} ${opts.beforeId ? db`AND id < ${opts.beforeId}` : db``}
     ORDER BY id DESC LIMIT ${opts.limit}`;
}

export async function balance(db: Db, userId: string): Promise<number> {
  const [r] = await db<{ b: number | null }[]>`SELECT coalesce(sum(amount_idr), 0)::bigint AS b FROM credit_entries WHERE user_id = ${userId}`;
  return Number(r?.b ?? 0);
}

/** Serializes credit writes for a user (same key as the jk_credit_non_negative trigger). */
export async function lockUserCredit(tx: TxSql, userId: string) {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'credit:' + userId}, 0))`;
}

export interface GrantInput {
  userId: string;
  amountIdr: number;
  reason: 'REFERRAL_REWARD' | 'PROMO_CASHBACK' | 'REDEEM_REVERSAL';
  referenceType: string;
  referenceId: string;
  expiresAt: Date | null;
  idempotencyKey: string;
  note?: string | null;
  now: Date;
}

/** Idempotent credit grant (unique idempotency_key). Returns the entry id, or null if it already existed. */
export async function grant(tx: Db, g: GrantInput): Promise<number | null> {
  const [r] = await tx<{ id: number }[]>`
    INSERT INTO credit_entries (user_id, amount_idr, reason, reference_type, reference_id, expires_at, idempotency_key, note, created_at)
    VALUES (${g.userId}, ${g.amountIdr}, ${g.reason}, ${g.referenceType}, ${g.referenceId}, ${g.expiresAt}, ${g.idempotencyKey}, ${g.note ?? null}, ${g.now})
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING id`;
  return r ? Number(r.id) : null;
}

export async function insertExpiry(tx: TxSql, userId: string, lotId: number, amountIdr: number, key: string, now: Date) {
  const [r] = await tx<{ id: number }[]>`
    INSERT INTO credit_entries (user_id, amount_idr, reason, reference_type, expires_at, idempotency_key, note, created_at)
    VALUES (${userId}, ${-amountIdr}, 'EXPIRY', 'credit_lot', NULL, ${key}, ${`lot #${lotId} expired`}, ${now})
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING id`;
  return r ? Number(r.id) : null;
}

/** Users holding at least one expired lot without its EXPIRY entry. */
export async function usersWithDueLots(db: Db, now: Date, limit: number): Promise<string[]> {
  const rows = await db<{ user_id: string }[]>`
    SELECT DISTINCT ce.user_id FROM credit_entries ce
     WHERE ce.amount_idr > 0 AND ce.expires_at IS NOT NULL AND ce.expires_at <= ${now}
       AND NOT EXISTS (SELECT 1 FROM credit_entries x WHERE x.idempotency_key = 'credit-expiry:' || ce.id)
       -- a zero balance cannot hold an unexpired remainder (fully used lots never get an EXPIRY row)
       AND (SELECT sum(b.amount_idr) FROM credit_entries b WHERE b.user_id = ce.user_id) > 0
     LIMIT ${limit}`;
  return rows.map((r) => r.user_id);
}
