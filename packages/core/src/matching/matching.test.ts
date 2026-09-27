import { describe, expect, it } from 'vitest';
import { DEFAULT_BUSINESS_CONFIG } from '../config';
import { SEEDS, createPrng } from '../testing/prng';
import {
  type MatchRequest,
  type MatchTrip,
  type RankingStrategy,
  type TravelerCandidate,
  type TravelerProfile,
  hardFilter,
  linearRankingStrategy,
  rankRequestsForTrip,
  rankTravelersForRequest,
} from './index';

const W = DEFAULT_BUSINESS_CONFIG['matching.weights'];
const NOW = new Date('2026-09-27T00:00:00Z');
const day = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

const request: MatchRequest = {
  id: 'req-1',
  buyerId: 'buyer-1',
  originCountry: 'JP',
  destinationCountry: 'ID',
  destinationCity: 'Jakarta',
  categoryCode: 'TOYS_HOBBIES',
  unitWeightKg: 0.8,
  quantity: 2,
  itemValueIdr: 2_000_000,
  maxBudgetIdr: 2_500_000,
  neededBy: day(20),
  restrictedClassification: 'ALLOWED',
};

const trip = (over: Partial<MatchTrip> = {}): MatchTrip => ({
  id: 'trip-a',
  travelerId: 'trav-a',
  status: 'ACTIVE',
  originCountry: 'JP',
  destinationCountry: 'ID',
  destinationCity: 'Jakarta',
  departureAt: day(5),
  arrivalAt: day(6),
  remainingCapacityKg: 10,
  excludedCategories: [],
  travelerFee: { type: 'PERCENT', rateBps: 1000 },
  ...over,
});

const traveler = (over: Partial<TravelerProfile> = {}): TravelerProfile => ({
  userId: 'trav-a',
  trustScore: 86,
  ratingAvg: 4.8,
  ratingCount: 23,
  completedTransactions: 30,
  transactionLimitIdr: 20_000_000,
  ...over,
});

describe('hardFilter', () => {
  it('passes a compatible pair', () => {
    expect(hardFilter(request, trip(), traveler())).toEqual([]);
  });

  it('returns every failing reason', () => {
    const codes = hardFilter(
      { ...request, restrictedClassification: 'PROHIBITED', buyerId: 'trav-a', itemValueIdr: 30_000_000 },
      trip({
        status: 'FULL',
        originCountry: 'KR',
        destinationCountry: 'MY',
        arrivalAt: day(25),
        remainingCapacityKg: 1,
        excludedCategories: ['TOYS_HOBBIES'],
      }),
      traveler(),
    ).map((r) => r.code);
    expect(codes).toEqual([
      'TRIP_NOT_ACTIVE',
      'ORIGIN_MISMATCH',
      'DESTINATION_MISMATCH',
      'ARRIVES_TOO_LATE',
      'CAPACITY_INSUFFICIENT',
      'CATEGORY_EXCLUDED',
      'ITEM_PROHIBITED',
      'TRAVELER_LIMIT_EXCEEDED',
      'SAME_USER',
    ]);
  });

  it('VERIFIED trips only when allowed', () => {
    expect(hardFilter(request, trip({ status: 'VERIFIED' }), traveler()).map((r) => r.code)).toEqual(['TRIP_NOT_ACTIVE']);
    expect(hardFilter(request, trip({ status: 'VERIFIED' }), traveler(), true)).toEqual([]);
  });
});

describe('rankTravelersForRequest', () => {
  const candidates: TravelerCandidate[] = [
    { trip: trip(), traveler: traveler() },
    { trip: trip({ id: 'trip-b', travelerId: 'trav-b', destinationCity: 'Bandung' }), traveler: traveler({ userId: 'trav-b' }) },
    {
      trip: trip({ id: 'trip-c', travelerId: 'trav-c', arrivalAt: day(15) }),
      traveler: traveler({ userId: 'trav-c', trustScore: 40, ratingAvg: 3.5, ratingCount: 4, completedTransactions: 1 }),
    },
    { trip: trip({ id: 'trip-x', travelerId: 'trav-x', originCountry: 'KR' }), traveler: traveler({ userId: 'trav-x' }) },
  ];
  const result = rankTravelersForRequest(request, candidates, W, NOW);

  it('ranks by score with explainable Indonesian reasons and excludes hard-filter failures', () => {
    expect(result.ranked.map((m) => m.tripId)).toEqual(['trip-a', 'trip-b', 'trip-c']);
    expect(result.excluded).toEqual([{ tripId: 'trip-x', requestId: 'req-1', reasons: [expect.objectContaining({ code: 'ORIGIN_MISMATCH' })] }]);
    const top = result.ranked[0];
    expect(top?.reasons).toEqual(
      expect.arrayContaining(['Tiba 14 hari sebelum batas', 'Trust Score 86', 'Rating 4,8 (23 ulasan)', 'Kota tujuan cocok (Jakarta)']),
    );
    expect(top?.features.routeExactness).toBe(1);
    expect(result.ranked[1]?.features.routeExactness).toBe(0.5);
    expect(top?.estimatedTravelerFeeIdr).toBe(200_000);
    expect(result.strategy.version).toBe('match-linear-v1');
  });

  it('scores are within 0–100 and deterministic', () => {
    for (const m of result.ranked) {
      expect(m.score).toBeGreaterThanOrEqual(0);
      expect(m.score).toBeLessThanOrEqual(100);
    }
    expect(rankTravelersForRequest(request, candidates, W, NOW)).toEqual(result);
  });

  it('price fit drops to 0 when the fee exceeds the budget headroom', () => {
    const r = rankTravelersForRequest({ ...request, maxBudgetIdr: 2_100_000 }, [candidates[0] as TravelerCandidate], W, NOW);
    expect(r.ranked[0]?.features.price).toBe(0);
    expect(r.ranked[0]?.reasons).toContain('Fee Rp200.000 melebihi sisa anggaran');
  });

  it('accepts a pluggable RankingStrategy (e.g. an AI ranker)', () => {
    const trustOnly: RankingStrategy = { name: 'trust-only', version: 't1', score: (f) => f.trust * 100 };
    const r = rankTravelersForRequest(request, candidates, W, NOW, { strategy: trustOnly });
    expect(r.strategy).toEqual({ name: 'trust-only', version: 't1' });
    expect(r.ranked.at(-1)?.tripId).toBe('trip-c');
  });

  it('a strictly better profile never ranks lower (property)', () => {
    for (const seed of SEEDS.slice(0, 60)) {
      const r = createPrng(seed);
      const base = traveler({ trustScore: r.int(0, 80), ratingAvg: 1 + r.next() * 3, ratingCount: r.int(0, 50), completedTransactions: r.int(0, 40) });
      const better = { ...base, userId: 'trav-z', trustScore: base.trustScore + r.int(1, 20), completedTransactions: base.completedTransactions + r.int(1, 10) };
      const res = rankTravelersForRequest(
        request,
        [
          { trip: trip({ id: 'trip-1' }), traveler: base },
          { trip: trip({ id: 'trip-2', travelerId: 'trav-z' }), traveler: better },
        ],
        W,
        NOW,
      );
      expect(res.ranked[0]?.tripId).toBe('trip-2');
    }
  });
});

describe('rankRequestsForTrip', () => {
  it('ranks requests using the buyer profile', () => {
    const buyerGood = { userId: 'b1', trustScore: 90, ratingAvg: 5, ratingCount: 10, completedTransactions: 12 };
    const buyerNew = { userId: 'b2', trustScore: 20, ratingAvg: null, ratingCount: 0, completedTransactions: 0 };
    const res = rankRequestsForTrip({ trip: trip(), traveler: traveler() }, [
      { request: { ...request, id: 'r-new', buyerId: 'b2' }, buyer: buyerNew },
      { request: { ...request, id: 'r-good', buyerId: 'b1' }, buyer: buyerGood },
      { request: { ...request, id: 'r-heavy', buyerId: 'b3', unitWeightKg: 20 }, buyer: buyerGood },
    ], W, NOW);
    expect(res.ranked.map((m) => m.requestId)).toEqual(['r-good', 'r-new']);
    expect(res.excluded[0]?.reasons[0]?.code).toBe('CAPACITY_INSUFFICIENT');
  });

  it('linear strategy rejects all-zero weights', () => {
    const zero = { date: 0, rating: 0, trust: 0, price: 0, capacity: 0, history: 0, routeExactness: 0 };
    expect(() => linearRankingStrategy.score(zero, zero)).toThrow();
  });
});
