import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../../../test/helpers';
import {
  call,
  createFile,
  createMatchedTx,
  idem,
  lineAmount,
  payViaWebhook,
  quoteAndPay,
  seedFx,
  setupParties,
  txLedger,
  txStatus,
  type Parties,
} from '../transactions/test-fixtures';
import { expirePriceConfirmations } from './service';

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

async function securedTx() {
  const tx = await createMatchedTx(t, p, { maxBudgetIdr: 10_000_000 });
  const { quote } = await quoteAndPay(t, p, tx);
  expect(await txStatus(t, tx.id)).toBe('PAYMENT_SECURED');
  return { tx, quote };
}

describe('price confirmation', () => {
  it('price check is refused before payment is secured', async () => {
    const tx = await createMatchedTx(t, p);
    const res = await call(t, p.traveler, 'POST', `/v1/transactions/${tx.id}/price-check`, { actualUnitPriceMinor: 20000, currency: 'JPY' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('PRICE_CHECK_NOT_ALLOWED');
  });

  it('above tolerance → PENDING → buyer approves → SUPPLEMENTAL payment → PURCHASE_APPROVED at the new ceiling', async () => {
    const { tx, quote } = await securedTx();
    const receipt = await createFile(t, p.traveler.id, 'RECEIPT');
    const chk = await call(t, p.traveler, 'POST', `/v1/transactions/${tx.id}/price-check`, { actualUnitPriceMinor: 22000, currency: 'JPY', receiptFileId: receipt, notes: 'Harga naik' });
    expect(chk.status, JSON.stringify(chk.body)).toBe(200);
    expect(chk.body.outcome).toBe('NEEDS_CONFIRMATION');
    expect(chk.body.transactionStatus).toBe('PRICE_CHANGE_PENDING');
    const pc = chk.body.priceConfirmation;
    expect(pc.status).toBe('PENDING');
    const supplemental = pc.supplementalRequiredIdr;
    expect(supplemental).toBe(pc.actualIdr - lineAmount(quote, 'ITEM_PRICE'));
    const [ev] = await t.adminSql`SELECT 1 FROM outbox_events WHERE event_type = 'price_confirmation.requested' AND aggregate_id = ${pc.id}`;
    expect(ev).toBeTruthy();
    // traveler cannot purchase while pending
    const detail = await call(t, p.traveler, 'GET', `/v1/transactions/${tx.id}`);
    expect(detail.body.purchaseGate.banner).toBe('DO_NOT_PURCHASE');

    const ok = await call(t, p.buyer, 'POST', `/v1/transactions/${tx.id}/price-confirmations/${pc.id}/respond`, { action: 'APPROVE' }, idem());
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.transactionStatus).toBe('AWAITING_PAYMENT');
    expect(ok.body.payment.purpose).toBe('SUPPLEMENTAL');
    expect(ok.body.payment.amountIdr).toBe(supplemental);
    const { res } = await payViaWebhook(t, ok.body.payment.id);
    expect(res.body.outcome).toBe('SECURED');
    expect(await txStatus(t, tx.id)).toBe('PURCHASE_APPROVED');
    const l = await txLedger(t, tx.id);
    expect(l.PRODUCT_FUND).toBe(lineAmount(quote, 'ITEM_PRICE') + supplemental);
    const [row] = await t.adminSql<{ purchase_ceiling_minor: number }[]>`SELECT purchase_ceiling_minor FROM transactions WHERE id = ${tx.id}`;
    expect(Number(row!.purchase_ceiling_minor)).toBe(22000);
  });

  it('reject → no-fault full refund (incl. payment fee), no trust penalty', async () => {
    const { tx, quote } = await securedTx();
    const chk = await call(t, p.traveler, 'POST', `/v1/transactions/${tx.id}/price-check`, { actualUnitPriceMinor: 25000, currency: 'JPY' });
    const pc = chk.body.priceConfirmation;
    const rej = await call(t, p.buyer, 'POST', `/v1/transactions/${tx.id}/price-confirmations/${pc.id}/respond`, { action: 'REJECT', note: 'Terlalu mahal' }, idem());
    expect(rej.status, JSON.stringify(rej.body)).toBe(200);
    expect(rej.body.cancellation.refundIdr).toBe(quote.totalIdr);
    expect(rej.body.cancellation.trustPenalty).toBe(0);
    expect(rej.body.transactionStatus).toBe('REFUNDED');
    const [refund] = await t.adminSql<{ reason_code: string; status: string; amount_idr: number }[]>`SELECT reason_code, status, amount_idr FROM refunds WHERE transaction_id = ${tx.id}`;
    expect(refund).toMatchObject({ reason_code: 'PRICE_CHANGE_REJECTED', status: 'SUCCEEDED' });
    expect(Number(refund!.amount_idr)).toBe(quote.totalIdr);
    const penalties = await t.adminSql`SELECT 1 FROM outbox_events WHERE event_type = 'transaction.cancelled_with_penalty' AND aggregate_id = ${tx.id}`;
    expect(penalties).toHaveLength(0);
    const l = await txLedger(t, tx.id);
    for (const b of ['PRODUCT_FUND', 'CUSTOMS_RESERVE', 'CLEARING', 'REFUND', 'PROVIDER_CASH', 'PLATFORM_REVENUE', 'PAYMENT_FEE']) expect(l[b] ?? 0).toBe(0);
  });

  it('clarification: buyer asks, traveler answers (window resets), buyer approves within funds', async () => {
    const { tx } = await securedTx();
    const chk = await call(t, p.traveler, 'POST', `/v1/transactions/${tx.id}/price-check`, { actualUnitPriceMinor: 21500, currency: 'JPY' });
    const pc = chk.body.priceConfirmation;
    const ask = await call(t, p.buyer, 'POST', `/v1/transactions/${tx.id}/price-confirmations/${pc.id}/respond`, { action: 'CLARIFY', note: 'Warna apa?' }, idem());
    expect(ask.body.priceConfirmation.status).toBe('CLARIFICATION_REQUESTED');
    t.clock.advance(10 * 60_000);
    const ans = await call(t, p.traveler, 'POST', `/v1/transactions/${tx.id}/price-confirmations/${pc.id}/clarify`, { note: 'Warna biru, harga sama' });
    expect(ans.status, JSON.stringify(ans.body)).toBe(200);
    expect(ans.body.priceConfirmation.status).toBe('PENDING');
    expect(ans.body.priceConfirmation.round).toBe(2);
    expect(new Date(ans.body.priceConfirmation.expiresAt).getTime()).toBeGreaterThan(new Date(pc.expiresAt).getTime());
    t.clock.advance(10 * 60_000); // past the ORIGINAL window, inside the reset one
    const ok = await call(t, p.buyer, 'POST', `/v1/transactions/${tx.id}/price-confirmations/${pc.id}/respond`, { action: 'APPROVE' }, idem());
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.transactionStatus).toBe('AWAITING_PAYMENT');
  });

  it('expiry without response → EXPIRED → treated as reject: full refund, no penalty', async () => {
    const { tx, quote } = await securedTx();
    const chk = await call(t, p.traveler, 'POST', `/v1/transactions/${tx.id}/price-check`, { actualUnitPriceMinor: 26000, currency: 'JPY' });
    const pc = chk.body.priceConfirmation;
    t.clock.advance(16 * 60_000);
    const late = await call(t, p.buyer, 'POST', `/v1/transactions/${tx.id}/price-confirmations/${pc.id}/respond`, { action: 'APPROVE' }, idem());
    expect(late.status).toBe(422);
    expect(late.body.error.code).toBe('PRICE_CONFIRMATION_EXPIRED');
    const r = await expirePriceConfirmations(t.deps);
    expect(r.expired).toBeGreaterThanOrEqual(1);
    const [row] = await t.adminSql<{ status: string }[]>`SELECT status FROM price_confirmations WHERE id = ${pc.id}`;
    expect(row!.status).toBe('EXPIRED');
    expect(await txStatus(t, tx.id)).toBe('REFUNDED');
    const [refund] = await t.adminSql<{ reason_code: string; amount_idr: number }[]>`SELECT reason_code, amount_idr FROM refunds WHERE transaction_id = ${tx.id}`;
    expect(refund!.reason_code).toBe('PRICE_CONFIRMATION_EXPIRED');
    expect(Number(refund!.amount_idr)).toBe(quote.totalIdr);
  });

  it('price decrease is auto-approved; the difference is refunded at completion', async () => {
    const { tx } = await securedTx();
    const chk = await call(t, p.traveler, 'POST', `/v1/transactions/${tx.id}/price-check`, { actualUnitPriceMinor: 18000, currency: 'JPY' });
    expect(chk.body.outcome).toBe('WITHIN_TOLERANCE');
    expect(chk.body.evaluation.refundDueIdr).toBeGreaterThan(0);
    expect(chk.body.purchaseCeiling.minor).toBe(18000);
  });
});
