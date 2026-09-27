/**
 * BUYER_CONFIRMED → COMPLETED (SYSTEM): final ledger release, residual buyer refund, traveler payout
 * scheduling (or ON_HOLD on risk), cashback credit, `receipt.final_available`.
 */
import { convert } from '@jastipkita/core';
import type { AppDeps } from '../../context';
import type { TxSql } from '../../db/sql';
import { audit } from '../../services/audit';
import { emitEvent } from '../../services/outbox';
import { loadQuote, type LoadedQuote } from '../checkout/repository';
import { type LedgerBucket, postJournal, releasePlan, transactionBuckets } from '../ledger/service';
import { schedulePayout, travelerPayoutAccount } from '../payouts/service';
import { allocateAcrossPayments, createRefundRows, processRefunds } from '../refunds/service';
import { assertCanTransition, loadTx, setDbActor, transitionTx, type TxRow } from './common';

/** Converts an item-currency amount to IDR at the quote's FX lock (identity for IDR items). */
export function toIdrAtLock(q: LoadedQuote, currency: string, minor: number): number {
  if (currency === 'IDR') return minor;
  if (!q.fxLock) throw new Error('quote has no FX lock for a foreign-currency item');
  return convert(minor, currency, 'IDR', q.fxLock.lockedRate);
}

export async function customsPaidIdr(db: TxSql, transactionId: string): Promise<number> {
  const [d] = await db<{ total_paid_idr: number }[]>`
    SELECT total_paid_idr FROM customs_declarations WHERE transaction_id = ${transactionId} AND status <> 'REJECTED' LIMIT 1`;
  return Number(d?.total_paid_idr ?? 0);
}

async function reimbursementIdr(db: TxSql, tx: TxRow, q: LoadedQuote): Promise<number> {
  const [proof] = await db<{ actual_price_minor: number; currency: string }[]>`
    SELECT actual_price_minor, currency FROM purchase_proofs
     WHERE transaction_id = ${tx.id} AND status IN ('ACCEPTED','FLAGGED') ORDER BY created_at DESC LIMIT 1`;
  const held = q.amounts.ITEM_PRICE;
  if (!proof) return tx.purchaseCeilingIdr ?? held;
  const idr = toIdrAtLock(q, proof.currency.trim(), Number(proof.actual_price_minor));
  return Math.min(idr, tx.purchaseCeilingIdr ?? idr);
}

export type CompletionOutcome = { completed: true; payoutId: string | null; buyerRefundIdr: number } | { completed: false; reason: string };

/** Idempotent: only acts on BUYER_CONFIRMED. */
export async function completeTransaction(deps: AppDeps, transactionId: string): Promise<CompletionOutcome> {
  const out = await deps.sql.begin(async (db): Promise<CompletionOutcome> => {
    await setDbActor(db, 'SYSTEM', null);
    let tx = await loadTx(db, transactionId, { forUpdate: true });
    if (!tx || tx.status !== 'BUYER_CONFIRMED') return { completed: false, reason: 'NOT_BUYER_CONFIRMED' };
    if (!tx.travelerId || !tx.activeQuoteId) return { completed: false, reason: 'INCOMPLETE_TRANSACTION' };
    if (!(await travelerPayoutAccount(db, tx.travelerId))) {
      deps.logger.warn('completion.payout_account_missing', { transactionId: tx.id });
      return { completed: false, reason: 'PAYOUT_ACCOUNT_MISSING' };
    }
    const q = (await loadQuote(db, tx.activeQuoteId))!;
    const held = await transactionBuckets(db, tx.id);
    const plan = releasePlan({
      buyerId: tx.buyerId,
      travelerId: tx.travelerId,
      held: { productFund: held.PRODUCT_FUND, customsReserve: held.CUSTOMS_RESERVE, clearing: held.CLEARING },
      reimbursementIdr: await reimbursementIdr(db, tx, q),
      customsPaidIdr: await customsPaidIdr(db, tx.id),
      fees: {
        travelerFee: q.amounts.TRAVELER_FEE,
        platformAndProtection: q.amounts.PLATFORM_FEE + q.amounts.PROTECTION_FEE,
        serviceTax: q.amounts.SERVICE_TAX,
        paymentFee: q.amounts.PAYMENT_FEE,
      },
    });
    await postJournal(db, {
      kind: 'COMPLETION_RELEASE',
      description: `Completion release for ${tx.number}`,
      transactionId: tx.id,
      idempotencyKey: `release:${tx.id}`,
      meta: { travelerEarningIdr: plan.travelerEarningIdr, buyerRefundIdr: plan.buyerRefundIdr, platformSubsidyIdr: plan.platformSubsidyIdr },
      entries: plan.entries,
    });
    if (plan.buyerRefundIdr > 0) {
      await createRefundRows(deps, db, tx, {
        allocations: await allocateAcrossPayments(db, tx.id, plan.buyerRefundIdr),
        reasonCode: 'OTHER',
        reasonNote: 'Selisih harga barang / bea masuk dikembalikan saat transaksi selesai',
        requestedBy: null,
        breakdown: { source: 'COMPLETION_RESIDUAL', allocationPosted: true, txOutcome: 'NONE' },
        idempotencyPrefix: `residual:${tx.id}`,
      });
    }
    const payout = await schedulePayout(deps, db, tx, { amountIdr: plan.travelerEarningIdr, kind: 'EARNING' });
    assertCanTransition(tx.status, 'COMPLETED', 'SYSTEM', { payoutScheduled: payout !== null, ledgerFinal: true });
    tx = await transitionTx(db, tx, 'COMPLETED', 'SYSTEM', null, 'Transaksi selesai; dana dirilis', {
      payoutId: payout?.id ?? null,
      buyerRefundIdr: plan.buyerRefundIdr,
    });
    const cashback = Number((q.quote.meta?.promotion?.cashbackIdr as number | undefined) ?? 0);
    if (cashback > 0) {
      await db`
        INSERT INTO credit_entries (user_id, amount_idr, reason, reference_type, reference_id, expires_at, idempotency_key, note)
        VALUES (${tx.buyerId}, ${cashback}, 'PROMO_CASHBACK', 'transaction', ${tx.id}, ${new Date(deps.clock.now().getTime() + 90 * 86400_000)},
                ${`cashback:${tx.id}`}, 'Cashback promo')
        ON CONFLICT (idempotency_key) DO NOTHING`;
    }
    await emitEvent(db, 'transaction', tx.id, 'receipt.final_available', { transactionId: tx.id, buyerId: tx.buyerId });
    await audit(db, {
      actorType: 'SYSTEM',
      actorId: null,
      action: 'transaction.completed',
      entityType: 'transaction',
      entityId: tx.id,
      meta: { travelerEarningIdr: plan.travelerEarningIdr, buyerRefundIdr: plan.buyerRefundIdr, payoutId: payout?.id ?? null },
    });
    return { completed: true, payoutId: payout?.id ?? null, buyerRefundIdr: plan.buyerRefundIdr };
  });
  if (out.completed && out.buyerRefundIdr > 0) await processRefunds(deps, { transactionId });
  return out;
}

/**
 * Partial-refund settlement (dispute/admin with remainder to traveler): what is still held for the
 * transaction is released like a completion — item fund and customs reserve to the traveler, fees per
 * quote (traveler fee → traveler, platform/protection → revenue, service tax → tax, payment fee → fee),
 * clipped to what is left. Returns whether a payout is scheduled.
 */
export async function releaseRemainderToTraveler(deps: AppDeps, db: TxSql, tx: TxRow, held: Record<LedgerBucket, number>): Promise<boolean> {
  if (!tx.travelerId || !tx.activeQuoteId) return false;
  const q = (await loadQuote(db, tx.activeQuoteId))!;
  let clearing = held.CLEARING;
  const take = (want: number) => {
    const v = Math.max(0, Math.min(want, clearing));
    clearing -= v;
    return v;
  };
  const tax = take(q.amounts.SERVICE_TAX);
  const payFee = take(q.amounts.PAYMENT_FEE);
  const platform = take(q.amounts.PLATFORM_FEE + q.amounts.PROTECTION_FEE);
  const travelerFee = take(q.amounts.TRAVELER_FEE);
  const extraPlatform = clearing; // anything else left in clearing
  const toTraveler = held.PRODUCT_FUND + held.CUSTOMS_RESERVE + travelerFee;
  await postJournal(db, {
    kind: 'REMAINDER_RELEASE',
    description: `Remainder release after partial refund of ${tx.number}`,
    transactionId: tx.id,
    idempotencyKey: `remainder:${tx.id}`,
    entries: [
      { bucket: 'PRODUCT_FUND', direction: 'DEBIT', amount: held.PRODUCT_FUND },
      { bucket: 'CUSTOMS_RESERVE', direction: 'DEBIT', amount: held.CUSTOMS_RESERVE },
      { bucket: 'CLEARING', direction: 'DEBIT', amount: held.CLEARING },
      { bucket: 'TRAVELER_EARNING', owner: tx.travelerId, direction: 'CREDIT', amount: toTraveler },
      { bucket: 'PLATFORM_REVENUE', direction: 'CREDIT', amount: platform + extraPlatform },
      { bucket: 'TAX_PAYABLE', direction: 'CREDIT', amount: tax },
      { bucket: 'PAYMENT_FEE', direction: 'CREDIT', amount: payFee },
    ],
  });
  if (toTraveler <= 0) return true;
  const payout = await schedulePayout(deps, db, tx, { amountIdr: toTraveler, kind: 'REMAINDER' });
  if (!payout) {
    // Released to TRAVELER_EARNING (owed); the payout is created once the traveler adds a payout account.
    deps.logger.warn('remainder.payout_account_missing', { transactionId: tx.id, amountIdr: toTraveler });
  }
  return true;
}

/** Scheduled job: completes BUYER_CONFIRMED transactions left behind (e.g. missing payout account, dispute resolution). */
export async function completeConfirmedTransactions(deps: AppDeps): Promise<{ completed: number; pending: number }> {
  const rows = await deps.sql<{ id: string }[]>`SELECT id FROM transactions WHERE status = 'BUYER_CONFIRMED' ORDER BY status_changed_at LIMIT 100`;
  let completed = 0;
  let pending = 0;
  for (const r of rows) {
    const o = await completeTransaction(deps, r.id);
    if (o.completed) completed++;
    else pending++;
  }
  return { completed, pending };
}
