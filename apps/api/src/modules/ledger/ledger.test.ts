import { DEFAULT_BUSINESS_CONFIG, evaluateCancellation, type TransactionStatus } from '@jastipkita/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../../../test/helpers';
import { processPayouts } from '../payouts/service';
import {
  call,
  createFile,
  createMatchedTx,
  idem,
  lineAmount,
  quoteAndPay,
  seedFx,
  setTripStatus,
  setupParties,
  txLedger,
  type Parties,
} from '../transactions/test-fixtures';
import { captureEntries, type LedgerEntry, type QuoteAmounts, releasePlan, settlementEntries } from './service';

const Q: QuoteAmounts = {
  ITEM_PRICE: 2_182_250,
  TRAVELER_FEE: 150_000,
  CUSTOMS_DUTY: 215_000,
  IMPORT_TAX: 380_000,
  PROTECTION_FEE: 32_734,
  PLATFORM_FEE: 109_113,
  SERVICE_TAX: 15_603,
  PAYMENT_FEE: 21_950,
  DISCOUNT: -100_000,
  REFERRAL_CREDIT: -25_000,
  TOTAL: 0,
};
Q.TOTAL = Object.entries(Q).filter(([k]) => k !== 'TOTAL').reduce((s, [, v]) => s + v, 0);

const sum = (es: LedgerEntry[], d: 'DEBIT' | 'CREDIT') => es.filter((e) => e.direction === d).reduce((s, e) => s + e.amount, 0);

describe('journal builders (pure)', () => {
  it('PAYMENT_CAPTURED balances: cash + promo = item + customs + fees', () => {
    const e = captureEntries(Q, Q.TOTAL);
    expect(sum(e, 'DEBIT')).toBe(sum(e, 'CREDIT'));
    expect(e.find((x) => x.bucket === 'PROMOTION_CREDIT')!.amount).toBe(125_000);
  });

  it('COMPLETION_RELEASE balances for exact, lower and within-tolerance higher prices', () => {
    const held = { productFund: Q.ITEM_PRICE, customsReserve: Q.CUSTOMS_DUTY + Q.IMPORT_TAX, clearing: Q.TRAVELER_FEE + Q.PROTECTION_FEE + Q.PLATFORM_FEE + Q.SERVICE_TAX + Q.PAYMENT_FEE };
    const fees = { travelerFee: Q.TRAVELER_FEE, platformAndProtection: Q.PLATFORM_FEE + Q.PROTECTION_FEE, serviceTax: Q.SERVICE_TAX, paymentFee: Q.PAYMENT_FEE };
    for (const reimb of [Q.ITEM_PRICE, Q.ITEM_PRICE - 200_000, Q.ITEM_PRICE + 30_000]) {
      for (const customsPaid of [0, 300_000, 900_000]) {
        const plan = releasePlan({ buyerId: 'b', travelerId: 't', held, reimbursementIdr: reimb, customsPaidIdr: customsPaid, fees });
        expect(sum(plan.entries, 'DEBIT')).toBe(sum(plan.entries, 'CREDIT'));
        expect(plan.customsReimbursedIdr).toBe(Math.min(customsPaid, held.customsReserve));
        expect(plan.platformSubsidyIdr).toBe(Math.max(0, reimb - Q.ITEM_PRICE));
      }
    }
    expect(() => releasePlan({ buyerId: 'b', travelerId: 't', held: { ...held, clearing: held.clearing - 1 }, reimbursementIdr: 1, customsPaidIdr: 0, fees })).toThrow(/Clearing/);
  });

  it('CANCELLATION_SETTLEMENT balances for every matrix row after payment', () => {
    const lines = Object.entries(Q).map(([type, amountIdr]) => ({ type: type as never, amountIdr }));
    const statuses: TransactionStatus[] = ['PAYMENT_SECURED', 'PRICE_CHANGE_PENDING', 'PURCHASE_APPROVED', 'PURCHASED', 'TRAVELING', 'ARRIVED'];
    let checked = 0;
    for (const status of statuses) {
      for (const actor of ['BUYER', 'TRAVELER', 'SYSTEM', 'ADMIN'] as const) {
        for (const cause of [undefined, 'PRICE_CHANGE_REJECTED']) {
          const r = evaluateCancellation({ status, actor, ...(cause ? { cause } : {}), quoteLines: lines, paymentCaptured: true }, DEFAULT_BUSINESS_CONFIG['cancellation.matrix']);
          if (!r.allowed) continue;
          const e = settlementEntries({
            buyerId: 'b',
            travelerId: 't',
            held: { productFund: Q.ITEM_PRICE, customsReserve: Q.CUSTOMS_DUTY + Q.IMPORT_TAX, clearing: Q.TRAVELER_FEE + Q.PROTECTION_FEE + Q.PLATFORM_FEE + Q.SERVICE_TAX + Q.PAYMENT_FEE },
            refundIdr: r.refundIdr,
            travelerCompensationIdr: r.travelerCompensationIdr,
            platformRetainedIdr: r.platformRetainedIdr,
            serviceTaxRetainedIdr: r.serviceTaxRetainedIdr,
            paymentFeeRetainedIdr: r.paymentFeeRetainedIdr,
            customsRetainedIdr: r.customsRetainedIdr,
            promoReturnedIdr: r.discountReversedIdr + r.creditRestoredIdr,
          });
          expect(sum(e, 'DEBIT'), `${status}/${actor}/${cause}`).toBe(sum(e, 'CREDIT'));
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(10);
  });
});

describe('ledger flows (DB)', () => {
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

  it('price decrease: traveler reimbursed the actual price, the difference goes back to the buyer as a refund', async () => {
    const tx = await createMatchedTx(t, p);
    const { quote } = await quoteAndPay(t, p, tx);
    await call(t, p.traveler, 'POST', `/v1/transactions/${tx.id}/price-check`, { actualUnitPriceMinor: 18000, currency: 'JPY' });
    const proof = await call(t, p.traveler, 'POST', `/v1/transactions/${tx.id}/purchase-proof`, {
      receiptFileId: await createFile(t, p.traveler.id, 'RECEIPT'),
      productPhotoFileIds: [await createFile(t, p.traveler.id, 'PRODUCT_PHOTO')],
      merchantName: 'Yodobashi Camera',
      actualPriceMinor: 18000,
      currency: 'JPY',
      purchasedAt: t.clock.now().toISOString(),
    });
    expect(proof.status).toBe(201);
    await setTripStatus(t, tx.tripId, ['ACTIVE', 'TRAVELING']);
    for (const to of ['TRAVELING', 'ARRIVED', 'READY_FOR_HANDOVER']) await call(t, p.traveler, 'POST', `/v1/transactions/${tx.id}/status`, { to });
    await call(t, p.traveler, 'POST', `/v1/transactions/${tx.id}/delivery`, { method: 'MEETUP', meetupPoint: 'Blok M' });
    const pin = await call(t, p.buyer, 'GET', `/v1/transactions/${tx.id}/delivery/pin`);
    await call(t, p.traveler, 'POST', `/v1/transactions/${tx.id}/delivery/verify`, { pin: pin.body.pin });
    const done = await call(t, p.buyer, 'POST', `/v1/transactions/${tx.id}/confirm-receipt`, undefined, idem());
    expect(done.body.transactionStatus).toBe('COMPLETED');
    const actualIdr = Math.round(18000 * Number(quote.fx.lockedRate));
    const customs = lineAmount(quote, 'CUSTOMS_DUTY') + lineAmount(quote, 'IMPORT_TAX');
    const [ref] = await t.adminSql<{ amount_idr: number; status: string; reason_code: string }[]>`SELECT amount_idr, status, reason_code FROM refunds WHERE transaction_id = ${tx.id}`;
    expect(Number(ref!.amount_idr)).toBe(lineAmount(quote, 'ITEM_PRICE') - actualIdr + customs);
    expect(ref!.status).toBe('SUCCEEDED');
    await processPayouts(t.deps, { transactionId: tx.id });
    const [po] = await t.adminSql<{ amount_idr: number; status: string }[]>`SELECT amount_idr, status FROM payouts WHERE transaction_id = ${tx.id}`;
    expect(Number(po!.amount_idr)).toBe(actualIdr + lineAmount(quote, 'TRAVELER_FEE'));
    expect(po!.status).toBe('PAID');
    const l = await txLedger(t, tx.id);
    for (const b of ['PRODUCT_FUND', 'CUSTOMS_RESERVE', 'CLEARING', 'REFUND', 'TRAVELER_EARNING']) expect(l[b] ?? 0).toBe(0);
    expect(-l.PROVIDER_CASH!).toBe(l.PLATFORM_REVENUE! + l.TAX_PAYABLE! + l.PAYMENT_FEE!);
  });

  it('ledger is append-only: UPDATE/DELETE of entries is rejected (JK001)', async () => {
    await expect(t.adminSql`UPDATE ledger_entries SET amount = amount + 1 WHERE id = (SELECT min(id) FROM ledger_entries)`).rejects.toMatchObject({ code: 'JK001' });
    await expect(t.adminSql`DELETE FROM ledger_journals WHERE id = (SELECT id FROM ledger_journals LIMIT 1)`).rejects.toMatchObject({ code: 'JK001' });
  });
});
