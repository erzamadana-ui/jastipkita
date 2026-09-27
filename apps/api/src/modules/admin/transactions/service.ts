/**
 * Admin · Transactions: list/filter/search by number, full detail (quote lines, payments, refunds, payouts, ledger
 * journals + entries, escrow per bucket, events, disputes, price confirmations, purchase proofs, delivery — never the
 * PIN), and ADMIN overrides that go through the money services:
 *   - cancel → cancellation/service.cancelInTx (matrix, actor ADMIN, adminApprovalRecorded) — CANCELLED before
 *     payment, REFUND_PENDING (+ refunds, traveler compensation) after payment; DURING_TRAVEL/AFTER_ARRIVAL overrides
 *   - refund → refunds/service.requestRefund (reason ADMIN, remainder to traveler or none)
 * Both require transactions.override + fresh MFA + Idempotency-Key; the processor runs right after commit.
 */
import { nextAllowed, purchaseGate, type TransactionStatus } from '@jastipkita/core';
import { Errors } from '../../../lib/errors';
import { cancelInTx } from '../../cancellation/service';
import { quoteView } from '../../checkout/service';
import { loadQuote } from '../../checkout/repository';
import { deliveryView, liveDelivery } from '../../delivery/service';
import { paymentsForTx, paymentView } from '../../payments/repository';
import { priceConfirmationsForTx } from '../../price-confirmation/service';
import { processRefunds, refundViews, requestRefund } from '../../refunds/service';
import { loadTx, type TxRow } from '../../transactions/common';
import { type AdminCtx, adminAudit, decodeKey, encodeKey, inAdminTx, iso, maskName, num, parseCsv } from '../common';

export const TX_STATUSES = [
  'REQUEST_CREATED', 'MATCHED', 'AWAITING_PAYMENT', 'PAYMENT_SECURED', 'PRICE_CHANGE_PENDING', 'PURCHASE_APPROVED', 'PURCHASED',
  'TRAVELING', 'ARRIVED', 'CUSTOMS_PROCESS', 'READY_FOR_HANDOVER', 'OUT_FOR_DELIVERY', 'DELIVERED', 'BUYER_CONFIRMED', 'COMPLETED',
  'CANCELLED', 'DISPUTED', 'REFUND_PENDING', 'REFUNDED',
] as const;

export interface TxListQuery {
  status?: string | undefined;
  q?: string | undefined;
  buyerId?: string | undefined;
  travelerId?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  limit: number;
  cursor?: string | undefined;
}

export async function listTransactions(ctx: AdminCtx, q: TxListQuery) {
  const db = ctx.deps.sql;
  const statuses = parseCsv(q.status, TX_STATUSES, 'status');
  const cursor = decodeKey(q.cursor);
  const number = q.q?.trim().toUpperCase();
  const r = await db<Record<string, unknown>[]>`
    SELECT t.id, t.number, t.status, t.buyer_id, t.traveler_id, t.total_idr, t.secured_idr, t.payout_hold_reason, t.created_at, t.updated_at,
           t.status_changed_at, r.product_name, r.category_code, bu.display_name AS buyer_name, tu.display_name AS traveler_name,
           EXISTS (SELECT 1 FROM disputes d WHERE d.transaction_id = t.id AND d.status <> 'CLOSED') AS open_dispute
      FROM transactions t JOIN requests r ON r.id = t.request_id
      JOIN users bu ON bu.id = t.buyer_id LEFT JOIN users tu ON tu.id = t.traveler_id
     WHERE true
       ${statuses ? db`AND t.status = ANY(${statuses}::text[])` : db``}
       ${number ? db`AND t.number LIKE ${number.replace(/[%_]/g, '') + '%'}` : db``}
       ${q.buyerId ? db`AND t.buyer_id = ${q.buyerId}` : db``}
       ${q.travelerId ? db`AND t.traveler_id = ${q.travelerId}` : db``}
       ${q.from ? db`AND t.created_at >= ${new Date(`${q.from}T00:00:00+07:00`)}` : db``}
       ${q.to ? db`AND t.created_at < ${new Date(new Date(`${q.to}T00:00:00+07:00`).getTime() + 86400_000)}` : db``}
       ${cursor ? db`AND (t.created_at, t.id) < (${cursor.t}::timestamptz, ${cursor.id}::uuid)` : db``}
     ORDER BY t.created_at DESC, t.id DESC LIMIT ${q.limit + 1}`;
  const more = r.length > q.limit;
  const data = r.slice(0, q.limit).map((x) => ({
    id: String(x.id),
    number: String(x.number),
    status: String(x.status),
    buyer: { id: String(x.buyer_id), displayName: maskName(x.buyer_name as string | null) },
    traveler: x.traveler_id ? { id: String(x.traveler_id), displayName: maskName(x.traveler_name as string | null) } : null,
    productName: String(x.product_name),
    categoryCode: (x.category_code as string | null) ?? null,
    totalIdr: x.total_idr === null ? null : num(x.total_idr),
    securedIdr: num(x.secured_idr),
    payoutHoldReason: (x.payout_hold_reason as string | null) ?? null,
    openDispute: !!x.open_dispute,
    statusChangedAt: iso(x.status_changed_at as Date)!,
    createdAt: iso(x.created_at as Date)!,
  }));
  const last = data[data.length - 1];
  return { data, nextCursor: more && last ? encodeKey({ t: last.createdAt, id: last.id }) : null };
}

async function requireTx(ctx: AdminCtx, id: string): Promise<TxRow> {
  const tx = await loadTx(ctx.deps.sql, id);
  if (!tx) throw Errors.notFound('Transaksi', 'TRANSACTION_NOT_FOUND');
  return tx;
}

export async function transactionDetail(ctx: AdminCtx, id: string) {
  const db = ctx.deps.sql;
  const tx = await requireTx(ctx, id);
  const [req] = await db<{ product_name: string; category_code: string | null; merchant_country: string | null; merchant_name: string | null; restriction_class: string | null; quantity: number; unit_price_minor: number | null; price_currency: string | null }[]>`
    SELECT product_name, category_code, merchant_country, merchant_name, restriction_class, quantity, unit_price_minor, price_currency FROM requests WHERE id = ${tx.requestId}`;
  const parties = await db<{ id: string; display_name: string | null; kyc_level: number; trust_score: number; status: string }[]>`
    SELECT id, display_name, kyc_level, trust_score, status FROM users WHERE id IN ${db([tx.buyerId, ...(tx.travelerId ? [tx.travelerId] : [])])}`;
  const party = (uid: string | null) => {
    const p = parties.find((x) => x.id === uid);
    return p ? { id: p.id, displayName: maskName(p.display_name), kycLevel: p.kyc_level, trustScore: p.trust_score, status: p.status } : null;
  };
  const quote = tx.activeQuoteId ? await loadQuote(db, tx.activeQuoteId) : null;
  const payments = (await paymentsForTx(db, tx.id)).map((p) => ({ ...paymentView(p, { includeCheckoutUrl: false }), sandbox: p.providerEnv !== 'LIVE' }));
  const payouts = await db<Record<string, unknown>[]>`
    SELECT p.id, p.number, p.status, p.amount_idr, p.fee_idr, p.net_idr, p.hold_reason, p.held_by, p.released_by, p.scheduled_for, p.paid_at,
           p.provider_env, p.failure_reason, p.attempts, a.bank_code, a.account_mask
      FROM payouts p JOIN payout_accounts a ON a.id = p.payout_account_id WHERE p.transaction_id = ${tx.id} ORDER BY p.created_at`;
  const journals = await db<{ id: string; seq: number; kind: string; description: string; idempotency_key: string | null; posted_at: Date; refund_id: string | null; payout_id: string | null; payment_id: string | null }[]>`
    SELECT id, seq, kind, description, idempotency_key, posted_at, refund_id, payout_id, payment_id FROM ledger_journals WHERE transaction_id = ${tx.id} ORDER BY seq`;
  const entries = journals.length
    ? await db<{ journal_id: string; bucket: string; owner_user_id: string | null; direction: string; amount: number; memo: string | null }[]>`
        SELECT e.journal_id, a.bucket, a.owner_user_id, e.direction, e.amount, e.memo FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
         WHERE e.journal_id IN ${db(journals.map((j) => j.id))} ORDER BY e.id`
    : [];
  const escrow = await db<{ bucket: string; net_credit: number }[]>`SELECT bucket, net_credit FROM v_transaction_ledger WHERE transaction_id = ${tx.id} ORDER BY bucket`;
  const events = await db<{ from_status: string | null; to_status: string; actor_type: string; actor_id: string | null; reason: string | null; created_at: Date }[]>`
    SELECT from_status, to_status, actor_type, actor_id, reason, created_at FROM transaction_events WHERE transaction_id = ${tx.id} ORDER BY id`;
  const disputes = await db<{ id: string; number: string; status: string; type: string; resolution: string | null; resolution_amount_idr: number | null; created_at: Date }[]>`
    SELECT id, number, status, type, resolution, resolution_amount_idr, created_at FROM disputes WHERE transaction_id = ${tx.id} ORDER BY created_at`;
  const proofs = await db<{ id: string; status: string; merchant_name: string; actual_price_minor: number; currency: string; fraud_reasons: unknown; created_at: Date }[]>`
    SELECT id, status, merchant_name, actual_price_minor, currency, fraud_reasons, created_at FROM purchase_proofs WHERE transaction_id = ${tx.id} ORDER BY created_at`;
  const delivery = await liveDelivery(db, tx.id);
  const [conv] = await db<{ id: string }[]>`SELECT id FROM conversations WHERE transaction_id = ${tx.id}`;
  const balanced = entries.length === 0 || journals.every((j) => {
    const js = entries.filter((e) => e.journal_id === j.id);
    return js.filter((e) => e.direction === 'DEBIT').reduce((s, e) => s + num(e.amount), 0) === js.filter((e) => e.direction === 'CREDIT').reduce((s, e) => s + num(e.amount), 0);
  });
  return {
    id: tx.id,
    number: tx.number,
    status: tx.status,
    version: tx.version,
    item: req ? { productName: req.product_name, categoryCode: req.category_code, merchantCountry: req.merchant_country?.trim() ?? null, merchantName: req.merchant_name, restrictionClass: req.restriction_class, quantity: req.quantity, unitPriceMinor: req.unit_price_minor, currency: req.price_currency?.trim() ?? null } : null,
    buyer: party(tx.buyerId),
    traveler: party(tx.travelerId),
    tripId: tx.tripId,
    totalIdr: tx.totalIdr,
    securedIdr: tx.securedIdr,
    payoutHoldReason: tx.payoutHoldReason,
    purchaseGate: purchaseGate(tx.status as TransactionStatus),
    quote: quote ? quoteView(quote) : null,
    payments,
    refunds: await refundViews(db, tx.id),
    payouts: payouts.map((p) => ({
      id: String(p.id), number: String(p.number), status: String(p.status), amountIdr: num(p.amount_idr), feeIdr: num(p.fee_idr), netIdr: num(p.net_idr),
      holdReason: (p.hold_reason as string | null) ?? null, heldBy: (p.held_by as string | null) ?? null, releasedBy: (p.released_by as string | null) ?? null,
      scheduledFor: iso(p.scheduled_for as Date), paidAt: iso(p.paid_at as Date | null), providerEnv: String(p.provider_env), failureReason: (p.failure_reason as string | null) ?? null,
      attempts: num(p.attempts), destination: { bankCode: String(p.bank_code), accountMask: String(p.account_mask) },
    })),
    ledger: {
      balanced,
      escrow: escrow.map((e) => ({ bucket: e.bucket, netCreditIdr: num(e.net_credit) })),
      journals: journals.map((j) => ({
        id: j.id, seq: num(j.seq), kind: j.kind, description: j.description, idempotencyKey: j.idempotency_key, postedAt: iso(j.posted_at)!,
        refundId: j.refund_id, payoutId: j.payout_id, paymentId: j.payment_id,
        entries: entries.filter((e) => e.journal_id === j.id).map((e) => ({ bucket: e.bucket, ownerUserId: e.owner_user_id, direction: e.direction, amountIdr: num(e.amount), memo: e.memo })),
      })),
    },
    priceConfirmations: await priceConfirmationsForTx(db, tx, quote),
    purchaseProofs: proofs.map((p) => ({ id: p.id, status: p.status, merchantName: p.merchant_name, actualPriceMinor: num(p.actual_price_minor), currency: p.currency.trim(), fraudReasons: p.fraud_reasons, createdAt: iso(p.created_at)! })),
    delivery: deliveryView(delivery, 'TRAVELER'),
    disputes: disputes.map((d) => ({ id: d.id, number: d.number, status: d.status, type: d.type, resolution: d.resolution, resolutionAmountIdr: d.resolution_amount_idr === null ? null : num(d.resolution_amount_idr), createdAt: iso(d.created_at)! })),
    conversationId: conv?.id ?? null,
    events: events.map((e) => ({ from: e.from_status, to: e.to_status, actorType: e.actor_type, actorId: e.actor_id, reason: e.reason, at: iso(e.created_at)! })),
    adminAllowedTransitions: nextAllowed(tx.status as TransactionStatus, 'ADMIN'),
    createdAt: iso(tx.createdAt)!,
    updatedAt: iso(tx.updatedAt)!,
  };
}

export async function adminCancel(ctx: AdminCtx, id: string, input: { reason: string; cause?: string | undefined; approvalNote: string }) {
  const out = await inAdminTx(ctx, async (db) => {
    const tx = await loadTx(db, id, { forUpdate: true });
    if (!tx) throw Errors.notFound('Transaksi', 'TRANSACTION_NOT_FOUND');
    if (tx.status === 'DISPUTED') throw Errors.unprocessable('USE_DISPUTE_RESOLUTION', 'Transaksi sedang dispute; selesaikan lewat resolusi dispute');
    const res = await cancelInTx(ctx.deps, db, tx, {
      actor: 'ADMIN',
      actorId: ctx.auth.userId,
      reason: input.reason,
      ...(input.cause ? { cause: input.cause } : {}),
      refundReasonCode: 'ADMIN',
      adminApprovalRecorded: true,
    });
    await adminAudit(db, ctx, {
      action: 'transactions.admin_cancel',
      entityType: 'transaction',
      entityId: id,
      before: { status: tx.status },
      after: { status: res.status },
      meta: { reason: input.reason, cause: input.cause ?? null, approvalNote: input.approvalNote, stage: res.cancellation.stage, refundIdr: res.cancellation.refundIdr },
    });
    return res;
  });
  if (out.refunds.length) await processRefunds(ctx.deps, { transactionId: id });
  const fresh = await loadTx(ctx.deps.sql, id);
  return { ...out, status: fresh?.status ?? out.status, refunds: await refundViews(ctx.deps.sql, id) };
}

export async function adminRefund(ctx: AdminCtx, id: string, input: { amountIdr: number; reason: string; remainderTo: 'TRAVELER' | 'NONE' }, idempotencyKey: string) {
  const rows = await inAdminTx(ctx, async (db) => {
    const tx = await loadTx(db, id, { forUpdate: true });
    if (!tx) throw Errors.notFound('Transaksi', 'TRANSACTION_NOT_FOUND');
    if (tx.status === 'DISPUTED') throw Errors.unprocessable('USE_DISPUTE_RESOLUTION', 'Transaksi sedang dispute; selesaikan lewat resolusi dispute');
    const created = await requestRefund(ctx.deps, db, id, {
      amountIdr: input.amountIdr,
      reasonCode: 'ADMIN',
      reasonNote: input.reason,
      requestedBy: ctx.auth.userId,
      actorType: 'ADMIN',
      remainderTo: input.remainderTo,
      adminApprovalRecorded: true,
      idempotencyKey: `admin-refund:${id}:${idempotencyKey}`,
    });
    await adminAudit(db, ctx, {
      action: 'transactions.admin_refund',
      entityType: 'transaction',
      entityId: id,
      before: { status: tx.status },
      after: { refunds: created.map((r) => ({ id: r.id, status: r.status, amountIdr: r.amountIdr })) },
      meta: { reason: input.reason, amountIdr: input.amountIdr, remainderTo: input.remainderTo },
    });
    return created;
  });
  await processRefunds(ctx.deps, { transactionId: id });
  const fresh = await loadTx(ctx.deps.sql, id);
  return {
    status: fresh?.status ?? null,
    refunds: await refundViews(ctx.deps.sql, id),
    created: rows.map((r) => r.id),
    note: rows.some((r) => r.status === 'PENDING_APPROVAL') ? 'Refund di atas batas auto-approve menunggu persetujuan admin lain (maker-checker).' : null,
  };
}
