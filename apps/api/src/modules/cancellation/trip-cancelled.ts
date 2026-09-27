/**
 * Money-group consumer of `trip.cancelled` (BUG-QA-01): the trips module only announces the open transactions of a
 * cancelled trip; this applies the cancellation matrix to each of them as the TRAVELER (cause `TRIP_CANCELLED`, a
 * free-form cause that falls back to the generic TRAVELER rows):
 *
 *   REQUEST_CREATED / MATCHED           → CANCELLED (AFTER_MATCH; the request re-opens for other travelers)
 *   AWAITING_PAYMENT, checkout pending  → payment EXPIRED + provider session cancelled (best effort; late funds are
 *                                         auto-refunded by the late-payment path) → MATCHED (SYSTEM) → CANCELLED
 *   AWAITING_PAYMENT, supplemental      → top-up EXPIRED → PAYMENT_SECURED (SYSTEM) → REFUND_PENDING (AFTER_PAYMENT)
 *   PAYMENT_SECURED / PRICE_CHANGE_PENDING / PURCHASE_APPROVED
 *                                       → REFUND_PENDING, full refund incl. payment fee, traveler trust penalty signal
 *   PURCHASED and later, DISPUTED       → never automatic (goods exist / dispute owns the money): ALERT + audit
 *                                         `trip.cancel_manual_follow_up`. POST /trips/{id}/cancel refuses such trips; this
 *                                         only catches admin/system paths and races.
 *
 * One DB transaction per transaction (row lock → idempotent: terminal / REFUND_PENDING rows are skipped, so a replayed
 * event does nothing), refunds processed right after commit, and `transaction.trip_cancelled` notifies buyer and traveler
 * (the generic `transaction.cancelled` notification is suppressed for this cause).
 */
import type { TransactionStatus } from '@jastipkita/core';
import type { AppDeps } from '../../context';
import { audit } from '../../services/audit';
import { emitEvent } from '../../services/outbox';
import { reverseCreditRedemption } from '../payments/service';
import { processRefunds } from '../refunds/service';
import { assertCanTransition, loadTx, setDbActor, transitionTx } from '../transactions/common';
import { cancelInTx } from './service';

export const TRIP_CANCELLED_CAUSE = 'TRIP_CANCELLED';

/** Statuses a trip cancellation cannot unwind automatically (the item may already be bought / a dispute owns it). */
export const TRIP_CANCEL_BLOCKING_STATUSES: readonly TransactionStatus[] = [
  'PURCHASED',
  'TRAVELING',
  'ARRIVED',
  'CUSTOMS_PROCESS',
  'READY_FOR_HANDOVER',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'BUYER_CONFIRMED',
  'DISPUTED',
];
const DONE: readonly TransactionStatus[] = ['COMPLETED', 'CANCELLED', 'REFUNDED', 'REFUND_PENDING'];

export interface TripCancelledPayload {
  tripId: string;
  travelerId?: string;
  reason?: string | null;
  actorType?: string;
  openTransactionIds?: string[];
}

export interface TripCancelResult {
  transactionId: string;
  outcome: 'CANCELLED' | 'REFUND_PENDING' | 'REFUNDED' | 'SKIPPED' | 'MANUAL_FOLLOW_UP';
}

export async function cancelTransactionsOfCancelledTrip(deps: AppDeps, payload: TripCancelledPayload): Promise<TripCancelResult[]> {
  // The event lists the open transactions at cancel time; re-read the trip too (robust to races with checkout).
  const rows = await deps.sql<{ id: string }[]>`
    SELECT id FROM transactions WHERE trip_id = ${payload.tripId} AND status NOT IN ('COMPLETED','CANCELLED','REFUNDED') ORDER BY created_at`;
  const ids = [...new Set([...(payload.openTransactionIds ?? []), ...rows.map((r) => r.id)])];
  const results: TripCancelResult[] = [];
  for (const id of ids) results.push(await cancelOne(deps, id, payload));
  return results;
}

async function cancelOne(deps: AppDeps, id: string, payload: TripCancelledPayload): Promise<TripCancelResult> {
  const reason = `Trip dibatalkan traveler${payload.reason ? `: ${payload.reason}` : ''}`.slice(0, 500);
  const res = await deps.sql.begin(async (db) => {
    let tx = await loadTx(db, id, { forUpdate: true });
    if (!tx || tx.tripId !== payload.tripId || DONE.includes(tx.status)) return { outcome: 'SKIPPED' as const, providerRefs: [] as string[], refunds: 0 };
    if (TRIP_CANCEL_BLOCKING_STATUSES.includes(tx.status)) {
      deps.logger.error('ALERT trip.cancelled_with_purchased_transaction', { tripId: payload.tripId, transactionId: tx.id, status: tx.status });
      await audit(db, {
        actorType: 'SYSTEM',
        actorId: null,
        action: 'trip.cancel_manual_follow_up',
        entityType: 'transaction',
        entityId: tx.id,
        meta: { tripId: payload.tripId, status: tx.status, reason: 'trip cancelled after purchase — admin cancellation/dispute required' },
      });
      return { outcome: 'MANUAL_FOLLOW_UP' as const, providerRefs: [] as string[], refunds: 0 };
    }

    const providerRefs: string[] = [];
    if (tx.status === 'AWAITING_PAYMENT') {
      // Stop the open invoice first (§4 has no TRAVELER edge out of AWAITING_PAYMENT).
      await setDbActor(db, 'SYSTEM', null);
      const pending = await db<{ id: string; purpose: string; provider_ref: string | null; quote_id: string | null }[]>`
        SELECT id, purpose, provider_ref, quote_id FROM payments WHERE transaction_id = ${tx.id} AND status = 'PENDING' FOR UPDATE`;
      for (const p of pending) {
        await db`UPDATE payments SET status = 'EXPIRED', failure_reason = 'Trip dibatalkan traveler', version = version + 1 WHERE id = ${p.id}`;
        await reverseCreditRedemption(db, p, tx.buyerId);
        if (p.quote_id) await db`UPDATE promotion_redemptions SET status = 'EXPIRED' WHERE quote_id = ${p.quote_id} AND status = 'RESERVED'`;
        if (p.provider_ref) providerRefs.push(p.provider_ref);
      }
      // Escrow holds checkout funds only after a PAYMENT_CAPTURED journal (a late payment is captured to REFUND
      // instead and refunds itself — it must not be refunded a second time here).
      const [captured] = await db<{ n: number }[]>`
        SELECT count(*)::int AS n FROM ledger_journals WHERE transaction_id = ${tx.id} AND kind = 'PAYMENT_CAPTURED'`;
      if ((captured?.n ?? 0) > 0) {
        // waiting for a SUPPLEMENTAL top-up: the checkout funds are secured → back to PAYMENT_SECURED, then refund
        assertCanTransition(tx.status, 'PAYMENT_SECURED', 'SYSTEM', { paymentSignatureValid: true, paymentAmountMatches: true, paymentCurrencyMatches: true });
        tx = await transitionTx(db, tx, 'PAYMENT_SECURED', 'SYSTEM', null, 'Pembayaran tambahan dihentikan: trip dibatalkan', { cause: TRIP_CANCELLED_CAUSE });
      } else {
        assertCanTransition(tx.status, 'MATCHED', 'SYSTEM', { invoiceExpired: true });
        tx = await transitionTx(db, tx, 'MATCHED', 'SYSTEM', null, 'Tagihan dihentikan: trip dibatalkan', { cause: TRIP_CANCELLED_CAUSE });
      }
    }

    const actor = tx.status === 'REQUEST_CREATED' ? ('SYSTEM' as const) : ('TRAVELER' as const);
    const out = await cancelInTx(deps, db, tx, {
      actor,
      actorId: actor === 'TRAVELER' ? tx.travelerId : null,
      reason,
      cause: TRIP_CANCELLED_CAUSE,
    });
    await emitEvent(db, 'transaction', tx.id, 'transaction.trip_cancelled', {
      transactionId: tx.id,
      tripId: payload.tripId,
      buyerId: tx.buyerId,
      travelerId: tx.travelerId,
      outcome: out.status,
      refundIdr: out.cancellation.refundIdr,
      trustPenalty: out.cancellation.trustPenalty,
    });
    return { outcome: out.status as 'CANCELLED' | 'REFUND_PENDING' | 'REFUNDED', providerRefs, refunds: out.refunds.length };
  });

  // Outside the DB transaction: provider calls. A failure never undoes the cancellation (late funds → auto-refund).
  for (const ref of res.providerRefs) {
    try {
      await deps.providers.payment.cancelCheckout?.(ref);
    } catch (err) {
      deps.logger.warn('payment.cancel_checkout_failed', { transactionId: id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (res.refunds > 0) await processRefunds(deps, { transactionId: id });
  const [fresh] = await deps.sql<{ status: string }[]>`SELECT status FROM transactions WHERE id = ${id}`;
  const outcome = res.outcome === 'REFUND_PENDING' && fresh?.status === 'REFUNDED' ? 'REFUNDED' : res.outcome;
  return { transactionId: id, outcome };
}
