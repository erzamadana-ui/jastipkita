import { describe, expect, it } from 'vitest';
import { type RatingInput, type RatingRecord, aggregateRatings, bayesianAverage, validateRating } from './index';

const NOW = new Date('2026-09-27T00:00:00Z');
const valid: RatingInput = {
  transactionStatus: 'COMPLETED',
  raterRole: 'BUYER',
  raterId: 'b1',
  transactionBuyerId: 'b1',
  transactionTravelerId: 't1',
  scores: { OVERALL: 5, ACCURACY: 4 },
  alreadyRatedBySide: false,
  completedAt: new Date('2026-09-20T00:00:00Z'),
  now: NOW,
};

describe('validateRating', () => {
  it('accepts a valid buyer rating of the traveler', () => {
    const r = validateRating(valid);
    expect(r.ok).toBe(true);
    expect(r.rateeId).toBe('t1');
  });

  it('only after COMPLETED, by a party, once per side, within the window', () => {
    const codes = (i: Partial<RatingInput>) => validateRating({ ...valid, ...i }).errors.map((e) => e.code);
    expect(codes({ transactionStatus: 'DELIVERED' })).toContain('TRANSACTION_NOT_COMPLETED');
    expect(codes({ raterId: 'x' })).toContain('NOT_A_PARTY');
    expect(codes({ alreadyRatedBySide: true })).toContain('ALREADY_RATED');
    expect(codes({ now: new Date('2026-10-05T00:00:01Z') })).toContain('RATING_WINDOW_CLOSED');
    expect(codes({ transactionTravelerId: 'b1' })).toContain('SELF_RATING');
  });

  it('validates 1–5 integer scores per known dimension', () => {
    const codes = (scores: Record<string, number>) => validateRating({ ...valid, scores }).errors.map((e) => e.code);
    expect(codes({ OVERALL: 6 })).toContain('SCORE_OUT_OF_RANGE');
    expect(codes({ OVERALL: 4.5 })).toContain('SCORE_OUT_OF_RANGE');
    expect(codes({ ACCURACY: 4 })).toContain('OVERALL_REQUIRED');
    expect(codes({ OVERALL: 4, RESPONSIVENESS: 4 })).toContain('UNKNOWN_DIMENSION');
    expect(validateRating({ ...valid, raterRole: 'TRAVELER', raterId: 't1', scores: { OVERALL: 4, RESPONSIVENESS: 5 } }).ok).toBe(true);
  });
});

describe('bayesianAverage', () => {
  it('shrinks small samples toward the prior', () => {
    expect(bayesianAverage(5, 1, 4, 5)).toBeCloseTo(25 / 6, 10);
    expect(bayesianAverage(0, 0, 4, 5)).toBe(4);
    expect(bayesianAverage(500, 100, 4, 5)).toBeCloseTo(520 / 105, 10);
    expect(() => bayesianAverage(0, 0, 4, 0)).toThrow();
  });
});

describe('aggregateRatings', () => {
  const r = (id: string, overall: number, value = 1_000_000, raterId = `u-${id}`): RatingRecord => ({
    id,
    raterId,
    overall,
    transactionValueIdr: value,
  });

  it('excludes linked accounts and down-weights flagged raters', () => {
    const agg = aggregateRatings([r('1', 5), r('2', 5), r('3', 1, 1_000_000, 'ring'), r('4', 5, 1_000_000, 'friend')], {
      flaggedRaterIds: ['ring'],
      linkedRaterIds: ['friend'],
    });
    expect(agg.effectiveCount).toBe(2.25);
    expect(agg.weightedAverage).toBeCloseTo(10.25 / 2.25, 10);
    expect(agg.adjustments.map((a) => a.reason).sort()).toEqual(['FLAGGED_RATER', 'LINKED_ACCOUNT']);
  });

  it('down-weights outliers on very-low-value transactions only', () => {
    const agg = aggregateRatings([r('1', 5), r('2', 5), r('3', 5), r('4', 1, 50_000), r('5', 1, 5_000_000)]);
    expect(agg.adjustments).toEqual([{ ratingId: '4', weight: 0.25, reason: 'LOW_VALUE_OUTLIER' }]);
    expect(agg.rawAverage).toBe(3.4);
  });

  it('empty input returns the prior', () => {
    const agg = aggregateRatings([]);
    expect(agg.bayesianScore).toBe(4);
    expect(agg.weightedAverage).toBeNull();
  });
});
