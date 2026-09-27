import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../../../test/helpers';
import { computeLots, dueExpiries, expiryKey } from './ledger';
import { runCreditExpiry } from './service';

describe('credit lots (pure)', () => {
  const d = (days: number) => new Date(Date.UTC(2026, 8, 27) + days * 86400_000);
  it('debits consume the earliest-expiring lot first; EXPIRY entries hit their own lot', () => {
    const lots = computeLots([
      { id: 1, amountIdr: 25_000, reason: 'REFERRAL_REWARD', expiresAt: d(90), createdAt: d(0), idempotencyKey: 'a' },
      { id: 2, amountIdr: 10_000, reason: 'PROMO_CASHBACK', expiresAt: d(10), createdAt: d(1), idempotencyKey: 'b' },
      { id: 3, amountIdr: -12_000, reason: 'CHECKOUT_REDEEM', expiresAt: null, createdAt: d(2), idempotencyKey: null },
    ]);
    expect(lots.map((l) => [l.lotId, l.remainingIdr])).toEqual([
      [1, 23_000],
      [2, 0],
    ]);
    expect(dueExpiries(lots, d(95))).toEqual([{ lotId: 1, amountIdr: 23_000 }]);
    const after = computeLots([
      { id: 1, amountIdr: 25_000, reason: 'REFERRAL_REWARD', expiresAt: d(90), createdAt: d(0), idempotencyKey: 'a' },
      { id: 4, amountIdr: -25_000, reason: 'EXPIRY', expiresAt: null, createdAt: d(91), idempotencyKey: expiryKey(1) },
    ]);
    expect(dueExpiries(after, d(95))).toEqual([]);
  });
});

describe('credit expiry job & GET /v1/credits', () => {
  let t: TestContext;
  beforeAll(async () => {
    t = await createTestContext();
  });
  afterAll(async () => {
    await t.close();
  });

  it('writes one EXPIRY entry per expired lot (FIFO-aware, idempotent) and reports balance / expiring soon / history', async () => {
    const u = await t.createUser();
    const ins = (amount: number, reason: string, expires: string | null, key: string | null) =>
      t.adminSql<{ id: number }[]>`INSERT INTO credit_entries (user_id, amount_idr, reason, reference_type, expires_at, idempotency_key, created_at)
                                   VALUES (${u.id}, ${amount}, ${reason}, 'test', ${expires === null ? null : t.adminSql`now() + ${expires}::interval`}, ${key}, now()) RETURNING id`;
    const [old] = await t.adminSql<{ id: number }[]>`
      INSERT INTO credit_entries (user_id, amount_idr, reason, reference_type, expires_at, idempotency_key, created_at)
      VALUES (${u.id}, 25000, 'REFERRAL_REWARD', 'referral', now() - interval '1 day', ${'t-old-' + u.id}, now() - interval '91 days') RETURNING id`;
    await ins(25000, 'REFERRAL_REWARD', '60 days', 't-mid-' + u.id);
    await ins(10000, 'PROMO_CASHBACK', '10 days', 't-soon-' + u.id);
    await ins(-10000, 'CHECKOUT_REDEEM', null, null); // FIFO: consumes the already-expired lot first
    void ins;

    const r1 = await runCreditExpiry(t.deps);
    expect(r1.expiredIdr).toBeGreaterThanOrEqual(15000);
    const exp = await t.adminSql<{ amount_idr: number; idempotency_key: string }[]>`SELECT amount_idr, idempotency_key FROM credit_entries WHERE user_id = ${u.id} AND reason = 'EXPIRY'`;
    expect(exp).toEqual([{ amount_idr: -15000, idempotency_key: `credit-expiry:${old!.id}` }]);
    await runCreditExpiry(t.deps);
    expect(await t.adminSql`SELECT 1 FROM credit_entries WHERE user_id = ${u.id} AND reason = 'EXPIRY'`).toHaveLength(1);

    const res = await t.request('GET', '/v1/credits?limit=2', { token: u.accessToken });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ balanceIdr: 35000, availableIdr: 35000, withdrawable: false });
    expect(res.body.expiringSoon).toMatchObject({ withinDays: 30, totalIdr: 10000 });
    expect(res.body.expiringSoon.lots).toHaveLength(1);
    expect(res.body.history.data).toHaveLength(2);
    expect(res.body.history.data[0]).toMatchObject({ reason: 'EXPIRY', amountIdr: -15000, label: 'Kedaluwarsa' });
    const p2 = await t.request('GET', `/v1/credits?limit=10&cursor=${encodeURIComponent(res.body.history.nextCursor)}`, { token: u.accessToken });
    expect(p2.body.history.data.map((e: { reason: string }) => e.reason)).toEqual(['PROMO_CASHBACK', 'REFERRAL_REWARD', 'REFERRAL_REWARD']);
    expect((await t.request('GET', '/v1/credits')).status).toBe(401);
    const aud = await t.adminSql`SELECT 1 FROM audit_logs WHERE action = 'credit.expired' AND entity_id = ${u.id}`;
    expect(aud).toHaveLength(1);
  });
});
