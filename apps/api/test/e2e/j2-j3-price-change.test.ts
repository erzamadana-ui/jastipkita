/**
 * J2 — price change above tolerance → buyer approves → SUPPLEMENTAL payment → PURCHASE_APPROVED at the new ceiling → COMPLETED.
 * J3 — price change rejected by the buyer → no-fault full refund (incl. payment fee), no trust penalty, capacity released.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../helpers';
import {
  api,
  emailTemplates,
  extraTrip,
  HELD,
  idem,
  line,
  meetupHandover,
  ok,
  outboxTypes,
  providerPays,
  securedDeal,
  tag,
  tick,
  travelToHandover,
  txLedger,
  txStatus,
  upload,
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

describe('J2 price change with supplemental payment', () => {
  it('+10% at the store → confirmation → approve → supplemental checkout → webhook → PURCHASE_APPROVED → COMPLETED with the new price', async () => {
    const ownTrip = await extraTrip(t, w); // this journey departs
    const d = await securedDeal(t, w, { tripId: ownTrip.id });
    const itemIdr = line(d.quote, 'ITEM_PRICE');
    const chk = await ok(api(t, w.traveler, 'POST', `/v1/transactions/${d.tx.id}/price-check`, { actualUnitPriceMinor: 6600, currency: 'JPY', notes: 'Harga naik di toko' }));
    expect(chk).toMatchObject({ outcome: 'NEEDS_CONFIRMATION', transactionStatus: 'PRICE_CHANGE_PENDING' });
    const pc = chk.priceConfirmation;
    expect(pc).toMatchObject({ status: 'PENDING', round: 1 });
    expect(pc.supplementalRequiredIdr).toBe(pc.actualIdr - itemIdr);
    expect(new Date(pc.expiresAt).getTime() - t.clock.now().getTime()).toBe(900_000);

    // traveler must still not buy; buyer sees the confirmation in the detail and gets the critical e-mail
    const tv = await ok(api(t, w.traveler, 'GET', `/v1/transactions/${d.tx.id}`));
    expect(tv.purchaseGate.banner).toBe('DO_NOT_PURCHASE');
    const bd = await ok(api(t, d.buyer, 'GET', `/v1/transactions/${d.tx.id}`));
    expect(bd.allowedActions).toEqual(expect.arrayContaining(['RESPOND_PRICE_CONFIRMATION']));
    await t.drain();
    expect(emailTemplates(t, d.buyer.email)).toContain(tag('price.change_requested'));

    const key = idem();
    const appr = await ok(api(t, d.buyer, 'POST', `/v1/transactions/${d.tx.id}/price-confirmations/${pc.id}/respond`, { action: 'APPROVE', note: 'OK, lanjut' }, key));
    expect(appr.transactionStatus).toBe('AWAITING_PAYMENT');
    expect(appr.payment).toMatchObject({ purpose: 'SUPPLEMENTAL', amountIdr: pc.supplementalRequiredIdr });
    // retry of the same approval (network loss) replays; nothing is created twice
    const again = await api(t, d.buyer, 'POST', `/v1/transactions/${d.tx.id}/price-confirmations/${pc.id}/respond`, { action: 'APPROVE', note: 'OK, lanjut' }, key);
    expect(again.headers.get('idempotent-replayed')).toBe('true');
    const supp = await t.adminSql`SELECT id FROM payments WHERE transaction_id = ${d.tx.id} AND purpose = 'SUPPLEMENTAL'`;
    expect(supp).toHaveLength(1);

    const { res } = await providerPays(t, appr.payment.id);
    expect(res.body.outcome).toBe('SECURED');
    expect(await txStatus(t, d.tx.id)).toBe('PURCHASE_APPROVED');
    const after = await ok(api(t, w.traveler, 'GET', `/v1/transactions/${d.tx.id}`));
    expect(after.purchaseCeilingMinor).toBe(6600);
    expect(after.purchaseGate).toMatchObject({ canPurchase: true, banner: 'PURCHASE_APPROVED' });
    const l = await txLedger(t, d.tx.id);
    expect(l.PRODUCT_FUND).toBe(itemIdr + pc.supplementalRequiredIdr);

    // purchase at the approved price (the price check is already done → proof directly)
    const pp = await ok(api(t, w.traveler, 'POST', `/v1/transactions/${d.tx.id}/purchase-proof`, {
      receiptFileId: await upload(t, w.traveler, 'RECEIPT', 'application/pdf'),
      productPhotoFileIds: [await upload(t, w.traveler, 'PRODUCT_PHOTO')],
      merchantName: 'UNIQLO Ginza',
      actualPriceMinor: 6600,
      currency: 'JPY',
      purchasedAt: t.clock.now().toISOString(),
    }), 201);
    expect(pp.transactionStatus).toBe('PURCHASED');
    await travelToHandover(t, w.traveler, d.tx.id, ownTrip.id);
    await meetupHandover(t, d.buyer, w.traveler, d.tx.id);
    const c = await ok(api(t, d.buyer, 'POST', `/v1/transactions/${d.tx.id}/confirm-receipt`, undefined, idem()));
    expect(c.transactionStatus).toBe('COMPLETED');
    await tick(t, 5);
    const fin = await txLedger(t, d.tx.id);
    for (const b of HELD) expect(fin[b] ?? 0, b).toBe(0);
    const [po] = await t.adminSql<{ status: string; amount_idr: number }[]>`SELECT status, amount_idr FROM payouts WHERE transaction_id = ${d.tx.id}`;
    // traveler is reimbursed the approved (higher) price; the unused customs reserve (no declaration) goes back to the buyer
    expect(po!.status).toBe('PAID');
    expect(Number(po!.amount_idr)).toBe(pc.actualIdr + line(d.quote, 'TRAVELER_FEE'));
    await t.drain();
    const mails = emailTemplates(t, d.buyer.email);
    expect(mails).toEqual(expect.arrayContaining([tag('price.change_requested'), tag('price.change_result'), tag('transaction.completed')]));
    const types = await outboxTypes(t, d.tx.id);
    expect(types.filter((x) => x === 'price_confirmation.resolved')).toHaveLength(1);
  });
});

describe('J3 price change rejected → no-fault full refund', () => {
  it('buyer rejects → REFUNDED incl. payment fee, cause PRICE_CHANGE_REJECTED, no trust penalty, capacity & request released', async () => {
    const before = (await ok(api(t, w.traveler, 'GET', `/v1/trips/${w.trip.id}`))).trip;
    const d = await securedDeal(t, w);
    const mid = (await ok(api(t, w.traveler, 'GET', `/v1/trips/${w.trip.id}`))).trip;
    expect(mid.reservedKg).toBeGreaterThan(before.reservedKg);
    const chk = await ok(api(t, w.traveler, 'POST', `/v1/transactions/${d.tx.id}/price-check`, { actualUnitPriceMinor: 7500, currency: 'JPY' }));
    const pc = chk.priceConfirmation;
    // preview what a cancellation would do now (no side effects)
    const prev = await ok(api(t, d.buyer, 'GET', `/v1/transactions/${d.tx.id}/cancel/preview?cause=PRICE_CHANGE_REJECTED`));
    expect(prev).toMatchObject({ refundIdr: d.quote.totalIdr, trustPenalty: 0 });
    const rej = await ok(api(t, d.buyer, 'POST', `/v1/transactions/${d.tx.id}/price-confirmations/${pc.id}/respond`, { action: 'REJECT', note: 'Kemahalan' }, idem()));
    expect(rej.transactionStatus).toBe('REFUNDED');
    expect(rej.cancellation).toMatchObject({ refundIdr: d.quote.totalIdr, trustPenalty: 0, paymentFeeRetainedIdr: 0 });
    const refunds = await ok(api(t, d.buyer, 'GET', `/v1/transactions/${d.tx.id}/refunds`));
    expect(refunds.data).toHaveLength(1);
    expect(refunds.data[0]).toMatchObject({ status: 'SUCCEEDED', amountIdr: d.quote.totalIdr, reasonCode: 'PRICE_CHANGE_REJECTED' });
    expect(t.payment.refunds.some((r) => r.amountIdr === d.quote.totalIdr)).toBe(true);
    const types = await outboxTypes(t, d.tx.id);
    expect(types).not.toContain('transaction.cancelled_with_penalty');
    expect(types).toEqual(expect.arrayContaining(['refund.requested', 'refund.succeeded']));
    const l = await txLedger(t, d.tx.id);
    for (const b of ['PRODUCT_FUND', 'CUSTOMS_RESERVE', 'CLEARING', 'REFUND', 'PROVIDER_CASH', 'PLATFORM_REVENUE', 'TAX_PAYABLE', 'PAYMENT_FEE', 'PROMOTION_CREDIT']) expect(l[b] ?? 0, b).toBe(0);
    await t.drain();
    const trip = (await ok(api(t, w.traveler, 'GET', `/v1/trips/${w.trip.id}`))).trip;
    expect(trip.reservedKg).toBe(before.reservedKg);
    const req = await ok(api(t, d.buyer, 'GET', `/v1/requests/${d.request.id}`));
    expect(req.request.status).toBe('CLOSED');
    const mails = emailTemplates(t, d.buyer.email);
    expect(mails).toEqual(expect.arrayContaining([tag('price.change_requested'), tag('price.change_result'), tag('refund.requested'), tag('refund.succeeded')]));
    expect(emailTemplates(t, w.traveler.email)).toContain(tag('price.change_result'));
    // Trust Score: the buyer's cancellation component is not penalised for a price-change rejection (§5)
    const [ts] = await t.adminSql<{ components: { items: { key: string; contribution: number }[] } }[]>`SELECT components FROM trust_scores WHERE user_id = ${d.buyer.id}`;
    expect(ts, 'trust score recomputed on REFUNDED').toBeTruthy();
    expect(ts!.components.items.find((i) => i.key === 'cancellationPenalty')!.contribution).toBe(0);
  });
});
