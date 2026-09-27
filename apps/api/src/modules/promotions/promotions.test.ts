import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext, type TestUser } from '../../../test/helpers';
import { advance, createTransaction } from '../notifications/testing/fixtures';

let t: TestContext;
let buyer: TestUser;
let traveler: TestUser;
let cashbackPromoId: string;

async function promo(p: { code: string | null; type: string; name: string; benefit: unknown; conditions?: unknown; startsAt?: string; endsAt?: string | null; budget?: number | null }) {
  const [r] = await t.adminSql<{ id: string }[]>`
    INSERT INTO promotions (code, name, type, benefit, conditions, status, starts_at, ends_at, budget_total_idr, usage_limit_per_user, description)
    VALUES (${p.code}, ${p.name}, ${p.type}, ${t.adminSql.json(p.benefit as never)}, ${t.adminSql.json((p.conditions ?? {}) as never)}, 'ACTIVE',
            ${p.startsAt ? t.adminSql`${p.startsAt}::timestamptz` : t.adminSql`now() - interval '1 day'`},
            ${p.endsAt === undefined ? t.adminSql`now() + interval '30 days'` : p.endsAt === null ? null : t.adminSql`${p.endsAt}::timestamptz`},
            ${p.budget ?? 10_000_000}, 1, ${`Promo ${p.name}`})
    RETURNING id`;
  return r!.id;
}

beforeAll(async () => {
  t = await createTestContext();
  buyer = await t.createUser({ kycLevel: 2 });
  traveler = await t.createUser({ kycLevel: 4, mode: 'TRAVELER' });
  await promo({ code: 'HEMAT10', type: 'PROMO_CODE', name: 'Hemat 10%', benefit: { kind: 'PERCENT', rateBps: 1000, capIdr: 150000 } });
  await promo({ code: null, type: 'FIRST_TRANSACTION', name: 'Transaksi pertama', benefit: { kind: 'FIXED', amountIdr: 50000 } });
  cashbackPromoId = await promo({ code: 'CASHBACK5', type: 'CASHBACK', name: 'Cashback 5%', benefit: { kind: 'CASHBACK_CREDIT', rateBps: 500, capIdr: 75000 }, conditions: { cashbackExpiryDays: 60 } });
  await promo({ code: 'JEPANG', type: 'PROMO_CODE', name: 'Khusus Korea', benefit: { kind: 'FIXED', amountIdr: 30000 }, conditions: { originCountries: ['KR'] } });
  await promo({ code: 'RAHASIA', type: 'PROMO_CODE', name: 'Internal', benefit: { kind: 'FIXED', amountIdr: 99000 }, conditions: { public: false } });
  await t.adminSql`INSERT INTO promotions (code, name, type, benefit, status, starts_at, ends_at) VALUES ('LAMA', 'Promo lama', 'PROMO_CODE', '{"kind":"FIXED","amountIdr":10000}', 'ACTIVE', now() - interval '60 days', now() - interval '30 days')`;
});
afterAll(async () => {
  await t.close();
});

const validate = (u: TestUser, transactionId: string, code: string) => t.request('POST', '/v1/promotions/validate', { token: u.accessToken, body: { transactionId, code } });

describe('GET /v1/promotions/active', () => {
  it('lists running public promotions without internal fields', async () => {
    const res = await t.request('GET', '/v1/promotions/active');
    expect(res.status).toBe(200);
    const codes = res.body.data.map((p: { code: string | null }) => p.code);
    expect(codes).toEqual(expect.arrayContaining(['HEMAT10', 'CASHBACK5', null]));
    expect(codes).not.toContain('RAHASIA');
    expect(codes).not.toContain('LAMA');
    const hemat = res.body.data.find((p: { code: string }) => p.code === 'HEMAT10');
    expect(hemat.benefit).toEqual({ kind: 'PERCENT', rateBps: 1000, amountIdr: null, capIdr: 150000 });
    for (const k of ['budgetTotalIdr', 'budget_total_idr', 'usageCount', 'fundedBy', 'createdBy']) expect(hemat).not.toHaveProperty(k);
  });
});

describe('POST /v1/promotions/validate', () => {
  it('previews a code against the quote (no redemption) and explains rejections', async () => {
    const tx = await createTransaction(t, { buyerId: buyer.id, travelerId: traveler.id, to: 'MATCHED', itemIdr: 1_000_000 });
    let res = await validate(buyer, tx.id, 'hemat10');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ valid: true, code: 'HEMAT10', type: 'PROMO_CODE', discountIdr: 100_000, reason: null });
    expect(await t.adminSql`SELECT 1 FROM promotion_redemptions`).toHaveLength(0);

    res = await validate(buyer, tx.id, 'CASHBACK5');
    expect(res.body).toMatchObject({ valid: true, discountIdr: 0, cashbackIdr: 50_000 });
    res = await validate(buyer, tx.id, 'JEPANG');
    expect(res.body).toMatchObject({ valid: false, reason: 'ORIGIN_NOT_ELIGIBLE' });
    res = await validate(buyer, tx.id, 'NGGAKADA');
    expect(res.body).toMatchObject({ valid: false, reason: 'UNKNOWN_CODE', message: 'Kode promo tidak ditemukan' });
    res = await validate(buyer, tx.id, 'LAMA');
    expect(res.body.valid).toBe(false);

    // small cart: the automatic first-transaction promo (Rp50.000) beats 10 % → not stackable
    const small = await createTransaction(t, { buyerId: buyer.id, travelerId: traveler.id, to: 'MATCHED', itemIdr: 300_000 });
    res = await validate(buyer, small.id, 'HEMAT10');
    expect(res.body).toMatchObject({ valid: false, reason: 'NOT_STACKABLE' });
    expect(res.body.otherApplied.some((o: { type: string; discountIdr: number }) => o.type === 'FIRST_TRANSACTION' && o.discountIdr === 50_000)).toBe(true);
  });

  it('only for my transaction, before payment, with a quote', async () => {
    const tx = await createTransaction(t, { buyerId: buyer.id, travelerId: traveler.id, to: 'MATCHED' });
    expect((await validate(traveler, tx.id, 'HEMAT10')).status).toBe(404);
    const paid = await createTransaction(t, { buyerId: buyer.id, travelerId: traveler.id, to: 'PAYMENT_SECURED' });
    const res = await validate(buyer, paid.id, 'HEMAT10');
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('PROMO_NOT_APPLICABLE');
    expect((await validate(buyer, tx.id, 'x')).status).toBe(400);
  });
});

describe('cashback on COMPLETED', () => {
  it('grants PROMO_CASHBACK credit once per redemption with the promo’s expiry and notifies', async () => {
    const tx = await createTransaction(t, { buyerId: buyer.id, travelerId: traveler.id, to: 'BUYER_CONFIRMED' });
    const [red] = await t.adminSql<{ id: string }[]>`
      INSERT INTO promotion_redemptions (promotion_id, user_id, transaction_id, quote_id, amount_idr, status, applied_at)
      VALUES (${cashbackPromoId}, ${buyer.id}, ${tx.id}, ${tx.quoteId}, 50000, 'APPLIED', now()) RETURNING id`;
    await t.drain();
    await advance(t, tx.id, 'COMPLETED');
    await t.drain();
    await t.drain();
    const credits = await t.adminSql<{ amount_idr: number; reason: string; reference_id: string; expires_at: Date }[]>`
      SELECT amount_idr, reason, reference_id, expires_at FROM credit_entries WHERE user_id = ${buyer.id} AND reason = 'PROMO_CASHBACK'`;
    expect(credits).toHaveLength(1);
    expect(credits[0]).toMatchObject({ amount_idr: 50000, reference_id: red!.id });
    expect(Math.round((credits[0]!.expires_at.getTime() - Date.now()) / 86400_000)).toBe(60);
    const n = await t.adminSql`SELECT 1 FROM notifications WHERE user_id = ${buyer.id} AND event_type = 'credit.cashback_granted'`;
    expect(n).toHaveLength(1);
  });
});
