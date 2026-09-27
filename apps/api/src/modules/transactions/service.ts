/**
 * Transaction reads: list, detail (quote lines, payments, price confirmations, proof, delivery, refunds,
 * purchaseGate + allowedActions for the caller), timeline.
 */
import { evaluateCancellation, nextAllowed, purchaseGate, type TransactionStatus } from '@jastipkita/core';
import type { AppDeps, AuthContext } from '../../context';
import { camel } from '../../db/sql';
import { decodeCursor, encodeCursor } from '../../lib/pagination';
import { quoteView } from '../checkout/service';
import { loadQuote, loadRequest, type LoadedQuote } from '../checkout/repository';
import { deliveryView, liveDelivery } from '../delivery/service';
import { paymentsForTx, paymentView } from '../payments/repository';
import { priceConfirmationsForTx } from '../price-confirmation/service';
import { refundViews } from '../refunds/service';
import { type PartyRole, requireParty, type TxRow } from './common';

async function publicProfile(deps: AppDeps, userId: string | null) {
  if (!userId) return null;
  const [u] = await deps.sql<{ id: string; display_name: string | null; kyc_level: number; trust_score: number; created_at: Date }[]>`
    SELECT id, display_name, kyc_level, trust_score, created_at FROM users WHERE id = ${userId}`;
  if (!u) return null;
  const [r] = await deps.sql<{ as_traveler_count: number; as_traveler_avg: string | null; as_buyer_count: number; as_buyer_avg: string | null }[]>`
    SELECT as_traveler_count, as_traveler_avg::text, as_buyer_count, as_buyer_avg::text FROM user_rating_summaries WHERE user_id = ${userId}`;
  return {
    id: u.id,
    displayName: u.display_name,
    kycLevel: u.kyc_level,
    trustScore: u.trust_score,
    memberSince: u.created_at.toISOString(),
    rating: r
      ? { asTraveler: { count: r.as_traveler_count, average: r.as_traveler_avg ? Number(r.as_traveler_avg) : null }, asBuyer: { count: r.as_buyer_count, average: r.as_buyer_avg ? Number(r.as_buyer_avg) : null } }
      : null,
  };
}

function txSummary(tx: TxRow) {
  return {
    id: tx.id,
    number: tx.number,
    status: tx.status,
    buyerId: tx.buyerId,
    travelerId: tx.travelerId,
    totalIdr: tx.totalIdr,
    securedIdr: tx.securedIdr,
    itemCurrency: tx.itemCurrency?.trim() ?? null,
    quantity: tx.quantity,
    deliveryMethod: tx.deliveryMethod,
    purchaseCeiling: tx.purchaseCeilingMinor !== null ? { minor: tx.purchaseCeilingMinor, idr: tx.purchaseCeilingIdr } : null,
    autoConfirmAt: tx.autoConfirmAt ? new Date(tx.autoConfirmAt).toISOString() : null,
    statusChangedAt: new Date(tx.statusChangedAt).toISOString(),
    createdAt: new Date(tx.createdAt).toISOString(),
    updatedAt: new Date(tx.updatedAt).toISOString(),
    cancelledAt: tx.cancelledAt ? new Date(tx.cancelledAt).toISOString() : null,
    completedAt: tx.completedAt ? new Date(tx.completedAt).toISOString() : null,
  };
}

export async function listTransactions(
  deps: AppDeps,
  auth: AuthContext,
  q: { role?: 'buyer' | 'traveler' | undefined; status?: string | undefined; limit: number; cursor?: string | undefined },
) {
  const db = deps.sql;
  const cursor = decodeCursor(q.cursor);
  const statuses = q.status ? q.status.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) : null;
  const rows = await db<Record<string, unknown>[]>`
    SELECT t.*, r.product_name, r.category_code, r.merchant_country
      FROM transactions t JOIN requests r ON r.id = t.request_id
     WHERE ${q.role === 'buyer' ? db`t.buyer_id = ${auth.userId}` : q.role === 'traveler' ? db`t.traveler_id = ${auth.userId}` : db`(t.buyer_id = ${auth.userId} OR t.traveler_id = ${auth.userId})`}
       ${statuses ? db`AND t.status = ANY(${statuses}::text[])` : db``}
       ${cursor ? db`AND (t.created_at, t.id) < (${cursor.t}::timestamptz, ${cursor.id}::uuid)` : db``}
     ORDER BY t.created_at DESC, t.id DESC
     LIMIT ${q.limit + 1}`;
  const items = rows.map((r) => {
    const tx = camel<TxRow & { productName: string; categoryCode: string | null; merchantCountry: string | null }>(r);
    const role: PartyRole = tx.buyerId === auth.userId ? 'BUYER' : 'TRAVELER';
    return {
      ...txSummary(tx),
      role,
      item: { productName: tx.productName, categoryCode: tx.categoryCode, merchantCountry: tx.merchantCountry?.trim() ?? null },
      purchaseGate: role === 'TRAVELER' ? purchaseGate(tx.status) : null,
      _createdAt: tx.createdAt,
    };
  });
  const hasMore = items.length > q.limit;
  const data = hasMore ? items.slice(0, q.limit) : items;
  const last = data[data.length - 1];
  return {
    data: data.map(({ _createdAt, ...rest }) => rest),
    nextCursor: hasMore && last ? encodeCursor({ t: new Date(last._createdAt).toISOString(), id: last.id }) : null,
  };
}

/** Actions the caller may take now (FSM + cheap guards); the endpoints re-check everything. */
async function allowedActions(deps: AppDeps, tx: TxRow, role: PartyRole, q: LoadedQuote | null, openPcStatus: string | null, deliveryMethod: string | null): Promise<string[]> {
  const now = deps.clock.now();
  const out = new Set<string>();
  const s = tx.status;
  if (role === 'BUYER') {
    if (s === 'MATCHED') {
      out.add('QUOTE');
      if (q && q.quote.status === 'ACTIVE' && now < new Date(q.quote.expiresAt) && (!q.fxLock || now < new Date(q.fxLock.expiresAt))) out.add('CHECKOUT');
    }
    if (s === 'AWAITING_PAYMENT') out.add('PAY');
    if (s === 'PRICE_CHANGE_PENDING' && openPcStatus === 'PENDING') out.add('RESPOND_PRICE_CONFIRMATION');
    if (s === 'PRICE_CHANGE_PENDING' && openPcStatus === 'CLARIFICATION_REQUESTED') out.add('REJECT_PRICE_CONFIRMATION');
    if (deliveryMethod === 'MEETUP' && ['PURCHASED', 'TRAVELING', 'ARRIVED', 'CUSTOMS_PROCESS', 'READY_FOR_HANDOVER'].includes(s)) out.add('VIEW_HANDOVER_PIN');
    if (s === 'DELIVERED') out.add('CONFIRM_RECEIPT');
  } else {
    if (s === 'PAYMENT_SECURED') out.add('PRICE_CHECK');
    if (s === 'PRICE_CHANGE_PENDING' && openPcStatus === 'CLARIFICATION_REQUESTED') out.add('CLARIFY_PRICE');
    if (s === 'PURCHASE_APPROVED') out.add('SUBMIT_PURCHASE_PROOF');
    for (const to of nextAllowed(s, 'TRAVELER')) {
      if (['TRAVELING', 'ARRIVED', 'CUSTOMS_PROCESS', 'READY_FOR_HANDOVER'].includes(to)) out.add(`UPDATE_STATUS:${to}`);
    }
    if (['PURCHASED', 'TRAVELING', 'ARRIVED', 'CUSTOMS_PROCESS', 'READY_FOR_HANDOVER'].includes(s)) {
      out.add('SET_DELIVERY');
      out.add('CUSTOMS_DECLARATION');
    }
    if (s === 'READY_FOR_HANDOVER' && deliveryMethod === 'MEETUP') out.add('VERIFY_HANDOVER');
    if (s === 'READY_FOR_HANDOVER' && (deliveryMethod === 'COURIER' || deliveryMethod === 'PARTNER_LOGISTICS')) out.add('MARK_SHIPPED');
    if (s === 'OUT_FOR_DELIVERY') out.add('MARK_DELIVERED');
  }
  if (nextAllowed(s, role).includes('DISPUTED')) out.add('OPEN_DISPUTE');
  // Cancellation availability straight from the matrix.
  if (['MATCHED', 'AWAITING_PAYMENT', 'PAYMENT_SECURED', 'PRICE_CHANGE_PENDING', 'PURCHASE_APPROVED'].includes(s)) {
    const matrix = await deps.config.get('cancellation.matrix');
    const lines = q ? q.lines.map((l) => ({ type: l.lineType, amountIdr: l.amountIdr })) : [];
    const captured = !['MATCHED', 'AWAITING_PAYMENT'].includes(s);
    try {
      const r = evaluateCancellation({ status: s, actor: role, quoteLines: captured ? lines : [], paymentCaptured: captured }, matrix);
      if (r.allowed && !r.requiresAdminApproval && r.fsmPermitsActor) out.add('CANCEL');
    } catch {
      /* inconsistent lines: no cancel shortcut */
    }
  }
  return [...out];
}

export async function getTransactionDetail(deps: AppDeps, auth: AuthContext, id: string) {
  const { tx, role } = await requireParty(deps.sql, id, auth);
  const db = deps.sql;
  const req = await loadRequest(db, tx.requestId);
  const q = tx.activeQuoteId ? await loadQuote(db, tx.activeQuoteId) : null;
  const payments = await paymentsForTx(db, tx.id);
  const pcs = await priceConfirmationsForTx(db, tx, q);
  const openPc = pcs.find((p) => p.status === 'PENDING' || p.status === 'CLARIFICATION_REQUESTED') ?? null;
  const [proofRow] = await db<Record<string, unknown>[]>`
    SELECT id, receipt_file_id, product_photo_file_ids, video_file_id, serial_number, merchant_name, actual_price_minor, currency, purchased_at, status, created_at
      FROM purchase_proofs WHERE transaction_id = ${tx.id} ORDER BY created_at DESC LIMIT 1`;
  const proof = proofRow ? camel<Record<string, unknown>>(proofRow) : null;
  const [decl] = await db<Record<string, unknown>[]>`
    SELECT id, status, duty_paid_idr, vat_paid_idr, income_tax_paid_idr, luxury_tax_paid_idr, total_paid_idr, estimated_total_idr, receipt_file_id, paid_at
      FROM customs_declarations WHERE transaction_id = ${tx.id} AND status <> 'REJECTED' LIMIT 1`;
  const delivery = await liveDelivery(db, tx.id);
  const refunds = await refundViews(db, tx.id);
  const [payout] = role === 'TRAVELER'
    ? await db<{ id: string; number: string; status: string; amount_idr: number; net_idr: number; hold_reason: string | null; paid_at: Date | null }[]>`
        SELECT id, number, status, amount_idr, net_idr, hold_reason, paid_at FROM payouts WHERE transaction_id = ${tx.id} ORDER BY created_at DESC LIMIT 1`
    : [];
  return {
    ...txSummary(tx),
    role,
    item: req
      ? {
          productName: req.productName,
          productUrl: req.productUrl,
          merchantName: req.merchantName,
          merchantCountry: req.merchantCountry,
          categoryCode: req.categoryCode,
          hsCode: req.hsCode,
          quantity: req.quantity,
          variant: req.variant,
          unitPriceMinor: req.unitPriceMinor,
          priceCurrency: req.priceCurrency,
          maxBudgetIdr: role === 'BUYER' ? req.maxBudgetIdr : null,
        }
      : null,
    buyer: await publicProfile(deps, tx.buyerId),
    traveler: await publicProfile(deps, tx.travelerId),
    quote: q ? quoteView(q) : null,
    payments: payments.map((p) => paymentView(p, { includeCheckoutUrl: role === 'BUYER' })),
    priceConfirmations: pcs,
    purchaseProof: proof
      ? {
          id: proof.id,
          status: proof.status,
          merchantName: proof.merchantName,
          actualPriceMinor: proof.actualPriceMinor,
          currency: String(proof.currency).trim(),
          purchasedAt: new Date(proof.purchasedAt as string).toISOString(),
          // Both parties may see the receipt & product photos (they are the evidence of this purchase);
          // fraud scores/reasons are internal and never returned.
          receiptFileId: proof.receiptFileId,
          productPhotoFileIds: proof.productPhotoFileIds,
          videoFileId: proof.videoFileId,
          serialNumber: role === 'TRAVELER' || tx.status === 'COMPLETED' || ['DELIVERED', 'BUYER_CONFIRMED'].includes(tx.status) ? proof.serialNumber : null,
        }
      : null,
    customsDeclaration: decl ? camel<Record<string, unknown>>(decl) : null,
    delivery: deliveryView(delivery, role),
    refunds,
    payout: payout
      ? { id: payout.id, number: payout.number, status: payout.status, amountIdr: payout.amount_idr, netIdr: payout.net_idr, holdReason: payout.hold_reason, paidAt: payout.paid_at?.toISOString() ?? null }
      : null,
    purchaseGate: role === 'TRAVELER' ? purchaseGate(tx.status) : null,
    allowedActions: await allowedActions(deps, tx, role, q, openPc?.status ?? null, delivery?.method ?? tx.deliveryMethod),
  };
}

export async function getTimeline(deps: AppDeps, auth: AuthContext, id: string) {
  const { tx } = await requireParty(deps.sql, id, auth);
  const rows = await deps.sql<{ id: number; from_status: string | null; to_status: TransactionStatus; actor_type: string; reason: string | null; meta: Record<string, unknown>; version: number; created_at: Date }[]>`
    SELECT id, from_status, to_status, actor_type, reason, meta, version, created_at FROM transaction_events WHERE transaction_id = ${tx.id} ORDER BY id`;
  const SAFE_META = ['cancellationStage', 'cause', 'confirmedVia', 'paymentId', 'priceConfirmationId', 'proofId', 'flagged', 'refundIdr'];
  return {
    transactionId: tx.id,
    number: tx.number,
    events: rows.map((r) => ({
      id: Number(r.id),
      from: r.from_status,
      to: r.to_status,
      actorType: r.actor_type,
      reason: r.reason,
      meta: Object.fromEntries(Object.entries(r.meta ?? {}).filter(([k]) => SAFE_META.includes(k))),
      version: r.version,
      at: r.created_at.toISOString(),
    })),
  };
}
