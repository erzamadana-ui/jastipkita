/**
 * J6 — courier delivery with a tracking number → delivered with proof → the buyer stays silent → auto-confirm after
 * `delivery.autoConfirmHours` (48 h, clock advanced) → COMPLETED → payout PAID. Sessions refresh through
 * POST /v1/auth/refresh like a real app after the access tokens expired.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../helpers';
import { api, emailsTo, extraTrip, HELD, ok, purchase, securedDeal, tag, tick, travelToHandover, txLedger, txStatus, upload, world, type World } from './support';

let t: TestContext;
let w: World;

beforeAll(async () => {
  t = await createTestContext();
  w = await world(t);
});
afterAll(async () => {
  await t.close();
});

describe('J6 courier delivery + auto-confirm', () => {
  it('COURIER → OUT_FOR_DELIVERY (tracking) → DELIVERED (proof) → +48 h auto-confirm (SYSTEM, AUTO) → COMPLETED → PAID', async () => {
    const trip = await extraTrip(t, w);
    const d = await securedDeal(t, w, { tripId: trip.id });
    await purchase(t, w.traveler, d.tx.id, 6000);
    await travelToHandover(t, w.traveler, d.tx.id, trip.id);

    const set = await ok(api(t, w.traveler, 'POST', `/v1/transactions/${d.tx.id}/delivery`, { method: 'COURIER', courierName: 'JNE', address: 'Jl. Kemang Raya No. 8, Jakarta Selatan', addressCity: 'Jakarta' }));
    expect(JSON.stringify(set)).not.toContain('Kemang Raya No. 8'); // encrypted address never echoed
    const noPin = await api(t, d.buyer, 'GET', `/v1/transactions/${d.tx.id}/delivery/pin`);
    expect(noPin.status).toBe(422);
    const shipped = await ok(api(t, w.traveler, 'POST', `/v1/transactions/${d.tx.id}/delivery/shipped`, { trackingNumber: 'JNE0012345678', courierName: 'JNE' }));
    expect(shipped.transactionStatus).toBe('OUT_FOR_DELIVERY');
    const bd = await ok(api(t, d.buyer, 'GET', `/v1/transactions/${d.tx.id}`));
    expect(bd.delivery).toMatchObject({ method: 'COURIER', trackingNumber: 'JNE0012345678' });
    const proof = await upload(t, w.traveler, 'DELIVERY_PROOF');
    const delivered = await ok(api(t, w.traveler, 'POST', `/v1/transactions/${d.tx.id}/delivery/delivered`, { proofFileIds: [proof] }));
    expect(delivered.transactionStatus).toBe('DELIVERED');
    const detail = await ok(api(t, d.buyer, 'GET', `/v1/transactions/${d.tx.id}`));
    const autoAt = new Date(detail.autoConfirmAt).getTime();
    expect(autoAt - t.clock.now().getTime()).toBe(48 * 3600_000);
    await t.drain();
    const outMail = emailsTo(t, d.buyer.email).find((m) => m.tags!.template === tag('transaction.out_for_delivery'));
    expect(outMail?.text).toContain('JNE0012345678');

    // 47 h later: still waiting for the buyer
    await tick(t, 47 * 60);
    expect(await txStatus(t, d.tx.id)).toBe('DELIVERED');
    // past the deadline: the SYSTEM confirms, completes and schedules the payout
    await tick(t, 61 + 5);
    expect(await txStatus(t, d.tx.id)).toBe('COMPLETED');
    const [dl] = await t.adminSql<{ confirmed_via: string }[]>`SELECT confirmed_via FROM deliveries WHERE transaction_id = ${d.tx.id} AND status = 'DELIVERED'`;
    expect(dl!.confirmed_via).toBe('AUTO');
    const tl = await ok(api(t, d.buyer, 'GET', `/v1/transactions/${d.tx.id}/timeline`)); // session refreshed via /auth/refresh
    const bc = tl.events.find((e: any) => e.to === 'BUYER_CONFIRMED');
    expect(bc.actorType).toBe('SYSTEM');
    await tick(t, 5);
    const po = await ok(api(t, w.traveler, 'GET', '/v1/payouts/mine'));
    expect(po.data).toHaveLength(1);
    expect(po.data[0].status).toBe('PAID');
    const l = await txLedger(t, d.tx.id);
    for (const b of HELD) expect(l[b] ?? 0, b).toBe(0);
    // a late manual confirmation is harmless
    const late = await ok(api(t, d.buyer, 'POST', `/v1/transactions/${d.tx.id}/confirm-receipt`, undefined, { 'idempotency-key': crypto.randomUUID() }));
    expect(late).toMatchObject({ transactionStatus: 'COMPLETED', alreadyConfirmed: true });
    const payouts = await t.adminSql`SELECT id FROM payouts WHERE transaction_id = ${d.tx.id}`;
    expect(payouts).toHaveLength(1);
  });
});
