/**
 * Product brief — mandatory test scenarios, end to end through HTTP (module-level versions are referenced in
 * docs/checklists/test-scenarios.md). Scenario "fraudulent referral" lives in j7-referral.test.ts; traveler
 * cancellation after payment also in j5-traveler-cancel.test.ts; price change approve/reject in j2-j3-price-change.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../helpers';
import {
  type Actor,
  api,
  buyerL2,
  emailTemplates,
  extraTrip,
  HELD,
  idem,
  line,
  matchedDeal,
  meetupHandover,
  ok,
  providerPays,
  providerRefOf,
  purchase,
  securedDeal,
  sendWebhook,
  tag,
  tick,
  travelToHandover,
  txLedger,
  txStatus,
  unbalancedJournals,
  world,
  type World,
} from './support';

let t: TestContext;
let w: World;

beforeAll(async () => {
  t = await createTestContext();
  w = await world(t);
});
afterAll(async () => {
  await t.close();
});

const count = async (q: PromiseLike<ArrayLike<unknown>>) => (await q).length;

describe('mandatory scenario: payment duplicate', () => {
  it('same Idempotency-Key replays; another key while pending → 409; concurrent double-submit → one payment; duplicate provider notifications → one capture', async () => {
    const d = await matchedDeal(t, w);
    const q = await ok(api(t, d.buyer, 'POST', `/v1/transactions/${d.tx.id}/quote`, { channel: 'QRIS' }), 201);
    // two devices submit at the same time with different keys
    const [a, b] = await Promise.all([
      api(t, d.buyer, 'POST', `/v1/transactions/${d.tx.id}/checkout`, { quoteId: q.quoteId }, idem()),
      api(t, d.buyer, 'POST', `/v1/transactions/${d.tx.id}/checkout`, { quoteId: q.quoteId }, idem()),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const first = a.status === 201 ? a : b;
    const loser = a.status === 201 ? b : a;
    expect(['PAYMENT_ALREADY_PENDING', 'QUOTE_NOT_ACTIVE', 'TRANSACTION_VERSION_CONFLICT', 'CONFLICT']).toContain(loser.body.error.code);
    expect(await count(t.adminSql`SELECT id FROM payments WHERE transaction_id = ${d.tx.id}`)).toBe(1);
    // replay with the original key
    const key = idem();
    const again = await api(t, d.buyer, 'POST', `/v1/transactions/${d.tx.id}/checkout`, { quoteId: q.quoteId }, key);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('PAYMENT_ALREADY_PENDING');
    const pay = await ok(api(t, d.buyer, 'GET', `/v1/transactions/${d.tx.id}/payment`));
    expect(pay.data).toHaveLength(1);
    expect(pay.current.id ?? pay.current.paymentId).toBe(first.body.paymentId);

    // the provider notifies twice (two distinct event ids for the same payment) and once more with the first event id
    const ref = await providerRefOf(t, first.body.paymentId);
    const ev1 = t.payment.buildPaymentWebhook(ref, 'SUCCEEDED');
    const ev2 = t.payment.buildPaymentWebhook(ref, 'SUCCEEDED');
    const r1 = await sendWebhook(t, ev1);
    const r2 = await sendWebhook(t, ev2);
    const r3 = await sendWebhook(t, ev1);
    expect(r1.body).toMatchObject({ status: 'PROCESSED', outcome: 'SECURED' });
    expect(r2.body.outcome).toBe('ALREADY_PROCESSED');
    expect(r3.body.status).toBe('DUPLICATE');
    expect(await count(t.adminSql`SELECT id FROM ledger_journals WHERE transaction_id = ${d.tx.id} AND kind = 'PAYMENT_CAPTURED'`)).toBe(1);
    expect(await count(t.adminSql`SELECT id FROM transaction_events WHERE transaction_id = ${d.tx.id} AND to_status = 'PAYMENT_SECURED'`)).toBe(1);
    expect(-(await txLedger(t, d.tx.id)).PROVIDER_CASH!).toBe(q.totalIdr);
  });

  it('payment security gate: forged signature → 401 (nothing stored); amount mismatch → no transition, HOLD review, payout hold', async () => {
    const d = await matchedDeal(t, w);
    const q = await ok(api(t, d.buyer, 'POST', `/v1/transactions/${d.tx.id}/quote`, { channel: 'QRIS' }), 201);
    const co = await ok(api(t, d.buyer, 'POST', `/v1/transactions/${d.tx.id}/checkout`, { quoteId: q.quoteId }, idem()), 201);
    const ref = await providerRefOf(t, co.paymentId);
    const forged = await sendWebhook(t, t.payment.buildPaymentWebhook(ref, 'SUCCEEDED'), 'forged-token');
    expect(forged.status).toBe(401);
    expect(await count(t.adminSql`SELECT id FROM payment_webhook_events WHERE payment_id = ${co.paymentId}`)).toBe(0);
    const short = await sendWebhook(t, t.payment.buildPaymentWebhook(ref, 'SUCCEEDED', { amount: q.totalIdr - 1000 }));
    expect(short.status).toBe(200);
    expect(await txStatus(t, d.tx.id)).toBe('AWAITING_PAYMENT');
    const [ra] = await t.adminSql<{ decision: string }[]>`SELECT decision FROM risk_assessments WHERE subject_id = ${co.paymentId} OR subject_id = ${d.tx.id} ORDER BY created_at DESC LIMIT 1`;
    expect(ra!.decision).toBe('HOLD');
    expect(await count(t.adminSql`SELECT 1 FROM outbox_events WHERE event_type = 'payment.amount_mismatch' AND payload->>'paymentId' = ${co.paymentId}`)).toBe(1);
    const tv = await ok(api(t, w.traveler, 'GET', `/v1/transactions/${d.tx.id}`));
    expect(tv.purchaseGate.banner).toBe('DO_NOT_PURCHASE');
  });
});

describe('mandatory scenario: webhook retry', () => {
  it('provider re-verification fails once → 500 (provider retries) → the retried delivery secures the payment exactly once', async () => {
    const d = await matchedDeal(t, w);
    const q = await ok(api(t, d.buyer, 'POST', `/v1/transactions/${d.tx.id}/quote`, { channel: 'QRIS' }), 201);
    const co = await ok(api(t, d.buyer, 'POST', `/v1/transactions/${d.tx.id}/checkout`, { quoteId: q.quoteId }, idem()), 201);
    const ref = await providerRefOf(t, co.paymentId);
    const body = t.payment.buildPaymentWebhook(ref, 'SUCCEEDED');
    const original = t.payment.getPayment.bind(t.payment);
    let calls = 0;
    t.payment.getPayment = (async (r: string) => {
      calls++;
      if (calls === 1) throw new Error('ETIMEDOUT provider GET /sessions');
      return original(r);
    }) as typeof t.payment.getPayment;
    try {
      const first = await sendWebhook(t, body);
      expect(first.status).toBe(500);
      expect(await txStatus(t, d.tx.id)).toBe('AWAITING_PAYMENT');
      expect(await count(t.adminSql`SELECT id FROM ledger_journals WHERE transaction_id = ${d.tx.id}`)).toBe(0);
      const retry = await sendWebhook(t, body);
      expect(retry.status).toBe(200);
      expect(retry.body).toMatchObject({ status: 'PROCESSED', outcome: 'SECURED' });
      const dup = await sendWebhook(t, body);
      expect(dup.body.status).toBe('DUPLICATE');
    } finally {
      t.payment.getPayment = original;
    }
    // a burst of the same delivery in parallel changes nothing
    const burst = await Promise.all(Array.from({ length: 5 }, () => sendWebhook(t, body)));
    for (const r of burst) expect(r.status).toBe(200);
    expect(await txStatus(t, d.tx.id)).toBe('PAYMENT_SECURED');
    expect(await count(t.adminSql`SELECT id FROM ledger_journals WHERE transaction_id = ${d.tx.id} AND kind = 'PAYMENT_CAPTURED'`)).toBe(1);
  });
});

describe('mandatory scenario: traveler cancellation', () => {
  it('after PURCHASED the traveler cannot cancel (use the Dispute Center)', async () => {
    const d = await securedDeal(t, w);
    await purchase(t, w.traveler, d.tx.id, 6000);
    const prev = await ok(api(t, w.traveler, 'GET', `/v1/transactions/${d.tx.id}/cancel/preview`));
    expect(prev.canCancel).toBe(false);
    const r = await api(t, w.traveler, 'POST', `/v1/transactions/${d.tx.id}/cancel`, { reason: 'Barang sudah dibeli tapi saya batal' }, idem());
    expect(r.status).toBe(422);
    expect(['CANCELLATION_NOT_ALLOWED', 'ADMIN_APPROVAL_REQUIRED']).toContain(r.body.error.code);
    expect(await txStatus(t, d.tx.id)).toBe('PURCHASED');
  });

  // BUG (high, money stuck): POST /v1/trips/{id}/cancel is allowed while the trip has a PAID transaction. trips/service.ts
  // cancelTrip() only emits `trip.cancelled {openTransactionIds}` "for the money group", but NO outbox consumer subscribes
  // to `trip.cancelled` (src/jobs/*.ts), so the transaction stays PAYMENT_SECURED on a CANCELLED trip forever: no refund,
  // no buyer notification, no traveler penalty, escrow never released. Expected (docs/api/marketplace.md §7, domain §3):
  // the cancellation matrix is applied (traveler cancels AFTER_PAYMENT → full refund incl. payment fee, penalty 5).
  let tripCancel: { txId: string; buyer: Actor; total: number };
  it('setup for the trip-cancel BUG: traveler cancels a trip that has a paid transaction (API accepts it)', async () => {
    const trip = await extraTrip(t, w);
    const d = await securedDeal(t, w, { tripId: trip.id });
    const c = await ok(api(t, w.traveler, 'POST', `/v1/trips/${trip.id}/cancel`, { reason: 'Penerbangan dibatalkan' }));
    expect(c.status).toBe('CANCELLED');
    const [ev] = await t.adminSql<{ payload: { openTransactionIds: string[] } }[]>`SELECT payload FROM outbox_events WHERE event_type = 'trip.cancelled' AND aggregate_id = ${trip.id}`;
    expect(ev!.payload.openTransactionIds).toEqual([d.tx.id]);
    await tick(t, 5);
    tripCancel = { txId: d.tx.id, buyer: d.buyer, total: d.quote.totalIdr };
  });
  it.fails('BUG: a paid transaction on a cancelled trip is never refunded (no consumer for trip.cancelled)', async () => {
    expect(await txStatus(t, tripCancel.txId)).toBe('REFUNDED'); // actual: PAYMENT_SECURED
  });

  // Same root cause, worse effect: a MATCHED (unpaid) transaction of a cancelled trip stays MATCHED, and quote/checkout do
  // not check the trip status — the buyer can still pay (→ PAYMENT_SECURED) for a trip that no longer exists.
  let matchedOnCancelled: { buyer: Actor; txId: string };
  it('setup for the pay-after-trip-cancel BUG: trip cancelled while its transaction is MATCHED', async () => {
    const trip = await extraTrip(t, w);
    const d = await matchedDeal(t, w, { tripId: trip.id });
    await ok(api(t, w.traveler, 'POST', `/v1/trips/${trip.id}/cancel`, { reason: 'Tidak jadi berangkat' }));
    await tick(t, 5);
    matchedOnCancelled = { buyer: d.buyer, txId: d.tx.id };
  });
  it.fails('BUG: buyer can still quote, check out and pay a transaction whose trip is CANCELLED', async () => {
    const { buyer, txId } = matchedOnCancelled;
    const q = await api(t, buyer, 'POST', `/v1/transactions/${txId}/quote`, { channel: 'QRIS' });
    expect(q.status).toBe(422); // actual: 201 — and checkout 201, webhook → PAYMENT_SECURED
  });
});

describe('mandatory scenario: refund (VA channel → bank disbursement)', () => {
  let refundCase: { txId: string; buyer: Actor; total: number; refundId: string };
  it('VA cannot be refunded by the provider → buyer adds a destination → worker disburses → REFUNDED, escrow empty', async () => {
    const d = await securedDeal(t, w, { channel: 'VA' });
    const res = await ok(api(t, w.traveler, 'POST', `/v1/transactions/${d.tx.id}/cancel`, { reason: 'Jadwal berubah' }, idem()));
    expect(res.status).toBe('REFUND_PENDING');
    const list = await ok(api(t, d.buyer, 'GET', `/v1/transactions/${d.tx.id}/refunds`));
    expect(list.data[0]).toMatchObject({ destinationRequired: true, method: 'PAYOUT_TO_BUYER' });
    refundCase = { txId: d.tx.id, buyer: d.buyer, total: d.quote.totalIdr, refundId: list.data[0].id };
    await tick(t, 3);
    expect(await txStatus(t, d.tx.id)).toBe('REFUND_PENDING'); // waits for the destination
    const dest = await ok(api(t, d.buyer, 'POST', `/v1/refunds/${list.data[0].id}/destination`, { bankCode: 'BCA', accountNumber: '8800112233', accountHolderName: 'Penitip E2E' }));
    expect(dest.accountMask).toBe('****2233');
    await tick(t, 3); // money.process_refunds (2 min)
    expect(await txStatus(t, d.tx.id)).toBe('REFUNDED');
    expect(t.payment.payouts.find((p) => p.accountNumber === '8800112233')?.amountIdr).toBe(d.quote.totalIdr);
    const l = await txLedger(t, d.tx.id);
    for (const b of ['PRODUCT_FUND', 'CUSTOMS_RESERVE', 'CLEARING', 'REFUND', 'PROVIDER_CASH']) expect(l[b] ?? 0, b).toBe(0);
    expect(emailTemplates(t, d.buyer.email)).toEqual(expect.arrayContaining([tag('refund.requested'), tag('refund.succeeded')]));
  });

  // BUG (medium): for VA/retail payments the refund needs a buyer bank account (`refund.destination_required` is emitted,
  // docs/api/money.md §3 names engagement as its consumer), but no outbox consumer/template exists for it. The only message
  // the buyer gets is `refund.requested`, which says the money goes back "ke metode pembayaran asal" — wrong for VA — so
  // the refund silently waits for a destination the buyer was never asked for. Expected: a notification/e-mail asking the
  // buyer to add a bank account (critical PAYMENT group).
  it.fails('BUG: the buyer is never asked for a refund bank account (refund.destination_required has no consumer)', async () => {
    const notes = await t.adminSql<{ event_type: string }[]>`SELECT event_type FROM notifications WHERE user_id = ${refundCase.buyer.id}`;
    expect(notes.map((n) => n.event_type)).toContain('refund.destination_required'); // actual: only refund.requested ("ke metode pembayaran asal")
  });
});

describe('mandatory scenario: dispute', () => {
  it('ITEM_NOT_RECEIVED opened while TRAVELING → no auto-confirm/payout → admin REFUND_FULL → REFUNDED, escrow empty, no payout', async () => {
    const trip = await extraTrip(t, w);
    const d = await securedDeal(t, w, { tripId: trip.id });
    await purchase(t, w.traveler, d.tx.id, 6000);
    await ok(api(t, w.traveler, 'POST', `/v1/trips/${trip.id}/depart`));
    await ok(api(t, w.traveler, 'POST', `/v1/transactions/${d.tx.id}/status`, { to: 'TRAVELING' }));
    const dsp = await ok(api(t, d.buyer, 'POST', `/v1/transactions/${d.tx.id}/disputes`, { type: 'ITEM_NOT_RECEIVED', description: 'Traveler tidak bisa dihubungi sejak berangkat', requestedResolution: 'REFUND_FULL' }), 201);
    expect(dsp.transactionStatus).toBe('DISPUTED');
    const blocked = await api(t, w.traveler, 'POST', `/v1/transactions/${d.tx.id}/status`, { to: 'ARRIVED' });
    expect(blocked.status).toBe(422);
    await ok(api(t, w.admin, 'POST', `/v1/admin/disputes/${dsp.id}/review`, { closeEvidenceWindow: true, note: 'Traveler tidak merespons' }));
    const res = await ok(api(t, w.admin, 'POST', `/v1/admin/disputes/${dsp.id}/resolve`, { resolution: 'REFUND_FULL', note: 'Barang tidak diterima' }, idem()));
    expect(res).toMatchObject({ transactionStatus: 'REFUNDED', resolutionAmountIdr: d.quote.totalIdr });
    const l = await txLedger(t, d.tx.id);
    for (const b of HELD) expect(l[b] ?? 0, b).toBe(0);
    expect(await count(t.adminSql`SELECT id FROM payouts WHERE transaction_id = ${d.tx.id}`)).toBe(0);
    expect(await unbalancedJournals(t)).toBe(0);
  });
});

describe('mandatory scenario: FX expiration', () => {
  it('checkout after the FX lock expired → 422 FX_LOCK_EXPIRED → re-quote (new lock) → checkout OK; invoice expiry → MATCHED; a late payment is auto-refunded', async () => {
    const d = await matchedDeal(t, w);
    const q1 = await ok(api(t, d.buyer, 'POST', `/v1/transactions/${d.tx.id}/quote`, { channel: 'QRIS' }), 201);
    t.clock.set(new Date(new Date(q1.fx.expiresAt).getTime() + 1000));
    const late = await api(t, d.buyer, 'POST', `/v1/transactions/${d.tx.id}/checkout`, { quoteId: q1.quoteId }, idem());
    expect(late.status).toBe(422);
    expect(['FX_LOCK_EXPIRED', 'QUOTE_EXPIRED']).toContain(late.body.error.code);
    expect(await txStatus(t, d.tx.id)).toBe('MATCHED');
    const q2 = await ok(api(t, d.buyer, 'POST', `/v1/transactions/${d.tx.id}/quote`, { channel: 'QRIS' }), 201);
    expect(q2.quoteId).not.toBe(q1.quoteId);
    expect(new Date(q2.fx.lockedAt).getTime()).toBeGreaterThan(new Date(q1.fx.lockedAt).getTime());
    const co = await ok(api(t, d.buyer, 'POST', `/v1/transactions/${d.tx.id}/checkout`, { quoteId: q2.quoteId }, idem()), 201);
    expect(await txStatus(t, d.tx.id)).toBe('AWAITING_PAYMENT');
    // the buyer walks away: the invoice expires → back to MATCHED (needs a new quote)
    t.clock.set(new Date(new Date(co.expiresAt).getTime() + 61_000));
    await t.drain();
    expect(await txStatus(t, d.tx.id)).toBe('MATCHED');
    const [p] = await t.adminSql<{ status: string }[]>`SELECT status FROM payments WHERE id = ${co.paymentId}`;
    expect(p!.status).toBe('EXPIRED');
    // …and then pays the expired invoice anyway: recorded + refunded automatically (LATE_PAYMENT)
    const { res } = await providerPays(t, co.paymentId);
    expect(res.status).toBe(200);
    await tick(t, 3);
    const [rf] = await t.adminSql<{ reason_code: string; status: string; amount_idr: number }[]>`SELECT reason_code, status, amount_idr FROM refunds WHERE payment_id = ${co.paymentId}`;
    expect(rf).toMatchObject({ reason_code: 'LATE_PAYMENT', status: 'SUCCEEDED' });
    expect(Number(rf!.amount_idr)).toBe(q2.totalIdr);
    expect(await txStatus(t, d.tx.id)).toBe('MATCHED');
    expect((await txLedger(t, d.tx.id)).PROVIDER_CASH ?? 0).toBe(0);
  });
});

describe('mandatory scenario: price change', () => {
  it('confirmation window expires without an answer → EXPIRED → treated as reject: full refund, no penalty', async () => {
    const d = await securedDeal(t, w);
    const chk = await ok(api(t, w.traveler, 'POST', `/v1/transactions/${d.tx.id}/price-check`, { actualUnitPriceMinor: 7200, currency: 'JPY' }));
    const pc = chk.priceConfirmation;
    await tick(t, 16);
    const late = await api(t, d.buyer, 'POST', `/v1/transactions/${d.tx.id}/price-confirmations/${pc.id}/respond`, { action: 'APPROVE' }, idem());
    expect(late.status).toBe(422);
    expect(['PRICE_CONFIRMATION_EXPIRED', 'PRICE_CONFIRMATION_NOT_OPEN']).toContain(late.body.error.code);
    expect(await txStatus(t, d.tx.id)).toBe('REFUNDED');
    const [rf] = await t.adminSql<{ reason_code: string; amount_idr: number }[]>`SELECT reason_code, amount_idr FROM refunds WHERE transaction_id = ${d.tx.id}`;
    expect(rf!.reason_code).toBe('PRICE_CONFIRMATION_EXPIRED');
    expect(Number(rf!.amount_idr)).toBe(d.quote.totalIdr);
    expect(await count(t.adminSql`SELECT 1 FROM outbox_events WHERE event_type = 'transaction.cancelled_with_penalty' AND aggregate_id = ${d.tx.id}`)).toBe(0);
  });

  // BUG (medium): when the buyer asks for clarification (respond CLARIFY) the service emits
  // `price_confirmation.clarification_requested` (price-confirmation/service.ts) but nothing consumes it — the traveler gets
  // no notification, although the 15-minute window keeps running and CLARIFICATION_REQUESTED → EXPIRED ends in a refund.
  // Expected (docs/api/money.md §3 "engagement (notify traveler)"): the traveler is notified (IN_APP/PUSH at least).
  let clarify: { travelerId: string; txId: string };
  it('setup for the clarification BUG: buyer asks for clarification on a price change', async () => {
    const d = await securedDeal(t, w);
    const chk = await ok(api(t, w.traveler, 'POST', `/v1/transactions/${d.tx.id}/price-check`, { actualUnitPriceMinor: 6900, currency: 'JPY' }));
    const ask = await ok(api(t, d.buyer, 'POST', `/v1/transactions/${d.tx.id}/price-confirmations/${chk.priceConfirmation.id}/respond`, { action: 'CLARIFY', note: 'Kenapa naik? Ada diskon member?' }, idem()));
    expect(ask.priceConfirmation.status).toBe('CLARIFICATION_REQUESTED');
    await t.drain();
    expect(await count(t.adminSql`SELECT 1 FROM outbox_events WHERE event_type = 'price_confirmation.clarification_requested' AND aggregate_id = ${chk.priceConfirmation.id}`)).toBe(1);
    clarify = { travelerId: w.traveler.id, txId: d.tx.id };
  });
  it.fails('BUG: the traveler is not notified of a clarification request (clarification_requested has no consumer)', async () => {
    const notes = await t.adminSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM notifications WHERE user_id = ${clarify.travelerId} AND data->>'transactionId' = ${clarify.txId} AND event_type LIKE 'price%'`;
    expect(notes[0]!.n).toBeGreaterThan(0); // actual: 0
  });
});

describe('mandatory scenario: network loss (retry with the same Idempotency-Key)', () => {
  it('client times out while the provider is slow → retry with the same key gets 409 IN_PROGRESS → later retry replays the original 201; one payment, one provider session', async () => {
    const d = await matchedDeal(t, w);
    const q = await ok(api(t, d.buyer, 'POST', `/v1/transactions/${d.tx.id}/quote`, { channel: 'QRIS' }), 201);
    const original = t.payment.createCheckout.bind(t.payment);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    t.payment.createCheckout = (async (i: Parameters<typeof original>[0]) => {
      await gate;
      return original(i);
    }) as typeof t.payment.createCheckout;
    const key = idem();
    const sessionsBefore = t.payment.sessions.size;
    try {
      const inFlight = api(t, d.buyer, 'POST', `/v1/transactions/${d.tx.id}/checkout`, { quoteId: q.quoteId }, key);
      // the app's 10 s timeout fires; wait until the server holds the key, then retry
      for (let i = 0; i < 100; i++) {
        const [row] = await t.adminSql<{ status: string }[]>`SELECT status FROM idempotency_keys WHERE user_id = ${d.buyer.id} AND key = ${key['idempotency-key']}`;
        if (row?.status === 'IN_PROGRESS') break;
        await new Promise((r) => setTimeout(r, 10));
      }
      const retry = await api(t, d.buyer, 'POST', `/v1/transactions/${d.tx.id}/checkout`, { quoteId: q.quoteId }, key);
      expect(retry.status).toBe(409);
      expect(retry.body.error.code).toBe('IDEMPOTENCY_IN_PROGRESS');
      release();
      const firstRes = await inFlight; // the response the client never saw
      expect(firstRes.status).toBe(201);
      const replay = await api(t, d.buyer, 'POST', `/v1/transactions/${d.tx.id}/checkout`, { quoteId: q.quoteId }, key);
      expect(replay.status).toBe(201);
      expect(replay.headers.get('idempotent-replayed')).toBe('true');
      expect(replay.body.paymentId).toBe(firstRes.body.paymentId);
    } finally {
      t.payment.createCheckout = original;
    }
    expect(t.payment.sessions.size - sessionsBefore).toBe(1);
    expect(await count(t.adminSql`SELECT id FROM payments WHERE transaction_id = ${d.tx.id}`)).toBe(1);
  });

  // BUG (medium): on money routes the rate limiter runs AFTER requireIdempotency (checkout/routes.ts:
  // [requireAuth, requireKycLevel(2), requireIdempotency, rateLimit]); the limiter's 429 is a 4xx, so the idempotency
  // middleware stores it as the COMPLETED response and replays it for 24 h. A client that follows Retry-After and retries
  // with the SAME key — exactly what the network-loss guidance says — gets the cached 429 forever and can never check out
  // with that key. Expected: 429 (and other transient errors) are not persisted (key released), or the limiter runs first.
  let limited: { buyer: Actor; tx2: string; quoteId: string; key: Record<string, string>; firstStatus: number };
  it('setup for the 429-replay BUG: 11th checkout call in a minute is rate limited', async () => {
    const buyer = await buyerL2(t);
    const d1 = await matchedDeal(t, w, { buyer });
    const d2 = await matchedDeal(t, w, { buyer });
    const q1 = await ok(api(t, buyer, 'POST', `/v1/transactions/${d1.tx.id}/quote`, { channel: 'QRIS' }), 201);
    const q2 = await ok(api(t, buyer, 'POST', `/v1/transactions/${d2.tx.id}/quote`, { channel: 'QRIS' }), 201);
    for (let i = 0; i < 10; i++) await api(t, buyer, 'POST', `/v1/transactions/${d1.tx.id}/checkout`, { quoteId: q1.quoteId }, idem());
    const key = idem();
    const r = await api(t, buyer, 'POST', `/v1/transactions/${d2.tx.id}/checkout`, { quoteId: q2.quoteId }, key);
    expect(r.status).toBe(429);
    t.clock.advance(61_000); // Retry-After elapsed; the FX lock (30 min) is still valid
    limited = { buyer, tx2: d2.tx.id, quoteId: q2.quoteId, key, firstStatus: r.status };
  });
  it.fails('BUG: a rate-limited (429) checkout is replayed from the idempotency store after Retry-After', async () => {
    const retry = await api(t, limited.buyer, 'POST', `/v1/transactions/${limited.tx2}/checkout`, { quoteId: limited.quoteId }, limited.key);
    expect(retry.headers.get('idempotent-replayed')).not.toBe('true'); // actual: 'true' with status 429
    expect(retry.status).toBe(201);
  });
});

describe('mandatory scenario: duplicate delivery confirmation', () => {
  it('PIN twice, QR after PIN, confirm-receipt twice (different keys, concurrently) and the auto-confirm job → one transition each, one payout, one release', async () => {
    const trip = await extraTrip(t, w);
    const d = await securedDeal(t, w, { tripId: trip.id });
    await purchase(t, w.traveler, d.tx.id, 6000);
    await travelToHandover(t, w.traveler, d.tx.id, trip.id);
    await ok(api(t, w.traveler, 'POST', `/v1/transactions/${d.tx.id}/delivery`, { method: 'MEETUP', meetupPoint: 'Stasiun Sudirman' }));
    const reveal = await ok(api(t, d.buyer, 'GET', `/v1/transactions/${d.tx.id}/delivery/pin`));
    const [v1, v2] = await Promise.all([
      api(t, w.traveler, 'POST', `/v1/transactions/${d.tx.id}/delivery/verify`, { pin: reveal.pin }),
      api(t, w.traveler, 'POST', `/v1/transactions/${d.tx.id}/delivery/verify`, { pin: reveal.pin }),
    ]);
    expect([v1.status, v2.status]).toEqual([200, 200]);
    expect([v1.body.alreadyConfirmed, v2.body.alreadyConfirmed].sort()).toEqual([false, true]);
    const qr = await api(t, w.traveler, 'POST', `/v1/transactions/${d.tx.id}/delivery/verify`, { qrToken: reveal.qrToken });
    expect(qr.status).toBe(200);
    expect(qr.body.alreadyConfirmed).toBe(true);
    const [c1, c2] = await Promise.all([
      api(t, d.buyer, 'POST', `/v1/transactions/${d.tx.id}/confirm-receipt`, undefined, idem()),
      api(t, d.buyer, 'POST', `/v1/transactions/${d.tx.id}/confirm-receipt`, undefined, idem()),
    ]);
    expect([c1.status, c2.status]).toEqual([200, 200]);
    expect(c1.body.transactionStatus).toBe('COMPLETED');
    expect(c2.body.transactionStatus).toBe('COMPLETED');
    await tick(t, 49 * 60); // auto-confirm window passes too
    for (const to of ['DELIVERED', 'BUYER_CONFIRMED', 'COMPLETED']) {
      expect(await count(t.adminSql`SELECT 1 FROM transaction_events WHERE transaction_id = ${d.tx.id} AND to_status = ${to}`), to).toBe(1);
    }
    expect(await count(t.adminSql`SELECT id FROM payouts WHERE transaction_id = ${d.tx.id}`)).toBe(1);
    expect(await count(t.adminSql`SELECT id FROM ledger_journals WHERE transaction_id = ${d.tx.id} AND kind = 'COMPLETION_RELEASE'`)).toBe(1);
    const [po] = await t.adminSql<{ status: string }[]>`SELECT status FROM payouts WHERE transaction_id = ${d.tx.id}`;
    expect(po!.status).toBe('PAID');
    expect(t.payment.payouts.filter((p) => p.amountIdr > 0 && p.idempotencyKey?.includes('payout:')).length).toBeGreaterThanOrEqual(1);
    const l = await txLedger(t, d.tx.id);
    for (const b of HELD) expect(l[b] ?? 0, b).toBe(0);
    expect(line(d.quote, 'TOTAL')).toBe(d.quote.totalIdr);
  });
});
