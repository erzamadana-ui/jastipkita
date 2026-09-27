import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../../../../test/helpers';
import { createTransaction } from '../../notifications/testing/fixtures';
import { type Admin, as, auditRows, createAdmin, idem } from '../test-support';

let t: TestContext;
let mkA: Admin;
let mkB: Admin;
let mkNoMfa: Admin;
let risk: Admin;
let support: Admin;

beforeAll(async () => {
  t = await createTestContext();
  mkA = await createAdmin(t, ['MARKETING']);
  mkB = await createAdmin(t, ['MARKETING']);
  mkNoMfa = await createAdmin(t, ['MARKETING'], { mfa: false });
  risk = await createAdmin(t, ['RISK']);
  support = await createAdmin(t, ['SUPPORT']);
});
afterAll(async () => {
  await t.close();
});

describe('promotions', () => {
  it('create DRAFT → creator cannot activate → another marketer (MFA) activates → pause → edit → end', async () => {
    const body = {
      code: 'MUDIK10',
      name: 'Diskon mudik 10%',
      type: 'PROMO_CODE',
      conditions: { minItemValueIdr: 500_000, firstTransactionOnly: false },
      benefit: { kind: 'PERCENT', rateBps: 1000, capIdr: 100_000, base: 'PLATFORM_FEE' },
      budgetTotalIdr: 5_000_000,
      usageLimitPerUser: 1,
      startsAt: new Date(t.clock.now().getTime() - 3600_000).toISOString(),
      endsAt: new Date(t.clock.now().getTime() + 30 * 86400_000).toISOString(),
    };
    expect((await as(t, support, 'POST', '/v1/admin/promotions', body)).status).toBe(403);
    const c = await as(t, mkA, 'POST', '/v1/admin/promotions', body);
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    expect(c.body).toMatchObject({ status: 'DRAFT', code: 'MUDIK10', benefit: { kind: 'PERCENT', rateBps: 1000 }, conditions: { minItemValueIdr: 500_000 } });
    const id = c.body.id;
    const self = await as(t, mkA, 'POST', `/v1/admin/promotions/${id}/activate`);
    expect(self.body.error.code).toBe('MAKER_CHECKER_VIOLATION');
    expect((await as(t, mkNoMfa, 'POST', `/v1/admin/promotions/${id}/activate`)).body.error.code).toBe('MFA_REQUIRED');
    const act = await as(t, mkB, 'POST', `/v1/admin/promotions/${id}/activate`);
    expect(act.status, JSON.stringify(act.body)).toBe(200);
    expect(act.body.status).toBe('ACTIVE');
    const locked = await as(t, mkA, 'PATCH', `/v1/admin/promotions/${id}`, { name: 'Diskon mudik 12%' });
    expect(locked.body.error.code).toBe('PROMOTION_ACTIVE');
    await as(t, mkA, 'POST', `/v1/admin/promotions/${id}/pause`, { reason: 'Evaluasi budget' });
    const edit = await as(t, mkA, 'PATCH', `/v1/admin/promotions/${id}`, { name: 'Diskon mudik 12%', benefit: { kind: 'PERCENT', rateBps: 1200, capIdr: 100_000, base: 'PLATFORM_FEE' } });
    expect(edit.status, JSON.stringify(edit.body)).toBe(200);
    expect(edit.body).toMatchObject({ name: 'Diskon mudik 12%', status: 'PAUSED', benefit: { rateBps: 1200 } });
    const end = await as(t, mkB, 'POST', `/v1/admin/promotions/${id}/end`, { reason: 'Kampanye selesai' });
    expect(end.body.status).toBe('ENDED');
    const [row] = await t.adminSql<{ created_by: string; approved_by: string }[]>`SELECT created_by, approved_by FROM promotions WHERE id = ${id}`;
    expect(row).toEqual({ created_by: mkA.id, approved_by: mkB.id });
    expect((await auditRows(t, 'promotions.activated', id))[0]!.meta).toMatchObject({ makerId: mkA.id });
  });

  it('invalid benefit shapes are rejected', async () => {
    const bad = await as(t, mkA, 'POST', '/v1/admin/promotions', { name: 'Salah', type: 'CAMPAIGN', benefit: { kind: 'PERCENT' }, startsAt: new Date().toISOString() });
    expect(bad.status).toBe(400);
  });
});

describe('referrals', () => {
  async function referral(status: 'PENDING' | 'QUALIFIED') {
    const referrer = await t.createUser({ kycLevel: 2 });
    const referee = await t.createUser({ kycLevel: 2 });
    let txId: string | null = null;
    if (status === 'QUALIFIED') {
      const traveler = await t.createUser({ kycLevel: 4, mode: 'TRAVELER' });
      txId = (await createTransaction(t, { buyerId: referee.id, travelerId: traveler.id, to: 'COMPLETED' })).id;
    }
    const [r] = await t.adminSql<{ id: string }[]>`
      INSERT INTO referrals (referrer_id, referee_id, program, status, qualifying_transaction_id, referrer_reward_idr, referee_reward_idr, qualified_at, expires_at)
      VALUES (${referrer.id}, ${referee.id}, 'BUYER', ${status}, ${txId}, 50000, 25000, ${status === 'QUALIFIED' ? t.clock.now() : null}, now() + interval '30 days')
      RETURNING id`;
    return { id: r!.id, referrer, referee };
  }

  it('stats expose definitions + data-quality; list masks names', async () => {
    await referral('PENDING');
    const s = await as(t, mkA, 'GET', '/v1/admin/referrals/stats');
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    for (const m of Object.values<any>(s.body.metrics)) {
      expect(m.definition).toBeTruthy();
      expect(m).toHaveProperty('dataQuality');
    }
    const l = await as(t, mkA, 'GET', '/v1/admin/referrals?status=PENDING');
    expect(l.body.data.length).toBeGreaterThan(0);
    expect(l.body.data[0].referrer.displayName).toMatch(/^User [A-Z0-9]\.$/);
    expect(s.body.guardrail).toHaveProperty('allowIncrease');
    expect((await as(t, support, 'GET', '/v1/admin/referrals')).status).toBe(403);
  });

  it('reject a suspicious PENDING referral; hold is only for QUALIFIED', async () => {
    const r = await referral('PENDING');
    const hold = await as(t, mkA, 'POST', `/v1/admin/referrals/${r.id}/hold`, { reason: 'Perangkat sama dengan pengundang' });
    expect(hold.body.error.code).toBe('REFERRAL_NOT_QUALIFIED');
    const rej = await as(t, mkA, 'POST', `/v1/admin/referrals/${r.id}/reject`, { reason: 'Perangkat sama dengan pengundang' });
    expect(rej.body.status).toBe('REJECTED');
    expect(await auditRows(t, 'referrals.rejected', r.id)).toHaveLength(1);
  });

  it('hold QUALIFIED → REFERRAL risk review; release blocked until RISK clears → REWARDED + credits + referral.rewarded', async () => {
    const r = await referral('QUALIFIED');
    const hold = await as(t, mkA, 'POST', `/v1/admin/referrals/${r.id}/hold`, { reason: 'Pola transaksi mirip farming' });
    expect(hold.status, JSON.stringify(hold.body)).toBe(200);
    const [review] = await t.adminSql<{ id: string }[]>`SELECT id FROM risk_reviews WHERE subject_type = 'REFERRAL' AND subject_id = ${r.id} AND status = 'OPEN'`;
    expect(review).toBeDefined();
    const blocked = await as(t, mkA, 'POST', `/v1/admin/referrals/${r.id}/release`, { note: 'Sudah dicek' }, idem());
    expect(blocked.body.error.code).toBe('RISK_REVIEW_OPEN');
    const cleared = await as(t, risk, 'POST', `/v1/admin/risk/reviews/${review!.id}/resolve`, { outcome: 'CLEARED', notes: 'Transaksi wajar, pengguna berbeda' });
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
    expect(cleared.body.userIds ?? cleared.body.userId).toBeTruthy();
    expect((await as(t, mkA, 'POST', `/v1/admin/referrals/${r.id}/release`, { note: 'Sudah dicek' })).status).toBe(400);
    const key = idem();
    const rel = await as(t, mkA, 'POST', `/v1/admin/referrals/${r.id}/release`, { note: 'Sudah dicek tim risk' }, key);
    expect(rel.status, JSON.stringify(rel.body)).toBe(200);
    expect(rel.body.status).toBe('REWARDED');
    expect(rel.body.granted.map((g: any) => [g.role, g.amountIdr])).toEqual([['REFERRER', 50000], ['REFEREE', 25000]]);
    const again = await as(t, mkA, 'POST', `/v1/admin/referrals/${r.id}/release`, { note: 'Sudah dicek tim risk' }, key);
    expect(again.status).toBe(200); // idempotent replay
    const credits = await t.adminSql<{ user_id: string; amount_idr: string }[]>`SELECT user_id, amount_idr::text FROM credit_entries WHERE reference_id = ${r.id} ORDER BY amount_idr DESC`;
    expect(credits.map((c) => [c.user_id, Number(c.amount_idr)])).toEqual([[r.referrer.id, 50000], [r.referee.id, 25000]]);
    const ev = await t.adminSql`SELECT 1 FROM outbox_events WHERE event_type = 'referral.rewarded' AND aggregate_id = ${r.id}`;
    expect(ev).toHaveLength(2);
  });
});
