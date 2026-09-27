/**
 * Price check & price confirmation (§5, §15.2). The purchase ceiling written here is the golden-rule
 * limit: purchase proofs above it are always rejected.
 */
import { convert, evaluatePriceChange, priceConfirmationFsm, resolveExpired, windowExpiresAt } from '@jastipkita/core';
import type { AppDeps, AuthContext } from '../../context';
import { camel, type Db, type TxSql } from '../../db/sql';
import { AppError, Errors } from '../../lib/errors';
import { audit } from '../../services/audit';
import { emitEvent } from '../../services/outbox';
import { loadQuote, loadRequest, type LoadedQuote } from '../checkout/repository';
import { createPayment } from '../payments/service';
import { paymentView } from '../payments/repository';
import { processRefunds } from '../refunds/service';
import { assertOwnedFiles, guardedTransition, loadTx, requireParty, setDbActor, type TxRow } from '../transactions/common';

export interface PriceConfirmationRow {
  id: string;
  transactionId: string;
  requestedBy: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CLARIFICATION_REQUESTED' | 'EXPIRED';
  originalPriceMinor: number;
  actualPriceMinor: number;
  currency: string;
  receiptFileId: string | null;
  notes: string | null;
  windowSeconds: number;
  expiresAt: Date;
  round: number;
  respondedAt: Date | null;
  responseNote: string | null;
  supplementalRequiredIdr: number;
  createdAt: Date;
}

async function loadPc(db: Db, id: string, forUpdate = false): Promise<PriceConfirmationRow | null> {
  const rows = forUpdate
    ? await db<Record<string, unknown>[]>`SELECT * FROM price_confirmations WHERE id = ${id} FOR UPDATE`
    : await db<Record<string, unknown>[]>`SELECT * FROM price_confirmations WHERE id = ${id}`;
  if (!rows[0]) return null;
  const pc = camel<PriceConfirmationRow>(rows[0]);
  return { ...pc, currency: pc.currency.trim() };
}

export function pcView(pc: PriceConfirmationRow, q: LoadedQuote | null) {
  const toIdr = (minor: number) => (pc.currency === 'IDR' || !q?.fxLock ? minor : convert(minor, pc.currency, 'IDR', q.fxLock.lockedRate));
  return {
    id: pc.id,
    status: pc.status,
    currency: pc.currency,
    originalPriceMinor: pc.originalPriceMinor,
    actualPriceMinor: pc.actualPriceMinor,
    originalIdr: toIdr(pc.originalPriceMinor),
    actualIdr: toIdr(pc.actualPriceMinor),
    supplementalRequiredIdr: pc.supplementalRequiredIdr,
    receiptFileId: pc.receiptFileId,
    notes: pc.notes,
    responseNote: pc.responseNote,
    round: pc.round,
    windowSeconds: pc.windowSeconds,
    expiresAt: new Date(pc.expiresAt).toISOString(),
    respondedAt: pc.respondedAt ? new Date(pc.respondedAt).toISOString() : null,
    createdAt: new Date(pc.createdAt).toISOString(),
  };
}

function itemIdr(q: LoadedQuote, currency: string, minor: number): number {
  if (currency === 'IDR') return minor;
  if (!q.fxLock) throw new AppError(500, 'FX_LOCK_MISSING', 'Quote has no FX lock');
  return convert(minor, currency, 'IDR', q.fxLock.lockedRate);
}

export interface PriceCheckInput {
  actualUnitPriceMinor: number;
  currency: string;
  receiptFileId?: string | undefined;
  photoFileId?: string | undefined;
  notes?: string | undefined;
}

/** Traveler reports the actual shelf price (PAYMENT_SECURED). */
export async function priceCheck(deps: AppDeps, auth: AuthContext, id: string, input: PriceCheckInput) {
  const now = deps.clock.now();
  const cfg = await deps.config.get('price_confirmation');
  return deps.sql.begin(async (db) => {
    await setDbActor(db, 'TRAVELER', auth.userId);
    const { tx } = await requireParty(db, id, auth, { role: 'TRAVELER', forUpdate: true });
    if (tx.status !== 'PAYMENT_SECURED') {
      throw Errors.unprocessable('PRICE_CHECK_NOT_ALLOWED', 'Konfirmasi harga hanya setelah pembayaran diamankan (PAYMENT_SECURED)', { status: tx.status });
    }
    const q = (await loadQuote(db, tx.activeQuoteId!))!;
    const req = (await loadRequest(db, tx.requestId))!;
    const currency = q.quote.meta.itemCurrency;
    if (input.currency !== currency) throw Errors.unprocessable('CURRENCY_MISMATCH', `Mata uang harus ${currency}`, { expected: currency });
    const files = [input.receiptFileId, input.photoFileId].filter((x): x is string => !!x);
    await assertOwnedFiles(db, files, auth.userId, ['RECEIPT', 'PRODUCT_PHOTO', 'EVIDENCE'], 'priceEvidence');
    const qty = q.quote.meta.quantity;
    const actualMinor = input.actualUnitPriceMinor * qty;
    const actualIdr = itemIdr(q, currency, actualMinor);
    const evaluation = evaluatePriceChange({
      securedItemIdr: q.amounts.ITEM_PRICE,
      maxBudgetIdr: req.maxBudgetIdr,
      actualItemIdr: actualIdr,
      toleranceBps: cfg.toleranceBps,
      toleranceMaxIdr: cfg.toleranceMaxIdr,
    });
    if (evaluation.outcome === 'WITHIN_TOLERANCE') {
      const next = await guardedTransition(db, tx, 'PURCHASE_APPROVED', 'TRAVELER', auth.userId, { priceWithinTolerance: true }, 'Harga aktual dalam toleransi', {
        actualIdr,
        differenceIdr: evaluation.differenceIdr,
      });
      await db`UPDATE transactions SET purchase_ceiling_minor = ${actualMinor}, purchase_ceiling_idr = ${actualIdr}, purchase_approved_at = ${now}
                WHERE id = ${next.id}`;
      await audit(db, { actorType: 'TRAVELER', actorId: auth.userId, action: 'transaction.price_checked', entityType: 'transaction', entityId: tx.id, meta: { outcome: evaluation.outcome, actualIdr, securedIdr: q.amounts.ITEM_PRICE } });
      return { outcome: evaluation.outcome, evaluation, transactionStatus: next.status, purchaseCeiling: { minor: actualMinor, idr: actualIdr, currency }, priceConfirmation: null };
    }
    const expiresAt = windowExpiresAt(now, cfg.windowSeconds);
    const [pc] = await db<{ id: string }[]>`
      INSERT INTO price_confirmations (transaction_id, requested_by, status, original_price_minor, actual_price_minor, currency, receipt_file_id,
                                       notes, window_seconds, expires_at, supplemental_required_idr)
      VALUES (${tx.id}, ${auth.userId}, 'PENDING', ${q.quote.meta.itemTotalMinor}, ${actualMinor}, ${currency}, ${input.receiptFileId ?? input.photoFileId ?? null},
              ${input.notes ?? null}, ${cfg.windowSeconds}, ${expiresAt}, ${evaluation.supplementalRequiredIdr})
      RETURNING id`;
    const next = await guardedTransition(db, tx, 'PRICE_CHANGE_PENDING', 'TRAVELER', auth.userId, { priceWithinTolerance: false }, 'Harga aktual di luar toleransi', {
      priceConfirmationId: pc!.id,
    });
    await emitEvent(db, 'price_confirmation', pc!.id, 'price_confirmation.requested', {
      priceConfirmationId: pc!.id,
      transactionId: tx.id,
      buyerId: tx.buyerId,
      travelerId: tx.travelerId,
      originalIdr: q.amounts.ITEM_PRICE,
      actualIdr,
      expiresAt: expiresAt.toISOString(),
      status: 'PENDING',
    });
    await audit(db, { actorType: 'TRAVELER', actorId: auth.userId, action: 'transaction.price_checked', entityType: 'transaction', entityId: tx.id, meta: { outcome: evaluation.outcome, actualIdr, priceConfirmationId: pc!.id } });
    const row = (await loadPc(db, pc!.id))!;
    return { outcome: evaluation.outcome, evaluation, transactionStatus: next.status, purchaseCeiling: null, priceConfirmation: pcView(row, q) };
  });
}

export type RespondAction = 'APPROVE' | 'REJECT' | 'CLARIFY';

/** Buyer responds to a price confirmation (💰). */
export async function respondPriceConfirmation(deps: AppDeps, auth: AuthContext, id: string, pcId: string, body: { action: RespondAction; note?: string | undefined }) {
  const now = deps.clock.now();
  const result = await deps.sql.begin(async (db) => {
    await setDbActor(db, 'BUYER', auth.userId);
    const { tx } = await requireParty(db, id, auth, { role: 'BUYER', forUpdate: true });
    const pc = await loadPc(db, pcId, true);
    if (!pc || pc.transactionId !== tx.id) throw Errors.notFound('Konfirmasi harga', 'PRICE_CONFIRMATION_NOT_FOUND');
    const target = body.action === 'APPROVE' ? 'APPROVED' : body.action === 'REJECT' ? 'REJECTED' : 'CLARIFICATION_REQUESTED';
    const expired = now.getTime() >= new Date(pc.expiresAt).getTime();
    const check = priceConfirmationFsm.canTransition(pc.status, target, 'BUYER', { windowExpired: expired });
    if (!check.ok) {
      throw new AppError(422, check.code === 'WINDOW_EXPIRED' ? 'PRICE_CONFIRMATION_EXPIRED' : 'PRICE_CONFIRMATION_NOT_OPEN', 'Konfirmasi harga sudah tidak dapat direspons', {
        status: pc.status,
        reason: check.message,
      });
    }
    if (tx.status !== 'PRICE_CHANGE_PENDING') throw Errors.unprocessable('INVALID_TRANSACTION_STATUS', 'Transaksi tidak sedang menunggu konfirmasi harga', { status: tx.status });
    const q = (await loadQuote(db, tx.activeQuoteId!))!;
    await db`UPDATE price_confirmations SET status = ${target}, responded_at = ${now}, response_note = ${body.note ?? null} WHERE id = ${pc.id}`;
    const resolvedPayload = {
      priceConfirmationId: pc.id,
      transactionId: tx.id,
      buyerId: tx.buyerId,
      travelerId: tx.travelerId,
      originalIdr: q.amounts.ITEM_PRICE,
      actualIdr: itemIdr(q, pc.currency, pc.actualPriceMinor),
      expiresAt: new Date(pc.expiresAt).toISOString(),
      status: target,
    };
    if (body.action === 'CLARIFY') {
      await emitEvent(db, 'price_confirmation', pc.id, 'price_confirmation.clarification_requested', resolvedPayload);
      return { kind: 'CLARIFY' as const, tx, pc: (await loadPc(db, pc.id))!, q };
    }
    await emitEvent(db, 'price_confirmation', pc.id, 'price_confirmation.resolved', resolvedPayload);
    if (body.action === 'REJECT') {
      const { cancelInTx } = await import('../cancellation/service');
      const out = await cancelInTx(deps, db, tx, {
        actor: 'BUYER',
        actorId: auth.userId,
        reason: body.note ?? 'Penitip menolak perubahan harga',
        cause: 'PRICE_CHANGE_REJECTED',
        refundReasonCode: 'PRICE_CHANGE_REJECTED',
      });
      return { kind: 'REJECT' as const, tx, pc: (await loadPc(db, pc.id))!, q, cancellation: out };
    }
    // APPROVE: the approved actual price becomes the purchase ceiling.
    const actualIdr = itemIdr(q, pc.currency, pc.actualPriceMinor);
    await db`UPDATE transactions SET purchase_ceiling_minor = ${pc.actualPriceMinor}, purchase_ceiling_idr = ${actualIdr} WHERE id = ${tx.id}`;
    if (pc.supplementalRequiredIdr > 0) {
      const next = await guardedTransition(db, tx, 'AWAITING_PAYMENT', 'BUYER', auth.userId, { priceChangeApproved: true, securedFundsSufficient: false }, 'Harga baru disetujui; menunggu pembayaran tambahan', {
        priceConfirmationId: pc.id,
        supplementalIdr: pc.supplementalRequiredIdr,
      });
      const cfg = await deps.config.get('price_confirmation');
      const payment = await createPayment(deps, db, {
        tx: next,
        purpose: 'SUPPLEMENTAL',
        quoteId: q.quote.id,
        amountIdr: pc.supplementalRequiredIdr,
        channel: q.quote.meta.paymentChannel,
        expiresAt: new Date(now.getTime() + Math.max(cfg.windowSeconds, 3600) * 1000),
        description: `Pembayaran tambahan ${next.number}`,
      });
      await emitEvent(db, 'payment', payment.id, 'payment.checkout_created', {
        paymentId: payment.id,
        transactionId: tx.id,
        buyerId: tx.buyerId,
        amountIdr: payment.amountIdr,
        expiresAt: payment.expiresAt?.toISOString() ?? null,
        purpose: 'SUPPLEMENTAL',
      });
      await audit(db, { actorType: 'BUYER', actorId: auth.userId, action: 'price_confirmation.approved', entityType: 'price_confirmation', entityId: pc.id, meta: { supplementalIdr: pc.supplementalRequiredIdr, paymentId: payment.id } });
      return { kind: 'APPROVE' as const, tx: next, pc: (await loadPc(db, pc.id))!, q, payment };
    }
    const next = await guardedTransition(db, tx, 'PURCHASE_APPROVED', 'BUYER', auth.userId, { priceChangeApproved: true, securedFundsSufficient: true }, 'Harga baru disetujui', {
      priceConfirmationId: pc.id,
    });
    await db`UPDATE transactions SET purchase_approved_at = ${now} WHERE id = ${tx.id}`;
    await audit(db, { actorType: 'BUYER', actorId: auth.userId, action: 'price_confirmation.approved', entityType: 'price_confirmation', entityId: pc.id });
    return { kind: 'APPROVE' as const, tx: next, pc: (await loadPc(db, pc.id))!, q, payment: null };
  });
  if (result.kind === 'REJECT') await processRefunds(deps, { transactionId: id });
  const fresh = (await loadTx(deps.sql, id))!;
  return {
    action: body.action,
    transactionStatus: fresh.status,
    priceConfirmation: pcView(result.pc, result.q),
    payment: result.kind === 'APPROVE' && result.payment ? paymentView(result.payment, { includeCheckoutUrl: true }) : null,
    cancellation: result.kind === 'REJECT' ? result.cancellation.cancellation : null,
  };
}

/** Traveler answers a clarification request → PENDING with a fresh window (price may be revised). */
export async function clarifyPriceConfirmation(
  deps: AppDeps,
  auth: AuthContext,
  id: string,
  pcId: string,
  body: { note: string; actualUnitPriceMinor?: number | undefined; receiptFileId?: string | undefined },
) {
  const now = deps.clock.now();
  const cfg = await deps.config.get('price_confirmation');
  return deps.sql.begin(async (db) => {
    await setDbActor(db, 'TRAVELER', auth.userId);
    const { tx } = await requireParty(db, id, auth, { role: 'TRAVELER', forUpdate: true });
    const pc = await loadPc(db, pcId, true);
    if (!pc || pc.transactionId !== tx.id) throw Errors.notFound('Konfirmasi harga', 'PRICE_CONFIRMATION_NOT_FOUND');
    const expired = now.getTime() >= new Date(pc.expiresAt).getTime();
    const check = priceConfirmationFsm.canTransition(pc.status, 'PENDING', 'TRAVELER', { windowExpired: expired });
    if (!check.ok || expired) throw new AppError(422, 'PRICE_CONFIRMATION_NOT_OPEN', 'Tidak ada permintaan klarifikasi yang terbuka', { status: pc.status });
    if (body.receiptFileId) await assertOwnedFiles(db, [body.receiptFileId], auth.userId, ['RECEIPT', 'PRODUCT_PHOTO', 'EVIDENCE'], 'receiptFileId');
    const q = (await loadQuote(db, tx.activeQuoteId!))!;
    let actualMinor = pc.actualPriceMinor;
    let supplemental = pc.supplementalRequiredIdr;
    if (body.actualUnitPriceMinor !== undefined) {
      const req = (await loadRequest(db, tx.requestId))!;
      actualMinor = body.actualUnitPriceMinor * q.quote.meta.quantity;
      const ev = evaluatePriceChange({
        securedItemIdr: q.amounts.ITEM_PRICE,
        maxBudgetIdr: req.maxBudgetIdr,
        actualItemIdr: itemIdr(q, pc.currency, actualMinor),
        toleranceBps: cfg.toleranceBps,
        toleranceMaxIdr: cfg.toleranceMaxIdr,
      });
      supplemental = Math.max(0, ev.differenceIdr);
    }
    const expiresAt = windowExpiresAt(now, cfg.windowSeconds);
    await db`UPDATE price_confirmations SET status = 'PENDING', round = round + 1, expires_at = ${expiresAt}, actual_price_minor = ${actualMinor},
               supplemental_required_idr = ${supplemental}, notes = ${body.note}, receipt_file_id = coalesce(${body.receiptFileId ?? null}::uuid, receipt_file_id)
             WHERE id = ${pc.id}`;
    const row = (await loadPc(db, pc.id))!;
    await emitEvent(db, 'price_confirmation', pc.id, 'price_confirmation.requested', {
      priceConfirmationId: pc.id,
      transactionId: tx.id,
      buyerId: tx.buyerId,
      travelerId: tx.travelerId,
      originalIdr: q.amounts.ITEM_PRICE,
      actualIdr: itemIdr(q, pc.currency, actualMinor),
      expiresAt: expiresAt.toISOString(),
      status: 'PENDING',
      round: row.round,
    });
    return { transactionStatus: tx.status, priceConfirmation: pcView(row, q) };
  });
}

/** Job: PENDING / CLARIFICATION_REQUESTED past expiry → EXPIRED; default action REJECT → full refund, no penalty. */
export async function expirePriceConfirmations(deps: AppDeps): Promise<{ expired: number }> {
  const now = deps.clock.now();
  const cfg = await deps.config.get('price_confirmation');
  const due = await deps.sql<{ id: string; transaction_id: string }[]>`
    SELECT id, transaction_id FROM price_confirmations WHERE status IN ('PENDING','CLARIFICATION_REQUESTED') AND expires_at <= ${now}
     ORDER BY expires_at LIMIT 100`;
  let expired = 0;
  const touched: string[] = [];
  for (const d of due) {
    const done = await deps.sql.begin(async (db) => {
      await setDbActor(db, 'SYSTEM', null);
      const tx = await loadTx(db, d.transaction_id, { forUpdate: true });
      const pc = await loadPc(db, d.id, true);
      if (!tx || !pc || !['PENDING', 'CLARIFICATION_REQUESTED'].includes(pc.status)) return false;
      const check = priceConfirmationFsm.canTransition(pc.status, 'EXPIRED', 'SYSTEM', { windowExpired: true });
      if (!check.ok) return false;
      await db`UPDATE price_confirmations SET status = 'EXPIRED' WHERE id = ${pc.id}`;
      if (tx.status !== 'PRICE_CHANGE_PENDING') return true;
      const resolution = resolveExpired(cfg, { supplementalRequiredIdr: pc.supplementalRequiredIdr, exceedsMaxBudget: false });
      if (resolution.action === 'APPROVE') {
        // §4 only lets the BUYER approve (PRICE_CHANGE_PENDING → PURCHASE_APPROVED); SYSTEM cannot → treat as reject.
        deps.logger.warn('price_confirmation.expired_approve_not_permitted', { priceConfirmationId: pc.id });
      }
      const q = (await loadQuote(db, tx.activeQuoteId!))!;
      await emitEvent(db, 'price_confirmation', pc.id, 'price_confirmation.resolved', {
        priceConfirmationId: pc.id,
        transactionId: tx.id,
        buyerId: tx.buyerId,
        travelerId: tx.travelerId,
        originalIdr: q.amounts.ITEM_PRICE,
        actualIdr: itemIdr(q, pc.currency, pc.actualPriceMinor),
        expiresAt: new Date(pc.expiresAt).toISOString(),
        status: 'EXPIRED',
      });
      const { cancelInTx } = await import('../cancellation/service');
      await cancelInTx(deps, db, tx, {
        actor: 'SYSTEM',
        actorId: null,
        reason: 'Konfirmasi harga tidak direspons sampai batas waktu',
        refundReasonCode: 'PRICE_CONFIRMATION_EXPIRED',
      });
      return true;
    });
    if (done) {
      expired++;
      touched.push(d.transaction_id);
    }
  }
  for (const t of touched) await processRefunds(deps, { transactionId: t });
  return { expired };
}

export async function priceConfirmationsForTx(db: TxSql | Db, tx: TxRow, q: LoadedQuote | null) {
  const rows = await db<Record<string, unknown>[]>`SELECT * FROM price_confirmations WHERE transaction_id = ${tx.id} ORDER BY created_at`;
  return rows.map((r) => {
    const pc = camel<PriceConfirmationRow>(r);
    return pcView({ ...pc, currency: pc.currency.trim() }, q);
  });
}
