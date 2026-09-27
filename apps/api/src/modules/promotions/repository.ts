import type { Db } from '../../db/sql';
import type { PromotionRow } from './mapper';

const COLS = (db: Db) => db`id, code, name, description, type, conditions, benefit, budget_total_idr, budget_used_idr, usage_limit_total, usage_count, usage_limit_per_user, starts_at, ends_at, status`;

export function activePromotions(db: Db, now: Date) {
  return db<PromotionRow[]>`
    SELECT ${COLS(db)} FROM promotions
     WHERE status = 'ACTIVE' AND starts_at <= ${now} AND (ends_at IS NULL OR ends_at > ${now})
     ORDER BY ends_at NULLS LAST, starts_at DESC, id`;
}

export async function transactionContext(db: Db, txId: string) {
  const [t] = await db<{ id: string; status: string; buyer_id: string; traveler_id: string | null; active_quote_id: string | null; origin_country: string | null; merchant_country: string | null; category_code: string | null }[]>`
    SELECT t.id, t.status, t.buyer_id, t.traveler_id, t.active_quote_id, tr.origin_country, r.merchant_country, r.category_code
      FROM transactions t JOIN requests r ON r.id = t.request_id LEFT JOIN trips tr ON tr.id = t.trip_id WHERE t.id = ${txId}`;
  return t ?? null;
}

/** Lines of the quote in effect: the transaction's active quote, else its ACTIVE quote. */
export async function quoteLines(db: Db, txId: string, activeQuoteId: string | null) {
  return db<{ line_type: string; amount_idr: number; meta: Record<string, unknown> }[]>`
    SELECT ql.line_type, ql.amount_idr, ql.meta FROM quote_lines ql
     WHERE ql.quote_id = (SELECT q.id FROM quotes q WHERE q.transaction_id = ${txId}
                           ORDER BY (q.id = ${activeQuoteId}::uuid) DESC NULLS LAST, (q.status = 'ACTIVE') DESC, q.created_at DESC LIMIT 1)`;
}

export async function hadEarlierPayment(db: Db, buyerId: string, excludeTxId: string): Promise<boolean> {
  const r = await db`
    SELECT 1 FROM transaction_events te JOIN transactions t ON t.id = te.transaction_id
     WHERE t.buyer_id = ${buyerId} AND t.id <> ${excludeTxId} AND te.to_status = 'PAYMENT_SECURED' LIMIT 1`;
  return r.length > 0;
}

export async function usageByPromo(db: Db, userId: string, excludeTxId: string): Promise<Record<string, number>> {
  const rows = await db<{ promotion_id: string; n: number }[]>`
    SELECT promotion_id, count(*)::int AS n FROM promotion_redemptions
     WHERE user_id = ${userId} AND status IN ('RESERVED','APPLIED') AND transaction_id <> ${excludeTxId} GROUP BY promotion_id`;
  return Object.fromEntries(rows.map((r) => [r.promotion_id, r.n]));
}

export function cashbackRedemptions(db: Db, txId: string) {
  return db<{ id: string; user_id: string; amount_idr: number; promotion_id: string; name: string; conditions: Record<string, unknown> }[]>`
    SELECT pr.id, pr.user_id, pr.amount_idr, pr.promotion_id, p.name, p.conditions
      FROM promotion_redemptions pr JOIN promotions p ON p.id = pr.promotion_id
     WHERE pr.transaction_id = ${txId} AND pr.status IN ('RESERVED','APPLIED')
       AND (p.type = 'CASHBACK' OR p.benefit->>'kind' = 'CASHBACK_CREDIT')`;
}
