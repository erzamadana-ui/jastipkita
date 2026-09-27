/**
 * Money abuse & race conditions (security review 2026-09, scope item 3).
 *   SEC-02  promotion limits (per user / global / budget / first transaction) were evaluated only when a QUOTE
 *           was built; checkout reserved the redemption without re-checking, so N quotes on N transactions
 *           (or N concurrent checkouts) all received a "once per user" / last-unit discount.
 *   Races   double checkout, double confirm-receipt, concurrent admin refund + buyer confirmation must never
 *           move more money than escrow holds.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../helpers';
import {
  call,
  createFile,
  createMatchedTx,
  idem,
  lineAmount,
  payViaWebhook,
  seedFx,
  setTripStatus,
  setupParties,
  txLedger,
  txStatus,
} from '../../src/modules/transactions/test-fixtures';
import { createAdmin, as, idem as adminIdem, purchasedTx } from '../../src/modules/admin/test-support';

let t: TestContext;
beforeAll(async () => {
  t = await createTestContext();
  await seedFx(t);
});
afterAll(() => t?.close());

async function promo(code: string, opts: { perUser?: number | null; total?: number | null; type?: string; budget?: number | null } = {}) {
  await t.adminSql`
    INSERT INTO promotions (code, name, type, conditions, benefit, starts_at, status, usage_limit_per_user, usage_limit_total, budget_total_idr)
    VALUES (${code}, ${code}, ${opts.type ?? 'PROMO_CODE'}, '{}'::jsonb, '{"kind":"FIXED","amountIdr":50000}'::jsonb,
            now() - interval '1 day', 'ACTIVE', ${opts.perUser === undefined ? 1 : opts.perUser}, ${opts.total ?? null}, ${opts.budget ?? null})`;
}

async function quote(p: Awaited<ReturnType<typeof setupParties>>, txId: string, promoCode?: string) {
  const q = await call(t, p.buyer, 'POST', `/v1/transactions/${txId}/quote`, { channel: 'QRIS', ...(promoCode ? { promoCode } : {}) });
  expect(q.status, JSON.stringify(q.body)).toBe(201);
  return q.body;
}

const checkout = (p: Awaited<ReturnType<typeof setupParties>>, txId: string, quoteId: string) =>
  call(t, p.buyer, 'POST', `/v1/transactions/${txId}/checkout`, { quoteId, acknowledgeRestricted: true }, idem());

async function reservations(code: string) {
  const [r] = await t.adminSql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM promotion_redemptions pr JOIN promotions p ON p.id = pr.promotion_id
     WHERE p.code = ${code} AND pr.status IN ('RESERVED','APPLIED')`;
  return r!.n;
}

describe('SEC-02 promotion limits are enforced at checkout, not only at quote time', () => {
  it('a once-per-user code quoted on two transactions is redeemed only once', async () => {
    await promo('SEKALI');
    const p = await setupParties(t);
    const a = await createMatchedTx(t, p);
    const b = await createMatchedTx(t, p);
    const qa = await quote(p, a.id, 'SEKALI');
    const qb = await quote(p, b.id, 'SEKALI');
    expect(qa.promotion.discountIdr).toBe(50000);
    expect(qb.promotion.discountIdr).toBe(50000); // both quotes see an unused code …
    expect((await checkout(p, a.id, qa.quoteId)).status).toBe(201);
    const second = await checkout(p, b.id, qb.quoteId);
    expect(second.status, JSON.stringify(second.body)).toBe(422); // … but only one checkout may redeem it
    expect(second.body.error.code).toBe('PROMO_NO_LONGER_VALID');
    expect(await reservations('SEKALI')).toBe(1);
    expect(await txStatus(t, b.id)).toBe('MATCHED');
    // a fresh quote no longer carries the discount and checks out normally
    const qb2 = await quote(p, b.id, 'SEKALI');
    expect(qb2.promotion.discountIdr).toBe(0);
    expect((await checkout(p, b.id, qb2.quoteId)).status).toBe(201);
  });

  it('concurrent checkouts cannot exceed a global usage limit', async () => {
    await promo('TERAKHIR', { perUser: null, total: 1 });
    const parties = await Promise.all([setupParties(t), setupParties(t), setupParties(t)]);
    const txs = await Promise.all(parties.map((p) => createMatchedTx(t, p)));
    const quotes: { quoteId: string }[] = [];
    for (let i = 0; i < 3; i++) quotes.push(await quote(parties[i]!, txs[i]!.id, 'TERAKHIR'));
    const results = await Promise.all(parties.map((p, i) => checkout(p, txs[i]!.id, quotes[i]!.quoteId)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.body?.error?.code === 'PROMO_NO_LONGER_VALID')).toHaveLength(2);
    expect(await reservations('TERAKHIR')).toBe(1);
  });

  it('a first-transaction promotion is granted to one transaction of a buyer only', async () => {
    await t.adminSql`UPDATE promotions SET status = 'ENDED' WHERE status = 'ACTIVE'`;
    await t.adminSql`
      INSERT INTO promotions (name, type, conditions, benefit, starts_at, status)
      VALUES ('Transaksi pertama', 'FIRST_TRANSACTION', '{}'::jsonb, '{"kind":"FIXED","amountIdr":30000}'::jsonb, now() - interval '1 day', 'ACTIVE')`;
    const p = await setupParties(t);
    const a = await createMatchedTx(t, p);
    const b = await createMatchedTx(t, p);
    const qa = await quote(p, a.id);
    const qb = await quote(p, b.id);
    expect(qa.promotion.discountIdr).toBe(30000);
    expect(qb.promotion.discountIdr).toBe(30000);
    const [ra, rb] = await Promise.all([checkout(p, a.id, qa.quoteId), checkout(p, b.id, qb.quoteId)]);
    expect([ra.status, rb.status].sort()).toEqual([201, 422]);
    expect([ra, rb].find((r) => r.status === 422)!.body.error.code).toBe('PROMO_NO_LONGER_VALID');
    await t.adminSql`UPDATE promotions SET status = 'ENDED' WHERE type = 'FIRST_TRANSACTION'`;
  });
});

describe('race conditions on money actions', () => {
  it('double checkout with different idempotency keys creates exactly one payment', async () => {
    const p = await setupParties(t);
    const tx = await createMatchedTx(t, p);
    const q = await quote(p, tx.id);
    const rs = await Promise.all([1, 2, 3, 4].map(() => checkout(p, tx.id, q.quoteId)));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    const [n] = await t.adminSql<{ n: number }[]>`SELECT count(*)::int AS n FROM payments WHERE transaction_id = ${tx.id}`;
    expect(n!.n).toBe(1);
  });

  it('the same idempotency key replayed concurrently runs the checkout once', async () => {
    const p = await setupParties(t);
    const tx = await createMatchedTx(t, p);
    const q = await quote(p, tx.id);
    const key = { 'idempotency-key': crypto.randomUUID() };
    const rs = await Promise.all([1, 2, 3].map(() => call(t, p.buyer, 'POST', `/v1/transactions/${tx.id}/checkout`, { quoteId: q.quoteId, acknowledgeRestricted: true }, key)));
    const ok = rs.filter((r) => r.status === 201);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    expect(new Set(ok.map((r) => r.body.paymentId)).size).toBe(1);
    for (const r of rs.filter((x) => x.status !== 201)) expect(r.body.error.code).toBe('IDEMPOTENCY_IN_PROGRESS');
  });

  it('a replayed webhook secures the payment and posts the capture journal only once', async () => {
    const p = await setupParties(t);
    const tx = await createMatchedTx(t, p);
    const q = await quote(p, tx.id);
    const co = await checkout(p, tx.id, q.quoteId);
    const { body } = await payViaWebhook(t, co.body.paymentId);
    const again = await Promise.all([1, 2, 3].map(() =>
      t.request('POST', '/v1/webhooks/payments/mock', { rawBody: body, headers: { 'content-type': 'application/json', 'x-callback-token': 'mock-webhook-token' } }),
    ));
    for (const r of again) expect(r.body.status).toBe('DUPLICATE');
    const [j] = await t.adminSql<{ n: number }[]>`SELECT count(*)::int AS n FROM ledger_journals WHERE idempotency_key = ${`capture:${co.body.paymentId}`}`;
    expect(j!.n).toBe(1);
  });

  it('concurrent admin full refund and buyer confirm-receipt never release more than escrow', async () => {
    const { p, tx, quote: qb } = await purchasedTx(t);
    await setTripStatus(t, tx.tripId, ['ACTIVE', 'TRAVELING']);
    for (const to of ['TRAVELING', 'ARRIVED']) {
      const r = await call(t, p.traveler, 'POST', `/v1/transactions/${tx.id}/status`, { to });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }
    const bpn = await createFile(t, p.traveler.id, 'RECEIPT');
    const decl = await call(t, p.traveler, 'POST', `/v1/transactions/${tx.id}/customs-declaration`, {
      dutyPaidIdr: lineAmount(qb, 'CUSTOMS_DUTY'), vatPaidIdr: lineAmount(qb, 'IMPORT_TAX'), incomeTaxPaidIdr: 0, receiptFileId: bpn, declarationRef: 'CD-SEC-0001',
    });
    expect(decl.status, JSON.stringify(decl.body)).toBe(200);
    expect((await call(t, p.traveler, 'POST', `/v1/transactions/${tx.id}/status`, { to: 'READY_FOR_HANDOVER' })).status).toBe(200);
    expect((await call(t, p.traveler, 'POST', `/v1/transactions/${tx.id}/delivery`, { method: 'MEETUP', meetupPoint: 'Stasiun MRT' })).status).toBe(200);
    const pin = await call(t, p.buyer, 'GET', `/v1/transactions/${tx.id}/delivery/pin`);
    expect((await call(t, p.traveler, 'POST', `/v1/transactions/${tx.id}/delivery/verify`, { pin: pin.body.pin })).status).toBe(200);
    expect(await txStatus(t, tx.id)).toBe('DELIVERED');

    const admin = await createAdmin(t, ['FINANCE_SUPER_ADMIN', 'OPERATIONS']);
    const total = qb.totalIdr;
    const [refund, confirm] = await Promise.all([
      as(t, admin, 'POST', `/v1/admin/transactions/${tx.id}/refund`, { amountIdr: total, reason: 'Uji balapan refund vs konfirmasi', remainderTo: 'NONE' }, adminIdem()),
      call(t, p.buyer, 'POST', `/v1/transactions/${tx.id}/confirm-receipt`, undefined, idem()),
    ]);
    expect(refund.status, JSON.stringify(refund.body)).not.toBe(500);
    expect(confirm.status, JSON.stringify(confirm.body)).not.toBe(500);
    // exactly one side wins
    expect([refund.status < 300, confirm.status < 300 && ['BUYER_CONFIRMED', 'COMPLETED'].includes(confirm.body.transactionStatus)].filter(Boolean)).toHaveLength(1);
    const ledger = await txLedger(t, tx.id);
    for (const bucket of ['PRODUCT_FUND', 'CUSTOMS_RESERVE', 'CLEARING']) {
      expect(ledger[bucket] ?? 0, `${bucket} must not go negative`).toBeGreaterThanOrEqual(0);
    }
    const [out] = await t.adminSql<{ refunds: string; payouts: string }[]>`
      SELECT (SELECT coalesce(sum(amount_idr),0) FROM refunds WHERE transaction_id = ${tx.id} AND status NOT IN ('REJECTED','CANCELLED'))::text AS refunds,
             (SELECT coalesce(sum(amount_idr),0) FROM payouts WHERE transaction_id = ${tx.id})::text AS payouts`;
    expect(Number(out!.refunds) + Number(out!.payouts)).toBeLessThanOrEqual(total);
  });
});
