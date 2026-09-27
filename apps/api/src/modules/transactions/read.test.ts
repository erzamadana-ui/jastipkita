import { OpenAPIHono } from '@hono/zod-openapi';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppEnv } from '../../context';
import { registerMoney } from '../money';
import { createTestContext, type TestContext } from '../../../test/helpers';
import { processPaymentEvent, expireDuePayments } from '../payments/service';
import { call, createMatchedTx, idem, quoteAndPay, seedFx, setupParties, txStatus, type Parties } from './test-fixtures';

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

describe('transaction reads', () => {
  it('non-parties get 404; parties get role-specific detail and allowedActions', async () => {
    const tx = await createMatchedTx(t, p);
    const stranger = await t.createUser({ kycLevel: 3 });
    const res = await t.request('GET', `/v1/transactions/${tx.id}`, { token: stranger.accessToken });
    expect(res.status).toBe(404);
    const unauth = await t.request('GET', `/v1/transactions/${tx.id}`);
    expect(unauth.status).toBe(401);
    const b = await call(t, p.buyer, 'GET', `/v1/transactions/${tx.id}`);
    expect(b.status).toBe(200);
    expect(b.body.role).toBe('BUYER');
    expect(b.body.purchaseGate).toBeNull();
    expect(b.body.allowedActions).toEqual(expect.arrayContaining(['QUOTE', 'CANCEL']));
    // public profile: first name + last initial only (never the full name)
    expect(b.body.traveler).toMatchObject({ id: p.traveler.id, displayName: 'Traveler U.', kycLevel: 4 });
    expect(JSON.stringify(b.body.traveler)).not.toMatch(/@|\+62/);
    const tr = await call(t, p.traveler, 'GET', `/v1/transactions/${tx.id}`);
    expect(tr.body.role).toBe('TRAVELER');
    expect(tr.body.purchaseGate.banner).toBe('DO_NOT_PURCHASE');
    expect(tr.body.item.maxBudgetIdr).toBeNull();
    expect(tr.body.allowedActions).not.toContain('QUOTE');
  });

  it('list filters by role and status with cursor pagination', async () => {
    await createMatchedTx(t, p);
    await createMatchedTx(t, p);
    const page1 = await call(t, p.buyer, 'GET', '/v1/transactions?role=buyer&status=MATCHED&limit=2');
    expect(page1.status).toBe(200);
    expect(page1.body.data).toHaveLength(2);
    expect(page1.body.nextCursor).toBeTruthy();
    const page2 = await call(t, p.buyer, 'GET', `/v1/transactions?role=buyer&status=MATCHED&limit=2&cursor=${page1.body.nextCursor}`);
    expect(page2.body.data.length).toBeGreaterThanOrEqual(1);
    expect(page2.body.data.map((x: any) => x.id)).not.toContain(page1.body.data[0].id);
    const asTraveler = await call(t, p.traveler, 'GET', '/v1/transactions?role=buyer');
    expect(asTraveler.body.data).toHaveLength(0);
  });

  it('supplemental payment never paid → back to PAYMENT_SECURED and a no-fault full refund', async () => {
    const tx = await createMatchedTx(t, p, { maxBudgetIdr: 10_000_000 });
    const { quote } = await quoteAndPay(t, p, tx);
    const chk = await call(t, p.traveler, 'POST', `/v1/transactions/${tx.id}/price-check`, { actualUnitPriceMinor: 23000, currency: 'JPY' });
    const ok = await call(t, p.buyer, 'POST', `/v1/transactions/${tx.id}/price-confirmations/${chk.body.priceConfirmation.id}/respond`, { action: 'APPROVE' }, idem());
    expect(ok.body.transactionStatus).toBe('AWAITING_PAYMENT');
    t.clock.advance(2 * 3600_000);
    const r = await expireDuePayments(t.deps);
    expect(r.expired).toBeGreaterThanOrEqual(1);
    const [refund] = await t.adminSql<{ reason_code: string; amount_idr: number }[]>`SELECT reason_code, amount_idr FROM refunds WHERE transaction_id = ${tx.id}`;
    expect(refund!.reason_code).toBe('PRICE_CONFIRMATION_EXPIRED');
    expect(Number(refund!.amount_idr)).toBe(quote.totalIdr);
    expect(await txStatus(t, tx.id)).toBe('REFUNDED');
    const events = await t.adminSql<{ to_status: string }[]>`SELECT to_status FROM transaction_events WHERE transaction_id = ${tx.id} ORDER BY id`;
    expect(events.map((e) => e.to_status).slice(-4)).toEqual(['AWAITING_PAYMENT', 'PAYMENT_SECURED', 'REFUND_PENDING', 'REFUNDED']);
  });

  it('processPaymentEvent ignores unknown payments', async () => {
    const r = await processPaymentEvent(t.deps, { provider: 'MOCK', providerRef: 'nope', status: 'SUCCEEDED', source: 'RECONCILIATION', signatureValid: true });
    expect(r.outcome).toBe('PAYMENT_NOT_FOUND');
  });

  it('OpenAPI documents the money endpoints (money routes only, isolated from other groups)', async () => {
    const app = new OpenAPIHono<AppEnv>();
    app.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' });
    registerMoney(app);
    const doc = app.getOpenAPI31Document({ openapi: '3.1.0', info: { title: 'money', version: 'test' } });
    const paths = Object.keys(doc.paths ?? {});
    for (const path of [
      '/v1/transactions',
      '/v1/transactions/{id}',
      '/v1/transactions/{id}/timeline',
      '/v1/transactions/{id}/quote',
      '/v1/transactions/{id}/checkout',
      '/v1/transactions/{id}/payment',
      '/v1/webhooks/payments/{provider}',
      '/v1/transactions/{id}/price-check',
      '/v1/transactions/{id}/price-confirmations/{pcId}/respond',
      '/v1/transactions/{id}/price-confirmations/{pcId}/clarify',
      '/v1/transactions/{id}/purchase-proof',
      '/v1/transactions/{id}/status',
      '/v1/transactions/{id}/customs-declaration',
      '/v1/transactions/{id}/delivery',
      '/v1/transactions/{id}/delivery/pin',
      '/v1/transactions/{id}/delivery/verify',
      '/v1/transactions/{id}/delivery/shipped',
      '/v1/transactions/{id}/delivery/delivered',
      '/v1/transactions/{id}/confirm-receipt',
      '/v1/transactions/{id}/cancel',
      '/v1/transactions/{id}/refunds',
      '/v1/refunds/{id}/destination',
      '/v1/payouts/mine',
    ]) {
      expect(paths, path).toContain(path);
    }
  });
});
