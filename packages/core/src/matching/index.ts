import {
  DEFAULT_BUSINESS_CONFIG,
  MATCHING_WEIGHT_KEYS,
  type MatchingWeightKey,
  type MatchingWeights,
  type TravelerFeeBoundsConfig,
} from '../config';
import type { RestrictedClassification, TripStatus } from '../domain';
import { CoreError, type Reason } from '../errors';
import { clamp01, compareStrings, logSaturate, roundScore, sortBy } from '../internal/math';
import { DAY_MS } from '../internal/time';
import { formatIdr } from '../money';
import { type TravelerFeeSpec, computeTravelerFee } from '../pricing';
import { bayesianAverage } from '../rating';

export interface MatchRequest {
  readonly id: string;
  readonly buyerId: string;
  /** Country of the merchant / product. */
  readonly originCountry: string;
  readonly destinationCountry: string;
  /** null = any city in the destination country. */
  readonly destinationCity?: string | null;
  readonly categoryCode: string;
  readonly unitWeightKg: number;
  readonly quantity: number;
  readonly itemValueIdr: number;
  readonly maxBudgetIdr?: number | null;
  readonly neededBy?: Date | null;
  readonly restrictedClassification: RestrictedClassification;
}

export interface MatchTrip {
  readonly id: string;
  readonly travelerId: string;
  readonly status: TripStatus;
  readonly originCountry: string;
  readonly destinationCountry: string;
  readonly destinationCity: string;
  readonly departureAt: Date;
  readonly arrivalAt: Date;
  readonly remainingCapacityKg: number;
  readonly excludedCategories: readonly string[];
  readonly travelerFee: TravelerFeeSpec;
}

export interface MatchProfile {
  readonly userId: string;
  readonly trustScore: number;
  readonly ratingAvg: number | null;
  readonly ratingCount: number;
  readonly completedTransactions: number;
}

export interface TravelerProfile extends MatchProfile {
  /** Current per-transaction limit (limits engine). */
  readonly transactionLimitIdr: number;
}

export interface TravelerCandidate {
  readonly trip: MatchTrip;
  readonly traveler: TravelerProfile;
}

export interface RequestCandidate {
  readonly request: MatchRequest;
  readonly buyer: MatchProfile;
}

export type MatchFeatures = Readonly<Record<MatchingWeightKey, number>>;

/** Pluggable scorer: the linear model today, an AI ranker later. Must return 0–100. */
export interface RankingStrategy {
  readonly name: string;
  readonly version: string;
  score(features: MatchFeatures, weights: MatchingWeights): number;
}

export const linearRankingStrategy: RankingStrategy = {
  name: 'linear',
  version: 'match-linear-v1',
  score(features, weights) {
    let num = 0;
    let den = 0;
    for (const k of MATCHING_WEIGHT_KEYS) {
      num += weights[k] * clamp01(features[k]);
      den += weights[k];
    }
    if (!(den > 0)) throw new CoreError('INVALID_MATCHING_WEIGHTS', 'Matching weights must sum to > 0');
    return roundScore((100 * num) / den, 2);
  },
};

export interface MatchingOptions {
  readonly strategy?: RankingStrategy;
  /** Allow VERIFIED (not yet ACTIVE) trips when config permits. Default false. */
  readonly allowVerifiedTrips?: boolean;
  readonly travelerFeeBounds?: TravelerFeeBoundsConfig;
}

export interface RankedMatch {
  readonly tripId: string;
  readonly requestId: string;
  readonly counterpartId: string;
  readonly score: number;
  readonly features: MatchFeatures;
  readonly estimatedTravelerFeeIdr: number;
  readonly reasons: readonly string[];
}

export interface ExcludedMatch {
  readonly tripId: string;
  readonly requestId: string;
  readonly reasons: readonly Reason[];
}

export interface RankingResult {
  readonly ranked: readonly RankedMatch[];
  readonly excluded: readonly ExcludedMatch[];
  readonly strategy: { readonly name: string; readonly version: string };
}

function idNum(n: number, digits = 1): string {
  return n.toFixed(digits).replace('.', ',');
}

/** Hard filters — every failing reason is returned (not just the first). */
export function hardFilter(
  request: MatchRequest,
  trip: MatchTrip,
  traveler: TravelerProfile,
  allowVerifiedTrips = false,
): Reason[] {
  const out: Reason[] = [];
  const statusOk = trip.status === 'ACTIVE' || (allowVerifiedTrips && trip.status === 'VERIFIED');
  if (!statusOk) out.push({ code: 'TRIP_NOT_ACTIVE', message: `Trip berstatus ${trip.status}` });
  if (trip.originCountry !== request.originCountry) {
    out.push({ code: 'ORIGIN_MISMATCH', message: `Trip dari ${trip.originCountry}, barang dari ${request.originCountry}` });
  }
  if (trip.destinationCountry !== request.destinationCountry) {
    out.push({ code: 'DESTINATION_MISMATCH', message: `Tujuan trip ${trip.destinationCountry} ≠ ${request.destinationCountry}` });
  }
  if (request.neededBy && trip.arrivalAt.getTime() > request.neededBy.getTime()) {
    out.push({ code: 'ARRIVES_TOO_LATE', message: 'Tiba setelah batas waktu pembeli' });
  }
  const needed = request.unitWeightKg * request.quantity;
  if (trip.remainingCapacityKg < needed) {
    out.push({ code: 'CAPACITY_INSUFFICIENT', message: `Butuh ${idNum(needed)} kg, sisa ${idNum(trip.remainingCapacityKg)} kg` });
  }
  if (trip.excludedCategories.includes(request.categoryCode)) {
    out.push({ code: 'CATEGORY_EXCLUDED', message: `Traveler tidak menerima kategori ${request.categoryCode}` });
  }
  if (request.restrictedClassification === 'PROHIBITED') {
    out.push({ code: 'ITEM_PROHIBITED', message: 'Barang dilarang' });
  }
  if (traveler.transactionLimitIdr < request.itemValueIdr) {
    out.push({ code: 'TRAVELER_LIMIT_EXCEEDED', message: 'Nilai barang melebihi limit traveler' });
  }
  if (traveler.userId === request.buyerId || trip.travelerId === request.buyerId) {
    out.push({ code: 'SAME_USER', message: 'Tidak dapat menitip ke diri sendiri' });
  }
  return out;
}

function profileFeatures(p: MatchProfile): { rating: number; trust: number; history: number; reasons: string[] } {
  const bayes = bayesianAverage((p.ratingAvg ?? 0) * p.ratingCount, p.ratingCount, 4, 5);
  return {
    rating: clamp01((bayes - 1) / 4),
    trust: clamp01(p.trustScore / 100),
    history: logSaturate(p.completedTransactions, 50),
    reasons: [
      `Trust Score ${Math.round(p.trustScore)}`,
      p.ratingCount > 0 ? `Rating ${idNum(p.ratingAvg ?? 0)} (${p.ratingCount} ulasan)` : 'Belum ada rating',
      `${p.completedTransactions} transaksi selesai`,
    ],
  };
}

function pairFeatures(
  request: MatchRequest,
  trip: MatchTrip,
  now: Date,
  bounds: TravelerFeeBoundsConfig,
): { date: number; price: number; capacity: number; routeExactness: number; feeIdr: number; reasons: string[] } {
  const reasons: string[] = [];
  const daysToArrival = Math.max(0, (trip.arrivalAt.getTime() - now.getTime()) / DAY_MS);
  const soon = 1 / (1 + daysToArrival / 14);
  let date = soon;
  if (request.neededBy) {
    const buffer = Math.max(0, (request.neededBy.getTime() - trip.arrivalAt.getTime()) / DAY_MS);
    date = 0.5 * soon + 0.5 * clamp01(buffer / 7);
    const d = Math.floor(buffer);
    reasons.push(d >= 1 ? `Tiba ${d} hari sebelum batas` : 'Tiba tepat menjelang batas');
  } else {
    reasons.push(`Tiba dalam ${Math.ceil(daysToArrival)} hari`);
  }

  const needed = request.unitWeightKg * request.quantity;
  const fee = computeTravelerFee(trip.travelerFee, request.itemValueIdr, needed, bounds).amountIdr;
  let price: number;
  if (request.maxBudgetIdr !== undefined && request.maxBudgetIdr !== null) {
    const room = request.maxBudgetIdr - request.itemValueIdr;
    price = room > 0 ? clamp01(1 - fee / room) : 0;
    reasons.push(fee <= room ? `Fee ${formatIdr(fee)} masuk anggaran` : `Fee ${formatIdr(fee)} melebihi sisa anggaran`);
  } else {
    const rate = request.itemValueIdr > 0 ? fee / request.itemValueIdr : 1;
    price = clamp01(1 - rate / (bounds.maxRateBps / 10_000));
    reasons.push(`Fee ${formatIdr(fee)}`);
  }

  const capacity = trip.remainingCapacityKg > 0 ? clamp01(1 - needed / trip.remainingCapacityKg) : 0;
  reasons.push(`Sisa kapasitas ${idNum(trip.remainingCapacityKg)} kg`);

  const cityExact =
    !request.destinationCity || request.destinationCity.trim().toLowerCase() === trip.destinationCity.trim().toLowerCase();
  reasons.push(cityExact ? `Kota tujuan cocok (${trip.destinationCity})` : `Beda kota (${trip.destinationCity})`);
  return { date, price, capacity, routeExactness: cityExact ? 1 : 0.5, feeIdr: fee, reasons };
}

function validateWeights(weights: MatchingWeights): void {
  for (const k of MATCHING_WEIGHT_KEYS) {
    if (!(weights[k] >= 0)) throw new CoreError('INVALID_MATCHING_WEIGHTS', `weight ${k} must be >= 0`);
  }
}

/** Ranks trips (with their travelers) for a buyer's request. */
export function rankTravelersForRequest(
  request: MatchRequest,
  candidates: readonly TravelerCandidate[],
  weights: MatchingWeights,
  now: Date,
  options: MatchingOptions = {},
): RankingResult {
  validateWeights(weights);
  const strategy = options.strategy ?? linearRankingStrategy;
  const bounds = options.travelerFeeBounds ?? DEFAULT_BUSINESS_CONFIG['pricing.traveler_fee_bounds'];
  const ranked: (RankedMatch & { arrival: number })[] = [];
  const excluded: ExcludedMatch[] = [];
  for (const { trip, traveler } of candidates) {
    const fails = hardFilter(request, trip, traveler, options.allowVerifiedTrips);
    if (fails.length > 0) {
      excluded.push({ tripId: trip.id, requestId: request.id, reasons: fails });
      continue;
    }
    const pf = pairFeatures(request, trip, now, bounds);
    const prof = profileFeatures(traveler);
    const features: MatchFeatures = {
      date: pf.date,
      rating: prof.rating,
      trust: prof.trust,
      price: pf.price,
      capacity: pf.capacity,
      history: prof.history,
      routeExactness: pf.routeExactness,
    };
    ranked.push({
      tripId: trip.id,
      requestId: request.id,
      counterpartId: traveler.userId,
      score: strategy.score(features, weights),
      features,
      estimatedTravelerFeeIdr: pf.feeIdr,
      reasons: [pf.reasons[0] as string, ...prof.reasons, ...pf.reasons.slice(1)],
      arrival: trip.arrivalAt.getTime(),
    });
  }
  const sorted = sortBy(ranked, (a, b) => b.score - a.score || a.arrival - b.arrival || compareStrings(a.tripId, b.tripId));
  return {
    ranked: sorted.map(({ arrival: _arrival, ...rest }) => rest),
    excluded,
    strategy: { name: strategy.name, version: strategy.version },
  };
}

/** Ranks open requests for a traveler's trip (buyer profile drives rating/trust/history). */
export function rankRequestsForTrip(
  candidate: TravelerCandidate,
  requests: readonly RequestCandidate[],
  weights: MatchingWeights,
  now: Date,
  options: MatchingOptions = {},
): RankingResult {
  validateWeights(weights);
  const strategy = options.strategy ?? linearRankingStrategy;
  const bounds = options.travelerFeeBounds ?? DEFAULT_BUSINESS_CONFIG['pricing.traveler_fee_bounds'];
  const { trip, traveler } = candidate;
  const ranked: RankedMatch[] = [];
  const excluded: ExcludedMatch[] = [];
  for (const { request, buyer } of requests) {
    const fails = hardFilter(request, trip, traveler, options.allowVerifiedTrips);
    if (fails.length > 0) {
      excluded.push({ tripId: trip.id, requestId: request.id, reasons: fails });
      continue;
    }
    const pf = pairFeatures(request, trip, now, bounds);
    const prof = profileFeatures(buyer);
    const features: MatchFeatures = {
      date: pf.date,
      rating: prof.rating,
      trust: prof.trust,
      price: pf.price,
      capacity: pf.capacity,
      history: prof.history,
      routeExactness: pf.routeExactness,
    };
    ranked.push({
      tripId: trip.id,
      requestId: request.id,
      counterpartId: buyer.userId,
      score: strategy.score(features, weights),
      features,
      estimatedTravelerFeeIdr: pf.feeIdr,
      reasons: [pf.reasons[0] as string, ...prof.reasons, ...pf.reasons.slice(1)],
    });
  }
  return {
    ranked: sortBy(ranked, (a, b) => b.score - a.score || compareStrings(a.requestId, b.requestId)),
    excluded,
    strategy: { name: strategy.name, version: strategy.version },
  };
}
