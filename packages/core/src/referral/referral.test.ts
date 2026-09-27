import { describe, expect, it } from 'vitest';
import { DEFAULT_BUSINESS_CONFIG, type ReferralConfig } from '../index';
import { SEEDS } from '../testing/prng';
import { type ReferralRewardInput, assignVariant, evaluateReferralReward, unitEconomicsGuardrail } from './index';

const CFG: ReferralConfig = DEFAULT_BUSINESS_CONFIG;
const NOW = new Date('2026-09-27T00:00:00Z');

const buyerInput: ReferralRewardInput = {
  program: 'BUYER',
  referrer: { userId: 'u-ref' },
  referee: { userId: 'u-new', completedTransactions: 1 },
  qualifyingTransaction: { id: 'tx1', status: 'COMPLETED', valueIdr: 750_000, isRefereeFirstTransaction: true },
  monthRewardedIdr: 0,
  signals: { decision: 'ALLOW' },
  now: NOW,
};

describe('evaluateReferralReward — buyer program', () => {
  it('grants Rp25.000 to both with 90-day non-withdrawable credit', () => {
    const r = evaluateReferralReward(buyerInput, CFG);
    expect(r).toMatchObject({ status: 'GRANTED', referrerRewardIdr: 25_000, refereeRewardIdr: 25_000, withdrawable: false });
    expect(r.expiresAt?.toISOString()).toBe('2026-12-26T00:00:00.000Z');
  });

  it('requires COMPLETED, first transaction, and minimum value', () => {
    const codes = (over: Partial<ReferralRewardInput['qualifyingTransaction']>) =>
      evaluateReferralReward({ ...buyerInput, qualifyingTransaction: { ...buyerInput.qualifyingTransaction, ...over } }, CFG).reasons.map(
        (x) => x.code,
      );
    expect(codes({ status: 'DELIVERED' })).toContain('TRANSACTION_NOT_COMPLETED');
    expect(codes({ isRefereeFirstTransaction: false })).toContain('NOT_FIRST_TRANSACTION');
    expect(codes({ valueIdr: 499_999 })).toContain('BELOW_MIN_VALUE');
  });

  it('partially caps the referrer at the monthly cap; referee unaffected', () => {
    const r = evaluateReferralReward({ ...buyerInput, monthRewardedIdr: 240_000 }, CFG);
    expect(r.referrerRewardIdr).toBe(10_000);
    expect(r.refereeRewardIdr).toBe(25_000);
    expect(r.cappedByMonthlyLimit).toBe(true);
    expect(evaluateReferralReward({ ...buyerInput, monthRewardedIdr: 300_000 }, CFG).referrerRewardIdr).toBe(0);
  });

  it('fraud gate: HOLD/BLOCK → no reward; REVIEW → pending review', () => {
    expect(evaluateReferralReward({ ...buyerInput, signals: { decision: 'HOLD' } }, CFG).status).toBe('REJECTED');
    expect(evaluateReferralReward({ ...buyerInput, signals: { decision: 'BLOCK' } }, CFG).referrerRewardIdr).toBe(0);
    expect(evaluateReferralReward({ ...buyerInput, signals: { decision: 'REVIEW' } }, CFG).status).toBe('PENDING_REVIEW');
  });

  it('rejects self-referral, duplicates, and disabled programs', () => {
    expect(evaluateReferralReward({ ...buyerInput, referee: { userId: 'u-ref', completedTransactions: 1 } }, CFG).status).toBe('REJECTED');
    expect(evaluateReferralReward({ ...buyerInput, alreadyRewarded: true }, CFG).status).toBe('REJECTED');
    const off = { ...CFG, 'referral.buyer': { ...CFG['referral.buyer'], enabled: false } };
    expect(evaluateReferralReward(buyerInput, off).reasons[0]?.code).toBe('PROGRAM_DISABLED');
  });

  it('uses the experiment variant amount when enabled', () => {
    const exp = { ...CFG, 'referral.buyer': { ...CFG['referral.buyer'], experiment: { ...CFG['referral.buyer'].experiment, enabled: true } } };
    const r = evaluateReferralReward(buyerInput, exp);
    const v = assignVariant('u-ref', 'referral_buyer_amount', ['A', 'B', 'C']);
    expect(r.variant).toBe(v);
    expect(r.referrerRewardIdr).toBe({ A: 15_000, B: 25_000, C: 50_000 }[v]);
  });
});

describe('evaluateReferralReward — traveler program', () => {
  const t: ReferralRewardInput = { ...buyerInput, program: 'TRAVELER', referee: { userId: 'trav-new', completedTransactions: 2 } };
  it('pays Rp50.000 to the referrer after N completed transactions', () => {
    expect(evaluateReferralReward(t, CFG)).toMatchObject({ status: 'GRANTED', referrerRewardIdr: 50_000, refereeRewardIdr: 0 });
    const early = evaluateReferralReward({ ...t, referee: { userId: 'trav-new', completedTransactions: 1 } }, CFG);
    expect(early.reasons.map((x) => x.code)).toContain('NOT_ENOUGH_COMPLETED');
  });
});

describe('assignVariant', () => {
  it('is deterministic and order-insensitive', () => {
    expect(assignVariant('user-42', 'exp', ['A', 'B', 'C'])).toBe(assignVariant('user-42', 'exp', ['C', 'A', 'B']));
    expect(() => assignVariant('u', 'exp', [])).toThrow();
  });

  it('distributes roughly uniformly (property)', () => {
    const counts: Record<string, number> = { A: 0, B: 0, C: 0 };
    for (let i = 0; i < 3000; i++) {
      const v = assignVariant(`user-${i}-${SEEDS[i % SEEDS.length]}`, 'referral_buyer_amount', ['A', 'B', 'C']);
      counts[v] = (counts[v] ?? 0) + 1;
    }
    for (const c of Object.values(counts)) expect(c).toBeGreaterThan(850);
  });
});

describe('unitEconomicsGuardrail', () => {
  const g = CFG['referral.buyer'].guardrails;
  it('allows increases within guardrails and pauses beyond them', () => {
    expect(unitEconomicsGuardrail({ cac: 30_000, ltv: 150_000, fraudRate: 0.01 }, g)).toMatchObject({ allowIncrease: true, pause: false });
    expect(unitEconomicsGuardrail({ cac: 60_000, ltv: 150_000, fraudRate: 0.01 }, g).reasons[0]?.code).toBe('CAC_LTV_TOO_HIGH');
    expect(unitEconomicsGuardrail({ cac: 10_000, ltv: 150_000, fraudRate: 0.06 }, g).pause).toBe(true);
    expect(unitEconomicsGuardrail({ cac: 10_000, ltv: 0, fraudRate: 0 }, g).reasons[0]?.code).toBe('LTV_NOT_POSITIVE');
  });
});
