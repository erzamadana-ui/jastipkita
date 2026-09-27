/**
 * SEC-03 (docs/security/review-2026-09.md): a payment webhook carrying a valid callback token but NOT confirmed by
 * the provider's own API (GET) must not secure funds. Before the fix the re-check only logged a warning and the
 * static token was the sole authority (a leaked token = forged payments).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../helpers';
import { call, createMatchedTx, idem, providerRef, seedFx, setupParties, txStatus } from '../../src/modules/transactions/test-fixtures';

let t: TestContext;
beforeAll(async () => {
  t = await createTestContext();
  await seedFx(t);
});
afterAll(() => t?.close());

async function pendingCheckout() {
  const p = await setupParties(t);
  const tx = await createMatchedTx(t, p);
  const q = await call(t, p.buyer, 'POST', `/v1/transactions/${tx.id}/quote`, { channel: 'QRIS' });
  const co = await call(t, p.buyer, 'POST', `/v1/transactions/${tx.id}/checkout`, { quoteId: q.body.quoteId, acknowledgeRestricted: true }, idem());
  expect(co.status).toBe(201);
  return { p, tx, paymentId: co.body.paymentId as string, amount: co.body.amountIdr as number };
}

/** A well-formed provider callback that the provider itself never sent (session still PENDING at the provider). */
function forged(ref: string, paymentId: string, amount: number, id = `evt_forged_${crypto.randomUUID()}`) {
  return JSON.stringify({ id, event: 'payment.succeeded', data: { id: ref, reference_id: paymentId, status: 'SUCCEEDED', amount, currency: 'IDR', channel: 'QRIS' } });
}

const post = (rawBody: string, token = 'mock-webhook-token') =>
  t.request('POST', '/v1/webhooks/payments/mock', { rawBody, headers: { 'content-type': 'application/json', 'x-callback-token': token } });

async function paymentStatus(id: string) {
  const [r] = await t.adminSql<{ status: string }[]>`SELECT status FROM payments WHERE id = ${id}`;
  return r!.status;
}

describe('SEC-03 payment webhooks are confirmed with the provider before funds are secured', () => {
  it('valid token + provider still PENDING → 5xx, nothing secured, provider retry later succeeds', async () => {
    const { tx, paymentId, amount } = await pendingCheckout();
    const ref = await providerRef(t, paymentId);
    const eventId = `evt_forged_${crypto.randomUUID()}`;
    const res = await post(forged(ref, paymentId, amount, eventId));
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('WEBHOOK_PROCESSING_FAILED');
    expect(await paymentStatus(paymentId)).toBe('PENDING');
    expect(await txStatus(t, tx.id)).toBe('AWAITING_PAYMENT');
    const [j] = await t.adminSql<{ n: number }[]>`SELECT count(*)::int AS n FROM ledger_journals WHERE idempotency_key = ${`capture:${paymentId}`}`;
    expect(j!.n).toBe(0);
    const [inbox] = await t.adminSql<{ processed_at: Date | null; processing_error: string | null }[]>`
      SELECT processed_at, processing_error FROM payment_webhook_events WHERE event_id = ${eventId}`;
    expect(inbox!.processed_at).toBeNull(); // stays retryable
    expect(inbox!.processing_error).toContain('mengonfirmasi');

    // the provider really completes the payment and retries the SAME event id → processed
    const legit = t.payment.buildPaymentWebhook(ref, 'SUCCEEDED');
    const retried = JSON.stringify({ ...JSON.parse(legit), id: eventId });
    const ok = await post(retried);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.outcome).toBe('SECURED');
    expect(await paymentStatus(paymentId)).toBe('SECURED');
  });

  it('provider re-check unavailable → fail closed (5xx, retried later), never secured on the token alone', async () => {
    const { paymentId, amount } = await pendingCheckout();
    const ref = await providerRef(t, paymentId);
    const session = t.payment.sessions.get(ref)!;
    t.payment.sessions.delete(ref); // provider GET now throws
    const res = await post(forged(ref, paymentId, amount));
    expect(res.status).toBe(500);
    expect(await paymentStatus(paymentId)).toBe('PENDING');
    t.payment.sessions.set(ref, session);
  });

  it('wrong / missing / prefix-of token → 401 and the event is not stored', async () => {
    const { paymentId, amount } = await pendingCheckout();
    const ref = await providerRef(t, paymentId);
    for (const token of ['nope', 'mock-webhook-toke', 'mock-webhook-token-x', '']) {
      const eventId = `evt_bad_${crypto.randomUUID()}`;
      const r = await post(forged(ref, paymentId, amount, eventId), token);
      expect(r.status, token).toBe(401);
      const rows = await t.adminSql`SELECT 1 FROM payment_webhook_events WHERE event_id = ${eventId}`;
      expect(rows).toHaveLength(0);
    }
  });

  it('amount tampering in a provider-confirmed callback → AMOUNT_MISMATCH hold, no capture', async () => {
    const { paymentId } = await pendingCheckout();
    const ref = await providerRef(t, paymentId);
    const body = t.payment.buildPaymentWebhook(ref, 'SUCCEEDED', { amount: 1000 });
    // a callback amount that differs from ours is held for risk review even when the provider confirms the session
    const res = await post(body);
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('AMOUNT_MISMATCH');
    expect(await paymentStatus(paymentId)).toBe('PENDING');
    const [hold] = await t.adminSql<{ payout_hold_reason: string | null }[]>`
      SELECT t.payout_hold_reason FROM transactions t JOIN payments p ON p.transaction_id = t.id WHERE p.id = ${paymentId}`;
    expect(hold!.payout_hold_reason).toBe('PAYMENT_AMOUNT_MISMATCH');
    // a provider-side amount that differs from ours is held
    const other = await pendingCheckout();
    const ref2 = await providerRef(t, other.paymentId);
    t.payment.sessions.get(ref2)!.input.amountIdr = other.amount - 1;
    const res2 = await post(t.payment.buildPaymentWebhook(ref2, 'SUCCEEDED'));
    expect(res2.body.outcome).toBe('AMOUNT_MISMATCH');
    expect(await paymentStatus(other.paymentId)).toBe('PENDING');
  });
});
