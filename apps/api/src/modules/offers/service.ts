/**
 * Offers & invites → accepted offer creates the transaction (REQUEST_CREATED → MATCHED) in ONE DB
 * transaction with the capacity reservation (§4 guard MATCH_PRECONDITIONS via core).
 */
import { canTransition, computeTravelerFee, formatTransactionNumber } from '@jastipkita/core';
import type { AppDeps, AuthContext } from '../../context';
import type { Db, TxSql } from '../../db/sql';
import { randomBytes } from '../../lib/crypto';
import { Errors } from '../../lib/errors';
import { emitEvent } from '../../services/outbox';
import { badCursor, ceilKg, core, decodeKeyset, encodeKeyset, iso, tx, wibDate } from '../catalog/shared';
import { toIdrAtSpot } from '../fx/service';
import { type PublicProfileDto, type UserSignals, loadUserSignals, publicProfile, travelerLimit, unitWeightKg } from '../matching/signals';
import * as reqRepo from '../requests/repository';
import { type RequestListingDto, listingDtos } from '../requests/service';
import { classifyRequestItem } from '../restricted/service';
import * as tripRepo from '../trips/repository';
import { type TripPublicDto, effectiveRemainingKg, feeSpec, publicTripDto, reserveTripCapacity } from '../trips/service';
import { closePendingOffers, offerEventPayload } from './lifecycle';
import * as repo from './repository';
import type { OfferRow, OfferStatus } from './repository';

type Deps = Pick<AppDeps, 'sql' | 'config' | 'clock' | 'logger' | 'providers' | 'env'>;

/** Assumption (no business config key yet): offers/invites expire after 48 h (or with the request). */
export const OFFER_TTL_HOURS = 48;
const NUMBER_ATTEMPTS = 5;

export interface OfferDto {
  id: string;
  requestId: string;
  tripId: string;
  travelerId: string;
  buyerId: string;
  initiatedBy: 'TRAVELER' | 'BUYER';
  travelerFeeIdr: number;
  message: string | null;
  status: OfferStatus;
  expiresAt: string | null;
  respondedAt: string | null;
  declineReason: string | null;
  transactionId: string | null;
  createdAt: string;
  trip: TripPublicDto | null;
  traveler: PublicProfileDto;
  request: RequestListingDto | null;
  allowedActions: ('ACCEPT' | 'DECLINE' | 'WITHDRAW')[];
}

async function offerDtos(db: Db, deps: Deps, rows: OfferRow[], viewer: string): Promise<OfferDto[]> {
  if (rows.length === 0) return [];
  const trips = new Map<string, tripRepo.TripRow>();
  for (const id of new Set(rows.map((r) => r.trip_id))) {
    const t = await tripRepo.getTrip(db, id);
    if (t) trips.set(id, t);
  }
  const reqs = new Map<string, reqRepo.RequestRow>();
  for (const id of new Set(rows.map((r) => r.request_id))) {
    const r = await reqRepo.getRequest(db, id);
    if (r) reqs.set(id, r);
  }
  const signals = await loadUserSignals(db, rows.map((r) => r.traveler_id));
  const listings = new Map((await listingDtos(db, deps, [...reqs.values()])).map((l) => [l.id, l]));
  const now = deps.clock.now();
  return rows.map((o) => {
    const t = trips.get(o.trip_id);
    const traveler = publicProfile(signals.get(o.traveler_id), o.traveler_id, 'TRAVELER');
    const pending = o.status === 'PENDING' && (!o.expires_at || o.expires_at > now);
    const counterparty = o.initiated_by === 'TRAVELER' ? o.buyer_id : o.traveler_id;
    const initiator = o.initiated_by === 'TRAVELER' ? o.traveler_id : o.buyer_id;
    const actions: OfferDto['allowedActions'] = [];
    if (pending && viewer === counterparty) actions.push('ACCEPT', 'DECLINE');
    if (pending && viewer === initiator) actions.push('WITHDRAW');
    return {
      id: o.id,
      requestId: o.request_id,
      tripId: o.trip_id,
      travelerId: o.traveler_id,
      buyerId: o.buyer_id,
      initiatedBy: o.initiated_by,
      travelerFeeIdr: o.traveler_fee_idr,
      message: o.message,
      status: o.status,
      expiresAt: iso(o.expires_at),
      respondedAt: iso(o.responded_at),
      declineReason: o.decline_reason,
      transactionId: o.transaction_id,
      createdAt: o.created_at.toISOString(),
      trip: t ? publicTripDto(t, traveler) : null,
      traveler,
      request: listings.get(o.request_id) ?? null,
      allowedActions: actions,
    };
  });
}

// ------------------------------------------------------------------------------ pair evaluation

interface PairEvaluation {
  itemValueIdr: number;
  totalKg: number;
  items: number;
  defaultFeeIdr: number;
  feeBounds: { minIdr: number; maxIdr: number };
}

/**
 * Business checks shared by offer/invite creation and acceptance. Throws a 422/409 AppError with a
 * stable code for the first failing rule.
 */
async function evaluatePair(
  db: Db,
  deps: Deps,
  r: reqRepo.RequestRow,
  trip: tripRepo.TripRow,
  traveler: UserSignals,
  restrictionClass: reqRepo.RestrictionClass | null,
): Promise<PairEvaluation> {
  const now = deps.clock.now();
  const today = wibDate(now);
  if (r.status !== 'OPEN' || (r.expires_at && r.expires_at <= now)) throw Errors.conflict('REQUEST_NOT_OPEN', 'Titipan tidak lagi terbuka', { status: r.status });
  if (r.buyer_id === traveler.userId) throw Errors.unprocessable('SELF_OFFER', 'Tidak dapat menitip ke diri sendiri');
  if (trip.status !== 'ACTIVE') throw Errors.unprocessable('TRIP_NOT_ACTIVE', 'Trip belum/tidak lagi aktif', { status: trip.status });
  if (trip.departure_date < today) throw Errors.unprocessable('TRIP_DEPARTED', 'Trip sudah berangkat');
  if (r.merchant_country !== trip.origin_country || r.destination_country !== trip.destination_country) {
    throw Errors.unprocessable('ROUTE_MISMATCH', `Trip ${trip.origin_country}→${trip.destination_country} tidak cocok dengan titipan ${r.merchant_country}→${r.destination_country}`);
  }
  if (r.needed_by && trip.arrival_date > r.needed_by) throw Errors.unprocessable('ARRIVES_TOO_LATE', 'Trip tiba setelah batas waktu titipan', { neededBy: r.needed_by, arrivalDate: trip.arrival_date });
  if (r.category_code && trip.excluded_categories.includes(r.category_code)) throw Errors.unprocessable('CATEGORY_EXCLUDED', 'Traveler tidak menerima kategori ini');
  if (restrictionClass === 'PROHIBITED') throw Errors.unprocessable('ITEM_PROHIBITED', 'Barang dilarang');
  if (traveler.status !== 'ACTIVE') throw Errors.unprocessable('TRAVELER_NOT_ELIGIBLE', 'Traveler tidak aktif');
  if (traveler.kycLevel < 3) throw Errors.unprocessable('TRAVELER_NOT_ELIGIBLE', 'Traveler belum terverifikasi identitas (KYC level 3)', { kycLevel: traveler.kycLevel });
  if (r.unit_price_minor === null || !r.price_currency) throw Errors.unprocessable('REQUEST_INCOMPLETE', 'Harga barang belum diisi');

  const categories = await reqRepo.categoryDefaults(db, [r.category_code ?? '']);
  const cat = r.category_code ? categories.get(r.category_code) : undefined;
  const totalKg = ceilKg(unitWeightKg(r.est_weight_kg, cat?.weightKg) * r.quantity);
  const remaining = effectiveRemainingKg(trip);
  if (totalKg > remaining || (trip.max_items !== null && trip.reserved_items + r.quantity > trip.max_items)) {
    throw Errors.unprocessable('CAPACITY_INSUFFICIENT', `Butuh ${totalKg} kg, sisa kapasitas ${remaining} kg`, { neededKg: totalKg, remainingKg: remaining });
  }
  const { idr: itemValueIdr } = await toIdrAtSpot(db, deps, r.unit_price_minor * r.quantity, r.price_currency);
  const [country] = await db<{ risk_level: 'LOW' | 'MEDIUM' | 'HIGH' }[]>`SELECT risk_level FROM countries WHERE code = ${trip.origin_country}`;
  const limit = await travelerLimit(db, deps, traveler, cat?.risk ?? 'MEDIUM', country?.risk_level ?? 'MEDIUM');
  if (limit.baseIdr === 0 || itemValueIdr > limit.effectiveMaxIdr) {
    throw Errors.unprocessable('TRAVELER_LIMIT_EXCEEDED', 'Nilai barang melebihi limit transaksi traveler', {
      itemValueIdr,
      limitIdr: limit.effectiveMaxIdr,
      reasons: limit.reasons.map((x) => x.message),
    });
  }
  const bounds = await deps.config.get('pricing.traveler_fee_bounds');
  const fee = await core(() => computeTravelerFee(feeSpec(trip), itemValueIdr, totalKg, bounds));
  const cap = Math.floor((itemValueIdr * bounds.maxRateBps) / 10_000);
  return { itemValueIdr, totalKg, items: r.quantity, defaultFeeIdr: fee.amountIdr, feeBounds: { minIdr: bounds.minIdr, maxIdr: Math.max(cap, bounds.minIdr) } };
}

function checkFee(fee: number, ev: PairEvaluation): void {
  if (fee < ev.feeBounds.minIdr || fee > ev.feeBounds.maxIdr) {
    throw Errors.unprocessable('FEE_OUT_OF_BOUNDS', `Traveler fee harus antara Rp${ev.feeBounds.minIdr.toLocaleString('id-ID')} dan Rp${ev.feeBounds.maxIdr.toLocaleString('id-ID')}`, {
      ...ev.feeBounds,
      proposedIdr: fee,
    });
  }
}

function offerExpiry(deps: Deps, r: reqRepo.RequestRow): Date {
  const ttl = new Date(deps.clock.now().getTime() + OFFER_TTL_HOURS * 3_600_000);
  return r.expires_at && r.expires_at < ttl ? r.expires_at : ttl;
}

async function travelerSignals(db: Db, userId: string): Promise<UserSignals> {
  const s = (await loadUserSignals(db, [userId])).get(userId);
  if (!s) throw Errors.notFound('User');
  return s;
}

// ------------------------------------------------------------------------------ create

export async function createTravelerOffer(
  deps: Deps,
  auth: AuthContext,
  requestId: string,
  input: { tripId: string; travelerFeeIdr?: number | undefined; message?: string | null | undefined },
): Promise<OfferDto> {
  if (auth.kycLevel < 3) throw Errors.kycRequired(3, auth.kycLevel);
  return tx(deps.sql, async (t) => {
    const r = await reqRepo.getRequest(t, requestId, { forUpdate: true });
    if (!r || (r.status === 'DRAFT' && r.buyer_id !== auth.userId)) throw Errors.notFound('Request', 'REQUEST_NOT_FOUND');
    const trip = await tripRepo.getTrip(t, input.tripId);
    if (!trip || trip.traveler_id !== auth.userId) throw Errors.notFound('Trip', 'TRIP_NOT_FOUND');
    const ev = await evaluatePair(t, deps, r, trip, await travelerSignals(t, auth.userId), r.restriction_class);
    const fee = input.travelerFeeIdr ?? ev.defaultFeeIdr;
    checkFee(fee, ev);
    if (await repo.hasPendingOffer(t, r.id, trip.id)) throw Errors.conflict('OFFER_ALREADY_PENDING', 'Sudah ada penawaran aktif untuk trip ini');
    const id = await repo.insertOffer(t, {
      requestId: r.id,
      tripId: trip.id,
      travelerId: auth.userId,
      initiatedBy: 'TRAVELER',
      travelerFeeIdr: fee,
      message: input.message ?? null,
      expiresAt: offerExpiry(deps, r),
    });
    const o = (await repo.getOffer(t, id))!;
    await emitEvent(t, 'offer', id, 'offer.created', offerEventPayload(o, { travelerFeeIdr: fee }));
    return (await offerDtos(t, deps, [o], auth.userId))[0]!;
  });
}

/** Buyer invites a traveler's ACTIVE trip for one of their OPEN requests (fee from the trip's fee spec). */
export async function createBuyerInvite(
  deps: Deps,
  auth: AuthContext,
  tripId: string,
  input: { requestId: string; message?: string | null | undefined },
): Promise<OfferDto> {
  return tx(deps.sql, async (t) => {
    const r = await reqRepo.getRequest(t, input.requestId, { forUpdate: true });
    if (!r || r.buyer_id !== auth.userId) throw Errors.notFound('Request', 'REQUEST_NOT_FOUND');
    const trip = await tripRepo.getTrip(t, tripId);
    if (!trip || !['ACTIVE', 'FULL', 'TRAVELING', 'COMPLETED'].includes(trip.status)) throw Errors.notFound('Trip', 'TRIP_NOT_FOUND');
    const ev = await evaluatePair(t, deps, r, trip, await travelerSignals(t, trip.traveler_id), r.restriction_class);
    if (await repo.hasPendingOffer(t, r.id, trip.id)) throw Errors.conflict('OFFER_ALREADY_PENDING', 'Sudah ada penawaran/undangan aktif untuk trip ini');
    const id = await repo.insertOffer(t, {
      requestId: r.id,
      tripId: trip.id,
      travelerId: trip.traveler_id,
      initiatedBy: 'BUYER',
      travelerFeeIdr: ev.defaultFeeIdr,
      message: input.message ?? null,
      expiresAt: offerExpiry(deps, r),
    });
    const o = (await repo.getOffer(t, id))!;
    await emitEvent(t, 'offer', id, 'offer.created', offerEventPayload(o, { travelerFeeIdr: ev.defaultFeeIdr }));
    return (await offerDtos(t, deps, [o], auth.userId))[0]!;
  });
}

// ------------------------------------------------------------------------------ queries

export async function listRequestOffers(deps: Deps, auth: AuthContext, requestId: string): Promise<{ data: OfferDto[] }> {
  const r = await reqRepo.getRequest(deps.sql, requestId);
  if (!r) throw Errors.notFound('Request', 'REQUEST_NOT_FOUND');
  const isBuyer = r.buyer_id === auth.userId;
  const rows = await repo.listForRequest(deps.sql, requestId, isBuyer ? null : auth.userId);
  if (!isBuyer && rows.length === 0 && r.status !== 'OPEN') throw Errors.notFound('Request', 'REQUEST_NOT_FOUND');
  return { data: await offerDtos(deps.sql, deps, rows, auth.userId) };
}

export async function listMyOffers(
  deps: Deps,
  auth: AuthContext,
  q: { role?: 'traveler' | 'buyer' | undefined; status?: OfferStatus | undefined; limit: number; cursor?: string | undefined },
): Promise<{ data: OfferDto[]; nextCursor: string | null }> {
  const cur = decodeKeyset(q.cursor);
  if (q.cursor && !cur) throw badCursor();
  const rows = await repo.listMine(deps.sql, auth.userId, { role: q.role, status: q.status, limit: q.limit, cursor: cur });
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    data: await offerDtos(deps.sql, deps, page, auth.userId),
    nextCursor: rows.length > q.limit && last ? encodeKeyset(last.created_at.toISOString(), last.id) : null,
  };
}

// ------------------------------------------------------------------------------ respond

async function lockOfferGraph(t: TxSql, offerId: string) {
  const o0 = await repo.getOffer(t, offerId);
  if (!o0) throw Errors.notFound('Offer', 'OFFER_NOT_FOUND');
  // lock order everywhere: request → offer → trip
  const r = await reqRepo.getRequest(t, o0.request_id, { forUpdate: true });
  const o = await repo.getOffer(t, offerId, { forUpdate: true });
  if (!r || !o) throw Errors.notFound('Offer', 'OFFER_NOT_FOUND');
  return { r, o };
}

function assertPending(o: OfferRow, now: Date): void {
  if (o.status === 'ACCEPTED') throw Errors.conflict('OFFER_ALREADY_ACCEPTED', 'Penawaran sudah diterima', { transactionId: o.transaction_id });
  if (o.status !== 'PENDING') throw Errors.conflict('OFFER_NOT_PENDING', `Penawaran berstatus ${o.status}`, { status: o.status });
  if (o.expires_at && o.expires_at <= now) throw Errors.conflict('OFFER_EXPIRED', 'Penawaran sudah kedaluwarsa');
}

export interface AcceptResult {
  offer: OfferDto;
  transaction: { id: string; number: string; status: 'MATCHED'; version: number; buyerId: string; travelerId: string; tripId: string; requestId: string; offerId: string };
}

/**
 * Accept by the counterparty of the initiator. One DB transaction: locks request → offer → trip,
 * re-checks capacity/limits/restriction, inserts `transactions` (REQUEST_CREATED, JK- number from
 * core with CSPRNG bytes, retried on collision), reserves trip capacity (ACTIVE→FULL automation),
 * transition_transaction(→ MATCHED), marks request MATCHED, declines the other pending offers and
 * emits `offer.accepted`.
 */
export async function acceptOffer(deps: Deps, auth: AuthContext, offerId: string): Promise<AcceptResult> {
  return tx(deps.sql, async (t) => {
    const now = deps.clock.now();
    const { r, o } = await lockOfferGraph(t, offerId);
    const isBuyer = auth.userId === r.buyer_id;
    const isTraveler = auth.userId === o.traveler_id;
    if (!isBuyer && !isTraveler) throw Errors.notFound('Offer', 'OFFER_NOT_FOUND');
    const counterpartyIsBuyer = o.initiated_by === 'TRAVELER';
    if (counterpartyIsBuyer !== isBuyer) throw Errors.forbidden('Hanya pihak yang menerima penawaran yang dapat menyetujuinya', 'NOT_COUNTERPARTY');
    if (isTraveler && auth.kycLevel < 3) throw Errors.kycRequired(3, auth.kycLevel);
    assertPending(o, now);
    if (r.status === 'MATCHED') throw Errors.conflict('REQUEST_ALREADY_MATCHED', 'Titipan sudah cocok dengan traveler lain');
    const trip = await tripRepo.getTrip(t, o.trip_id, { forUpdate: true });
    if (!trip) throw Errors.notFound('Trip', 'TRIP_NOT_FOUND');

    // fresh restriction classification with rules in force today
    const cls = await classifyRequestItem(t, deps, {
      originCountry: r.merchant_country ?? '',
      destinationCountry: r.destination_country,
      categoryCode: r.category_code ?? 'OTHER',
      hsCode: r.hs_code,
      productName: r.product_name,
      quantity: r.quantity,
      unitPriceMinor: r.unit_price_minor,
      currency: r.price_currency,
    });
    if (cls.classification !== r.restriction_class) {
      if (cls.classification === 'PROHIBITED') throw Errors.unprocessable('ITEM_PROHIBITED', 'Barang kini masuk daftar larangan', { ruleRef: cls.ruleRef });
      await t`UPDATE requests SET restriction_class = ${cls.classification}, restriction_rule_ref = ${cls.ruleRef},
                restriction_ack_at = CASE WHEN ${cls.requiresAcknowledgement} THEN restriction_ack_at ELSE NULL END WHERE id = ${r.id}`;
    }
    const traveler = await travelerSignals(t, o.traveler_id);
    const ev = await evaluatePair(t, deps, r, trip, traveler, cls.classification);
    const actorType = isBuyer ? 'BUYER' : 'TRAVELER';
    const guard = canTransition('REQUEST_CREATED', 'MATCHED', actorType, {
      offerAcceptedByBoth: true,
      tripStatus: trip.status,
      capacitySufficient: true,
      limitPassed: true,
      restrictedClassification: cls.classification,
    });
    if (!guard.ok) throw Errors.unprocessable(guard.code, guard.message);

    let created: { id: string; number: string; version: number } | null = null;
    for (let attempt = 0; attempt < NUMBER_ATTEMPTS && !created; attempt++) {
      try {
        created = await repo.insertTransaction(t, {
          number: formatTransactionNumber(now, randomBytes(4)),
          requestId: r.id,
          tripId: trip.id,
          offerId: o.id,
          buyerId: r.buyer_id,
          travelerId: o.traveler_id,
          itemCurrency: r.price_currency,
          quantity: r.quantity,
          deliveryMethod: r.delivery_preference && r.delivery_preference !== 'ANY' ? r.delivery_preference : null,
        });
      } catch (err) {
        const e = err as { code?: string; constraint_name?: string };
        if (e.code === '23505' && e.constraint_name === 'transactions_number_key') continue;
        if (e.code === '23505' && e.constraint_name === 'transactions_one_live_per_request') {
          throw Errors.conflict('REQUEST_ALREADY_MATCHED', 'Titipan sudah memiliki transaksi aktif');
        }
        throw err;
      }
    }
    if (!created) throw Errors.internal('Gagal membuat nomor transaksi, coba lagi');

    await reserveTripCapacity(t, { trip, transactionId: created.id, offerId: o.id, kg: ev.totalKg, items: ev.items });
    const [matched] = await t<{ version: number; status: string }[]>`
      SELECT version, status FROM transition_transaction(${created.id}, ${created.version}, 'MATCHED', ${actorType}, ${auth.userId}, 'offer accepted',
        ${t.json({ offerId: o.id, tripId: trip.id, requestId: r.id, initiatedBy: o.initiated_by, travelerFeeIdr: o.traveler_fee_idr, reservedKg: ev.totalKg } as never)}::jsonb)`;
    await repo.setOfferStatus(t, o.id, 'ACCEPTED', now);
    await reqRepo.setStatus(t, r.id, 'MATCHED', now);
    await closePendingOffers(t, { requestId: r.id, excludeOfferId: o.id }, 'DECLINED', 'OTHER_OFFER_ACCEPTED', now);
    await emitEvent(
      t,
      'offer',
      o.id,
      'offer.accepted',
      offerEventPayload(o, { transactionId: created.id, transactionNumber: created.number, acceptedBy: actorType, travelerFeeIdr: o.traveler_fee_idr }),
    );
    const offer = (await offerDtos(t, deps, [(await repo.getOffer(t, o.id))!], auth.userId))[0]!;
    return {
      offer,
      transaction: {
        id: created.id,
        number: created.number,
        status: 'MATCHED',
        version: matched!.version,
        buyerId: r.buyer_id,
        travelerId: o.traveler_id,
        tripId: trip.id,
        requestId: r.id,
        offerId: o.id,
      },
    };
  });
}

export async function declineOffer(deps: Deps, auth: AuthContext, offerId: string, reason: string | null): Promise<OfferDto> {
  return tx(deps.sql, async (t) => {
    const now = deps.clock.now();
    const { r, o } = await lockOfferGraph(t, offerId);
    const isBuyer = auth.userId === r.buyer_id;
    if (!isBuyer && auth.userId !== o.traveler_id) throw Errors.notFound('Offer', 'OFFER_NOT_FOUND');
    if ((o.initiated_by === 'TRAVELER') !== isBuyer) throw Errors.forbidden('Hanya pihak penerima yang dapat menolak; pengirim dapat menarik penawaran', 'NOT_COUNTERPARTY');
    assertPending(o, now);
    const closed = await closePendingOffers(t, { offerIds: [o.id] }, 'DECLINED', reason ?? 'DECLINED_BY_COUNTERPARTY', now);
    if (closed.length === 0) throw Errors.conflict('OFFER_NOT_PENDING', 'Penawaran tidak lagi menunggu');
    return (await offerDtos(t, deps, [(await repo.getOffer(t, o.id))!], auth.userId))[0]!;
  });
}

export async function withdrawOffer(deps: Deps, auth: AuthContext, offerId: string): Promise<OfferDto> {
  return tx(deps.sql, async (t) => {
    const now = deps.clock.now();
    const { r, o } = await lockOfferGraph(t, offerId);
    const initiator = o.initiated_by === 'TRAVELER' ? o.traveler_id : r.buyer_id;
    if (auth.userId !== initiator) {
      if (auth.userId === r.buyer_id || auth.userId === o.traveler_id) throw Errors.forbidden('Hanya pengirim penawaran yang dapat menariknya', 'NOT_INITIATOR');
      throw Errors.notFound('Offer', 'OFFER_NOT_FOUND');
    }
    if (o.status !== 'PENDING') throw Errors.conflict('OFFER_NOT_PENDING', `Penawaran berstatus ${o.status}`, { status: o.status });
    await closePendingOffers(t, { offerIds: [o.id] }, 'WITHDRAWN', 'WITHDRAWN_BY_INITIATOR', now);
    return (await offerDtos(t, deps, [(await repo.getOffer(t, o.id))!], auth.userId))[0]!;
  });
}

