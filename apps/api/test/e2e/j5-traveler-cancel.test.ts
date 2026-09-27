/**
 * J5 — traveler cancels after the buyer paid → full refund incl. payment fee (provider refund), trust penalty recorded
 * against the traveler (event + Trust Score component), capacity released, buyer notified.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../helpers';
import { api, emailTemplates, idem, line, ok, outboxTypes, securedDeal, tag, txLedger, txStatus, world, type World } from './support';

let t: TestContext;
let w: World;

beforeAll(async () => {
  t = await createTestContext();
  w = await world(t);
});
afterAll(async () => {
  await t.close();
});

describe('J5 traveler cancels after payment', () => {
  it('preview == outcome: full refund incl. payment fee, traveler penalty 5, ledger drained, trust penalised', async () => {
    const d = await securedDeal(t, w);
    const tripBefore = (await ok(api(t, w.traveler, 'GET', `/v1/trips/${w.trip.id}`))).trip;
    expect(line(d.quote, 'PAYMENT_FEE')).toBeGreaterThan(0);
    const prev = await ok(api(t, w.traveler, 'GET', `/v1/transactions/${d.tx.id}/cancel/preview`));
    expect(prev).toMatchObject({ allowed: true, stage: 'AFTER_PAYMENT', refundIdr: d.quote.totalIdr, paymentFeeRetainedIdr: 0, trustPenalty: 5, penalizedActor: 'TRAVELER', canCancel: true });
    // the buyer's preview for the same stage differs (payment fee retained) — no side effects either way
    const bprev = await ok(api(t, d.buyer, 'GET', `/v1/transactions/${d.tx.id}/cancel/preview`));
    expect(bprev.paymentFeeRetainedIdr).toBe(line(d.quote, 'PAYMENT_FEE'));
    expect(await txStatus(t, d.tx.id)).toBe('PAYMENT_SECURED');

    const noKey = await api(t, w.traveler, 'POST', `/v1/transactions/${d.tx.id}/cancel`, { reason: 'Penerbangan dibatalkan maskapai' });
    expect(noKey.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const res = await ok(api(t, w.traveler, 'POST', `/v1/transactions/${d.tx.id}/cancel`, { reason: 'Penerbangan dibatalkan maskapai' }, idem()));
    expect(res.status).toBe('REFUNDED');
    expect(res.cancellation).toMatchObject({ stage: prev.stage, refundIdr: prev.refundIdr, paymentFeeRetainedIdr: 0, trustPenalty: 5, travelerCompensationIdr: 0 });
    expect(res.refunds).toHaveLength(1);
    expect(res.refunds[0].amountIdr).toBe(d.quote.totalIdr);
    expect(t.payment.refunds.filter((r) => r.amountIdr === d.quote.totalIdr)).toHaveLength(1);

    const l = await txLedger(t, d.tx.id);
    for (const b of ['PRODUCT_FUND', 'CUSTOMS_RESERVE', 'CLEARING', 'REFUND', 'PROVIDER_CASH', 'PLATFORM_REVENUE', 'TAX_PAYABLE', 'PAYMENT_FEE', 'PROMOTION_CREDIT']) expect(l[b] ?? 0, b).toBe(0);
    const [pen] = await t.adminSql<{ payload: any }[]>`SELECT payload FROM outbox_events WHERE event_type = 'transaction.cancelled_with_penalty' AND aggregate_id = ${d.tx.id}`;
    expect(pen!.payload).toMatchObject({ userId: w.traveler.id, role: 'TRAVELER', trustPenalty: 5, stage: 'AFTER_PAYMENT' });

    await t.drain();
    const [ts] = await t.adminSql<{ components: { items: { key: string; contribution: number }[] } }[]>`SELECT components FROM trust_scores WHERE user_id = ${w.traveler.id}`;
    expect(ts!.components.items.find((i) => i.key === 'cancellationPenalty')!.contribution).toBeLessThan(0);
    const [bs] = await t.adminSql<{ components: { items: { key: string; contribution: number }[] } }[]>`SELECT components FROM trust_scores WHERE user_id = ${d.buyer.id}`;
    expect(bs!.components.items.find((i) => i.key === 'cancellationPenalty')!.contribution).toBe(0);

    const tripAfter = (await ok(api(t, w.traveler, 'GET', `/v1/trips/${w.trip.id}`))).trip;
    expect(tripAfter.reservedKg).toBeLessThan(tripBefore.reservedKg);
    expect(emailTemplates(t, d.buyer.email)).toEqual(expect.arrayContaining([tag('refund.requested'), tag('refund.succeeded')]));
    const types = await outboxTypes(t, d.tx.id);
    expect(types).toEqual(expect.arrayContaining(['refund.requested', 'refund.succeeded', 'transaction.cancelled_with_penalty']));
    // the traveler's view: no more actions, buyer detail shows the refund
    const bd = await ok(api(t, d.buyer, 'GET', `/v1/transactions/${d.tx.id}`));
    expect(bd.refunds[0]).toMatchObject({ amountIdr: d.quote.totalIdr, status: 'SUCCEEDED' });
    const again = await api(t, w.traveler, 'POST', `/v1/transactions/${d.tx.id}/cancel`, { reason: 'lagi' }, idem());
    expect(again.status).toBe(422);
  });

  // BUG (contract, low): POST /v1/transactions/{id}/cancel refreshes `status` after processRefunds() (cancellation/routes.ts
  // `{...out, status: fresh.status}`) but returns `refunds[]` from the pre-processing snapshot — the same body says
  // status REFUNDED and refunds[0].status APPROVED. The stale body is also what the Idempotency-Key replays for 24 h, so a
  // client that retries shows "refund approved" for a refund that already SUCCEEDED. Expected: refunds[] re-read after
  // processing (like the dispute resolve response does).
  let staleRes: any;
  it('setup for the stale-refund BUG: traveler cancels a second paid deal; GET /refunds says SUCCEEDED', async () => {
    const d = await securedDeal(t, w);
    staleRes = await ok(api(t, w.traveler, 'POST', `/v1/transactions/${d.tx.id}/cancel`, { reason: 'Sakit, tidak jadi berangkat' }, idem()));
    expect(staleRes.status).toBe('REFUNDED');
    const fresh = await ok(api(t, d.buyer, 'GET', `/v1/transactions/${d.tx.id}/refunds`));
    expect(fresh.data[0].status).toBe('SUCCEEDED');
  });
  it.fails('BUG: cancel response refunds[] status is stale (APPROVED) while status is REFUNDED', () => {
    expect(staleRes.refunds[0].status).toBe('SUCCEEDED'); // actual: 'APPROVED'
  });
});
