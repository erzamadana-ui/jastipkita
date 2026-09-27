/**
 * Cancellation (§8 stages, business config `cancellation.matrix`) and the trust-penalty signal.
 *
 * Trust penalty contract (consumed by the engagement trust job): outbox event
 * `transaction.cancelled_with_penalty` { transactionId, userId, role, trustPenalty, stage, cause, eventAt }
 * is emitted whenever the matrix row carries trustPenalty > 0. No money is moved by it.
 */
import { type Actor, type CancellationResult, evaluateCancellation, type TransactionStatus } from '@jastipkita/core';
import type { AppDeps, AuthContext } from '../../context';
import type { TxSql } from '../../db/sql';
import { AppError, Errors } from '../../lib/errors';
import { audit } from '../../services/audit';
import { emitEvent } from '../../services/outbox';
import { loadQuote } from '../checkout/repository';
import { postJournal, settlementEntries, transactionBuckets } from '../ledger/service';
import { reverseCreditRedemption } from '../payments/service';
import { schedulePayout } from '../payouts/service';
import { allocateAcrossPayments, createRefundRows, maybeFinalizeRefunds, processRefunds, type RefundReason } from '../refunds/service';
import { assertCanTransition, loadTx, requireParty, setDbActor, transitionTx, type TxRow } from '../transactions/common';

export interface CancelInput {
  actor: Actor;
  actorId: string | null;
  reason: string;
  cause?: string | undefined;
  refundReasonCode?: RefundReason;
  adminApprovalRecorded?: boolean;
}

export interface CancelOutcome {
  status: TransactionStatus;
  cancellation: {
    stage: string | null;
    allowed: boolean;
    refundIdr: number;
    travelerCompensationIdr: number;
    platformRetainedIdr: number;
    paymentFeeRetainedIdr: number;
    serviceTaxRetainedIdr: number;
    customsRetainedIdr: number;
    creditRestoredIdr: number;
    discountReversedIdr: number;
    trustPenalty: number;
    penalizedActor: string | null;
  };
  refunds: { id: string; number: string; amountIdr: number; status: string; method: string | undefined }[];
}

/** Quote lines as actually paid: supplemental top-ups are added to ITEM_PRICE and TOTAL. */
async function paidLines(db: TxSql, tx: TxRow) {
  if (!tx.activeQuoteId) return [];
  const q = (await loadQuote(db, tx.activeQuoteId))!;
  const [supp] = await db<{ s: number }[]>`
    SELECT coalesce(sum(amount_idr), 0)::bigint AS s FROM payments
     WHERE transaction_id = ${tx.id} AND purpose = 'SUPPLEMENTAL' AND status IN ('SECURED','PARTIALLY_REFUNDED','REFUNDED')`;
  const extra = Number(supp?.s ?? 0);
  return q.lines.map((l) => ({
    type: l.lineType,
    amountIdr: l.lineType === 'ITEM_PRICE' || l.lineType === 'TOTAL' ? l.amountIdr + extra : l.amountIdr,
  }));
}

function penaltyUser(tx: TxRow, actor: Actor): { userId: string; role: 'BUYER' | 'TRAVELER' } | null {
  if (actor === 'BUYER') return { userId: tx.buyerId, role: 'BUYER' };
  if (actor === 'TRAVELER' && tx.travelerId) return { userId: tx.travelerId, role: 'TRAVELER' };
  return null;
}

/**
 * Evaluates the matrix and applies the cancellation inside the caller's DB transaction.
 * Before payment → CANCELLED. After payment → REFUND_PENDING + settlement journal + refunds (+ traveler
 * compensation payout); REFUNDED once every refund succeeds.
 */
export async function cancelInTx(deps: AppDeps, db: TxSql, tx: TxRow, input: CancelInput): Promise<CancelOutcome> {
  const now = deps.clock.now();
  await setDbActor(db, input.actor, input.actorId);
  const [captured] = await db<{ n: number }[]>`
    SELECT count(*)::int AS n FROM payments WHERE transaction_id = ${tx.id} AND status IN ('SECURED','PARTIALLY_REFUNDED')`;
  if (tx.status === 'AWAITING_PAYMENT' && (captured?.n ?? 0) > 0) {
    // Waiting for a SUPPLEMENTAL top-up after an approved price increase: §4 has no refund edge from
    // AWAITING_PAYMENT; letting the top-up expire triggers the no-fault full refund automatically.
    throw new AppError(422, 'CANCELLATION_NOT_ALLOWED', 'Pembayaran tambahan sedang menunggu; biarkan kedaluwarsa untuk refund penuh otomatis', {
      stage: 'AFTER_PAYMENT',
    });
  }
  const paymentCaptured = (captured?.n ?? 0) > 0 && !['REQUEST_CREATED', 'MATCHED', 'AWAITING_PAYMENT'].includes(tx.status);
  const matrix = await deps.config.get('cancellation.matrix');
  const lines = await paidLines(db, tx);
  const result: CancellationResult = evaluateCancellation(
    { status: tx.status, actor: input.actor, ...(input.cause ? { cause: input.cause } : {}), quoteLines: lines, paymentCaptured },
    matrix,
  );
  if (!result.allowed) {
    throw new AppError(422, 'CANCELLATION_NOT_ALLOWED', result.reason ?? 'Pembatalan tidak diizinkan pada tahap ini', {
      stage: result.stage,
      reasonCode: result.reasonCode,
      hint: result.stage && ['AFTER_PURCHASE', 'DURING_TRAVEL', 'AFTER_ARRIVAL'].includes(result.stage) ? 'Gunakan Dispute Center' : undefined,
    });
  }
  if (result.requiresAdminApproval && !(input.actor === 'ADMIN' && input.adminApprovalRecorded)) {
    throw new AppError(422, 'ADMIN_APPROVAL_REQUIRED', 'Pembatalan pada tahap ini memerlukan persetujuan admin; hubungi Pusat Bantuan', {
      stage: result.stage,
    });
  }
  const target = result.transitionPath[0] as TransactionStatus;
  if (target !== 'CANCELLED' && target !== 'REFUND_PENDING') {
    throw new AppError(422, 'CANCELLATION_NOT_ALLOWED', 'Gunakan Dispute Center untuk transaksi yang sudah terkirim', { path: result.transitionPath });
  }
  const openPc = await db<{ id: string; status: string }[]>`
    SELECT id, status FROM price_confirmations WHERE transaction_id = ${tx.id} AND status IN ('PENDING','CLARIFICATION_REQUESTED') FOR UPDATE`;
  const meta = { cancellationStage: result.stage, cause: input.cause ?? null, trustPenalty: result.trustPenalty, refundIdr: result.refundIdr };
  const ctx = {
    cancellationAllowed: true,
    fundsReceived: false,
    priceChangeRejected: input.actor === 'BUYER',
    priceConfirmationExpired: input.actor === 'SYSTEM',
    adminApprovalRecorded: input.adminApprovalRecorded ?? false,
  };
  assertCanTransition(tx.status, target, input.actor, ctx);
  const fromStatus = tx.status;
  let next = await transitionTx(db, tx, target, input.actor, input.actorId, input.reason, meta);

  const refundsOut: CancelOutcome['refunds'] = [];
  if (target === 'CANCELLED') {
    // Pending checkout (AWAITING_PAYMENT): stop it; late funds would be refunded automatically.
    const pending = await db<{ id: string }[]>`SELECT id FROM payments WHERE transaction_id = ${tx.id} AND status = 'PENDING' FOR UPDATE`;
    for (const p of pending) {
      await db`UPDATE payments SET status = 'EXPIRED', failure_reason = 'Transaksi dibatalkan', version = version + 1 WHERE id = ${p.id}`;
      await reverseCreditRedemption(db, p, tx.buyerId);
      await db`UPDATE promotion_redemptions SET status = 'REVERSED', reversed_at = ${now} WHERE transaction_id = ${tx.id} AND status = 'RESERVED'`;
    }
  } else {
    for (const pc of openPc) {
      if (input.actor === 'BUYER') {
        await db`UPDATE price_confirmations SET status = 'REJECTED', responded_at = ${now}, response_note = coalesce(response_note, ${input.reason}) WHERE id = ${pc.id}`;
      }
    }
    const held = await transactionBuckets(db, tx.id);
    await postJournal(db, {
      kind: 'CANCELLATION_SETTLEMENT',
      description: `Cancellation (${result.stage}, ${input.actor}${input.cause ? `, ${input.cause}` : ''}) of ${tx.number}`,
      transactionId: tx.id,
      idempotencyKey: `cancel-settle:${tx.id}`,
      actorId: input.actorId,
      meta: { ...meta, fromStatus },
      entries: settlementEntries({
        buyerId: tx.buyerId,
        travelerId: tx.travelerId,
        held: { productFund: held.PRODUCT_FUND, customsReserve: held.CUSTOMS_RESERVE, clearing: held.CLEARING },
        refundIdr: result.refundIdr,
        travelerCompensationIdr: result.travelerCompensationIdr,
        platformRetainedIdr: result.platformRetainedIdr,
        serviceTaxRetainedIdr: result.serviceTaxRetainedIdr,
        paymentFeeRetainedIdr: result.paymentFeeRetainedIdr,
        customsRetainedIdr: result.customsRetainedIdr,
        promoReturnedIdr: result.discountReversedIdr + result.creditRestoredIdr,
      }),
    });
    if (result.creditRestoredIdr > 0) {
      await db`
        INSERT INTO credit_entries (user_id, amount_idr, reason, reference_type, reference_id, idempotency_key, note)
        VALUES (${tx.buyerId}, ${result.creditRestoredIdr}, 'REDEEM_REVERSAL', 'transaction', ${tx.id}, ${`cancel-credit:${tx.id}`},
                'Transaksi dibatalkan — JastipKita Credit dikembalikan')
        ON CONFLICT (idempotency_key) DO NOTHING`;
    }
    if (result.discountReversedIdr > 0) {
      await db`UPDATE promotion_redemptions SET status = 'REVERSED', reversed_at = ${now} WHERE transaction_id = ${tx.id} AND status IN ('RESERVED','APPLIED')`;
    }
    const refundReason: RefundReason =
      input.refundReasonCode ??
      (input.cause === 'PRICE_CHANGE_REJECTED' ? 'PRICE_CHANGE_REJECTED' : input.actor === 'TRAVELER' ? 'TRAVELER_CANCEL' : input.actor === 'BUYER' ? 'BUYER_CANCEL' : 'ADMIN');
    const rows = await createRefundRows(deps, db, next, {
      allocations: await allocateAcrossPayments(db, tx.id, result.refundIdr),
      reasonCode: refundReason,
      reasonNote: input.reason,
      requestedBy: input.actor === 'ADMIN' ? input.actorId : null,
      breakdown: {
        source: 'CANCELLATION',
        allocationPosted: true,
        allocationJournalKey: `cancel-settle:${tx.id}`,
        txOutcome: 'REFUNDED',
        cancellation: {
          stage: result.stage,
          actor: input.actor,
          cause: input.cause ?? null,
          refundByLine: result.refundByLine,
          retainedByLine: result.retainedByLine,
          travelerCompensationIdr: result.travelerCompensationIdr,
        },
      },
      idempotencyPrefix: `cancel:${tx.id}`,
    });
    for (const r of rows) refundsOut.push({ id: r.id, number: r.number, amountIdr: r.amountIdr, status: r.status, method: r.breakdown.method });
    if (result.travelerCompensationIdr + result.customsRetainedIdr > 0) {
      await schedulePayout(deps, db, next, { amountIdr: result.travelerCompensationIdr + result.customsRetainedIdr, kind: 'COMPENSATION' });
    }
    if (rows.length === 0) await maybeFinalizeRefunds(deps, db, tx.id);
    next = (await loadTx(db, tx.id))!;
  }

  const penalized = result.trustPenalty > 0 ? penaltyUser(tx, input.actor) : null;
  if (penalized) {
    await emitEvent(db, 'transaction', tx.id, 'transaction.cancelled_with_penalty', {
      transactionId: tx.id,
      userId: penalized.userId,
      role: penalized.role,
      trustPenalty: result.trustPenalty,
      stage: result.stage,
      cause: input.cause ?? null,
      eventAt: now.toISOString(),
    });
  }
  await audit(db, {
    actorType: input.actor,
    actorId: input.actorId,
    action: 'transaction.cancelled',
    entityType: 'transaction',
    entityId: tx.id,
    before: { status: fromStatus },
    after: { status: next.status },
    meta: { ...meta, travelerCompensationIdr: result.travelerCompensationIdr },
  });
  return {
    status: next.status,
    cancellation: {
      stage: result.stage,
      allowed: true,
      refundIdr: result.refundIdr,
      travelerCompensationIdr: result.travelerCompensationIdr,
      platformRetainedIdr: result.platformRetainedIdr,
      paymentFeeRetainedIdr: result.paymentFeeRetainedIdr,
      serviceTaxRetainedIdr: result.serviceTaxRetainedIdr,
      customsRetainedIdr: result.customsRetainedIdr,
      creditRestoredIdr: result.creditRestoredIdr,
      discountReversedIdr: result.discountReversedIdr,
      trustPenalty: result.trustPenalty,
      penalizedActor: result.penalizedActor,
    },
    refunds: refundsOut,
  };
}

/** POST /transactions/{id}/cancel — actor = caller's role. */
export async function cancelTransaction(deps: AppDeps, auth: AuthContext, id: string, body: { reason: string; cause?: string | undefined }): Promise<CancelOutcome> {
  if (body.cause && !/^[A-Z][A-Z0-9_]{2,63}$/.test(body.cause)) throw Errors.validation({ cause: 'UPPER_SNAKE code' });
  if (body.cause === 'PRICE_CHANGE_REJECTED') {
    // Only reachable through the price-confirmation REJECT action (no-fault refund).
    const { tx } = await requireParty(deps.sql, id, auth);
    if (tx.status !== 'PRICE_CHANGE_PENDING') throw Errors.unprocessable('CAUSE_NOT_APPLICABLE', 'Alasan ini hanya berlaku saat konfirmasi harga');
  }
  const out = await deps.sql.begin(async (db) => {
    const { tx, role } = await requireParty(db, id, auth, { forUpdate: true });
    const cause = body.cause ?? (tx.status === 'PRICE_CHANGE_PENDING' && role === 'BUYER' ? 'PRICE_CHANGE_REJECTED' : undefined);
    return cancelInTx(deps, db, tx, { actor: role, actorId: auth.userId, reason: body.reason, cause });
  });
  if (out.refunds.length) await processRefunds(deps, { transactionId: id });
  return out;
}
