/**
 * SafePay payments: provider checkout creation, webhook/reconciliation event processing (idempotent,
 * order-independent), payment expiry, and protection-policy binding.
 */
import type { AppDeps } from '../../context';
import type { TxSql } from '../../db/sql';
import { AppError, Errors } from '../../lib/errors';
import { providerEnv } from '../../providers/payment';
import { normalizeChannel } from '../../providers/payment/channels';
import { audit } from '../../services/audit';
import { emitEvent } from '../../services/outbox';
import { recordRiskAssessment } from '../../services/risk';
import { loadQuote } from '../checkout/repository';
import { captureEntries, postJournal } from '../ledger/service';
import { loadTx, setDbActor, transitionTx, type TxRow, assertCanTransition } from '../transactions/common';
import { loadPayment, type PaymentRow, findPaymentByProviderRef } from './repository';

// ------------------------------------------------------------------ creation

export interface CreatePaymentInput {
  tx: TxRow;
  purpose: 'CHECKOUT' | 'SUPPLEMENTAL';
  quoteId: string | null;
  amountIdr: number;
  channel: string;
  expiresAt: Date;
  description: string;
}

/**
 * Inserts a PENDING payment and opens a provider checkout inside the caller's DB transaction.
 * Provider idempotency key = `pay:<paymentId>` (one key per payment). If the provider call fails the whole
 * DB transaction rolls back (an orphan provider session simply expires).
 */
export async function createPayment(deps: AppDeps, db: TxSql, input: CreatePaymentInput): Promise<PaymentRow> {
  const provider = deps.providers.payment;
  const id = crypto.randomUUID();
  const idempotencyKey = `pay:${id}`;
  await db`
    INSERT INTO payments (id, transaction_id, quote_id, purpose, provider, provider_env, channel, amount_idr, status,
                          expires_at, idempotency_key)
    VALUES (${id}, ${input.tx.id}, ${input.quoteId}, ${input.purpose}, ${provider.name}, ${providerEnv(provider)},
            ${normalizeChannel(input.channel) ?? null}, ${input.amountIdr}, 'PENDING', ${input.expiresAt}, ${idempotencyKey})`;
  const session = await provider.createCheckout({
    referenceId: id,
    amountIdr: input.amountIdr,
    description: input.description,
    customer: {},
    channels: [input.channel],
    expiresAt: input.expiresAt,
    idempotencyKey,
    metadata: { transactionId: input.tx.id, transactionNumber: input.tx.number, purpose: input.purpose, ...(input.quoteId ? { quoteId: input.quoteId } : {}) },
  });
  await db`UPDATE payments SET provider_ref = ${session.providerRef}, checkout_url = ${session.checkoutUrl},
             expires_at = ${session.expiresAt} WHERE id = ${id}`;
  return (await loadPayment(db, id))!;
}

// ------------------------------------------------------------------ credit / promo side effects

/** Reverses the JastipKita Credit redeemed at checkout for this payment (idempotent). */
export async function reverseCreditRedemption(db: TxSql, payment: Pick<PaymentRow, 'id'>, buyerId: string): Promise<number> {
  const [redeem] = await db<{ amount_idr: number }[]>`
    SELECT amount_idr FROM credit_entries WHERE idempotency_key = ${`redeem:${payment.id}`}`;
  if (!redeem) return 0;
  const amount = -Number(redeem.amount_idr);
  await db`
    INSERT INTO credit_entries (user_id, amount_idr, reason, reference_type, reference_id, idempotency_key, note)
    VALUES (${buyerId}, ${amount}, 'REDEEM_REVERSAL', 'payment', ${payment.id}, ${`redeem-reversal:${payment.id}`},
            'Pembayaran tidak selesai — credit dikembalikan')
    ON CONFLICT (idempotency_key) DO NOTHING`;
  return amount;
}

// ------------------------------------------------------------------ event processing

export interface PaymentEventInput {
  provider: 'XENDIT' | 'MOCK';
  providerRef: string;
  referenceId?: string | undefined;
  /** Normalized: SUCCEEDED | EXPIRED | FAILED | PENDING */
  status: string;
  amountIdr?: number | undefined;
  currency?: string | undefined;
  channel?: string | undefined;
  source: 'WEBHOOK' | 'RECONCILIATION' | 'DEV' | 'EXPIRY_JOB';
  /** payment_webhook_events.id to mark processed in the same DB transaction. */
  inboxId?: number | undefined;
  signatureValid: boolean;
}

export type PaymentEventOutcome =
  | 'SECURED'
  | 'SECURED_LATE_REFUND'
  | 'ALREADY_PROCESSED'
  | 'AMOUNT_MISMATCH'
  | 'EXPIRED'
  | 'FAILED'
  | 'IGNORED'
  | 'PAYMENT_NOT_FOUND';

const SUCCESS = new Set(['SUCCEEDED', 'SECURED', 'COMPLETED', 'PAID', 'CAPTURED', 'SETTLED']);

/**
 * Applies one provider payment event. Safe under retries and out-of-order delivery:
 * - SUCCEEDED on PENDING → SECURED (+ capture journal, transaction AWAITING_PAYMENT → PAYMENT_SECURED)
 * - SUCCEEDED on EXPIRED/FAILED, or for a transaction that moved on → SECURED then automatic refund (late payment)
 * - SUCCEEDED on SECURED/REFUNDED → no-op
 * - amount/currency mismatch → no state change, risk assessment HOLD + alert
 * - EXPIRED/FAILED on PENDING → payment EXPIRED/FAILED, credit reversed, transaction back to MATCHED
 * - EXPIRED/FAILED on anything else → no-op (a success already arrived)
 */
export async function processPaymentEvent(deps: AppDeps, e: PaymentEventInput): Promise<{ outcome: PaymentEventOutcome; paymentId?: string; transactionId?: string }> {
  const now = deps.clock.now();
  const result = await deps.sql.begin(async (db) => {
    await setDbActor(db, 'SYSTEM', null);
    let payment: PaymentRow | null = null;
    if (e.providerRef) payment = await findPaymentByProviderRef(db, e.provider, e.providerRef);
    if (!payment && e.referenceId && /^[0-9a-f-]{36}$/i.test(e.referenceId)) payment = await loadPayment(db, e.referenceId);
    if (!payment || payment.provider !== e.provider) {
      if (e.inboxId) await db`UPDATE payment_webhook_events SET processed_at = ${now}, processing_error = 'PAYMENT_NOT_FOUND' WHERE id = ${e.inboxId}`;
      return { outcome: 'PAYMENT_NOT_FOUND' as const };
    }
    // Lock order everywhere: transaction row first, then payment row.
    const tx = (await loadTx(db, payment.transactionId, { forUpdate: true }))!;
    payment = (await loadPayment(db, payment.id, { forUpdate: true }))!;
    if (e.inboxId) await db`UPDATE payment_webhook_events SET payment_id = ${payment.id} WHERE id = ${e.inboxId}`;

    let outcome: PaymentEventOutcome;
    if (SUCCESS.has(e.status.toUpperCase())) {
      outcome = await applySuccess(deps, db, tx, payment, e, now);
    } else if (e.status === 'EXPIRED' || e.status === 'FAILED') {
      outcome = await applyExpiry(deps, db, tx, payment, e.status, now, e.source);
    } else {
      outcome = 'IGNORED';
    }
    if (e.inboxId) await db`UPDATE payment_webhook_events SET processed_at = ${now}, processing_error = NULL WHERE id = ${e.inboxId}`;
    return { outcome, paymentId: payment.id, transactionId: tx.id };
  });
  // Post-commit: late payments are refunded by the refund processor; kick it for immediacy.
  if (result.outcome === 'SECURED_LATE_REFUND' || result.outcome === 'EXPIRED' || result.outcome === 'FAILED') {
    const { processRefunds } = await import('../refunds/service');
    await processRefunds(deps, { transactionId: result.transactionId });
  }
  return result;
}

async function applySuccess(deps: AppDeps, db: TxSql, tx: TxRow, payment: PaymentRow, e: PaymentEventInput, now: Date): Promise<PaymentEventOutcome> {
  if (payment.status === 'SECURED' || payment.status === 'REFUNDED' || payment.status === 'PARTIALLY_REFUNDED') {
    return 'ALREADY_PROCESSED';
  }
  // Verify amount & currency against our row (and, for webhooks, the provider's own view).
  let providerAmount = e.amountIdr;
  let providerCurrency = e.currency ?? 'IDR';
  if (e.source === 'WEBHOOK' && payment.providerRef) {
    // SEC-03: the static callback token alone must never secure funds. The provider's own view (GET) has to
    // confirm the payment; otherwise nothing changes and the webhook answers 5xx, so the provider retries and
    // the PENDING-payment reconciliation poll settles it later (fail closed — a leaked token cannot mint money).
    let p: Awaited<ReturnType<typeof deps.providers.payment.getPayment>>;
    try {
      p = await deps.providers.payment.getPayment(payment.providerRef);
    } catch (err) {
      deps.logger.warn('payment.provider_recheck_failed', { paymentId: payment.id, error: err instanceof Error ? err.message : String(err) });
      throw new AppError(503, 'PROVIDER_RECHECK_UNAVAILABLE', 'Status pembayaran belum dapat diverifikasi ke penyedia; coba lagi');
    }
    if (p.status !== 'SECURED') {
      deps.logger.error('ALERT payment.webhook_not_confirmed_by_provider', { paymentId: payment.id, providerStatus: p.status });
      throw new AppError(409, 'PAYMENT_NOT_CONFIRMED_BY_PROVIDER', 'Penyedia pembayaran belum mengonfirmasi pembayaran ini', { providerStatus: p.status });
    }
    if (providerAmount === undefined) providerAmount = p.amountIdr;
    if (p.amountIdr !== payment.amountIdr) providerAmount = p.amountIdr;
    providerCurrency = e.currency ?? p.currency;
  }
  const amountMatches = providerAmount === payment.amountIdr;
  const currencyMatches = (providerCurrency ?? 'IDR').toUpperCase() === 'IDR';
  if (!e.signatureValid || !amountMatches || !currencyMatches) {
    await recordRiskAssessment(
      db,
      'PAYMENT',
      payment.id,
      {
        score: 80,
        decision: 'HOLD',
        reasons: [
          ...(!amountMatches ? [{ code: 'PAYMENT_AMOUNT_MISMATCH', weight: 60, message: `Nominal ${providerAmount ?? 'null'} ≠ ${payment.amountIdr}` }] : []),
          ...(!currencyMatches ? [{ code: 'PAYMENT_CURRENCY_MISMATCH', weight: 60, message: `Mata uang ${providerCurrency}` }] : []),
          ...(!e.signatureValid ? [{ code: 'PAYMENT_SIGNATURE_INVALID', weight: 80, message: 'Signature invalid' }] : []),
        ],
      },
      { expectedIdr: payment.amountIdr, receivedIdr: providerAmount ?? null, currency: providerCurrency ?? null, source: e.source },
      'money-v1',
    );
    await db`UPDATE transactions SET payout_hold_reason = coalesce(payout_hold_reason, 'PAYMENT_AMOUNT_MISMATCH') WHERE id = ${tx.id}`;
    await emitEvent(db, 'payment', payment.id, 'payment.amount_mismatch', {
      paymentId: payment.id,
      transactionId: tx.id,
      expectedIdr: payment.amountIdr,
      receivedIdr: providerAmount ?? null,
      currency: providerCurrency ?? null,
    });
    deps.logger.error('ALERT payment.amount_mismatch', { paymentId: payment.id, transactionId: tx.id, expectedIdr: payment.amountIdr, receivedIdr: providerAmount });
    await audit(db, {
      actorType: 'SYSTEM',
      actorId: null,
      action: 'payment.amount_mismatch',
      entityType: 'payment',
      entityId: payment.id,
      meta: { expectedIdr: payment.amountIdr, receivedIdr: providerAmount ?? null, currency: providerCurrency ?? null },
    });
    return 'AMOUNT_MISMATCH';
  }

  const channel = normalizeChannel(e.channel) ?? payment.channel;
  const wasPending = payment.status === 'PENDING';
  await db`UPDATE payments SET status = 'SECURED', secured_at = ${now}, channel = ${channel}, failure_reason = NULL,
             version = version + 1 WHERE id = ${payment.id}`;

  const isCurrent =
    wasPending &&
    tx.status === 'AWAITING_PAYMENT' &&
    (payment.purpose === 'SUPPLEMENTAL' || payment.quoteId === tx.activeQuoteId);

  if (!isCurrent) {
    // Late / orphan funds: record them (never lose money) and refund automatically.
    await postJournal(db, {
      kind: 'LATE_PAYMENT_CAPTURED',
      description: `Late payment ${payment.id} on ${tx.number} (${tx.status}) — to be refunded`,
      transactionId: tx.id,
      idempotencyKey: `capture:${payment.id}`,
      refs: { paymentId: payment.id },
      meta: { txStatus: tx.status, previousPaymentStatus: payment.status },
      entries: [
        { bucket: 'PROVIDER_CASH', direction: 'DEBIT', amount: payment.amountIdr },
        { bucket: 'REFUND', owner: tx.buyerId, direction: 'CREDIT', amount: payment.amountIdr, memo: 'late payment — full refund' },
      ],
    });
    const { createRefundRows } = await import('../refunds/service');
    await createRefundRows(deps, db, tx, {
      allocations: [{ payment: { ...payment, status: 'SECURED' }, amountIdr: payment.amountIdr }],
      reasonCode: 'LATE_PAYMENT',
      reasonNote: `Pembayaran diterima setelah ${payment.status === 'PENDING' ? 'transaksi berubah' : 'kedaluwarsa'}; dikembalikan otomatis`,
      requestedBy: null,
      breakdown: { source: 'LATE_PAYMENT', allocationPosted: true, txOutcome: 'NONE' },
      idempotencyPrefix: `late:${payment.id}`,
    });
    await audit(db, { actorType: 'SYSTEM', actorId: null, action: 'payment.late_secured', entityType: 'payment', entityId: payment.id, meta: { transactionId: tx.id, txStatus: tx.status } });
    return 'SECURED_LATE_REFUND';
  }

  const guardCtx = { paymentSignatureValid: true, paymentAmountMatches: true, paymentCurrencyMatches: true };
  if (payment.purpose === 'CHECKOUT') {
    const q = (await loadQuote(db, payment.quoteId!))!;
    await postJournal(db, {
      kind: 'PAYMENT_CAPTURED',
      description: `Payment captured for ${tx.number}`,
      transactionId: tx.id,
      idempotencyKey: `capture:${payment.id}`,
      refs: { paymentId: payment.id },
      meta: { quoteId: q.quote.id, channel },
      entries: captureEntries(q.amounts, payment.amountIdr),
    });
    await db`UPDATE promotion_redemptions SET status = 'APPLIED', applied_at = ${now}
              WHERE transaction_id = ${tx.id} AND quote_id = ${q.quote.id} AND status = 'RESERVED'`;
    assertCanTransition(tx.status, 'PAYMENT_SECURED', 'SYSTEM', guardCtx);
    const next = await transitionTx(db, tx, 'PAYMENT_SECURED', 'SYSTEM', null, 'Pembayaran diamankan SafePay', { paymentId: payment.id });
    await db`UPDATE transactions SET secured_idr = secured_idr + ${payment.amountIdr} WHERE id = ${next.id}`;
  } else {
    // Supplemental top-up after an approved price increase: funds the higher purchase ceiling.
    await postJournal(db, {
      kind: 'SUPPLEMENTAL_CAPTURED',
      description: `Supplemental payment captured for ${tx.number}`,
      transactionId: tx.id,
      idempotencyKey: `capture:${payment.id}`,
      refs: { paymentId: payment.id },
      entries: [
        { bucket: 'PROVIDER_CASH', direction: 'DEBIT', amount: payment.amountIdr },
        { bucket: 'PRODUCT_FUND', direction: 'CREDIT', amount: payment.amountIdr, memo: 'approved price increase' },
      ],
    });
    assertCanTransition(tx.status, 'PAYMENT_SECURED', 'SYSTEM', guardCtx);
    const secured = await transitionTx(db, tx, 'PAYMENT_SECURED', 'SYSTEM', null, 'Pembayaran tambahan diamankan', { paymentId: payment.id });
    await db`UPDATE transactions SET secured_idr = secured_idr + ${payment.amountIdr} WHERE id = ${secured.id}`;
    const fresh = (await loadTx(db, secured.id))!;
    // Approved ceiling is now fully funded → purchase approved (SYSTEM, PRICE_WITHIN_TOLERANCE).
    assertCanTransition(fresh.status, 'PURCHASE_APPROVED', 'SYSTEM', { priceWithinTolerance: true });
    await transitionTx(db, fresh, 'PURCHASE_APPROVED', 'SYSTEM', null, 'Harga baru disetujui & dana tambahan diamankan', { paymentId: payment.id });
    await db`UPDATE transactions SET purchase_approved_at = ${now} WHERE id = ${tx.id}`;
  }
  await emitEvent(db, 'payment', payment.id, 'payment.secured', {
    paymentId: payment.id,
    transactionId: tx.id,
    buyerId: tx.buyerId,
    travelerId: tx.travelerId,
    amountIdr: payment.amountIdr,
    channel,
    purpose: payment.purpose,
  });
  await audit(db, {
    actorType: 'SYSTEM',
    actorId: null,
    action: 'payment.secured',
    entityType: 'payment',
    entityId: payment.id,
    before: { status: payment.status },
    after: { status: 'SECURED' },
    meta: { transactionId: tx.id, amountIdr: payment.amountIdr, source: e.source },
  });
  return 'SECURED';
}

async function applyExpiry(
  deps: AppDeps,
  db: TxSql,
  tx: TxRow,
  payment: PaymentRow,
  status: 'EXPIRED' | 'FAILED',
  now: Date,
  source: PaymentEventInput['source'],
): Promise<PaymentEventOutcome> {
  if (payment.status !== 'PENDING') return 'ALREADY_PROCESSED';
  await db`UPDATE payments SET status = ${status}, failure_reason = ${status === 'EXPIRED' ? 'Invoice kedaluwarsa' : 'Pembayaran gagal di provider'},
             version = version + 1 WHERE id = ${payment.id}`;
  const creditBack = await reverseCreditRedemption(db, payment, tx.buyerId);
  if (payment.quoteId) {
    await db`UPDATE promotion_redemptions SET status = 'EXPIRED' WHERE quote_id = ${payment.quoteId} AND status = 'RESERVED'`;
  }
  const isCurrent = tx.status === 'AWAITING_PAYMENT' && (payment.purpose === 'SUPPLEMENTAL' || payment.quoteId === tx.activeQuoteId);
  if (isCurrent && payment.purpose === 'CHECKOUT') {
    assertCanTransition(tx.status, 'MATCHED', 'SYSTEM', { invoiceExpired: true });
    await transitionTx(db, tx, 'MATCHED', 'SYSTEM', null, 'Pembayaran kedaluwarsa/gagal — perlu penawaran harga baru', { paymentId: payment.id, source });
  } else if (isCurrent && payment.purpose === 'SUPPLEMENTAL') {
    // Buyer approved a price increase but never funded it → treated like an expired confirmation (no fault):
    // back to PAYMENT_SECURED (original funds are secured) then SYSTEM cancellation with a full refund.
    assertCanTransition(tx.status, 'PAYMENT_SECURED', 'SYSTEM', { paymentSignatureValid: true, paymentAmountMatches: true, paymentCurrencyMatches: true });
    const back = await transitionTx(db, tx, 'PAYMENT_SECURED', 'SYSTEM', null, 'Pembayaran tambahan tidak diselesaikan', { paymentId: payment.id });
    const { cancelInTx } = await import('../cancellation/service');
    await cancelInTx(deps, db, back, { actor: 'SYSTEM', actorId: null, reason: 'Pembayaran tambahan kedaluwarsa', cause: 'PRICE_CHANGE_REJECTED', refundReasonCode: 'PRICE_CONFIRMATION_EXPIRED' });
  }
  await emitEvent(db, 'payment', payment.id, status === 'EXPIRED' ? 'payment.expired' : 'payment.failed', {
    paymentId: payment.id,
    transactionId: tx.id,
    buyerId: tx.buyerId,
    travelerId: tx.travelerId,
    amountIdr: payment.amountIdr,
    channel: payment.channel,
    creditRestoredIdr: creditBack,
  });
  await audit(db, {
    actorType: 'SYSTEM',
    actorId: null,
    action: status === 'EXPIRED' ? 'payment.expired' : 'payment.failed',
    entityType: 'payment',
    entityId: payment.id,
    before: { status: 'PENDING' },
    after: { status },
    meta: { transactionId: tx.id, source },
  });
  return status;
}

// ------------------------------------------------------------------ jobs

/**
 * Expires PENDING payments past `expires_at`. Asks the provider first (a missed webhook may hide a
 * payment) — a SECURED answer secures the payment instead.
 */
export async function expireDuePayments(deps: AppDeps): Promise<{ expired: number; secured: number }> {
  const now = deps.clock.now();
  const due = await deps.sql<{ id: string; provider: 'XENDIT' | 'MOCK'; provider_ref: string | null; amount_idr: number }[]>`
    SELECT id, provider, provider_ref, amount_idr FROM payments WHERE status = 'PENDING' AND expires_at <= ${now} ORDER BY expires_at LIMIT 200`;
  let expired = 0;
  let secured = 0;
  for (const p of due) {
    let status = 'EXPIRED';
    let amountIdr: number | undefined;
    let channel: string | undefined;
    if (p.provider_ref && p.provider === deps.providers.payment.name) {
      try {
        const remote = await deps.providers.payment.getPayment(p.provider_ref);
        if (remote.status === 'SECURED') {
          status = 'SUCCEEDED';
          amountIdr = remote.amountIdr;
          channel = remote.channel;
        } else if (remote.status === 'FAILED') status = 'FAILED';
      } catch (err) {
        deps.logger.warn('payment.expiry_recheck_failed', { paymentId: p.id, error: err instanceof Error ? err.message : String(err) });
      }
    }
    const r = await processPaymentEvent(deps, {
      provider: p.provider,
      providerRef: p.provider_ref ?? '',
      referenceId: p.id,
      status,
      amountIdr: amountIdr ?? (status === 'SUCCEEDED' ? undefined : p.amount_idr),
      currency: 'IDR',
      channel,
      source: 'EXPIRY_JOB',
      signatureValid: true,
    });
    if (r.outcome === 'EXPIRED' || r.outcome === 'FAILED') expired++;
    if (r.outcome === 'SECURED' || r.outcome === 'SECURED_LATE_REFUND') secured++;
  }
  return { expired, secured };
}

/** Quotes and FX locks past their expiry → EXPIRED (SYSTEM, §15.8). */
export async function expireQuotesAndLocks(deps: AppDeps): Promise<{ quotes: number; locks: number }> {
  const now = deps.clock.now();
  const q = await deps.sql`UPDATE quotes SET status = 'EXPIRED' WHERE status = 'ACTIVE' AND expires_at <= ${now} RETURNING id`;
  const l = await deps.sql`UPDATE fx_locks SET status = 'EXPIRED' WHERE status = 'ACTIVE' AND expires_at <= ${now} RETURNING id`;
  return { quotes: q.length, locks: l.length };
}

// ------------------------------------------------------------------ protection policy (outbox subscriber)

/** Binds the JastipKita Protection policy after a CHECKOUT payment is secured (idempotent per transaction). */
export async function bindProtectionPolicy(deps: AppDeps, payload: { transactionId: string; purpose?: string }): Promise<void> {
  if (payload.purpose && payload.purpose !== 'CHECKOUT') return;
  const ins = deps.providers.insurance;
  if (ins.name === 'none') return;
  const [existing] = await deps.sql`SELECT id FROM insurance_policies WHERE transaction_id = ${payload.transactionId} AND status IN ('ACTIVE','CLAIMED')`;
  if (existing) return;
  const tx = await loadTx(deps.sql, payload.transactionId);
  if (!tx?.activeQuoteId) return;
  const q = await loadQuote(deps.sql, tx.activeQuoteId);
  if (!q) return;
  const [reqRow] = await deps.sql<{ category_code: string | null; merchant_country: string | null }[]>`
    SELECT category_code, merchant_country FROM requests WHERE id = ${tx.requestId}`;
  const coverages = ['LOSS', 'DAMAGE', 'NON_DELIVERY'];
  const sumInsured = Math.max(1, q.amounts.ITEM_PRICE);
  const quote = await ins.quote({ coverages, sumInsuredIdr: sumInsured, category: reqRow?.category_code ?? 'OTHER', originCountry: reqRow?.merchant_country?.trim() ?? 'XX' });
  const bound = await ins.bind({ transactionId: tx.id, productCode: quote.productCode, sumInsuredIdr: sumInsured, premiumIdr: quote.premiumIdr });
  const now = deps.clock.now();
  await deps.sql`
    INSERT INTO insurance_policies (transaction_id, provider, provider_env, product_code, coverages, premium_idr, sum_insured_idr,
                                    status, provider_ref, issued_at, expires_at)
    VALUES (${tx.id}, ${ins.name.toUpperCase().replace(/[^A-Z0-9_]/g, '_')}, ${ins.mode === 'LIVE' ? 'LIVE' : 'TEST'}, ${quote.productCode},
            ${quote.coverages}, ${quote.premiumIdr}, ${sumInsured}, 'ACTIVE', ${bound.policyRef}, ${now},
            ${new Date(now.getTime() + 120 * 86400_000)})
    ON CONFLICT DO NOTHING`;
}

export function assertPaymentPending(p: PaymentRow | null): asserts p is PaymentRow {
  if (!p) throw Errors.notFound('Pembayaran', 'PAYMENT_NOT_FOUND');
}
