/**
 * Refunds (§15.6): creation (auto-approve under a threshold, maker-checker above), provider refund or —
 * for channels that cannot be refunded (VA, retail) — payout-style disbursement to a validated buyer bank
 * account, retries with the SYSTEM budget, ledger (REFUND_PAID) and transaction finalization
 * (REFUND_PENDING → REFUNDED / COMPLETED).
 *
 * Public API for other groups (admin / dispute resolution):
 *   requestRefund(deps, db, transactionId, RequestRefundInput)   — inside the caller's DB transaction
 *   approveRefund(deps, refundId, adminUserId) / rejectRefund(deps, refundId, adminUserId, reason)
 *   processRefunds(deps, { transactionId? })                      — the processor (also a scheduled job)
 */
import { type DisputeResolution, refundFsm } from '@jastipkita/core';
import type { AppDeps, AuthContext } from '../../context';
import { camel, type Db, type TxSql } from '../../db/sql';
import { AppError, Errors } from '../../lib/errors';
import { channelSupportsProviderRefund } from '../../providers/payment/channels';
import { audit } from '../../services/audit';
import { emitEvent } from '../../services/outbox';
import { type RequestMeta, securityEvent } from '../auth/common';
import { consumeSensitiveActionOtp } from '../auth/service';
import { namesMatch, verifiedIdentityName } from '../kyc/service';
import { postJournal, reverseJournalByKey, transactionBuckets } from '../ledger/service';
import { type PaymentRow, securedPaymentsForTx } from '../payments/repository';
import {
  assertCanTransition,
  loadTx,
  maskAccount,
  moneyPolicy,
  requireParty,
  setDbActor,
  transitionTx,
  type TxRow,
} from '../transactions/common';

export type RefundReason =
  | 'BUYER_CANCEL'
  | 'TRAVELER_CANCEL'
  | 'PRICE_CHANGE_REJECTED'
  | 'PRICE_CONFIRMATION_EXPIRED'
  | 'DISPUTE_RESOLUTION'
  | 'PAYMENT_DUPLICATE'
  | 'LATE_PAYMENT'
  | 'ADMIN'
  | 'OTHER';

export type RefundMethod = 'PROVIDER_REFUND' | 'PAYOUT_TO_BUYER';

export interface RefundBreakdown {
  /** What created the refund. */
  source: 'CANCELLATION' | 'LATE_PAYMENT' | 'COMPLETION_RESIDUAL' | 'DISPUTE' | 'ADMIN';
  method?: RefundMethod;
  /** The REFUND(buyer) bucket was already credited by the journal that created this refund. */
  allocationPosted: boolean;
  /** Journal key to reverse if the refund is rejected/cancelled before paying out. */
  allocationJournalKey?: string;
  /** Transaction outcome once every refund of the transaction succeeded. */
  txOutcome: 'REFUNDED' | 'COMPLETED' | 'NONE';
  destinationRequested?: boolean;
  cancellation?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface RefundRow {
  id: string;
  number: string;
  transactionId: string;
  paymentId: string;
  reasonCode: RefundReason;
  reasonNote: string | null;
  amountIdr: number;
  breakdown: RefundBreakdown;
  type: 'FULL' | 'PARTIAL';
  status: 'REQUESTED' | 'PENDING_APPROVAL' | 'APPROVED' | 'PROCESSING' | 'SUCCEEDED' | 'FAILED' | 'REJECTED' | 'CANCELLED';
  providerRef: string | null;
  requestedBy: string | null;
  approvedBy: string | null;
  approvedAt: Date | null;
  processedAt: Date | null;
  failureReason: string | null;
  idempotencyKey: string | null;
  attempts: number;
  createdAt: Date;
  updatedAt: Date;
}

async function loadRefund(db: Db, id: string, forUpdate = false): Promise<RefundRow | null> {
  const rows = forUpdate
    ? await db<Record<string, unknown>[]>`SELECT * FROM refunds WHERE id = ${id} FOR UPDATE`
    : await db<Record<string, unknown>[]>`SELECT * FROM refunds WHERE id = ${id}`;
  return rows[0] ? camel<RefundRow>(rows[0]) : null;
}

const OPEN_STATUSES = ['REQUESTED', 'PENDING_APPROVAL', 'APPROVED', 'PROCESSING', 'FAILED'] as const;

// ------------------------------------------------------------------ allocation across payments

export interface PaymentAllocation {
  payment: PaymentRow;
  amountIdr: number;
}

/** Splits a refund amount over the transaction's secured payments (most recent first), within each one's refundable remainder. */
export async function allocateAcrossPayments(db: Db, transactionId: string, amountIdr: number): Promise<PaymentAllocation[]> {
  if (amountIdr <= 0) return [];
  const payments = (await securedPaymentsForTx(db, transactionId)).reverse();
  const out: PaymentAllocation[] = [];
  let left = amountIdr;
  for (const p of payments) {
    const [r] = await db<{ reserved: number }[]>`
      SELECT coalesce(sum(amount_idr), 0)::bigint AS reserved FROM refunds
       WHERE payment_id = ${p.id} AND status NOT IN ('REJECTED','CANCELLED','FAILED')`;
    const capacity = p.amountIdr - Number(r?.reserved ?? 0);
    if (capacity <= 0) continue;
    const take = Math.min(capacity, left);
    out.push({ payment: p, amountIdr: take });
    left -= take;
    if (left === 0) break;
  }
  if (left > 0) {
    throw new AppError(422, 'REFUND_EXCEEDS_CAPTURED', 'Nominal refund melebihi dana yang tertangkap', { requestedIdr: amountIdr, unallocatedIdr: left });
  }
  return out;
}

// ------------------------------------------------------------------ creation

export interface CreateRefundRowsInput {
  allocations: PaymentAllocation[];
  reasonCode: RefundReason;
  reasonNote: string | null;
  requestedBy: string | null;
  breakdown: RefundBreakdown;
  idempotencyPrefix: string;
}

/** Inserts refund rows (one per payment) in REQUESTED, then auto-approves (≤ threshold) or routes to PENDING_APPROVAL. */
export async function createRefundRows(deps: AppDeps, db: TxSql, tx: TxRow, input: CreateRefundRowsInput): Promise<RefundRow[]> {
  const policy = await moneyPolicy(db);
  const now = deps.clock.now();
  const out: RefundRow[] = [];
  for (const a of input.allocations) {
    if (a.amountIdr <= 0) continue;
    const key = `${input.idempotencyPrefix}:${a.payment.id}`;
    const [exists] = await db<{ id: string }[]>`SELECT id FROM refunds WHERE idempotency_key = ${key}`;
    if (exists) {
      out.push((await loadRefund(db, exists.id))!);
      continue;
    }
    const method: RefundMethod = channelSupportsProviderRefund(a.payment.channel) ? 'PROVIDER_REFUND' : 'PAYOUT_TO_BUYER';
    const breakdown: RefundBreakdown = { ...input.breakdown, method };
    const [ins] = await db<{ id: string }[]>`
      INSERT INTO refunds (transaction_id, payment_id, reason_code, reason_note, amount_idr, breakdown, type, status, requested_by, idempotency_key)
      VALUES (${tx.id}, ${a.payment.id}, ${input.reasonCode}, ${input.reasonNote}, ${a.amountIdr}, ${db.json(breakdown as never)},
              ${a.amountIdr === a.payment.amountIdr ? 'FULL' : 'PARTIAL'}, 'REQUESTED', ${input.requestedBy}, ${key})
      RETURNING id`;
    const above = a.amountIdr > policy.refundAutoApproveMaxIdr;
    const to = above ? 'PENDING_APPROVAL' : 'APPROVED';
    const check = refundFsm.canTransition('REQUESTED', to, 'SYSTEM', { amountWithinCaptured: true, aboveAutoApproveLimit: above });
    if (!check.ok) throw new AppError(500, check.code, check.message);
    if (to === 'APPROVED') {
      await db`UPDATE refunds SET status = 'APPROVED', approved_at = ${now} WHERE id = ${ins!.id}`;
    } else {
      await db`UPDATE refunds SET status = 'PENDING_APPROVAL' WHERE id = ${ins!.id}`;
    }
    const row = (await loadRefund(db, ins!.id))!;
    await emitEvent(db, 'refund', row.id, 'refund.requested', {
      refundId: row.id,
      refundNumber: row.number,
      transactionId: tx.id,
      buyerId: tx.buyerId,
      amountIdr: row.amountIdr,
      reasonCode: row.reasonCode,
      method,
      status: row.status,
      destinationRequired: method === 'PAYOUT_TO_BUYER',
    });
    await audit(db, {
      actorType: input.requestedBy ? 'ADMIN' : 'SYSTEM',
      actorId: input.requestedBy,
      action: 'refund.requested',
      entityType: 'refund',
      entityId: row.id,
      after: { status: row.status, amountIdr: row.amountIdr },
      meta: { transactionId: tx.id, paymentId: a.payment.id, reasonCode: row.reasonCode, method },
    });
    out.push(row);
  }
  return out;
}

// ------------------------------------------------------------------ public API for admin / dispute resolution

export interface RequestRefundInput {
  amountIdr: number;
  reasonCode: RefundReason;
  reasonNote?: string | null;
  /** Admin user requesting (maker). NULL = system. */
  requestedBy: string | null;
  actorType: 'ADMIN' | 'SYSTEM';
  /** Remaining escrow after the refund: released to the traveler (→ COMPLETED) or returned (→ REFUNDED). */
  remainderTo: 'TRAVELER' | 'NONE';
  /** Needed when the transaction is DISPUTED (§4 DISPUTED → REFUND_PENDING guard). */
  disputeResolution?: DisputeResolution;
  /** Needed for ADMIN override edges (TRAVELING … OUT_FOR_DELIVERY → REFUND_PENDING). */
  adminApprovalRecorded?: boolean;
  /** Stable key so a retried resolution never creates a second refund. */
  idempotencyKey: string;
}

/**
 * Creates a refund for a transaction from a dispute resolution / admin decision (call inside the caller's
 * DB transaction). Moves the transaction to REFUND_PENDING if needed, allocates the amount out of the
 * escrow buckets (PRODUCT_FUND → CUSTOMS_RESERVE → CLEARING) into REFUND(buyer) with a journal, and creates
 * the refund rows (auto-approved or PENDING_APPROVAL). The processor pays it out; when all refunds
 * succeed the transaction becomes COMPLETED (remainder released to the traveler) or REFUNDED.
 */
export async function requestRefund(deps: AppDeps, db: TxSql, transactionId: string, input: RequestRefundInput): Promise<RefundRow[]> {
  if (!Number.isSafeInteger(input.amountIdr) || input.amountIdr <= 0) throw Errors.validation({ amountIdr: 'must be a positive integer' });
  let tx = await loadTx(db, transactionId, { forUpdate: true });
  if (!tx) throw Errors.notFound('Transaksi', 'TRANSACTION_NOT_FOUND');
  // starts_with, not LIKE: the key embeds a client Idempotency-Key, whose % / _ would act as wildcards (SEC-10)
  const [existing] = await db<{ id: string }[]>`SELECT id FROM refunds WHERE starts_with(idempotency_key, ${`${input.idempotencyKey}:`}) LIMIT 1`;
  if (existing) {
    const rows = await db<Record<string, unknown>[]>`SELECT * FROM refunds WHERE starts_with(idempotency_key, ${`${input.idempotencyKey}:`})`;
    return rows.map((r) => camel<RefundRow>(r));
  }
  await setDbActor(db, input.actorType, input.requestedBy);
  if (tx.status !== 'REFUND_PENDING') {
    assertCanTransition(tx.status, 'REFUND_PENDING', input.actorType, {
      disputeResolution: input.disputeResolution ?? (input.remainderTo === 'TRAVELER' ? 'REFUND_PARTIAL' : 'REFUND_FULL'),
      cancellationAllowed: true,
      adminApprovalRecorded: input.adminApprovalRecorded ?? false,
    });
    tx = await transitionTx(db, tx, 'REFUND_PENDING', input.actorType, input.requestedBy, input.reasonNote ?? input.reasonCode, {
      refundReason: input.reasonCode,
    });
  }
  const held = await transactionBuckets(db, tx.id);
  const fromPf = Math.min(held.PRODUCT_FUND, input.amountIdr);
  const fromCr = Math.min(held.CUSTOMS_RESERVE, input.amountIdr - fromPf);
  const fromCl = Math.min(held.CLEARING, input.amountIdr - fromPf - fromCr);
  if (fromPf + fromCr + fromCl < input.amountIdr) {
    throw new AppError(422, 'REFUND_EXCEEDS_ESCROW', 'Nominal refund melebihi dana yang masih ditahan untuk transaksi ini', {
      requestedIdr: input.amountIdr,
      heldIdr: fromPf + fromCr + fromCl,
    });
  }
  const allocations = await allocateAcrossPayments(db, tx.id, input.amountIdr);
  const journalKey = `refund-alloc:${input.idempotencyKey}`;
  await postJournal(db, {
    kind: 'DISPUTE_REFUND_ALLOCATION',
    description: `Refund allocation (${input.reasonCode}) for ${tx.number}`,
    transactionId: tx.id,
    idempotencyKey: journalKey,
    actorId: input.requestedBy,
    meta: { reasonCode: input.reasonCode },
    entries: [
      { bucket: 'PRODUCT_FUND', direction: 'DEBIT', amount: fromPf },
      { bucket: 'CUSTOMS_RESERVE', direction: 'DEBIT', amount: fromCr },
      { bucket: 'CLEARING', direction: 'DEBIT', amount: fromCl },
      { bucket: 'REFUND', owner: tx.buyerId, direction: 'CREDIT', amount: input.amountIdr },
    ],
  });
  return createRefundRows(deps, db, tx, {
    allocations,
    reasonCode: input.reasonCode,
    reasonNote: input.reasonNote ?? null,
    requestedBy: input.requestedBy,
    breakdown: {
      source: input.reasonCode === 'DISPUTE_RESOLUTION' ? 'DISPUTE' : 'ADMIN',
      allocationPosted: true,
      allocationJournalKey: journalKey,
      txOutcome: input.remainderTo === 'TRAVELER' ? 'COMPLETED' : 'REFUNDED',
    },
    idempotencyPrefix: input.idempotencyKey,
  });
}

/** Maker-checker approval of a PENDING_APPROVAL refund (approver ≠ requester). */
export async function approveRefund(deps: AppDeps, refundId: string, adminUserId: string): Promise<RefundRow> {
  return deps.sql.begin(async (db) => {
    await setDbActor(db, 'ADMIN', adminUserId);
    const r = await loadRefund(db, refundId, true);
    if (!r) throw Errors.notFound('Refund', 'REFUND_NOT_FOUND');
    const check = refundFsm.canTransition(r.status, 'APPROVED', 'ADMIN', {
      amountWithinCaptured: true,
      requestedBy: r.requestedBy ?? 'SYSTEM',
      approvedBy: adminUserId,
    });
    if (!check.ok) throw new AppError(422, check.code, 'Refund tidak dapat disetujui', { reason: check.message });
    await db`UPDATE refunds SET status = 'APPROVED', approved_by = ${adminUserId}, approved_at = ${deps.clock.now()} WHERE id = ${r.id}`;
    await audit(db, { actorType: 'ADMIN', actorId: adminUserId, action: 'refund.approved', entityType: 'refund', entityId: r.id, before: { status: r.status }, after: { status: 'APPROVED' } });
    return (await loadRefund(db, r.id))!;
  });
}

/** Rejects a refund (reason required); the REFUND allocation journal is reversed back into escrow. */
export async function rejectRefund(deps: AppDeps, refundId: string, adminUserId: string, reason: string): Promise<RefundRow> {
  if (!reason.trim()) throw Errors.validation({ reason: 'required' });
  return deps.sql.begin(async (db) => {
    await setDbActor(db, 'ADMIN', adminUserId);
    const r = await loadRefund(db, refundId, true);
    if (!r) throw Errors.notFound('Refund', 'REFUND_NOT_FOUND');
    const check = refundFsm.canTransition(r.status, 'REJECTED', 'ADMIN', { reason });
    if (!check.ok) throw new AppError(422, check.code, 'Refund tidak dapat ditolak', { reason: check.message });
    await db`UPDATE refunds SET status = 'REJECTED', reason_note = coalesce(reason_note, '') || ${` | ditolak: ${reason}`} WHERE id = ${r.id}`;
    if (r.breakdown.allocationJournalKey) await reverseJournalByKey(db, r.breakdown.allocationJournalKey, `refund ${r.number} rejected: ${reason}`, adminUserId);
    await audit(db, { actorType: 'ADMIN', actorId: adminUserId, action: 'refund.rejected', entityType: 'refund', entityId: r.id, before: { status: r.status }, after: { status: 'REJECTED' }, meta: { reason } });
    return (await loadRefund(db, r.id))!;
  });
}

// ------------------------------------------------------------------ processor

export interface ProcessResult {
  processed: number;
  succeeded: number;
  failed: number;
  awaitingDestination: number;
}

/** Processes APPROVED refunds and retries FAILED ones within the SYSTEM budget. */
export async function processRefunds(deps: AppDeps, filter: { transactionId?: string | undefined } = {}): Promise<ProcessResult> {
  const policy = await moneyPolicy(deps.sql);
  const res: ProcessResult = { processed: 0, succeeded: 0, failed: 0, awaitingDestination: 0 };
  const ids = await deps.sql<{ id: string }[]>`
    SELECT id FROM refunds
     WHERE (status = 'APPROVED' OR (status = 'FAILED' AND attempts < ${policy.refundMaxSystemRetries}))
       ${filter.transactionId ? deps.sql`AND transaction_id = ${filter.transactionId}` : deps.sql``}
     ORDER BY created_at LIMIT 100`;
  for (const { id } of ids) {
    const r = await processOneRefund(deps, id, policy.refundMaxSystemRetries);
    if (r === 'SKIPPED') continue;
    res.processed++;
    if (r === 'SUCCEEDED') res.succeeded++;
    else if (r === 'FAILED') res.failed++;
    else if (r === 'AWAITING_DESTINATION') res.awaitingDestination++;
  }
  return res;
}

type OneResult = 'SUCCEEDED' | 'FAILED' | 'PENDING' | 'AWAITING_DESTINATION' | 'SKIPPED';

async function processOneRefund(deps: AppDeps, refundId: string, maxRetries: number): Promise<OneResult> {
  // Phase 1: claim (APPROVED/FAILED → PROCESSING) and gather what the provider call needs.
  const claim = await deps.sql.begin(async (db) => {
    await setDbActor(db, 'SYSTEM', null);
    const [locked] = await db<Record<string, unknown>[]>`SELECT * FROM refunds WHERE id = ${refundId} FOR UPDATE SKIP LOCKED`;
    if (!locked) return null;
    const r = camel<RefundRow>(locked);
    if (r.status !== 'APPROVED' && r.status !== 'FAILED') return null;
    const method: RefundMethod = r.breakdown.method ?? 'PROVIDER_REFUND';
    const tx = (await loadTx(db, r.transactionId))!;
    const [pay] = await db<{ provider_ref: string | null; channel: string | null }[]>`SELECT provider_ref, channel FROM payments WHERE id = ${r.paymentId}`;
    let destination: { bankCode: string; accountNumber: string; holderName: string } | null = null;
    if (method === 'PAYOUT_TO_BUYER') {
      const [d] = await db<{ id: string; bank_code: string; account_number_enc: Buffer; holder_name_enc: Buffer; validation_status: string }[]>`
        SELECT id, bank_code, account_number_enc, holder_name_enc, validation_status FROM refund_destinations WHERE refund_id = ${r.id}`;
      if (!d || d.validation_status !== 'VALID') {
        if (!r.breakdown.destinationRequested) {
          await db`UPDATE refunds SET breakdown = breakdown || '{"destinationRequested": true}'::jsonb WHERE id = ${r.id}`;
          await emitEvent(db, 'refund', r.id, 'refund.destination_required', {
            refundId: r.id,
            transactionId: r.transactionId,
            buyerId: tx.buyerId,
            amountIdr: r.amountIdr,
          });
        }
        return { awaiting: true as const };
      }
      destination = {
        bankCode: d.bank_code,
        accountNumber: await deps.crypto.decryptString(new Uint8Array(d.account_number_enc), `refund_destinations.account_number:${d.id}`),
        holderName: await deps.crypto.decryptString(new Uint8Array(d.holder_name_enc), `refund_destinations.holder_name:${d.id}`),
      };
    }
    if (r.status === 'FAILED') {
      const check = refundFsm.canTransition('FAILED', 'PROCESSING', 'SYSTEM', { attempts: r.attempts, maxAttempts: maxRetries });
      if (!check.ok) return null;
    }
    await db`UPDATE refunds SET status = 'PROCESSING', attempts = attempts + 1, failure_reason = NULL WHERE id = ${r.id}`;
    return { awaiting: false as const, refund: r, method, providerRef: pay?.provider_ref ?? null, destination, buyerId: tx.buyerId };
  });
  if (!claim) return 'SKIPPED';
  if (claim.awaiting) return 'AWAITING_DESTINATION';
  const { refund, method, destination } = claim;

  // Phase 2: provider call (outside any DB transaction).
  let outcome: { status: 'SUCCEEDED' | 'PENDING' | 'FAILED'; providerRef?: string; reason?: string; switchToPayout?: boolean };
  try {
    if (method === 'PROVIDER_REFUND') {
      if (!claim.providerRef) throw new Error('payment has no provider reference');
      const r = await deps.providers.payment.refund({
        paymentProviderRef: claim.providerRef,
        referenceId: refund.number,
        amountIdr: refund.amountIdr,
        reason: `${refund.reasonCode}${refund.reasonNote ? `: ${refund.reasonNote}` : ''}`,
        idempotencyKey: `refund:${refund.id}`,
      });
      if (!r.supported) outcome = { status: 'FAILED', reason: 'REFUND_NOT_SUPPORTED_FOR_CHANNEL', switchToPayout: true };
      else outcome = { status: r.status, ...(r.providerRef ? { providerRef: r.providerRef } : {}), ...(r.status === 'FAILED' ? { reason: 'PROVIDER_REFUND_FAILED' } : {}) };
    } else {
      const d = destination!;
      const r = await deps.providers.payment.payout({
        referenceId: refund.number,
        amountIdr: refund.amountIdr,
        bankCode: d.bankCode,
        accountNumber: d.accountNumber,
        accountHolderName: d.holderName,
        description: `Refund JastipKita ${refund.number}`,
        idempotencyKey: `refund-payout:${refund.id}`,
      });
      outcome = { status: r.status, providerRef: r.providerRef, ...(r.status === 'FAILED' ? { reason: 'DISBURSEMENT_FAILED' } : {}) };
    }
  } catch (err) {
    outcome = { status: 'FAILED', reason: `PROVIDER_ERROR: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}` };
  }

  // Phase 3: record the result.
  return deps.sql.begin(async (db) => {
    await setDbActor(db, 'SYSTEM', null);
    const r = (await loadRefund(db, refund.id, true))!;
    if (r.status !== 'PROCESSING') return 'SKIPPED' as const;
    if (outcome.status === 'SUCCEEDED') {
      await markRefundSucceeded(deps, db, r, outcome.providerRef ?? null);
      return 'SUCCEEDED' as const;
    }
    if (outcome.status === 'PENDING') {
      if (outcome.providerRef) await db`UPDATE refunds SET provider_ref = ${outcome.providerRef} WHERE id = ${r.id}`;
      return 'PENDING' as const;
    }
    await db`UPDATE refunds SET status = 'FAILED', failure_reason = ${outcome.reason ?? 'FAILED'} WHERE id = ${r.id}`;
    if (outcome.switchToPayout) {
      // Channel cannot be refunded: switch to disbursement; the switch does not consume the retry budget.
      await db`UPDATE refunds SET attempts = 0, breakdown = breakdown || '{"method":"PAYOUT_TO_BUYER"}'::jsonb WHERE id = ${r.id}`;
    }
    const tx = (await loadTx(db, r.transactionId))!;
    await emitEvent(db, 'refund', r.id, 'refund.failed', {
      refundId: r.id,
      transactionId: r.transactionId,
      buyerId: tx.buyerId,
      amountIdr: r.amountIdr,
      reason: outcome.reason ?? null,
      willRetry: outcome.switchToPayout ? true : r.attempts < maxRetries,
    });
    await audit(db, { actorType: 'SYSTEM', actorId: null, action: 'refund.failed', entityType: 'refund', entityId: r.id, meta: { reason: outcome.reason ?? null, attempts: r.attempts } });
    return 'FAILED' as const;
  });
}

/** PROCESSING → SUCCEEDED: payment refunded amount, REFUND_PAID journal, events, transaction finalization. */
export async function markRefundSucceeded(deps: AppDeps, db: TxSql, r: RefundRow, providerRef: string | null): Promise<void> {
  const now = deps.clock.now();
  // Lock order used across the money group: transaction → payment → refund rows.
  await loadTx(db, r.transactionId, { forUpdate: true });
  await db`UPDATE refunds SET status = 'SUCCEEDED', processed_at = ${now}, provider_ref = coalesce(${providerRef}, provider_ref) WHERE id = ${r.id}`;
  const [p] = await db<{ amount_idr: number; refunded_idr: number; status: string }[]>`
    SELECT amount_idr, refunded_idr, status FROM payments WHERE id = ${r.paymentId} FOR UPDATE`;
  const refunded = Number(p!.refunded_idr) + r.amountIdr;
  const newStatus = refunded >= Number(p!.amount_idr) ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
  if (p!.status !== newStatus) {
    await db`UPDATE payments SET refunded_idr = ${refunded}, status = ${newStatus}, version = version + 1 WHERE id = ${r.paymentId}`;
  } else {
    await db`UPDATE payments SET refunded_idr = ${refunded}, version = version + 1 WHERE id = ${r.paymentId}`;
  }
  const tx = (await loadTx(db, r.transactionId))!;
  await postJournal(db, {
    kind: 'REFUND_PAID',
    description: `Refund ${r.number} paid out`,
    transactionId: r.transactionId,
    idempotencyKey: `refund-paid:${r.id}`,
    refs: { refundId: r.id, paymentId: r.paymentId },
    meta: { method: r.breakdown.method ?? null },
    entries: [
      { bucket: 'REFUND', owner: tx.buyerId, direction: 'DEBIT', amount: r.amountIdr },
      { bucket: 'PROVIDER_CASH', direction: 'CREDIT', amount: r.amountIdr },
    ],
  });
  await emitEvent(db, 'refund', r.id, 'refund.succeeded', {
    refundId: r.id,
    refundNumber: r.number,
    transactionId: r.transactionId,
    buyerId: tx.buyerId,
    amountIdr: r.amountIdr,
    method: r.breakdown.method ?? null,
  });
  await audit(db, {
    actorType: 'SYSTEM',
    actorId: null,
    action: 'refund.succeeded',
    entityType: 'refund',
    entityId: r.id,
    before: { status: 'PROCESSING' },
    after: { status: 'SUCCEEDED' },
    meta: { amountIdr: r.amountIdr, paymentId: r.paymentId },
  });
  await maybeFinalizeRefunds(deps, db, r.transactionId);
}

/**
 * When every refund of a REFUND_PENDING transaction has succeeded:
 * - txOutcome REFUNDED → any escrow left (promo-funded part) goes back to PROMOTION_CREDIT/PLATFORM → REFUNDED
 * - txOutcome COMPLETED → remainder released to the traveler + payout → COMPLETED (partial refund settled)
 */
export async function maybeFinalizeRefunds(deps: AppDeps, db: TxSql, transactionId: string): Promise<void> {
  let tx = (await loadTx(db, transactionId, { forUpdate: true }))!;
  if (tx.status !== 'REFUND_PENDING') return;
  const [open] = await db<{ n: number }[]>`
    SELECT count(*)::int AS n FROM refunds WHERE transaction_id = ${tx.id} AND status = ANY(${[...OPEN_STATUSES]}::text[])`;
  if ((open?.n ?? 0) > 0) return;
  const refunds = await db<{ breakdown: RefundBreakdown; status: string }[]>`
    SELECT breakdown, status FROM refunds WHERE transaction_id = ${tx.id} ORDER BY created_at DESC`;
  const relevant = refunds.filter((x) => x.breakdown.txOutcome !== 'NONE');
  const outcome = relevant[0]?.breakdown.txOutcome ?? 'REFUNDED';
  const held = await transactionBuckets(db, tx.id);
  if (outcome === 'COMPLETED' && tx.travelerId) {
    const { releaseRemainderToTraveler } = await import('../transactions/completion');
    const scheduled = await releaseRemainderToTraveler(deps, db, tx, held);
    assertCanTransition(tx.status, 'COMPLETED', 'SYSTEM', { refundSucceeded: true, refundType: 'PARTIAL', remainderPaidOut: scheduled });
    tx = await transitionTx(db, tx, 'COMPLETED', 'SYSTEM', null, 'Refund parsial selesai, sisa dana dibayarkan ke traveler');
    await emitEvent(db, 'transaction', tx.id, 'receipt.final_available', { transactionId: tx.id, buyerId: tx.buyerId });
    return;
  }
  const leftover = held.PRODUCT_FUND + held.CUSTOMS_RESERVE + held.CLEARING;
  if (leftover > 0) {
    const promoFunded = Math.max(0, -held.PROMOTION_CREDIT);
    const toPromo = Math.min(leftover, promoFunded);
    await postJournal(db, {
      kind: 'REMAINDER_RELEASE',
      description: `Escrow remainder after full refund of ${tx.number}`,
      transactionId: tx.id,
      idempotencyKey: `remainder:${tx.id}`,
      entries: [
        { bucket: 'PRODUCT_FUND', direction: 'DEBIT', amount: held.PRODUCT_FUND },
        { bucket: 'CUSTOMS_RESERVE', direction: 'DEBIT', amount: held.CUSTOMS_RESERVE },
        { bucket: 'CLEARING', direction: 'DEBIT', amount: held.CLEARING },
        { bucket: 'PROMOTION_CREDIT', direction: 'CREDIT', amount: toPromo, memo: 'promo-funded share returned' },
        { bucket: 'PLATFORM_REVENUE', direction: 'CREDIT', amount: leftover - toPromo, memo: 'unrefunded remainder' },
      ],
    });
  }
  assertCanTransition(tx.status, 'REFUNDED', 'SYSTEM', { refundSucceeded: true, refundType: 'FULL' });
  tx = await transitionTx(db, tx, 'REFUNDED', 'SYSTEM', null, 'Refund selesai');
}

// ------------------------------------------------------------------ provider webhooks for refunds

export async function processRefundEvent(deps: AppDeps, e: { providerRef: string; referenceId?: string | undefined; status: string }): Promise<string> {
  return deps.sql.begin(async (db) => {
    await setDbActor(db, 'SYSTEM', null);
    const rows = await db<Record<string, unknown>[]>`
      SELECT * FROM refunds WHERE provider_ref = ${e.providerRef} OR number = ${e.referenceId ?? ''} LIMIT 1 FOR UPDATE`;
    if (!rows[0]) return 'NOT_FOUND';
    const r = camel<RefundRow>(rows[0]);
    if (r.status !== 'PROCESSING') return 'ALREADY_PROCESSED';
    if (e.status === 'SUCCEEDED') {
      await markRefundSucceeded(deps, db, r, e.providerRef || null);
      return 'SUCCEEDED';
    }
    if (e.status === 'FAILED' || e.status === 'EXPIRED') {
      await db`UPDATE refunds SET status = 'FAILED', failure_reason = 'PROVIDER_REPORTED_FAILURE' WHERE id = ${r.id}`;
      return 'FAILED';
    }
    return 'IGNORED';
  });
}

// ------------------------------------------------------------------ buyer destination & reads

export interface DestinationInput {
  bankCode: string;
  accountNumber: string;
  accountHolderName: string;
  /** SEC-12: SENSITIVE_ACTION OTP bound to (REFUND_DESTINATION_SET, refund id). */
  stepUp?: { challengeId: string; code: string } | undefined;
}

export async function setRefundDestination(deps: AppDeps, auth: AuthContext, refundId: string, input: DestinationInput, req: RequestMeta | null = null) {
  const refund = await loadRefund(deps.sql, refundId);
  if (!refund) throw Errors.notFound('Refund', 'REFUND_NOT_FOUND');
  const { tx } = await requireParty(deps.sql, refund.transactionId, auth, { role: 'BUYER' }).catch(() => {
    throw Errors.notFound('Refund', 'REFUND_NOT_FOUND');
  });
  if ((refund.breakdown.method ?? 'PROVIDER_REFUND') !== 'PAYOUT_TO_BUYER') {
    throw Errors.unprocessable('DESTINATION_NOT_REQUIRED', 'Refund ini dikembalikan ke metode pembayaran asal');
  }
  if (!['APPROVED', 'PENDING_APPROVAL', 'FAILED', 'REQUESTED'].includes(refund.status)) {
    throw Errors.unprocessable('REFUND_NOT_EDITABLE', 'Rekening tujuan tidak dapat diubah pada status refund ini', { status: refund.status });
  }
  const accountNumber = input.accountNumber.replace(/[\s-]/g, '');
  if (!/^\d{6,20}$/.test(accountNumber)) throw Errors.validation({ accountNumber: 'Nomor rekening 6–20 digit' });
  // SEC-12: a hijacked session must not be able to redirect a refund — fresh single-use OTP to the verified
  // phone/e-mail, bound to this refund (verified + consumed in its own committed transaction).
  const stepUp = await consumeSensitiveActionOtp(deps, { userId: auth.userId, action: 'REFUND_DESTINATION_SET', targetId: refund.id, proof: input.stepUp }, req);
  const validation = (await deps.providers.payment.validateBankAccount({ bankCode: input.bankCode, accountNumber })) as {
    valid: boolean;
    holderName?: string;
    reason?: string;
  };
  if (!validation.valid) {
    throw Errors.unprocessable(
      validation.reason === 'NAME_VALIDATION_UNAVAILABLE' ? 'BANK_ACCOUNT_VALIDATION_UNAVAILABLE' : 'BANK_ACCOUNT_INVALID',
      validation.reason === 'NAME_VALIDATION_UNAVAILABLE'
        ? 'Validasi rekening belum tersedia; tim kami akan menghubungi Anda'
        : 'Rekening tidak valid atau tidak ditemukan',
    );
  }
  // Holder name vs the verified KYC identity (buyer ≥ L3): a different name is never auto-accepted → PENDING_REVIEW
  // (the processor only pays VALID destinations; FINANCE approves/rejects via /v1/admin/refund-destinations).
  const identityName = await verifiedIdentityName(deps, deps.sql, auth.userId);
  const bankHolder = validation.holderName ?? input.accountHolderName.trim();
  const nameMatch: 'MATCH' | 'MISMATCH' | 'NO_IDENTITY' = identityName ? (namesMatch(bankHolder, identityName) ? 'MATCH' : 'MISMATCH') : 'NO_IDENTITY';
  const validationStatus = nameMatch === 'MISMATCH' ? ('PENDING_REVIEW' as const) : ('VALID' as const);
  const now = deps.clock.now();
  const validatedAt = validationStatus === 'VALID' ? now : null;
  return deps.sql.begin(async (db) => {
    const [existing] = await db<{ id: string }[]>`SELECT id FROM refund_destinations WHERE refund_id = ${refund.id} FOR UPDATE`;
    const id = existing?.id ?? crypto.randomUUID();
    const enc = await deps.crypto.encrypt(accountNumber, `refund_destinations.account_number:${id}`);
    const holderEnc = await deps.crypto.encrypt(input.accountHolderName.trim(), `refund_destinations.holder_name:${id}`);
    const hash = await deps.crypto.hashIdentifier('bank_account', `${input.bankCode}:${accountNumber}`);
    const mask = maskAccount(accountNumber);
    if (existing) {
      await db`UPDATE refund_destinations SET bank_code = ${input.bankCode}, account_number_enc = ${Buffer.from(enc)},
                 account_number_hash = ${Buffer.from(hash)}, account_mask = ${mask}, holder_name_enc = ${Buffer.from(holderEnc)},
                 enc_key_id = ${deps.crypto.activeKeyId}, validation_status = ${validationStatus}, validated_at = ${validatedAt},
                 name_match = ${nameMatch}, step_up_challenge_id = ${stepUp.challengeId},
                 reviewed_by = NULL, reviewed_at = NULL, review_note = NULL WHERE id = ${id}`;
    } else {
      await db`INSERT INTO refund_destinations (id, refund_id, buyer_id, bank_code, account_number_enc, account_number_hash, account_mask,
                                                holder_name_enc, enc_key_id, validation_status, validated_at, name_match, step_up_challenge_id)
               VALUES (${id}, ${refund.id}, ${tx.buyerId}, ${input.bankCode}, ${Buffer.from(enc)}, ${Buffer.from(hash)}, ${mask},
                       ${Buffer.from(holderEnc)}, ${deps.crypto.activeKeyId}, ${validationStatus}, ${validatedAt}, ${nameMatch}, ${stepUp.challengeId})`;
    }
    if (refund.status === 'FAILED') await db`UPDATE refunds SET attempts = 0 WHERE id = ${refund.id}`;
    if (nameMatch === 'MISMATCH') {
      await securityEvent(deps, db, { userId: auth.userId, type: 'REFUND_DESTINATION_NAME_MISMATCH', severity: 'MEDIUM', req, meta: { refundId: refund.id, bankCode: input.bankCode, accountMask: mask } });
    }
    await audit(db, {
      actorType: 'BUYER',
      actorId: auth.userId,
      action: 'refund.destination_set',
      entityType: 'refund',
      entityId: refund.id,
      meta: { bankCode: input.bankCode, accountMask: mask, validationStatus, nameMatch, stepUpChallengeId: stepUp.challengeId },
    });
    await emitEvent(db, 'refund', refund.id, 'refund.destination_set', {
      refundId: refund.id,
      transactionId: refund.transactionId,
      buyerId: tx.buyerId,
      validationStatus,
    });
    return {
      refundId: refund.id,
      bankCode: input.bankCode,
      accountMask: mask,
      validationStatus,
      reviewRequired: validationStatus === 'PENDING_REVIEW',
      validatedAt: validatedAt?.toISOString() ?? null,
    };
  });
}

export async function refundViews(db: Db, transactionId: string) {
  const rows = await db<Record<string, unknown>[]>`
    SELECT r.*, d.bank_code AS dest_bank_code, d.account_mask AS dest_account_mask, d.validation_status AS dest_status
      FROM refunds r LEFT JOIN refund_destinations d ON d.refund_id = r.id
     WHERE r.transaction_id = ${transactionId} ORDER BY r.created_at`;
  return rows.map((row) => {
    const r = camel<RefundRow & { destBankCode: string | null; destAccountMask: string | null; destStatus: string | null }>(row);
    const method = r.breakdown.method ?? 'PROVIDER_REFUND';
    return {
      id: r.id,
      number: r.number,
      paymentId: r.paymentId,
      reasonCode: r.reasonCode,
      reasonNote: r.reasonNote,
      amountIdr: r.amountIdr,
      type: r.type,
      status: r.status,
      method,
      // A rejected/invalid destination must be replaced by the buyer (the row is updated in place on resubmission).
      destinationRequired:
        method === 'PAYOUT_TO_BUYER' &&
        (!r.destStatus || r.destStatus === 'REJECTED' || r.destStatus === 'INVALID') &&
        !['SUCCEEDED', 'REJECTED', 'CANCELLED'].includes(r.status),
      destination: r.destStatus ? { bankCode: r.destBankCode, accountMask: r.destAccountMask, validationStatus: r.destStatus } : null,
      failureReason: r.failureReason,
      processedAt: r.processedAt ? new Date(r.processedAt).toISOString() : null,
      createdAt: new Date(r.createdAt).toISOString(),
    };
  });
}
