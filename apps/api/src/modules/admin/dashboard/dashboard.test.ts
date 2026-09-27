import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../../../../test/helpers';
import { createTransaction } from '../../notifications/testing/fixtures';
import { type Admin, as, createAdmin } from '../test-support';

let t: TestContext;
let analyst: Admin;
let support: Admin;

beforeAll(async () => {
  t = await createTestContext();
  analyst = await createAdmin(t, ['MARKETING']);
  support = await createAdmin(t, ['SUPPORT']);
  const buyer = await t.createUser({ kycLevel: 2 });
  const traveler = await t.createUser({ kycLevel: 4, mode: 'TRAVELER' });
  await createTransaction(t, { buyerId: buyer.id, travelerId: traveler.id, to: 'COMPLETED', itemIdr: 1_000_000 });
  await createTransaction(t, { buyerId: buyer.id, travelerId: traveler.id, to: 'COMPLETED', itemIdr: 2_000_000 });
  await createTransaction(t, { buyerId: buyer.id, travelerId: traveler.id, to: 'PAYMENT_SECURED' });
});
afterAll(async () => {
  await t.close();
});

describe('admin dashboard', () => {
  it('requires analytics.read (SUPPORT → 403) and an admin role (plain user → 403)', async () => {
    const res = await as(t, support, 'GET', '/v1/admin/dashboard/kpis');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PERMISSION_DENIED');
    const user = await t.createUser({ kycLevel: 2 });
    const r2 = await t.request('GET', '/v1/admin/dashboard/kpis', { token: user.accessToken });
    expect(r2.status).toBe(403);
    expect(r2.body.error.code).toBe('ADMIN_ONLY');
    const r3 = await t.request('GET', '/v1/admin/dashboard/kpis');
    expect(r3.status).toBe(401);
  });

  it('KPIs are computed from the DB with a definition and a small-sample dataQuality note', async () => {
    const res = await as(t, analyst, 'GET', '/v1/admin/dashboard/kpis');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const m = Object.fromEntries(res.body.metrics.map((x: any) => [x.key, x]));
    expect(m.gmv.value).toBe(3_000_000);
    expect(m.completedTransactions.value).toBe(2);
    expect(m.gmv.definition).toContain('ITEM_PRICE');
    expect(m.gmv.dataQuality).toContain('Sampel kecil');
    // platform revenue = PROTECTION (1.5%) + PLATFORM (5%) quote lines of the fixture breakdown
    expect(m.platformRevenue.value).toBe(15_000 + 50_000 + 30_000 + 100_000);
    expect(m.takeRate.value).toBeCloseTo(195_000 / 3_000_000, 5);
    expect(m.netRevenue.value).toBe(195_000 - 50_000);
    for (const metric of res.body.metrics) expect(typeof metric.definition).toBe('string');
    const statuses = Object.fromEntries(res.body.breakdowns.transactionsByStatus.map((x: any) => [x.status, x.count]));
    expect(statuses).toMatchObject({ COMPLETED: 2, PAYMENT_SECURED: 1 });
    expect(res.body.systemHealth.integrations.payments).toBe('MOCK');
  });

  it('time series fills zero buckets and funnel reports definitions per step', async () => {
    const ts = await as(t, analyst, 'GET', '/v1/admin/dashboard/timeseries?metric=gmv&interval=day');
    expect(ts.status, JSON.stringify(ts.body)).toBe(200);
    expect(ts.body.points).toHaveLength(30);
    expect(ts.body.points.reduce((s: number, p: any) => s + p.value, 0)).toBe(3_000_000);
    const wk = await as(t, analyst, 'GET', '/v1/admin/dashboard/timeseries?metric=transactions_created&interval=week');
    expect(wk.status).toBe(200);
    expect(wk.body.points.reduce((s: number, p: any) => s + p.value, 0)).toBe(3);
    const fn = await as(t, analyst, 'GET', '/v1/admin/dashboard/funnel');
    expect(fn.status, JSON.stringify(fn.body)).toBe(200);
    expect(fn.body.steps.map((s: any) => s.step)).toEqual(['INSTALL', 'SIGNUP', 'KYC', 'REQUEST', 'MATCH', 'CHECKOUT', 'PAYMENT', 'PURCHASE', 'DELIVERY', 'REPEAT']);
    const byStep = Object.fromEntries(fn.body.steps.map((s: any) => [s.step, s.count]));
    expect(byStep.MATCH).toBe(3);
    expect(byStep.REPEAT).toBe(1);
    const bad = await as(t, analyst, 'GET', '/v1/admin/dashboard/kpis?from=2026-09-10&to=2026-09-01');
    expect(bad.status).toBe(422);
  });
});
