import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../../../test/helpers';
import { expireDuePayments } from '../payments/service';
import { pollPendingPayments, runDailyReconciliation } from '../reconciliation/service';
import { call, createMatchedTx, idem, payViaWebhook, providerRef, seedFx, setupParties, txLedger, txStatus, type Parties } from '../transactions/test-fixtures';

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

async function checkoutTx(channel = 'QRIS') {
  const tx = await createMatchedTx(t, p);
  const q = await call(t, p.buyer, 'POST', `/v1/transactions/${tx.id}/quote`, { channel });
  const co = await call(t, p.buyer, 'POST', `/v1/transactions/${tx.id}/checkout`, { quoteId: q.body.quoteId }, idem());
  return { tx, quote: q.body, paymentId: co.body.paymentId as string };
}

describe('payment webhooks', () => {
  it('bad token → 401, nothing stored, nothing changes', async () => {
    const { tx, paymentId } = await checkoutTx();
    const { res } = await payViaWebhook(t, paymentId, { token: 'forged-token' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('WEBHOOK_UNAUTHORIZED');
    expect(await txStatus(t, tx.id)).toBe('AWAITING_PAYMENT');
    const [pay] = await t.adminSql<{ status: string }[]>`SELECT status FROM payments WHERE id = ${paymentId}`;
    expect(pay!.status).toBe('PENDING');
    const inbox = await t.adminSql`SELECT id FROM payment_webhook_events WHERE payment_id = ${paymentId}`;
    expect(inbox).toHaveLength(0);
    const journals = await t.adminSql`SELECT id FROM ledger_journals WHERE transaction_id = ${tx.id}`;
    expect(journals).toHaveLength(0);
  });

  it('webhook retry: the same event twice is processed once', async () => {
    const { tx, paymentId, quote } = await checkoutTx();
    const ref = await providerRef(t, paymentId);
    const body = t.payment.buildPaymentWebhook(ref, 'SUCCEEDED');
    const send = () =>
      t.request('POST', '/v1/webhooks/payments/mock', { rawBody: body, headers: { 'content-type': 'application/json', 'x-callback-token': 'mock-webhook-token' } });
    const a = await send();
    const b = await send();
    expect(a.body.status).toBe('PROCESSED');
    expect(b.status).toBe(200);
    expect(b.body.status).toBe('DUPLICATE');
    expect(await txStatus(t, tx.id)).toBe('PAYMENT_SECURED');
    const journals = await t.adminSql`SELECT id FROM ledger_journals WHERE transaction_id = ${tx.id} AND kind = 'PAYMENT_CAPTURED'`;
    expect(journals).toHaveLength(1);
    const events = await t.adminSql`SELECT id FROM transaction_events WHERE transaction_id = ${tx.id} AND to_status = 'PAYMENT_SECURED'`;
    expect(events).toHaveLength(1);
    const l = await txLedger(t, tx.id);
    expect(l.PROVIDER_CASH).toBe(-quote.totalIdr);
    // A different notification for the same (already secured) payment is a no-op as well.
    const c = await send().then(() => t.request('POST', '/v1/webhooks/payments/mock', {
      rawBody: t.payment.buildPaymentWebhook(ref, 'SUCCEEDED'),
      headers: { 'content-type': 'application/json', 'x-callback-token': 'mock-webhook-token' },
    }));
    expect(c.body.outcome).toBe('ALREADY_PROCESSED');
    // Out of order: an expiry notification after success changes nothing.
    const d = await t.request('POST', '/v1/webhooks/payments/mock', {
      rawBody: JSON.stringify({ id: 'evt_late_expiry', event: 'payment.expired', data: { id: ref, reference_id: paymentId, status: 'EXPIRED' } }),
      headers: { 'content-type': 'application/json', 'x-callback-token': 'mock-webhook-token' },
    });
    expect(d.body.outcome).toBe('ALREADY_PROCESSED');
    expect(await txStatus(t, tx.id)).toBe('PAYMENT_SECURED');
  });

  it('amount mismatch → no transition, risk assessment HOLD, alert event', async () => {
    const { tx, paymentId, quote } = await checkoutTx();
    const { res } = await payViaWebhook(t, paymentId, { amount: quote.totalIdr - 1000 });
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('AMOUNT_MISMATCH');
    expect(await txStatus(t, tx.id)).toBe('AWAITING_PAYMENT');
    const [pay] = await t.adminSql<{ status: string }[]>`SELECT status FROM payments WHERE id = ${paymentId}`;
    expect(pay!.status).toBe('PENDING');
    const [risk] = await t.adminSql<{ decision: string }[]>`SELECT decision FROM risk_assessments WHERE subject_type = 'PAYMENT' AND subject_id = ${paymentId}`;
    expect(risk!.decision).toBe('HOLD');
    const [review] = await t.adminSql<{ status: string }[]>`SELECT status FROM risk_reviews WHERE subject_id = ${paymentId}`;
    expect(review!.status).toBe('OPEN');
    const [ev] = await t.adminSql`SELECT 1 FROM outbox_events WHERE event_type = 'payment.amount_mismatch' AND aggregate_id = ${paymentId}`;
    expect(ev).toBeTruthy();
    const journals = await t.adminSql`SELECT id FROM ledger_journals WHERE transaction_id = ${tx.id}`;
    expect(journals).toHaveLength(0);
  });

  it('late payment after expiry → recorded SECURED then refunded automatically', async () => {
    const { tx, paymentId, quote } = await checkoutTx();
    t.clock.advance(31 * 60_000);
    const r = await expireDuePayments(t.deps);
    expect(r.expired).toBeGreaterThanOrEqual(1);
    expect(await txStatus(t, tx.id)).toBe('MATCHED');
    const { res } = await payViaWebhook(t, paymentId);
    expect(res.body.outcome).toBe('SECURED_LATE_REFUND');
    expect(await txStatus(t, tx.id)).toBe('MATCHED');
    const [refund] = await t.adminSql<{ status: string; amount_idr: number; reason_code: string }[]>`SELECT status, amount_idr, reason_code FROM refunds WHERE payment_id = ${paymentId}`;
    expect(refund).toMatchObject({ status: 'SUCCEEDED', reason_code: 'LATE_PAYMENT' });
    expect(Number(refund!.amount_idr)).toBe(quote.totalIdr);
    const [pay] = await t.adminSql<{ status: string; refunded_idr: number }[]>`SELECT status, refunded_idr FROM payments WHERE id = ${paymentId}`;
    expect(pay!.status).toBe('REFUNDED');
    const l = await txLedger(t, tx.id);
    expect(l.PROVIDER_CASH ?? 0).toBe(0);
    expect(l.REFUND ?? 0).toBe(0);
    expect(l.PRODUCT_FUND ?? 0).toBe(0);
  });

  it('dev mock-checkout pay route uses the same webhook path (development/test only)', async () => {
    const { tx, paymentId } = await checkoutTx();
    const ref = await providerRef(t, paymentId);
    const res = await t.request('POST', `/v1/dev/mock-checkout/${ref}/pay`);
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('SECURED');
    expect(await txStatus(t, tx.id)).toBe('PAYMENT_SECURED');
    const [inbox] = await t.adminSql`SELECT processed_at FROM payment_webhook_events WHERE payment_id = ${paymentId}`;
    expect(inbox).toBeTruthy();
    const unknown = await t.request('POST', '/v1/webhooks/payments/xendit', { rawBody: '{}', headers: { 'content-type': 'application/json' } });
    expect(unknown.status).toBe(404);
  });

  it('reconciliation: missed webhook recovered by polling; daily run matches captures', async () => {
    const { tx, paymentId } = await checkoutTx();
    await t.payment.simulatePayment(await providerRef(t, paymentId)); // provider paid, webhook lost
    t.clock.advance(20 * 60_000);
    const poll = await pollPendingPayments(t.deps);
    expect(poll.secured).toBe(1);
    expect(await txStatus(t, tx.id)).toBe('PAYMENT_SECURED');
    const run = await runDailyReconciliation(t.deps, { start: new Date(t.clock.now().getTime() - 86400_000), end: new Date(t.clock.now().getTime() + 60_000) });
    expect(run.mismatches).toBe(0);
    expect(run.status).toBe('MATCHED');
    expect(run.payments).toBeGreaterThanOrEqual(2);
    const [row] = await t.adminSql<{ status: string }[]>`SELECT status FROM reconciliation_runs WHERE id = ${run.runId}`;
    expect(row!.status).toBe('MATCHED');
  });
});
