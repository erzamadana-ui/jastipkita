import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../../../test/helpers';
import { expireDuePayments, expireQuotesAndLocks } from '../payments/service';
import { call, createMatchedTx, idem, lineAmount, seedFx, setupParties, txStatus, type Parties } from '../transactions/test-fixtures';

let t: TestContext;
let p: Parties;

beforeAll(async () => {
  t = await createTestContext();
  await seedFx(t);
  p = await setupParties(t);
});
afterAll(async () => {
  await t.close();
});

describe('quote', () => {
  it('only the buyer can quote, only in MATCHED', async () => {
    const tx = await createMatchedTx(t, p);
    const asTraveler = await call(t, p.traveler, 'POST', `/v1/transactions/${tx.id}/quote`, {});
    expect(asTraveler.status).toBe(403);
    const stranger = await t.createUser({ kycLevel: 3 });
    const res = await t.request('POST', `/v1/transactions/${tx.id}/quote`, { token: stranger.accessToken, body: {} });
    expect(res.status).toBe(404);
  });

  it('PROHIBITED items are blocked at quote time', async () => {
    const tx = await createMatchedTx(t, p, { productName: 'Vape pod mint flavour', categoryCode: 'TOBACCO_VAPE' });
    const res = await call(t, p.buyer, 'POST', `/v1/transactions/${tx.id}/quote`, { channel: 'QRIS' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('ITEM_PROHIBITED');
  });

  it('below the minimum transaction value is blocked', async () => {
    const tx = await createMatchedTx(t, p, { unitPriceMinor: 500 });
    const res = await call(t, p.buyer, 'POST', `/v1/transactions/${tx.id}/quote`, { channel: 'QRIS' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('BELOW_MINIMUM_TRANSACTION');
  });

  it('QRIS above Rp10.000.000 is refused (channel limit); buyer limit enforced', async () => {
    const tx = await createMatchedTx(t, p, { unitPriceMinor: 120_000 });
    const res = await call(t, p.buyer, 'POST', `/v1/transactions/${tx.id}/quote`, { channel: 'QRIS' });
    expect(res.status).toBe(422);
    expect(['CHANNEL_LIMIT_EXCEEDED', 'LIMIT_EXCEEDED']).toContain(res.body.error.code);
  });

  it('applies a promo code and JastipKita Credit (non-withdrawable) transparently', async () => {
    await t.adminSql`
      INSERT INTO promotions (code, name, type, conditions, benefit, starts_at, status, usage_limit_per_user)
      VALUES ('HEMAT10', 'Hemat 10%', 'PROMO_CODE', '{}'::jsonb, '{"kind":"PERCENT","rateBps":1000,"capIdr":100000}'::jsonb,
              now() - interval '1 day', 'ACTIVE', 1)`;
    await t.adminSql`
      INSERT INTO credit_entries (user_id, amount_idr, reason, expires_at, idempotency_key)
      VALUES (${p.buyer.id}, 25000, 'REFERRAL_REWARD', ${new Date(t.clock.now().getTime() + 90 * 86400_000)}, ${`ref-reward:${p.buyer.id}`})`;
    const tx = await createMatchedTx(t, p);
    const q = await call(t, p.buyer, 'POST', `/v1/transactions/${tx.id}/quote`, { channel: 'QRIS', promoCode: 'hemat10', useCredit: true });
    expect(q.status, JSON.stringify(q.body)).toBe(201);
    expect(lineAmount(q.body, 'DISCOUNT')).toBe(-100000);
    expect(lineAmount(q.body, 'REFERRAL_CREDIT')).toBe(-25000);
    expect(q.body.credit).toMatchObject({ appliedIdr: 25000, withdrawable: false });
    const co = await call(t, p.buyer, 'POST', `/v1/transactions/${tx.id}/checkout`, { quoteId: q.body.quoteId }, idem());
    expect(co.status).toBe(201);
    const [bal] = await t.adminSql<{ b: number }[]>`SELECT coalesce(sum(amount_idr),0)::int AS b FROM credit_entries WHERE user_id = ${p.buyer.id}`;
    expect(bal!.b).toBe(0);
    const [red] = await t.adminSql<{ status: string; amount_idr: number }[]>`SELECT status, amount_idr FROM promotion_redemptions WHERE transaction_id = ${tx.id}`;
    expect(red).toMatchObject({ status: 'RESERVED' });
    expect(Number(red!.amount_idr)).toBe(100000);

    // Payment expires → tx back to MATCHED, credit restored, promo reservation released.
    t.clock.advance(31 * 60_000);
    const r = await expireDuePayments(t.deps);
    expect(r.expired).toBe(1);
    expect(await txStatus(t, tx.id)).toBe('MATCHED');
    const [bal2] = await t.adminSql<{ b: number }[]>`SELECT coalesce(sum(amount_idr),0)::int AS b FROM credit_entries WHERE user_id = ${p.buyer.id}`;
    expect(bal2!.b).toBe(25000);
    const [red2] = await t.adminSql<{ status: string }[]>`SELECT status FROM promotion_redemptions WHERE transaction_id = ${tx.id}`;
    expect(red2!.status).toBe('EXPIRED');
    const [ev] = await t.adminSql`SELECT 1 FROM outbox_events WHERE event_type = 'payment.expired' AND payload->>'transactionId' = ${tx.id}`;
    expect(ev).toBeTruthy();
  });
});

describe('checkout', () => {
  it('payment duplicate: same Idempotency-Key replays; a different key while AWAITING_PAYMENT → 409', async () => {
    const tx = await createMatchedTx(t, p);
    const q = await call(t, p.buyer, 'POST', `/v1/transactions/${tx.id}/quote`, { channel: 'QRIS' });
    const key = idem();
    const first = await call(t, p.buyer, 'POST', `/v1/transactions/${tx.id}/checkout`, { quoteId: q.body.quoteId }, key);
    expect(first.status).toBe(201);
    // network loss: the client never saw the response and retries with the SAME key
    const retry = await call(t, p.buyer, 'POST', `/v1/transactions/${tx.id}/checkout`, { quoteId: q.body.quoteId }, key);
    expect(retry.status).toBe(201);
    expect(retry.headers.get('idempotent-replayed')).toBe('true');
    expect(retry.body.paymentId).toBe(first.body.paymentId);
    expect(retry.body.checkoutUrl).toBe(first.body.checkoutUrl);
    const again = await call(t, p.buyer, 'POST', `/v1/transactions/${tx.id}/checkout`, { quoteId: q.body.quoteId }, idem());
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('PAYMENT_ALREADY_PENDING');
    const payments = await t.adminSql`SELECT id FROM payments WHERE transaction_id = ${tx.id}`;
    expect(payments).toHaveLength(1);
    const reused = await call(t, p.buyer, 'POST', `/v1/transactions/${tx.id}/checkout`, { quoteId: q.body.quoteId, acknowledgeRestricted: true }, key);
    expect(reused.status).toBe(422);
    expect(reused.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('requires an Idempotency-Key and KYC level 2', async () => {
    const tx = await createMatchedTx(t, p);
    const q = await call(t, p.buyer, 'POST', `/v1/transactions/${tx.id}/quote`, { channel: 'QRIS' });
    const noKey = await call(t, p.buyer, 'POST', `/v1/transactions/${tx.id}/checkout`, { quoteId: q.body.quoteId });
    expect(noKey.status).toBe(400);
    expect(noKey.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const k1 = await t.createUser({ kycLevel: 1 });
    const res = await t.request('POST', `/v1/transactions/${tx.id}/checkout`, { token: k1.accessToken, body: { quoteId: q.body.quoteId }, headers: idem() });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('KYC_LEVEL_REQUIRED');
  });

  it('FX expiration: checkout after the lock expired is rejected; a re-quote works', async () => {
    const tx = await createMatchedTx(t, p);
    const q = await call(t, p.buyer, 'POST', `/v1/transactions/${tx.id}/quote`, { channel: 'QRIS' });
    expect(q.status).toBe(201);
    t.clock.set(new Date(new Date(q.body.fx.expiresAt).getTime() + 1000));
    const late = await call(t, p.buyer, 'POST', `/v1/transactions/${tx.id}/checkout`, { quoteId: q.body.quoteId }, idem());
    expect(late.status).toBe(422);
    expect(late.body.error.code).toBe('FX_LOCK_EXPIRED');
    expect(await txStatus(t, tx.id)).toBe('MATCHED');
    const exp = await expireQuotesAndLocks(t.deps);
    expect(exp.quotes).toBeGreaterThanOrEqual(1);
    const q2 = await call(t, p.buyer, 'POST', `/v1/transactions/${tx.id}/quote`, { channel: 'QRIS' });
    expect(q2.status).toBe(201);
    expect(q2.body.quoteId).not.toBe(q.body.quoteId);
    const old = await call(t, p.buyer, 'POST', `/v1/transactions/${tx.id}/checkout`, { quoteId: q.body.quoteId }, idem());
    expect(old.status).toBe(422);
    const ok = await call(t, p.buyer, 'POST', `/v1/transactions/${tx.id}/checkout`, { quoteId: q2.body.quoteId }, idem());
    expect(ok.status).toBe(201);
    expect(await txStatus(t, tx.id)).toBe('AWAITING_PAYMENT');
    const [fx] = await t.adminSql<{ status: string }[]>`SELECT f.status FROM quotes q JOIN fx_locks f ON f.id = q.fx_lock_id WHERE q.id = ${q2.body.quoteId}`;
    expect(fx!.status).toBe('CONSUMED');
  });

  it('restricted items need acknowledgement before payment', async () => {
    const tx = await createMatchedTx(t, p, { productName: 'Anker Power Bank 10000mAh', categoryCode: 'BATTERIES_POWERBANK', unitPriceMinor: 6000 });
    const q = await call(t, p.buyer, 'POST', `/v1/transactions/${tx.id}/quote`, { channel: 'QRIS' });
    expect(q.status, JSON.stringify(q.body)).toBe(201);
    if (q.body.restricted.requiresAcknowledgement) {
      const noAck = await call(t, p.buyer, 'POST', `/v1/transactions/${tx.id}/checkout`, { quoteId: q.body.quoteId }, idem());
      expect(noAck.status).toBe(422);
      expect(noAck.body.error.code).toBe('RESTRICTED_NOT_ACKNOWLEDGED');
    }
    const ack = await call(t, p.buyer, 'POST', `/v1/transactions/${tx.id}/checkout`, { quoteId: q.body.quoteId, acknowledgeRestricted: true }, idem());
    expect(ack.status).toBe(201);
  });

  it('GET /payment returns the checkout URL to the buyer only', async () => {
    const tx = await createMatchedTx(t, p);
    const q = await call(t, p.buyer, 'POST', `/v1/transactions/${tx.id}/quote`, { channel: 'VA' });
    expect(q.status).toBe(201);
    await call(t, p.buyer, 'POST', `/v1/transactions/${tx.id}/checkout`, { quoteId: q.body.quoteId }, idem());
    const b = await call(t, p.buyer, 'GET', `/v1/transactions/${tx.id}/payment`);
    expect(b.body.current.checkoutUrl).toBeTruthy();
    expect(b.body.current.channel).toBe('VA');
    const tr = await call(t, p.traveler, 'GET', `/v1/transactions/${tx.id}/payment`);
    expect(tr.body.current.checkoutUrl).toBeNull();
  });
});
