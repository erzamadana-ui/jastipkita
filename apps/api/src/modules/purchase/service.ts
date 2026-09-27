/**
 * Purchase proof (golden rule: only in PURCHASE_APPROVED, never above the approved ceiling), travel
 * status updates and customs declarations.
 */
import { assessReceipt, receiptHoldRequired, type TransactionStatus } from '@jastipkita/core';
import type { AppDeps, AuthContext } from '../../context';
import { bytesToHex } from '../../lib/crypto';
import { AppError, Errors } from '../../lib/errors';
import { audit } from '../../services/audit';
import { emitEvent } from '../../services/outbox';
import { recordRiskAssessment } from '../../services/risk';
import { loadQuote, loadRequest, loadTrip } from '../checkout/repository';
import { assertOwnedFiles, guardedTransition, requireParty, setDbActor } from '../transactions/common';

export interface PurchaseProofInput {
  receiptFileId: string;
  productPhotoFileIds: string[];
  videoFileId?: string | undefined;
  serialNumber?: string | undefined;
  receiptNumber?: string | undefined;
  merchantName: string;
  /** Total paid for all units, item currency minor units (as printed on the receipt). */
  actualPriceMinor: number;
  currency: string;
  purchasedAt: string;
}

export async function submitPurchaseProof(deps: AppDeps, auth: AuthContext, id: string, input: PurchaseProofInput) {
  const now = deps.clock.now();
  const purchasedAt = new Date(input.purchasedAt);
  if (Number.isNaN(purchasedAt.getTime())) throw Errors.validation({ purchasedAt: 'invalid date' });
  const thresholds = await deps.config.get('risk.thresholds');
  return deps.sql.begin(async (db) => {
    await setDbActor(db, 'TRAVELER', auth.userId);
    const { tx } = await requireParty(db, id, auth, { role: 'TRAVELER', forUpdate: true });
    if (tx.status !== 'PURCHASE_APPROVED') {
      throw new AppError(422, 'PURCHASE_NOT_APPROVED', 'JANGAN BELI: pembelian hanya boleh setelah status Purchase Approved', {
        status: tx.status,
        banner: 'DO_NOT_PURCHASE',
      });
    }
    if (purchasedAt.getTime() > now.getTime() + 5 * 60_000) throw Errors.unprocessable('PURCHASE_TIME_IN_FUTURE', 'Waktu pembelian tidak boleh di masa depan');
    const q = (await loadQuote(db, tx.activeQuoteId!))!;
    const req = (await loadRequest(db, tx.requestId))!;
    const currency = q.quote.meta.itemCurrency;
    if (input.currency !== currency) throw Errors.unprocessable('CURRENCY_MISMATCH', `Mata uang struk harus ${currency}`, { expected: currency });
    const ceiling = tx.purchaseCeilingMinor ?? q.quote.meta.itemTotalMinor;
    if (input.actualPriceMinor > ceiling) {
      throw new AppError(422, 'PURCHASE_PRICE_EXCEEDS_APPROVED', 'Harga pembelian melebihi harga yang disetujui penitip', {
        approvedMinor: ceiling,
        actualMinor: input.actualPriceMinor,
        currency,
      });
    }
    const [cat] = await db<{ requires_serial: boolean; requires_video: boolean }[]>`
      SELECT requires_serial, requires_video FROM product_categories WHERE code = ${req.categoryCode ?? 'OTHER'}`;
    const requiresSerial = cat?.requires_serial ?? false;
    const requiresVideo = cat?.requires_video ?? false;
    if (requiresSerial && !input.serialNumber?.trim()) throw Errors.unprocessable('SERIAL_REQUIRED', 'Kategori ini wajib mencantumkan nomor seri');
    if (requiresVideo && !input.videoFileId) throw Errors.unprocessable('VIDEO_REQUIRED', 'Kategori ini wajib video pembelian/unboxing');
    const [receipt] = await assertOwnedFiles(db, [input.receiptFileId], auth.userId, ['RECEIPT'], 'receiptFileId');
    await assertOwnedFiles(db, input.productPhotoFileIds, auth.userId, ['PRODUCT_PHOTO'], 'productPhotoFileIds');
    if (input.videoFileId) {
      const [v] = await assertOwnedFiles(db, [input.videoFileId], auth.userId, ['PRODUCT_PHOTO', 'EVIDENCE'], 'videoFileId');
      if (!v!.mime.startsWith('video/')) throw Errors.unprocessable('FILE_PURPOSE_INVALID', 'Berkas video harus bertipe video/*');
    }
    const imageHash = receipt!.sha256 ? bytesToHex(new Uint8Array(receipt!.sha256)) : `file:${receipt!.id}`;

    // Fraud history: receipt images & serials used on OTHER transactions.
    const history = await db<{ transaction_id: string; hash: string | null; serial_number: string | null }[]>`
      SELECT p.transaction_id, encode(f.sha256, 'hex') AS hash, p.serial_number
        FROM purchase_proofs p JOIN files f ON f.id = p.receipt_file_id
       WHERE p.transaction_id <> ${tx.id}
         AND (f.sha256 = ${receipt!.sha256 ?? Buffer.alloc(0)} OR (p.serial_number IS NOT NULL AND p.serial_number = ${input.serialNumber ?? ''}))`;
    const [secured] = await db<{ secured_at: Date | null }[]>`
      SELECT min(secured_at) AS secured_at FROM payments WHERE transaction_id = ${tx.id} AND purpose = 'CHECKOUT' AND secured_at IS NOT NULL`;
    const assessment = assessReceipt(
      {
        transactionId: tx.id,
        imageHash,
        receiptNumber: input.receiptNumber ?? null,
        merchantName: input.merchantName,
        purchasedAt,
        amountMinor: input.actualPriceMinor,
        currency: input.currency,
        serialNumber: input.serialNumber ?? null,
        hasVideo: !!input.videoFileId,
        expected: {
          paymentSecuredAt: secured?.secured_at ?? null,
          purchaseApprovedAt: tx.purchaseApprovedAt,
          approvedAmountMinor: ceiling,
          approvedCurrency: currency,
          merchantName: req.merchantName,
          requiresSerial,
          requiresVideo,
        },
        now,
      },
      {
        imageHashes: history.filter((h) => h.hash).map((h) => ({ hash: h.hash as string, transactionId: h.transaction_id })),
        serialNumbers: history.filter((h) => h.serial_number).map((h) => ({ serial: h.serial_number as string, transactionId: h.transaction_id })),
      },
      thresholds,
    );
    // Soft signals (MERCHANT_MISMATCH, core SOFT_RECEIPT_SIGNALS) only open a low-weight REVIEW; they never FLAG the
    // proof or hold the payout on their own (QA observation 2026-09-28: URL-derived merchant vs brand store).
    const flagged = receiptHoldRequired(assessment.reasons);
    const softOnly = !flagged && assessment.reasons.length > 0;
    const [proof] = await db<{ id: string }[]>`
      INSERT INTO purchase_proofs (transaction_id, traveler_id, receipt_file_id, product_photo_file_ids, video_file_id, serial_number,
                                   merchant_name, actual_price_minor, currency, purchased_at, fraud_score, fraud_reasons, status)
      VALUES (${tx.id}, ${auth.userId}, ${input.receiptFileId}, ${input.productPhotoFileIds}::uuid[], ${input.videoFileId ?? null},
              ${input.serialNumber ?? null}, ${input.merchantName}, ${input.actualPriceMinor}, ${currency}, ${purchasedAt},
              ${Math.round(assessment.score)}, ${db.json(assessment.reasons.map((r) => ({ code: r.code, weight: r.weight, message: r.message })) as never)},
              ${flagged ? 'FLAGGED' : 'ACCEPTED'})
      RETURNING id`;
    if (softOnly) {
      await recordRiskAssessment(
        db,
        'PURCHASE_PROOF',
        proof!.id,
        { score: assessment.score, decision: 'REVIEW', reasons: assessment.reasons.map((r) => ({ code: r.code, weight: r.weight, message: r.message })) },
        { transactionId: tx.id, imageHash, engineVersion: assessment.engineVersion, soft: true },
        'core-receipt-v1',
      );
    }
    if (flagged) {
      const decision = assessment.decision === 'ALLOW' ? 'REVIEW' : assessment.decision;
      await recordRiskAssessment(
        db,
        'PURCHASE_PROOF',
        proof!.id,
        { score: assessment.score, decision, reasons: assessment.reasons.map((r) => ({ code: r.code, weight: r.weight, message: r.message })) },
        { transactionId: tx.id, imageHash, engineVersion: assessment.engineVersion },
        'core-receipt-v1',
      );
      const codes = assessment.reasons.map((r) => r.code).join(',');
      await db`UPDATE transactions SET payout_hold_reason = coalesce(payout_hold_reason, ${`PURCHASE_PROOF_FLAGGED:${codes}`.slice(0, 500)}) WHERE id = ${tx.id}`;
    }
    const next = await guardedTransition(
      db,
      tx,
      'PURCHASED',
      'TRAVELER',
      auth.userId,
      { proofComplete: assessment.proofComplete, purchasePriceWithinApproved: assessment.priceWithinApproved },
      'Bukti pembelian diunggah',
      { proofId: proof!.id, flagged },
    );
    await emitEvent(db, 'transaction', tx.id, 'purchase.proof_submitted', { transactionId: tx.id, proofId: proof!.id, flagged, buyerId: tx.buyerId, travelerId: tx.travelerId });
    await audit(db, {
      actorType: 'TRAVELER',
      actorId: auth.userId,
      action: 'purchase.proof_submitted',
      entityType: 'purchase_proof',
      entityId: proof!.id,
      meta: { transactionId: tx.id, flagged, fraudScore: assessment.score, reasons: assessment.reasons.map((r) => r.code) },
    });
    return {
      proofId: proof!.id,
      status: flagged ? ('FLAGGED' as const) : ('ACCEPTED' as const),
      flagged,
      transactionStatus: next.status,
    };
  });
}

// ------------------------------------------------------------------ travel status

const TRAVEL_TARGETS = ['TRAVELING', 'ARRIVED', 'CUSTOMS_PROCESS', 'READY_FOR_HANDOVER'] as const;
export type TravelTarget = (typeof TRAVEL_TARGETS)[number];

export async function updateTravelStatus(deps: AppDeps, auth: AuthContext, id: string, body: { to: TravelTarget; note?: string | undefined }) {
  const now = deps.clock.now();
  return deps.sql.begin(async (db) => {
    await setDbActor(db, 'TRAVELER', auth.userId);
    const { tx } = await requireParty(db, id, auth, { role: 'TRAVELER', forUpdate: true });
    if (tx.status === body.to) return { transactionStatus: tx.status as TransactionStatus, changed: false };
    const trip = tx.tripId ? await loadTrip(db, tx.tripId) : null;
    const today = new Date(now.getTime() + 7 * 3600_000).toISOString().slice(0, 10);
    const tripArrived = !!trip && (trip.status === 'COMPLETED' || (trip.status === 'TRAVELING' && trip.arrivalDate <= today));
    const [decl] = await db<{ total_paid_idr: number; receipt_file_id: string | null }[]>`
      SELECT total_paid_idr, receipt_file_id FROM customs_declarations WHERE transaction_id = ${tx.id} AND status <> 'REJECTED' LIMIT 1`;
    const ctx = {
      tripStatus: (trip?.status ?? undefined) as never,
      tripArrived,
      ...(decl ? { customsDutyPaid: Number(decl.total_paid_idr) > 0, customsProofUploaded: !!decl.receipt_file_id } : {}),
    };
    const next = await guardedTransition(db, tx, body.to, 'TRAVELER', auth.userId, ctx, body.note ?? null);
    return { transactionStatus: next.status, changed: true };
  });
}

// ------------------------------------------------------------------ customs declaration

export interface CustomsDeclarationInput {
  dutyPaidIdr: number;
  vatPaidIdr: number;
  incomeTaxPaidIdr: number;
  luxuryTaxPaidIdr: number;
  declarationRef?: string | undefined;
  receiptFileId?: string | undefined;
  declaredValueMinor?: number | undefined;
  declaredCurrency?: string | undefined;
  notes?: string | undefined;
}

const DECLARABLE: readonly TransactionStatus[] = ['PURCHASED', 'TRAVELING', 'ARRIVED', 'CUSTOMS_PROCESS', 'READY_FOR_HANDOVER'];

export async function submitCustomsDeclaration(deps: AppDeps, auth: AuthContext, id: string, input: CustomsDeclarationInput) {
  const now = deps.clock.now();
  return deps.sql.begin(async (db) => {
    await setDbActor(db, 'TRAVELER', auth.userId);
    const { tx } = await requireParty(db, id, auth, { role: 'TRAVELER', forUpdate: true });
    if (!DECLARABLE.includes(tx.status)) throw Errors.unprocessable('CUSTOMS_DECLARATION_NOT_ALLOWED', 'Deklarasi bea masuk tidak dapat diubah pada status ini', { status: tx.status });
    const total = input.dutyPaidIdr + input.vatPaidIdr + input.incomeTaxPaidIdr + input.luxuryTaxPaidIdr;
    if (total > 0 && !input.receiptFileId) throw Errors.unprocessable('CUSTOMS_RECEIPT_REQUIRED', 'Unggah bukti pembayaran bea masuk & pajak (billing/BPN)');
    if (input.receiptFileId) await assertOwnedFiles(db, [input.receiptFileId], auth.userId, ['RECEIPT', 'EVIDENCE'], 'receiptFileId');
    const q = (await loadQuote(db, tx.activeQuoteId!))!;
    const estimated = q.amounts.CUSTOMS_DUTY + q.amounts.IMPORT_TAX;
    const status = total > 0 ? 'PAID' : 'NOT_REQUIRED';
    const [existing] = await db<{ id: string }[]>`SELECT id FROM customs_declarations WHERE transaction_id = ${tx.id} AND status <> 'REJECTED' FOR UPDATE`;
    let declId: string;
    if (existing) {
      await db`UPDATE customs_declarations SET duty_paid_idr = ${input.dutyPaidIdr}, vat_paid_idr = ${input.vatPaidIdr}, income_tax_paid_idr = ${input.incomeTaxPaidIdr},
                 luxury_tax_paid_idr = ${input.luxuryTaxPaidIdr}, declaration_ref = ${input.declarationRef ?? null}, receipt_file_id = ${input.receiptFileId ?? null},
                 declared_value_minor = ${input.declaredValueMinor ?? null}, declared_currency = ${input.declaredCurrency ?? null}, notes = ${input.notes ?? null},
                 estimated_total_idr = ${estimated}, status = ${status}, paid_at = ${total > 0 ? now : null} WHERE id = ${existing.id}`;
      declId = existing.id;
    } else {
      const [ins] = await db<{ id: string }[]>`
        INSERT INTO customs_declarations (transaction_id, traveler_id, declared_value_minor, declared_currency, estimated_total_idr, duty_paid_idr,
                                          vat_paid_idr, income_tax_paid_idr, luxury_tax_paid_idr, declaration_ref, receipt_file_id, status, paid_at, notes)
        VALUES (${tx.id}, ${auth.userId}, ${input.declaredValueMinor ?? null}, ${input.declaredCurrency ?? null}, ${estimated}, ${input.dutyPaidIdr},
                ${input.vatPaidIdr}, ${input.incomeTaxPaidIdr}, ${input.luxuryTaxPaidIdr}, ${input.declarationRef ?? null}, ${input.receiptFileId ?? null},
                ${status}, ${total > 0 ? now : null}, ${input.notes ?? null})
        RETURNING id`;
      declId = ins!.id;
    }
    await audit(db, {
      actorType: 'TRAVELER',
      actorId: auth.userId,
      action: 'customs.declared',
      entityType: 'customs_declaration',
      entityId: declId,
      meta: { transactionId: tx.id, totalPaidIdr: total, estimatedIdr: estimated },
    });
    return {
      id: declId,
      status,
      totalPaidIdr: total,
      estimatedTotalIdr: estimated,
      reimbursableIdr: Math.min(total, estimated),
      note: total > estimated ? 'Bea/pajak aktual melebihi estimasi; selisih di atas cadangan tidak otomatis diganti (ajukan melalui Pusat Bantuan).' : null,
    };
  });
}
