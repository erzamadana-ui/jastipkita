import { describe, expect, it } from 'vitest';
import { DEFAULT_BUSINESS_CONFIG } from '../config';
import { buildQuote } from '../pricing';
import { SEEDS, createPrng } from '../testing/prng';
import { type PromoCart, type PromoUser, type Promotion, evaluatePromotions } from './index';

const NOW = new Date('2026-09-27T00:00:00Z');
const cart: PromoCart = {
  itemValueIdr: 2_000_000,
  travelerFeeIdr: 200_000,
  platformFeeIdr: 100_000,
  originCountry: 'JP',
  categoryCode: 'TOYS_HOBBIES',
  travelerId: 'trav-a',
  enteredCodes: ['hemat10'],
};
const user: PromoUser = { id: 'u1', isFirstTransaction: true, segments: ['NEW'], usageByPromo: {} };
const window = { status: 'ACTIVE', startsAt: new Date('2026-09-01T00:00:00Z'), endsAt: new Date('2026-10-01T00:00:00Z') } as const;

const P = {
  code: { ...window, id: 'p-code', code: 'HEMAT10', type: 'PROMO_CODE', name: 'Hemat 10%', benefit: { kind: 'PERCENT', rateBps: 1000, capIdr: 150_000 } },
  first: { ...window, id: 'p-first', type: 'FIRST_TRANSACTION', name: 'Pertama', benefit: { kind: 'FIXED', amountIdr: 50_000 } },
  japan: {
    ...window,
    id: 'p-jp',
    type: 'COUNTRY',
    name: 'Japan week',
    conditions: { originCountries: ['JP'], minItemValueIdr: 1_000_000 },
    benefit: { kind: 'FIXED', amountIdr: 100_000 },
  },
  freeFee: { ...window, id: 'p-free', type: 'FREE_PLATFORM_FEE', name: 'Gratis platform fee', benefit: { kind: 'FREE_PLATFORM_FEE' } },
  cashback: {
    ...window,
    id: 'p-cb',
    type: 'CASHBACK',
    name: 'Cashback 5%',
    benefit: { kind: 'CASHBACK_CREDIT', rateBps: 500, capIdr: 75_000 },
  },
} satisfies Record<string, Promotion>;

describe('evaluatePromotions', () => {
  it('applies the best single discount and stacks one cashback', () => {
    const r = evaluatePromotions(cart, Object.values(P), user, NOW);
    expect(r.applied.map((a) => a.promoId)).toEqual(['p-code', 'p-cb']);
    expect(r.discountIdr).toBe(150_000); // 10% of 2,000,000 capped at 150,000
    expect(r.cashbackIdr).toBe(75_000);
    expect(r.freePlatformFee).toBe(false);
    expect(r.rejected.filter((x) => x.code === 'NOT_STACKABLE').map((x) => x.promoId).sort()).toEqual(['p-first', 'p-free', 'p-jp']);
  });

  it('FREE_PLATFORM_FEE wins when it is the most valuable and sets the flag (no cash discount)', () => {
    const r = evaluatePromotions({ ...cart, platformFeeIdr: 750_000, enteredCodes: [] }, [P.first, P.freeFee], user, NOW);
    expect(r.applied[0]?.promoId).toBe('p-free');
    expect(r.freePlatformFee).toBe(true);
    expect(r.discountIdr).toBe(0);
  });

  it('checks date window, first transaction, country, min value and traveler conditions', () => {
    const late = evaluatePromotions(cart, [P.first], user, new Date('2026-10-01T00:00:00Z'));
    expect(late.rejected[0]?.code).toBe('OUTSIDE_DATE_WINDOW');
    expect(evaluatePromotions(cart, [P.first], { ...user, isFirstTransaction: false }, NOW).rejected[0]?.code).toBe('NOT_FIRST_TRANSACTION');
    expect(evaluatePromotions({ ...cart, originCountry: 'KR' }, [P.japan], user, NOW).rejected[0]?.code).toBe('ORIGIN_NOT_ELIGIBLE');
    expect(evaluatePromotions({ ...cart, itemValueIdr: 900_000 }, [P.japan], user, NOW).rejected[0]?.code).toBe('BELOW_MIN_ITEM_VALUE');
    const trav: Promotion = { ...window, id: 'p-t', type: 'TRAVELER', name: 't', conditions: { travelerIds: ['trav-b'] }, benefit: { kind: 'FIXED', amountIdr: 1 } };
    expect(evaluatePromotions(cart, [trav], user, NOW).rejected[0]?.code).toBe('TRAVELER_NOT_ELIGIBLE');
  });

  it('enforces per-user, global and budget limits (budget partially caps)', () => {
    const limited: Promotion = { ...P.first, limits: { perUser: 1 } };
    expect(evaluatePromotions(cart, [limited], { ...user, usageByPromo: { 'p-first': 1 } }, NOW).rejected[0]?.code).toBe(
      'PER_USER_LIMIT_REACHED',
    );
    const global: Promotion = { ...P.first, limits: { global: 100 }, usage: { globalCount: 100, budgetUsedIdr: 0 } };
    expect(evaluatePromotions(cart, [global], user, NOW).rejected[0]?.code).toBe('GLOBAL_LIMIT_REACHED');
    const budget: Promotion = { ...P.first, limits: { budgetIdr: 1_000_000 }, usage: { globalCount: 0, budgetUsedIdr: 980_000 } };
    const r = evaluatePromotions(cart, [budget], user, NOW);
    expect(r.discountIdr).toBe(20_000);
    expect(r.applied[0]?.budgetCapped).toBe(true);
  });

  it('reports unknown codes, ignores codes not entered', () => {
    const r = evaluatePromotions({ ...cart, enteredCodes: ['NOPE'] }, [P.code], user, NOW);
    expect(r.rejected).toEqual([{ promoId: 'code:NOPE', code: 'UNKNOWN_CODE', reason: 'UNKNOWN_CODE' }]);
    expect(r.applied).toHaveLength(0);
  });

  it('feeds pricing: discount never exceeds eligible base, TOTAL stays ≥ 0 (property)', () => {
    const cfg = DEFAULT_BUSINESS_CONFIG;
    for (const seed of SEEDS.slice(0, 80)) {
      const r = createPrng(seed);
      const item = r.int(100_000, 5_000_000);
      const promos: Promotion[] = [
        { ...window, id: 'a', type: 'CAMPAIGN', name: 'a', benefit: { kind: 'PERCENT', rateBps: r.int(0, 10_000), base: r.pick(['ITEM_PRICE', 'SUBTOTAL'] as const) } },
        { ...window, id: 'b', type: 'CAMPAIGN', name: 'b', benefit: { kind: 'FIXED', amountIdr: r.int(0, 10_000_000) } },
      ];
      const ev = evaluatePromotions({ ...cart, itemValueIdr: item, enteredCodes: [] }, promos, user, NOW);
      expect(ev.applied.length).toBeLessThanOrEqual(1);
      const q = buildQuote(
        {
          item: { unitPriceMinor: item, currency: 'IDR', quantity: 1 },
          travelerFee: { type: 'FIXED', amountIdr: 200_000 },
          customs: null,
          promotion: ev,
          now: NOW,
        },
        cfg,
      );
      expect(q.totalIdr).toBeGreaterThanOrEqual(0);
      expect(-q.amounts.DISCOUNT).toBeLessThanOrEqual(ev.discountIdr);
    }
  });
});
