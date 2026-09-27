/**
 * Transaction reads: list, detail (quote lines, payments, price confirmations, proof, delivery, refunds,
 * purchaseGate + allowedActions for the caller), timeline.
 */
import { evaluateCancellation, nextAllowed, purchaseGate, type TransactionStatus } from '@jastipkita/core';
import type { AppDeps, AuthContext } from '../../context';
import { camel } from '../../db/sql';
import { fileContentUrl } from '../../lib/openapi';
import { decodeCursor, encodeCursor } from '../../lib/pagination';
import { quoteView } from '../checkout/service';
import { loadQuote, loadRequest, loadTrip, type LoadedQuote } from '../checkout/repository';
import { publicDisplayName, trustBadge, trustTier } from '../catalog/shared';
import { deliveryView, liveDelivery } from '../delivery/service';
import { paymentsForTx, paymentView } from '../payments/repository';
import { priceConfirmationsForTx } from '../price-confirmation/service';
import { refundViews } from '../refunds/service';
import { type PartyRole, requireParty, type TxRow } from './common';

type RatingSide = { average: number | null; count: number };

export interface PartyProfile {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  trustScore: number;
  trustTier: ReturnType<typeof trustTier>;
  trustBadge: ReturnType<typeof trustBadge>;
  kycLevel: number;
  identityVerified: boolean;
  ratingSummary: { asTraveler: RatingSide; asBuyer: RatingSide };
  memberSince: string;
  /** Deprecated alias (unweighted averages; null without a rating summary row). */
  rating: { asTraveler: RatingSide; asBuyer: RatingSide } | null;
}

interface PartyRow {
  id: string;
  display_name: string | null;
  kyc_level: number;
  trust_score: number;
  created_at: Date;
  avatar_file_id: string | null;
  has_summary: boolean;
  as_traveler_count: number | null;
  as_traveler_avg: string | null;
  as_traveler_weighted: string | null;
  as_buyer_count: number | null;
  as_buyer_avg: string | null;
  as_buyer_weighted: string | null;
}

const numOr = (v: string | null | undefined): number | null => (v === null || v === undefined ? null : Number(v));

/**
 * Public profiles of transaction parties (first name + initial, trust, KYC level, ratings, avatar) — never
 * e-mail, phone or the full name. The avatar is only linked when the AVATAR file is ready.
 */
export async function partyProfiles(deps: AppDeps, ids: readonly (string | null | undefined)[]): Promise<Map<string, PartyProfile>> {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  const out = new Map<string, PartyProfile>();
  if (!unique.length) return out;
  const rows = await deps.sql<PartyRow[]>`
    SELECT u.id, u.display_name, u.kyc_level, u.trust_score, u.created_at,
           CASE WHEN f.id IS NOT NULL THEN u.avatar_file_id END AS avatar_file_id,
           rs.user_id IS NOT NULL AS has_summary,
           rs.as_traveler_count, rs.as_traveler_avg::text AS as_traveler_avg, rs.as_traveler_weighted::text AS as_traveler_weighted,
           rs.as_buyer_count, rs.as_buyer_avg::text AS as_buyer_avg, rs.as_buyer_weighted::text AS as_buyer_weighted
      FROM users u
      LEFT JOIN files f ON f.id = u.avatar_file_id AND f.purpose = 'AVATAR' AND f.deleted_at IS NULL AND f.scan_status = 'CLEAN'
      LEFT JOIN user_rating_summaries rs ON rs.user_id = u.id
     WHERE u.id = ANY(${unique}::uuid[])`;
  for (const u of rows) {
    const side = (count: number | null, weighted: string | null, avg: string | null): RatingSide => ({ average: numOr(weighted ?? avg), count: count ?? 0 });
    out.set(u.id, {
      id: u.id,
      displayName: publicDisplayName(u.display_name),
      avatarUrl: u.avatar_file_id ? fileContentUrl(deps.env.API_BASE_URL, u.avatar_file_id) : null,
      trustScore: u.trust_score,
      trustTier: trustTier(u.trust_score),
      trustBadge: trustBadge(u.kyc_level),
      kycLevel: u.kyc_level,
      identityVerified: u.kyc_level >= 3,
      ratingSummary: {
        asTraveler: side(u.as_traveler_count, u.as_traveler_weighted, u.as_traveler_avg),
        asBuyer: side(u.as_buyer_count, u.as_buyer_weighted, u.as_buyer_avg),
      },
      memberSince: u.created_at.toISOString(),
      rating: u.has_summary
        ? {
            asTraveler: { count: u.as_traveler_count ?? 0, average: numOr(u.as_traveler_avg) },
            asBuyer: { count: u.as_buyer_count ?? 0, average: numOr(u.as_buyer_avg) },
          }
        : null,
    });
  }
  return out;
}

/** First image of each request as an absolute URL (merchant image URL, or the uploaded file's content URL). */
async function requestImageUrls(deps: AppDeps, requestIds: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!requestIds.length) return out;
  const rows = await deps.sql<{ request_id: string; file_id: string | null; source_url: string | null }[]>`
    SELECT DISTINCT ON (request_id) request_id, file_id, source_url
      FROM request_images WHERE request_id = ANY(${[...new Set(requestIds)]}::uuid[])
     ORDER BY request_id, sort`;
  for (const r of rows) {
    const url = r.source_url ?? (r.file_id ? fileContentUrl(deps.env.API_BASE_URL, r.file_id) : null);
    if (url) out.set(r.request_id, url);
  }
  return out;
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
    purchaseCeilingIdr: tx.purchaseCeilingIdr,
    purchaseCeilingMinor: tx.purchaseCeilingMinor,
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
  const txs = rows.map((r) => camel<TxRow & { productName: string; categoryCode: string | null; merchantCountry: string | null }>(r));
  const hasMore = txs.length > q.limit;
  const page = hasMore ? txs.slice(0, q.limit) : txs;
  const counterpartIds = page.map((tx) => (tx.buyerId === auth.userId ? tx.travelerId : tx.buyerId));
  const [profiles, images] = await Promise.all([partyProfiles(deps, counterpartIds), requestImageUrls(deps, page.map((tx) => tx.requestId))]);
  const data = page.map((tx) => {
    const role: PartyRole = tx.buyerId === auth.userId ? 'BUYER' : 'TRAVELER';
    const otherId = role === 'BUYER' ? tx.travelerId : tx.buyerId;
    const other = otherId ? profiles.get(otherId) : undefined;
    return {
      ...txSummary(tx),
      role,
      item: {
        productName: tx.productName,
        categoryCode: tx.categoryCode,
        merchantCountry: tx.merchantCountry?.trim() ?? null,
        imageUrl: images.get(tx.requestId) ?? null,
      },
      counterparty: otherId
        ? {
            id: otherId,
            role: role === 'BUYER' ? ('TRAVELER' as const) : ('BUYER' as const),
            displayName: other?.displayName ?? publicDisplayName(null),
            avatarUrl: other?.avatarUrl ?? null,
          }
        : null,
      purchaseGate: role === 'TRAVELER' ? purchaseGate(tx.status) : null,
    };
  });
  const last = page[page.length - 1];
  return {
    data,
    nextCursor: hasMore && last ? encodeCursor({ t: new Date(last.createdAt).toISOString(), id: last.id }) : null,
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

type ProofRow = {
  id: string;
  receipt_file_id: string;
  product_photo_file_ids: string[];
  video_file_id: string | null;
  serial_number: string | null;
  merchant_name: string;
  actual_price_minor: number;
  currency: string;
  purchased_at: Date;
  status: 'SUBMITTED' | 'ACCEPTED' | 'FLAGGED' | 'REJECTED';
};

type DeclRow = {
  id: string;
  status: 'NOT_REQUIRED' | 'PENDING' | 'SUBMITTED' | 'PAID' | 'VERIFIED' | 'REJECTED';
  duty_paid_idr: number | null;
  vat_paid_idr: number | null;
  income_tax_paid_idr: number | null;
  luxury_tax_paid_idr: number | null;
  total_paid_idr: number | null;
  estimated_total_idr: number | null;
  receipt_file_id: string | null;
  paid_at: Date | null;
};

type PayoutRow = {
  id: string;
  number: string;
  status: 'SCHEDULED' | 'ON_HOLD' | 'PROCESSING' | 'PAID' | 'FAILED' | 'CANCELLED';
  amount_idr: number;
  net_idr: number;
  hold_reason: string | null;
  scheduled_for: Date | null;
  paid_at: Date | null;
};

/** Purchase proof as both parties may see it: the evidence files it references, never fraud scores/reasons. */
async function proofView(deps: AppDeps, tx: TxRow, role: PartyRole, p: ProofRow) {
  const refs: { id: string; kind: 'RECEIPT' | 'PRODUCT_PHOTO' | 'VIDEO' }[] = [
    { id: p.receipt_file_id, kind: 'RECEIPT' },
    ...(p.product_photo_file_ids ?? []).map((id) => ({ id, kind: 'PRODUCT_PHOTO' as const })),
    ...(p.video_file_id ? [{ id: p.video_file_id, kind: 'VIDEO' as const }] : []),
  ];
  const meta = await deps.sql<{ id: string; mime: string; size_bytes: number | null }[]>`
    SELECT id, mime, size_bytes FROM files WHERE id = ANY(${refs.map((r) => r.id)}::uuid[]) AND deleted_at IS NULL`;
  const byId = new Map(meta.map((m) => [m.id, m]));
  return {
    id: p.id,
    status: p.status,
    merchantName: p.merchant_name,
    actualPriceMinor: p.actual_price_minor,
    currency: String(p.currency).trim(),
    purchasedAt: new Date(p.purchased_at).toISOString(),
    receiptFileId: p.receipt_file_id,
    productPhotoFileIds: p.product_photo_file_ids ?? [],
    videoFileId: p.video_file_id,
    serialNumber: role === 'TRAVELER' || ['DELIVERED', 'BUYER_CONFIRMED', 'COMPLETED'].includes(tx.status) ? p.serial_number : null,
    files: refs.map((r) => ({
      id: r.id,
      kind: r.kind,
      mime: byId.get(r.id)?.mime ?? null,
      sizeBytes: byId.get(r.id)?.size_bytes ?? null,
      contentUrl: fileContentUrl(deps.env.API_BASE_URL, r.id),
    })),
  };
}

export async function getTransactionDetail(deps: AppDeps, auth: AuthContext, id: string) {
  const { tx, role } = await requireParty(deps.sql, id, auth);
  const db = deps.sql;
  const req = await loadRequest(db, tx.requestId);
  const trip = tx.tripId ? await loadTrip(db, tx.tripId) : null;
  const q = tx.activeQuoteId ? await loadQuote(db, tx.activeQuoteId) : null;
  const payments = await paymentsForTx(db, tx.id);
  const pcs = await priceConfirmationsForTx(db, tx, q);
  const openPc = pcs.find((p) => p.status === 'PENDING' || p.status === 'CLARIFICATION_REQUESTED') ?? null;
  const [proofRow] = await db<ProofRow[]>`
    SELECT id, receipt_file_id, product_photo_file_ids, video_file_id, serial_number, merchant_name, actual_price_minor, currency, purchased_at, status
      FROM purchase_proofs WHERE transaction_id = ${tx.id} ORDER BY created_at DESC LIMIT 1`;
  const [decl] = await db<DeclRow[]>`
    SELECT id, status, duty_paid_idr, vat_paid_idr, income_tax_paid_idr, luxury_tax_paid_idr, total_paid_idr, estimated_total_idr, receipt_file_id, paid_at
      FROM customs_declarations WHERE transaction_id = ${tx.id} AND status <> 'REJECTED' LIMIT 1`;
  const delivery = await liveDelivery(db, tx.id);
  const refunds = await refundViews(db, tx.id);
  const [payout] = role === 'TRAVELER'
    ? await db<PayoutRow[]>`
        SELECT id, number, status, amount_idr, net_idr, hold_reason, scheduled_for, paid_at FROM payouts WHERE transaction_id = ${tx.id} ORDER BY created_at DESC LIMIT 1`
    : [];
  const [conv] = await db<{ id: string }[]>`SELECT id FROM conversations WHERE transaction_id = ${tx.id}`;
  const profiles = await partyProfiles(deps, [tx.buyerId, tx.travelerId]);
  const images = await requestImageUrls(deps, [tx.requestId]);
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
          currency: req.priceCurrency,
          priceCurrency: req.priceCurrency,
          imageUrl: images.get(req.id) ?? null,
          maxBudgetIdr: role === 'BUYER' ? req.maxBudgetIdr : null,
        }
      : null,
    buyer: profiles.get(tx.buyerId) ?? null,
    traveler: tx.travelerId ? (profiles.get(tx.travelerId) ?? null) : null,
    trip: trip
      ? {
          id: trip.id,
          status: trip.status,
          originCountry: trip.originCountry,
          originCity: trip.originCity,
          destinationCountry: trip.destinationCountry,
          destinationCity: trip.destinationCity,
          departureDate: trip.departureDate,
          arrivalDate: trip.arrivalDate,
        }
      : null,
    quote: q ? quoteView(q) : null,
    payments: payments.map((p) => paymentView(p, { includeCheckoutUrl: role === 'BUYER' })),
    priceConfirmations: pcs,
    purchaseProof: proofRow ? await proofView(deps, tx, role, proofRow) : null,
    customsDeclaration: decl
      ? {
          id: decl.id,
          status: decl.status,
          dutyPaidIdr: decl.duty_paid_idr,
          vatPaidIdr: decl.vat_paid_idr,
          incomeTaxPaidIdr: decl.income_tax_paid_idr,
          luxuryTaxPaidIdr: decl.luxury_tax_paid_idr,
          totalPaidIdr: decl.total_paid_idr,
          estimatedTotalIdr: decl.estimated_total_idr,
          receiptFileId: decl.receipt_file_id,
          paidAt: decl.paid_at ? decl.paid_at.toISOString() : null,
        }
      : null,
    delivery: deliveryView(delivery, role, tx.status),
    refunds,
    payout: payout
      ? {
          id: payout.id,
          number: payout.number,
          status: payout.status,
          amountIdr: payout.amount_idr,
          netIdr: payout.net_idr,
          holdReason: payout.hold_reason,
          scheduledAt: payout.scheduled_for?.toISOString() ?? null,
          paidAt: payout.paid_at?.toISOString() ?? null,
        }
      : null,
    conversationId: conv?.id ?? null,
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
