import { describe, expect, it } from 'vitest';
import { DEFAULT_BUSINESS_CONFIG } from '../config';
import { SEEDS, createPrng } from '../testing/prng';
import { type TrustSignals, applyOverride, computeTrustScore, effectiveTrustScore } from './index';

const W = DEFAULT_BUSINESS_CONFIG['trust.weights'];
const NOW = new Date('2026-09-27T00:00:00Z');

const newUser: TrustSignals = {
  kycLevel: 1,
  completedTransactions: 0,
  totalCompletedValueIdr: 0,
  accountCreatedAt: NOW,
  cancellations: { count: 0, rate: 0 },
  disputesLost: { count: 0, rate: 0 },
  onTimeDeliveryRate: null,
  verifiedTrips: null,
  fraudSignals: { count: 0, maxSeverity: 'NONE' },
  paymentHistory: { failedPayments: 0, chargebacks: 0 },
  ratingAvg: null,
  ratingCount: 0,
};

const veteranTraveler: TrustSignals = {
  kycLevel: 5,
  completedTransactions: 60,
  totalCompletedValueIdr: 200_000_000,
  accountCreatedAt: new Date('2024-01-01T00:00:00Z'),
  cancellations: { count: 0, rate: 0 },
  disputesLost: { count: 0, rate: 0 },
  onTimeDeliveryRate: 1,
  verifiedTrips: 12,
  fraudSignals: { count: 0, maxSeverity: 'NONE' },
  paymentHistory: { failedPayments: 0, chargebacks: 0 },
  ratingAvg: 5,
  ratingCount: 60,
};

describe('computeTrustScore', () => {
  it('a brand-new user scores low but not zero, with explanations', () => {
    const r = computeTrustScore(newUser, W, NOW);
    // payment history (8) + prior rating 0.75×12, normalized over 70 applicable points
    expect(r.score).toBe(24);
    expect(r.version).toBe('trust-v1');
    expect(r.components.find((c) => c.key === 'onTimeDelivery')?.applicable).toBe(false);
    expect(r.components.every((c) => c.explanation.length > 0)).toBe(true);
  });

  it('a veteran traveler with a clean record approaches 100', () => {
    const r = computeTrustScore(veteranTraveler, W, NOW);
    expect(r.score).toBeGreaterThanOrEqual(95);
    expect(r.score).toBeLessThanOrEqual(100);
  });

  it('penalties are capped at their weight and the score is clamped to 0', () => {
    const r = computeTrustScore(
      {
        ...newUser,
        cancellations: { count: 50, rate: 1 },
        disputesLost: { count: 50, rate: 1 },
        fraudSignals: { count: 99, maxSeverity: 'CRITICAL' },
      },
      W,
      NOW,
    );
    expect(r.components.find((c) => c.key === 'fraudPenalty')?.contribution).toBe(-30);
    expect(r.components.find((c) => c.key === 'cancellationPenalty')?.contribution).toBe(-10);
    expect(r.score).toBe(0);
  });

  it('a HIGH fraud signal alone costs 24 points', () => {
    const base = computeTrustScore(veteranTraveler, W, NOW).score;
    const hit = computeTrustScore({ ...veteranTraveler, fraudSignals: { count: 1, maxSeverity: 'HIGH' } }, W, NOW).score;
    expect(base - hit).toBe(24);
  });

  it('is an integer in [0,100], monotonic in completed transactions, and deterministic (property)', () => {
    for (const seed of SEEDS) {
      const r = createPrng(seed);
      const s: TrustSignals = {
        kycLevel: r.int(1, 5),
        completedTransactions: r.int(0, 200),
        totalCompletedValueIdr: r.int(0, 2_000_000_000),
        accountCreatedAt: new Date(NOW.getTime() - r.int(0, 2000) * 86_400_000),
        cancellations: { count: r.int(0, 20), rate: r.next() * 0.5 },
        disputesLost: { count: r.int(0, 10), rate: r.next() * 0.3 },
        onTimeDeliveryRate: r.bool() ? r.next() : null,
        verifiedTrips: r.bool() ? r.int(0, 30) : null,
        fraudSignals: { count: r.int(0, 3), maxSeverity: r.pick(['NONE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const) },
        paymentHistory: { failedPayments: r.int(0, 5), chargebacks: r.int(0, 2) },
        ratingAvg: r.bool() ? 1 + r.next() * 4 : null,
        ratingCount: r.int(0, 100),
      };
      const a = computeTrustScore(s, W, NOW);
      expect(Number.isInteger(a.score)).toBe(true);
      expect(a.score).toBeGreaterThanOrEqual(0);
      expect(a.score).toBeLessThanOrEqual(100);
      const b = computeTrustScore({ ...s, completedTransactions: s.completedTransactions + r.int(1, 20) }, W, NOW);
      expect(b.score).toBeGreaterThanOrEqual(a.score);
      expect(computeTrustScore(s, W, NOW)).toEqual(a);
    }
  });
});

describe('applyOverride', () => {
  const computed = { score: 62, version: 'trust-v1' };
  const ok = {
    newScore: 80,
    reason: 'Verified corporate traveler after manual review',
    requestedBy: 'risk-1',
    approvedBy: 'risk-lead',
    approvedAt: NOW,
    expiresAt: new Date('2026-12-31T00:00:00Z'),
  };

  it('returns the new score and an audit payload', () => {
    const r = applyOverride(computed, ok);
    expect(r.score).toBe(80);
    expect(r.audit).toMatchObject({ action: 'TRUST_SCORE_OVERRIDE', before: 62, after: 80, approvedBy: 'risk-lead' });
  });

  it('requires a real reason, a different approver and a sane score', () => {
    expect(() => applyOverride(computed, { ...ok, reason: 'ok' })).toThrowError(expect.objectContaining({ code: 'OVERRIDE_REASON_REQUIRED' }));
    expect(() => applyOverride(computed, { ...ok, approvedBy: 'risk-1' })).toThrowError(
      expect.objectContaining({ code: 'OVERRIDE_SELF_APPROVAL' }),
    );
    expect(() => applyOverride(computed, { ...ok, newScore: 101 })).toThrow();
  });

  it('effective score falls back to computed after expiry', () => {
    expect(effectiveTrustScore(62, ok, NOW)).toBe(80);
    expect(effectiveTrustScore(62, ok, new Date('2027-01-01T00:00:00Z'))).toBe(62);
    expect(effectiveTrustScore(62, null, NOW)).toBe(62);
  });
});
