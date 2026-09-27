/**
 * SafePay double-entry ledger (docs/04-payments-ledger.md). Journals are posted ONLY through the DB
 * function `post_journal` (idempotent on its key) and corrected ONLY with `reverse_journal`
 * (compensating entries). Ledger rows are never UPDATEd.
 *
 * Sign conventions (ledger_accounts.normal_side): PROVIDER_CASH, PAYMENT_FEE, PROMOTION_CREDIT and
 * CLEARING are debit-normal; every other bucket is credit-normal. The per-transaction escrow view
 * `v_transaction_ledger.net_credit` is credit-positive for every bucket.
 */
import type { Db } from '../../db/sql';
import { AppError } from '../../lib/errors';

export type LedgerBucket =
  | 'PRODUCT_FUND'
  | 'TRAVELER_EARNING'
  | 'CUSTOMS_RESERVE'
  | 'PLATFORM_REVENUE'
  | 'TAX_PAYABLE'
  | 'PAYMENT_FEE'
  | 'REFUND'
  | 'PROMOTION_CREDIT'
  | 'CLEARING'
  | 'PROVIDER_CASH';

export interface LedgerEntry {
  bucket: LedgerBucket;
  /** Owner for user-scoped accounts (TRAVELER_EARNING → traveler, REFUND → buyer). */
  owner?: string | null;
  direction: 'DEBIT' | 'CREDIT';
  amount: number;
  memo?: string;
}

export type JournalKind =
  | 'PAYMENT_CAPTURED'
  | 'SUPPLEMENTAL_CAPTURED'
  | 'LATE_PAYMENT_CAPTURED'
  | 'COMPLETION_RELEASE'
  | 'CANCELLATION_SETTLEMENT'
  | 'DISPUTE_REFUND_ALLOCATION'
  | 'REMAINDER_RELEASE'
  | 'REFUND_PAID'
  | 'PAYOUT_PAID';

export interface PostJournalInput {
  kind: JournalKind;
  description: string;
  transactionId: string | null;
  idempotencyKey: string;
  refs?: { paymentId?: string; refundId?: string; payoutId?: string };
  meta?: Record<string, unknown>;
  actorId?: string | null;
  entries: LedgerEntry[];
}

/** Posts a balanced journal; zero lines are dropped. Returns the journal id (existing one on replay), or null if nothing to post. */
export async function postJournal(db: Db, input: PostJournalInput): Promise<string | null> {
  const entries = input.entries.filter((e) => e.amount !== 0);
  for (const e of entries) {
    if (!Number.isSafeInteger(e.amount) || e.amount < 0) {
      throw new AppError(500, 'LEDGER_INVALID_AMOUNT', `Ledger amount must be a non-negative integer (${e.bucket} ${e.amount})`);
    }
  }
  if (entries.length === 0) return null;
  const debit = entries.filter((e) => e.direction === 'DEBIT').reduce((s, e) => s + e.amount, 0);
  const credit = entries.filter((e) => e.direction === 'CREDIT').reduce((s, e) => s + e.amount, 0);
  if (debit !== credit) {
    throw new AppError(500, 'LEDGER_UNBALANCED', `Journal ${input.kind} unbalanced: debit ${debit} ≠ credit ${credit}`, {
      kind: input.kind,
      debit,
      credit,
    });
  }
  const payload = entries.map((e) => ({
    bucket: e.bucket,
    ownerUserId: e.owner ?? null,
    direction: e.direction,
    amount: e.amount,
    currency: 'IDR',
    ...(e.memo ? { memo: e.memo } : {}),
  }));
  const refs = { ...(input.refs ?? {}), meta: input.meta ?? {} };
  const [row] = await db<{ id: string }[]>`
    SELECT post_journal(${input.kind}, ${input.description}, ${db.json(payload as never)}::jsonb, ${input.transactionId},
                        ${input.idempotencyKey}, ${db.json(refs as never)}::jsonb, ${input.actorId ?? null}) AS id`;
  return row!.id;
}

export async function reverseJournalByKey(db: Db, idempotencyKey: string, reason: string, actorId: string | null = null): Promise<string | null> {
  const [j] = await db<{ id: string }[]>`SELECT id FROM ledger_journals WHERE idempotency_key = ${idempotencyKey}`;
  if (!j) return null;
  const [existing] = await db<{ id: string }[]>`SELECT id FROM ledger_journals WHERE reverses_journal_id = ${j.id}`;
  if (existing) return existing.id;
  const [row] = await db<{ id: string }[]>`SELECT reverse_journal(${j.id}, ${reason}, ${actorId}) AS id`;
  return row!.id;
}

/** Escrow per bucket for one transaction (credit-positive; PROMOTION_CREDIT is negative when promo funded). */
export async function transactionBuckets(db: Db, transactionId: string): Promise<Record<LedgerBucket, number>> {
  const rows = await db<{ bucket: LedgerBucket; net_credit: number }[]>`
    SELECT bucket, net_credit FROM v_transaction_ledger WHERE transaction_id = ${transactionId} AND currency = 'IDR'`;
  const out = {
    PRODUCT_FUND: 0,
    TRAVELER_EARNING: 0,
    CUSTOMS_RESERVE: 0,
    PLATFORM_REVENUE: 0,
    TAX_PAYABLE: 0,
    PAYMENT_FEE: 0,
    REFUND: 0,
    PROMOTION_CREDIT: 0,
    CLEARING: 0,
    PROVIDER_CASH: 0,
  } as Record<LedgerBucket, number>;
  for (const r of rows) out[r.bucket] = Number(r.net_credit);
  return out;
}

/** Normal-side balance per account (ledger_balances view), keyed by bucket[:owner]. */
export async function accountBalances(db: Db): Promise<Map<string, number>> {
  const rows = await db<{ bucket: string; owner_user_id: string | null; balance: number }[]>`
    SELECT bucket, owner_user_id, balance FROM ledger_balances WHERE currency = 'IDR'`;
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.owner_user_id ? `${r.bucket}:${r.owner_user_id}` : r.bucket, Number(r.balance));
  return m;
}

// ------------------------------------------------------------------ journal builders (pure)

export interface QuoteAmounts {
  ITEM_PRICE: number;
  TRAVELER_FEE: number;
  CUSTOMS_DUTY: number;
  IMPORT_TAX: number;
  PROTECTION_FEE: number;
  PLATFORM_FEE: number;
  SERVICE_TAX: number;
  PAYMENT_FEE: number;
  DISCOUNT: number; // ≤ 0
  REFERRAL_CREDIT: number; // ≤ 0
  TOTAL: number;
}

/**
 * PAYMENT_CAPTURED:
 *   Dr PROVIDER_CASH (cash paid) + Dr PROMOTION_CREDIT (discount + credit)
 *   Cr PRODUCT_FUND (item) · Cr CUSTOMS_RESERVE (duty + import tax)
 *   Cr CLEARING (traveler fee + protection + platform + service tax + payment fee)
 */
export function captureEntries(q: QuoteAmounts, paidIdr: number): LedgerEntry[] {
  const promo = -(q.DISCOUNT + q.REFERRAL_CREDIT);
  return [
    { bucket: 'PROVIDER_CASH', direction: 'DEBIT', amount: paidIdr, memo: 'cash received at provider' },
    { bucket: 'PROMOTION_CREDIT', direction: 'DEBIT', amount: promo, memo: 'discount + JastipKita Credit (platform-funded)' },
    { bucket: 'PRODUCT_FUND', direction: 'CREDIT', amount: q.ITEM_PRICE, memo: 'item price held' },
    { bucket: 'CUSTOMS_RESERVE', direction: 'CREDIT', amount: q.CUSTOMS_DUTY + q.IMPORT_TAX, memo: 'estimated duty + import tax held' },
    {
      bucket: 'CLEARING',
      direction: 'CREDIT',
      amount: q.TRAVELER_FEE + q.PROTECTION_FEE + q.PLATFORM_FEE + q.SERVICE_TAX + q.PAYMENT_FEE,
      memo: 'fees held until completion',
    },
  ];
}

export interface ReleaseInput {
  buyerId: string;
  travelerId: string;
  held: { productFund: number; customsReserve: number; clearing: number };
  /** Approved actual item price reimbursed to the traveler (IDR). */
  reimbursementIdr: number;
  /** Duty/tax actually paid by the traveler per customs declaration (IDR, uncapped). */
  customsPaidIdr: number;
  fees: { travelerFee: number; platformAndProtection: number; serviceTax: number; paymentFee: number };
}

export interface ReleasePlan {
  entries: LedgerEntry[];
  travelerEarningIdr: number;
  buyerRefundIdr: number;
  platformSubsidyIdr: number;
  customsReimbursedIdr: number;
}

/**
 * COMPLETION_RELEASE:
 *   Dr PRODUCT_FUND → Cr TRAVELER_EARNING(traveler) reimbursement, remainder Cr REFUND(buyer)
 *     (a within-tolerance increase above the held item fund is platform-funded: Dr PROMOTION_CREDIT)
 *   Dr CUSTOMS_RESERVE → Cr TRAVELER_EARNING (declared duty/tax, capped at reserve), remainder Cr REFUND(buyer)
 *   Dr CLEARING → Cr TRAVELER_EARNING (traveler fee), Cr PLATFORM_REVENUE (platform + protection),
 *                 Cr TAX_PAYABLE (service tax), Cr PAYMENT_FEE (payment fee charged to buyer)
 */
export function releasePlan(r: ReleaseInput): ReleasePlan {
  const reimb = Math.max(0, r.reimbursementIdr);
  const fromProductFund = Math.min(reimb, r.held.productFund);
  const subsidy = reimb - fromProductFund;
  const productRefund = r.held.productFund - fromProductFund;
  const customsToTraveler = Math.min(Math.max(0, r.customsPaidIdr), r.held.customsReserve);
  const customsRefund = r.held.customsReserve - customsToTraveler;
  const feeSum = r.fees.travelerFee + r.fees.platformAndProtection + r.fees.serviceTax + r.fees.paymentFee;
  if (feeSum !== r.held.clearing) {
    throw new AppError(500, 'LEDGER_CLEARING_MISMATCH', `Clearing held ${r.held.clearing} ≠ quote fees ${feeSum}`, {
      held: r.held.clearing,
      fees: feeSum,
    });
  }
  const travelerEarning = reimb + customsToTraveler + r.fees.travelerFee;
  const buyerRefund = productRefund + customsRefund;
  return {
    travelerEarningIdr: travelerEarning,
    buyerRefundIdr: buyerRefund,
    platformSubsidyIdr: subsidy,
    customsReimbursedIdr: customsToTraveler,
    entries: [
      { bucket: 'PRODUCT_FUND', direction: 'DEBIT', amount: r.held.productFund, memo: 'release item fund' },
      { bucket: 'PROMOTION_CREDIT', direction: 'DEBIT', amount: subsidy, memo: 'within-tolerance price increase absorbed by platform' },
      { bucket: 'CUSTOMS_RESERVE', direction: 'DEBIT', amount: r.held.customsReserve, memo: 'release customs reserve' },
      { bucket: 'CLEARING', direction: 'DEBIT', amount: r.held.clearing, memo: 'release fees' },
      { bucket: 'TRAVELER_EARNING', owner: r.travelerId, direction: 'CREDIT', amount: travelerEarning, memo: 'item reimbursement + customs paid + traveler fee' },
      { bucket: 'PLATFORM_REVENUE', direction: 'CREDIT', amount: r.fees.platformAndProtection, memo: 'platform + protection fee' },
      { bucket: 'TAX_PAYABLE', direction: 'CREDIT', amount: r.fees.serviceTax, memo: 'PPN on platform services' },
      { bucket: 'PAYMENT_FEE', direction: 'CREDIT', amount: r.fees.paymentFee, memo: 'payment fee charged to buyer' },
      { bucket: 'REFUND', owner: r.buyerId, direction: 'CREDIT', amount: buyerRefund, memo: 'item/customs difference back to buyer' },
    ],
  };
}

export interface SettlementInput {
  buyerId: string;
  travelerId: string | null;
  held: { productFund: number; customsReserve: number; clearing: number };
  refundIdr: number;
  travelerCompensationIdr: number;
  platformRetainedIdr: number;
  serviceTaxRetainedIdr: number;
  paymentFeeRetainedIdr: number;
  customsRetainedIdr: number;
  promoReturnedIdr: number;
}

/**
 * CANCELLATION_SETTLEMENT (cancellation matrix result): drains PRODUCT_FUND, CUSTOMS_RESERVE and CLEARING
 * for the transaction and credits REFUND(buyer), TRAVELER_EARNING(traveler) compensation, PLATFORM_REVENUE,
 * TAX_PAYABLE, PAYMENT_FEE; unused discount / restored credit go back to PROMOTION_CREDIT.
 */
export function settlementEntries(s: SettlementInput): LedgerEntry[] {
  const toTraveler = s.travelerCompensationIdr + s.customsRetainedIdr;
  if (toTraveler > 0 && !s.travelerId) throw new AppError(500, 'LEDGER_NO_TRAVELER', 'Settlement credits a traveler but none is set');
  return [
    { bucket: 'PRODUCT_FUND', direction: 'DEBIT', amount: s.held.productFund, memo: 'cancel: release item fund' },
    { bucket: 'CUSTOMS_RESERVE', direction: 'DEBIT', amount: s.held.customsReserve, memo: 'cancel: release customs reserve' },
    { bucket: 'CLEARING', direction: 'DEBIT', amount: s.held.clearing, memo: 'cancel: release fees' },
    { bucket: 'REFUND', owner: s.buyerId, direction: 'CREDIT', amount: s.refundIdr, memo: 'cash refund due to buyer' },
    ...(toTraveler > 0
      ? [{ bucket: 'TRAVELER_EARNING' as const, owner: s.travelerId, direction: 'CREDIT' as const, amount: toTraveler, memo: 'traveler compensation / customs paid' }]
      : []),
    { bucket: 'PLATFORM_REVENUE', direction: 'CREDIT', amount: s.platformRetainedIdr, memo: 'retained per cancellation matrix' },
    { bucket: 'TAX_PAYABLE', direction: 'CREDIT', amount: s.serviceTaxRetainedIdr, memo: 'service tax on retained fees' },
    { bucket: 'PAYMENT_FEE', direction: 'CREDIT', amount: s.paymentFeeRetainedIdr, memo: 'payment fee retained' },
    { bucket: 'PROMOTION_CREDIT', direction: 'CREDIT', amount: s.promoReturnedIdr, memo: 'unused discount / restored credit' },
  ];
}
