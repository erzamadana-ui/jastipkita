/**
 * Matching: candidate signals from the DB → @jastipkita/core rankTravelersForRequest /
 * rankRequestsForTrip with `matching.weights`. The ranking strategy is pluggable (RankingStrategy)
 * so an AI ranker can replace the linear model without touching the API.
 */
import {
  type MatchRequest,
  type MatchTrip,
  type RankingResult,
  type RankingStrategy,
  type RequestCandidate,
  type RiskLevel,
  type TravelerCandidate,
  linearRankingStrategy,
  rankRequestsForTrip,
  rankTravelersForRequest,
} from '@jastipkita/core';
import type { AppDeps, AuthContext } from '../../context';
import type { Db } from '../../db/sql';
import { AppError, Errors } from '../../lib/errors';
import { core, wibDate, wibEndOfDay, wibStartOfDay } from '../catalog/shared';
import { toIdrAtSpot } from '../fx/service';
import * as reqRepo from '../requests/repository';
import { type RequestListingDto, listingDtos } from '../requests/service';
import * as tripRepo from '../trips/repository';
import { type TripPublicDto, effectiveRemainingKg, feeSpec, publicTripDto } from '../trips/service';
import { type UserSignals, loadUserSignals, publicProfile, travelerLimit, unitWeightKg } from './signals';

type Deps = Pick<AppDeps, 'sql' | 'config' | 'clock' | 'logger' | 'providers'>;

// ------------------------------------------------------------------------------ strategy seam

let activeStrategy: RankingStrategy = linearRankingStrategy;

/** Swap the ranking model (e.g. an AI ranker implementing RankingStrategy). Returns the previous one. */
export function useRankingStrategy(strategy: RankingStrategy): RankingStrategy {
  const prev = activeStrategy;
  activeStrategy = strategy;
  return prev;
}

export function currentRankingStrategy(): RankingStrategy {
  return activeStrategy;
}

const CANDIDATE_LIMIT = 200;

// ------------------------------------------------------------------------------ mapping helpers

export function matchTrip(t: tripRepo.TripRow): MatchTrip {
  return {
    id: t.id,
    travelerId: t.traveler_id,
    status: t.status,
    originCountry: t.origin_country,
    destinationCountry: t.destination_country,
    destinationCity: t.destination_city,
    departureAt: wibStartOfDay(t.departure_date),
    arrivalAt: wibStartOfDay(t.arrival_date),
    remainingCapacityKg: effectiveRemainingKg(t),
    excludedCategories: t.excluded_categories,
    travelerFee: feeSpec(t),
  };
}

export async function matchRequest(
  db: Db,
  deps: Deps,
  r: reqRepo.RequestRow,
  categories: Map<string, { weightKg: number | null; risk: RiskLevel }>,
): Promise<MatchRequest> {
  const cat = r.category_code ? categories.get(r.category_code) : undefined;
  const itemValueIdr =
    r.unit_price_minor !== null && r.price_currency ? (await toIdrAtSpot(db, deps, r.unit_price_minor * r.quantity, r.price_currency)).idr : 0;
  return {
    id: r.id,
    buyerId: r.buyer_id,
    originCountry: r.merchant_country ?? '',
    destinationCountry: r.destination_country,
    destinationCity: r.destination_city,
    categoryCode: r.category_code ?? 'OTHER',
    unitWeightKg: unitWeightKg(r.est_weight_kg, cat?.weightKg),
    quantity: r.quantity,
    itemValueIdr,
    maxBudgetIdr: r.max_budget_idr,
    neededBy: r.needed_by ? wibEndOfDay(r.needed_by) : null,
    restrictedClassification: r.restriction_class ?? 'ALLOWED',
  };
}

async function countryRisk(db: Db, code: string): Promise<RiskLevel> {
  const [row] = await db<{ risk_level: RiskLevel }[]>`SELECT risk_level FROM countries WHERE code = ${code}`;
  return row?.risk_level ?? 'MEDIUM';
}

async function travelerProfile(db: Db, deps: Deps, s: UserSignals, productRisk: RiskLevel, cRisk: RiskLevel) {
  const limit = await travelerLimit(db, deps, s, productRisk, cRisk);
  return {
    userId: s.userId,
    trustScore: s.trustScore,
    ratingAvg: s.travelerRating.average,
    ratingCount: s.travelerRating.count,
    completedTransactions: s.travelerCompleted,
    // KYC < 3 travelers cannot accept transactions (§1) → limit 0 excludes them
    transactionLimitIdr: s.kycLevel >= 3 && s.status === 'ACTIVE' ? limit.effectiveMaxIdr : 0,
  };
}

// ------------------------------------------------------------------------------ recommendations

export interface RecommendedTraveler {
  trip: TripPublicDto;
  score: number;
  reasons: string[];
  estimatedTravelerFeeIdr: number;
  features: Record<string, number>;
}

export async function recommendTravelers(
  deps: Deps,
  auth: AuthContext,
  requestId: string,
  limit: number,
): Promise<{ data: RecommendedTraveler[]; excludedCount: number; strategy: { name: string; version: string } }> {
  const db = deps.sql;
  const r = await reqRepo.getRequest(db, requestId);
  if (!r || r.buyer_id !== auth.userId) throw Errors.notFound('Request', 'REQUEST_NOT_FOUND');
  if (!r.merchant_country) throw Errors.unprocessable('REQUEST_INCOMPLETE', 'Negara toko belum diisi');
  const today = wibDate(deps.clock.now());
  const trips = await db<tripRepo.TripRow[]>`
    SELECT ${tripRepo.tripCols(db)} FROM trips t
      JOIN users u ON u.id = t.traveler_id AND u.status = 'ACTIVE'
     WHERE t.status = 'ACTIVE' AND t.origin_country = ${r.merchant_country} AND t.destination_country = ${r.destination_country}
       AND t.departure_date >= ${today}::date AND t.traveler_id <> ${auth.userId}
     ORDER BY t.departure_date, t.id LIMIT ${CANDIDATE_LIMIT}`;
  const categories = await reqRepo.categoryDefaults(db, [r.category_code ?? '']);
  const request = await matchRequest(db, deps, r, categories);
  const productRisk = (r.category_code ? categories.get(r.category_code)?.risk : undefined) ?? 'MEDIUM';
  const cRisk = await countryRisk(db, r.merchant_country);
  const signals = await loadUserSignals(db, trips.map((t) => t.traveler_id));
  const candidates: TravelerCandidate[] = [];
  for (const t of trips) {
    const s = signals.get(t.traveler_id);
    if (!s) continue;
    candidates.push({ trip: matchTrip(t), traveler: await travelerProfile(db, deps, s, productRisk, cRisk) });
  }
  const weights = await deps.config.get('matching.weights');
  const bounds = await deps.config.get('pricing.traveler_fee_bounds');
  const result: RankingResult = await core(() =>
    rankTravelersForRequest(request, candidates, weights, deps.clock.now(), { strategy: activeStrategy, travelerFeeBounds: bounds }),
  );
  const byId = new Map(trips.map((t) => [t.id, t]));
  const data = result.ranked.slice(0, limit).map((m) => {
    const t = byId.get(m.tripId)!;
    return {
      trip: publicTripDto(t, publicProfile(signals.get(t.traveler_id), t.traveler_id, 'TRAVELER')),
      score: m.score,
      reasons: [...m.reasons],
      estimatedTravelerFeeIdr: m.estimatedTravelerFeeIdr,
      features: { ...m.features },
    };
  });
  return { data, excludedCount: result.excluded.length, strategy: { ...result.strategy } };
}

export interface RecommendedRequest {
  request: RequestListingDto;
  score: number;
  reasons: string[];
  estimatedTravelerFeeIdr: number;
  features: Record<string, number>;
}

export async function recommendRequests(
  deps: Deps,
  auth: AuthContext,
  tripId: string,
  limit: number,
): Promise<{ data: RecommendedRequest[]; excludedCount: number; strategy: { name: string; version: string } }> {
  const db = deps.sql;
  const trip = await tripRepo.getTrip(db, tripId);
  if (!trip || trip.traveler_id !== auth.userId) throw Errors.notFound('Trip', 'TRIP_NOT_FOUND');
  const now = deps.clock.now();
  const reqs = await db<reqRepo.RequestRow[]>`
    SELECT ${reqRepo.requestCols(db)} FROM requests r
      JOIN users u ON u.id = r.buyer_id AND u.status = 'ACTIVE'
     WHERE r.status = 'OPEN' AND r.merchant_country = ${trip.origin_country} AND r.destination_country = ${trip.destination_country}
       AND r.buyer_id <> ${auth.userId} AND (r.expires_at IS NULL OR r.expires_at > ${now})
     ORDER BY r.published_at DESC, r.id LIMIT ${CANDIDATE_LIMIT}`;
  const categories = await reqRepo.categoryDefaults(db, reqs.map((r) => r.category_code ?? ''));
  const signals = await loadUserSignals(db, [auth.userId, ...reqs.map((r) => r.buyer_id)]);
  const me = signals.get(auth.userId);
  if (!me) throw Errors.notFound('User');
  const cRisk = await countryRisk(db, trip.origin_country);
  const weights = await deps.config.get('matching.weights');
  const bounds = await deps.config.get('pricing.traveler_fee_bounds');

  let excluded = 0;
  // The traveler limit depends on product risk → rank per product-risk bucket, then merge.
  const buckets = new Map<RiskLevel, RequestCandidate[]>();
  for (const r of reqs) {
    const risk = (r.category_code ? categories.get(r.category_code)?.risk : undefined) ?? 'MEDIUM';
    const s = signals.get(r.buyer_id);
    let request: MatchRequest;
    try {
      request = await matchRequest(db, deps, r, categories);
    } catch (err) {
      if (err instanceof AppError) {
        excluded++; // no FX for this request's currency right now
        continue;
      }
      throw err;
    }
    const cand: RequestCandidate = {
      request,
      buyer: {
        userId: r.buyer_id,
        trustScore: s?.trustScore ?? 50,
        ratingAvg: s?.buyerRating.average ?? null,
        ratingCount: s?.buyerRating.count ?? 0,
        completedTransactions: s?.buyerCompleted ?? 0,
      },
    };
    buckets.set(risk, [...(buckets.get(risk) ?? []), cand]);
  }
  const ranked: RankingResult['ranked'][number][] = [];
  let strategy = { name: activeStrategy.name, version: activeStrategy.version };
  for (const [risk, cands] of buckets) {
    const traveler = await travelerProfile(db, deps, me, risk, cRisk);
    const res = await core(() =>
      rankRequestsForTrip({ trip: matchTrip(trip), traveler }, cands, weights, now, { strategy: activeStrategy, travelerFeeBounds: bounds }),
    );
    ranked.push(...res.ranked);
    excluded += res.excluded.length;
    strategy = { ...res.strategy };
  }
  ranked.sort((a, b) => b.score - a.score || (a.requestId < b.requestId ? -1 : a.requestId > b.requestId ? 1 : 0));
  const top = ranked.slice(0, limit);
  const byId = new Map(reqs.map((r) => [r.id, r]));
  const listings = await listingDtos(db, deps, top.map((m) => byId.get(m.requestId)!));
  return {
    data: top.map((m, i) => ({
      request: listings[i]!,
      score: m.score,
      reasons: [...m.reasons],
      estimatedTravelerFeeIdr: m.estimatedTravelerFeeIdr,
      features: { ...m.features },
    })),
    excludedCount: excluded,
    strategy,
  };
}
