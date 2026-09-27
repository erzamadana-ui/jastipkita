import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../../../test/helpers';
import { processPayouts } from '../payouts/service';
import {
  accountBalance,
  call,
  createFile,
  createMatchedTx,
  idem,
  lineAmount,
  payViaWebhook,
  seedFx,
  setTripStatus,
  setupParties,
  txLedger,
  txStatus,
  type MatchedTx,
  type Parties,
} from './test-fixtures';

let t: TestContext;
let p: Parties;
let tx: MatchedTx;

beforeAll(async () => {
  t = await createTestContext();
  await seedFx(t);
  p = await setupParties(t);
  tx = await createMatchedTx(t, p);
});
afterAll(async () => {
  await t.close();
});

describe('SafePay happy path (MATCHED → COMPLETED → payout PAID) with ledger invariants', () => {
  let quote: any;
  let paymentId: string;

  it('quote: 11 transparent lines in §10 order, FX lock shown, customs estimate badge', async () => {
    const res = await call(t, p.buyer, 'POST', `/v1/transactions/${tx.id}/quote`, { channel: 'QRIS' });
    expect(res.status).toBe(201);
    quote = res.body;
    expect(quote.lines.map((l: any) => l.type)).toEqual([
      'ITEM_PRICE', 'TRAVELER_FEE', 'CUSTOMS_DUTY', 'IMPORT_TAX', 'PROTECTION_FEE', 'PLATFORM_FEE', 'SERVICE_TAX', 'PAYMENT_FEE', 'DISCOUNT', 'REFERRAL_CREDIT', 'TOTAL',
    ]);
    const sum = quote.lines.filter((l: any) => l.type !== 'TOTAL').reduce((s: number, l: any) => s + l.amountIdr, 0);
    expect(sum).toBe(quote.totalIdr);
    expect(quote.fx.base).toBe('JPY');
    expect(quote.fx.spotRate).toBe('107.5');
    expect(quote.fx.markupBps).toBe(150);
    expect(quote.fx.lockedAt).toBeTruthy();
    expect(quote.expiresAt).toBe(quote.fx.expiresAt);
    expect(lineAmount(quote, 'ITEM_PRICE')).toBe(2_182_250); // ¥20.000 × 109,1125 (107,5 + 1,5%)
    expect(quote.estimateBadges).toContain('CUSTOMS_DUTY');
    expect(quote.customs.ruleCode).toBe('ID_PAX_NON_PERSONAL');
    expect(quote.restricted.classification).toBe('ALLOWED');
    expect(quote.credit.withdrawable).toBe(false);
  });

  it('traveler sees DO_NOT_PURCHASE before payment', async () => {
    const res = await call(t, p.traveler, 'GET', `/v1/transactions/${tx.id}`);
    expect(res.status).toBe(200);
    expect(res.body.purchaseGate.banner).toBe('DO_NOT_PURCHASE');
    expect(res.body.purchaseGate.canPurchase).toBe(false);
  });

  it('checkout creates a PENDING SANDBOX payment and moves to AWAITING_PAYMENT', async () => {
    const res = await call(t, p.buyer, 'POST', `/v1/transactions/${tx.id}/checkout`, { quoteId: quote.quoteId }, idem());
    expect(res.status).toBe(201);
    expect(res.body.amountIdr).toBe(quote.totalIdr);
    expect(res.body.providerEnv).toBe('TEST');
    expect(res.body.sandbox).toBe(true);
    expect(res.body.checkoutUrl).toContain('/v1/dev/mock-checkout/');
    paymentId = res.body.paymentId;
    expect(await txStatus(t, tx.id)).toBe('AWAITING_PAYMENT');
    const page = await t.request('GET', new URL(res.body.checkoutUrl).pathname);
    expect(page.status).toBe(200);
    expect(String(page.body)).toContain('Simulasi Pembayaran — MOCK');
  });

  it('mock webhook secures the payment and posts PAYMENT_CAPTURED', async () => {
    const { res } = await payViaWebhook(t, paymentId);
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('SECURED');
    expect(await txStatus(t, tx.id)).toBe('PAYMENT_SECURED');
    const l = await txLedger(t, tx.id);
    expect(l.PRODUCT_FUND).toBe(lineAmount(quote, 'ITEM_PRICE'));
    expect(l.CUSTOMS_RESERVE).toBe(lineAmount(quote, 'CUSTOMS_DUTY') + lineAmount(quote, 'IMPORT_TAX'));
    expect(l.CLEARING).toBe(
      ['TRAVELER_FEE', 'PROTECTION_FEE', 'PLATFORM_FEE', 'SERVICE_TAX', 'PAYMENT_FEE'].reduce((s, k) => s + lineAmount(quote, k), 0),
    );
    expect(l.PROVIDER_CASH).toBe(-quote.totalIdr);
    const detail = await call(t, p.traveler, 'GET', `/v1/transactions/${tx.id}`);
    expect(detail.body.purchaseGate.banner).toBe('DO_NOT_PURCHASE');
    expect(detail.body.purchaseGate.paymentBadge).toBe('PAYMENT_SECURED');
    expect(detail.body.allowedActions).toContain('PRICE_CHECK');
  });

  it('protection policy is bound by the payment.secured subscriber (SANDBOX insurer)', async () => {
    await t.drain();
    const [pol] = await t.adminSql<{ status: string; provider_env: string }[]>`SELECT status, provider_env FROM insurance_policies WHERE transaction_id = ${tx.id}`;
    expect(pol).toMatchObject({ status: 'ACTIVE', provider_env: 'TEST' });
  });

  it('price check within tolerance → PURCHASE_APPROVED with ceiling', async () => {
    const res = await call(t, p.traveler, 'POST', `/v1/transactions/${tx.id}/price-check`, { actualUnitPriceMinor: 20000, currency: 'JPY' });
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('WITHIN_TOLERANCE');
    expect(res.body.transactionStatus).toBe('PURCHASE_APPROVED');
    const detail = await call(t, p.traveler, 'GET', `/v1/transactions/${tx.id}`);
    expect(detail.body.purchaseGate).toMatchObject({ canPurchase: true, banner: 'PURCHASE_APPROVED' });
  });

  it('purchase proof → PURCHASED (ACCEPTED, no flags)', async () => {
    const receipt = await createFile(t, p.traveler.id, 'RECEIPT');
    const photo = await createFile(t, p.traveler.id, 'PRODUCT_PHOTO');
    const res = await call(t, p.traveler, 'POST', `/v1/transactions/${tx.id}/purchase-proof`, {
      receiptFileId: receipt,
      productPhotoFileIds: [photo],
      merchantName: 'Yodobashi Camera Akiba',
      actualPriceMinor: 20000,
      currency: 'JPY',
      purchasedAt: t.clock.now().toISOString(),
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'ACCEPTED', flagged: false, transactionStatus: 'PURCHASED' });
  });

  it('travel: TRAVELING (trip departed) → ARRIVED → READY_FOR_HANDOVER', async () => {
    const early = await call(t, p.traveler, 'POST', `/v1/transactions/${tx.id}/status`, { to: 'TRAVELING' });
    expect(early.status).toBe(422);
    expect(early.body.error.code).toBe('TRIP_NOT_TRAVELING');
    await setTripStatus(t, tx.tripId, ['ACTIVE', 'TRAVELING']);
    for (const to of ['TRAVELING', 'ARRIVED']) {
      const r = await call(t, p.traveler, 'POST', `/v1/transactions/${tx.id}/status`, { to });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.transactionStatus).toBe(to);
    }
    // Duty & import tax actually paid at the airport (equal to the estimate here), with the official receipt.
    const bpn = await createFile(t, p.traveler.id, 'RECEIPT');
    const decl = await call(t, p.traveler, 'POST', `/v1/transactions/${tx.id}/customs-declaration`, {
      dutyPaidIdr: lineAmount(quote, 'CUSTOMS_DUTY'),
      vatPaidIdr: lineAmount(quote, 'IMPORT_TAX'),
      incomeTaxPaidIdr: 0,
      receiptFileId: bpn,
      declarationRef: 'CD-SOETTA-0001',
    });
    expect(decl.status, JSON.stringify(decl.body)).toBe(200);
    expect(decl.body.status).toBe('PAID');
    const ready = await call(t, p.traveler, 'POST', `/v1/transactions/${tx.id}/status`, { to: 'READY_FOR_HANDOVER' });
    expect(ready.body.transactionStatus).toBe('READY_FOR_HANDOVER');
  });

  it('MEETUP handover: PIN only visible to the buyer; traveler verifies → DELIVERED', async () => {
    const set = await call(t, p.traveler, 'POST', `/v1/transactions/${tx.id}/delivery`, { method: 'MEETUP', meetupPoint: 'Stasiun MRT Bundaran HI' });
    expect(set.status).toBe(200);
    expect(JSON.stringify(set.body)).not.toMatch(/pin_hash|pinHash/);
    const [ev] = await t.adminSql<{ payload: Record<string, unknown> }[]>`
      SELECT payload FROM outbox_events WHERE event_type = 'delivery.pin_ready' AND aggregate_id = ${tx.id}`;
    expect(ev!.payload).toEqual({ transactionId: tx.id, buyerId: p.buyer.id });
    const denied = await call(t, p.traveler, 'GET', `/v1/transactions/${tx.id}/delivery/pin`);
    expect(denied.status).toBe(403);
    const pin = await call(t, p.buyer, 'GET', `/v1/transactions/${tx.id}/delivery/pin`);
    expect(pin.status).toBe(200);
    expect(pin.body.pin).toMatch(/^\d{6}$/);
    const travelerView = await call(t, p.traveler, 'GET', `/v1/transactions/${tx.id}`);
    expect(JSON.stringify(travelerView.body)).not.toContain(pin.body.pin);
    const ok = await call(t, p.traveler, 'POST', `/v1/transactions/${tx.id}/delivery/verify`, { pin: pin.body.pin });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ transactionStatus: 'DELIVERED', confirmedVia: 'PIN', alreadyConfirmed: false });
  });

  it('buyer confirms receipt → COMPLETED; release journal; payout SCHEDULED', async () => {
    const res = await call(t, p.buyer, 'POST', `/v1/transactions/${tx.id}/confirm-receipt`, undefined, idem());
    expect(res.status).toBe(200);
    expect(res.body.transactionStatus).toBe('COMPLETED');
    const l = await txLedger(t, tx.id);
    expect(l.PRODUCT_FUND).toBe(0);
    expect(l.CUSTOMS_RESERVE).toBe(0);
    expect(l.CLEARING).toBe(0);
    expect(l.REFUND ?? 0).toBe(0);
    expect(l.PLATFORM_REVENUE).toBe(lineAmount(quote, 'PLATFORM_FEE') + lineAmount(quote, 'PROTECTION_FEE'));
    expect(l.TAX_PAYABLE).toBe(lineAmount(quote, 'SERVICE_TAX'));
    const customs = lineAmount(quote, 'CUSTOMS_DUTY') + lineAmount(quote, 'IMPORT_TAX');
    const expectedEarning = lineAmount(quote, 'ITEM_PRICE') + lineAmount(quote, 'TRAVELER_FEE') + customs;
    const [po] = await t.adminSql<{ status: string; amount_idr: number }[]>`SELECT status, amount_idr FROM payouts WHERE transaction_id = ${tx.id}`;
    expect(po!.status).toBe('SCHEDULED');
    expect(Number(po!.amount_idr)).toBe(expectedEarning);
    expect(l.TRAVELER_EARNING).toBe(expectedEarning);
    const refunds = await t.adminSql`SELECT id FROM refunds WHERE transaction_id = ${tx.id}`;
    expect(refunds).toHaveLength(0);
    const events = await t.adminSql<{ event_type: string }[]>`
      SELECT event_type FROM outbox_events WHERE (payload->>'transactionId') = ${tx.id} ORDER BY id`;
    const types = events.map((e) => e.event_type);
    for (const e of ['payment.checkout_created', 'payment.secured', 'purchase.proof_submitted', 'delivery.pin_ready', 'payout.scheduled', 'receipt.final_available']) {
      expect(types).toContain(e);
    }
  });

  it('payout processor pays the traveler; all held buckets are zero', async () => {
    const r = await processPayouts(t.deps);
    expect(r.paid).toBe(1);
    const [po] = await t.adminSql<{ status: string }[]>`SELECT status FROM payouts WHERE transaction_id = ${tx.id}`;
    expect(po!.status).toBe('PAID');
    expect(t.payment.payouts).toHaveLength(1);
    const l = await txLedger(t, tx.id);
    for (const b of ['PRODUCT_FUND', 'CUSTOMS_RESERVE', 'CLEARING', 'REFUND', 'TRAVELER_EARNING', 'PROMOTION_CREDIT']) expect(l[b] ?? 0).toBe(0);
    const customs = lineAmount(quote, 'CUSTOMS_DUTY') + lineAmount(quote, 'IMPORT_TAX');
    const payout = lineAmount(quote, 'ITEM_PRICE') + lineAmount(quote, 'TRAVELER_FEE') + customs;
    // Cash left at the provider = platform take: revenue + tax + payment fee.
    expect(-l.PROVIDER_CASH!).toBe(quote.totalIdr - payout);
    expect(-l.PROVIDER_CASH!).toBe(l.PLATFORM_REVENUE! + l.TAX_PAYABLE! + l.PAYMENT_FEE!);
    // ledger_balances view: traveler earning account fully paid out, platform accounts carry the take.
    expect(await accountBalance(t, 'TRAVELER_EARNING', p.traveler.id)).toBe(0);
    expect(await accountBalance(t, 'REFUND', p.buyer.id)).toBe(0);
    expect(await accountBalance(t, 'PRODUCT_FUND')).toBe(0);
    expect(await accountBalance(t, 'CUSTOMS_RESERVE')).toBe(0);
    expect(await accountBalance(t, 'CLEARING')).toBe(0);
    expect(await accountBalance(t, 'PLATFORM_REVENUE')).toBe(lineAmount(quote, 'PLATFORM_FEE') + lineAmount(quote, 'PROTECTION_FEE'));
    expect(await accountBalance(t, 'TAX_PAYABLE')).toBe(lineAmount(quote, 'SERVICE_TAX'));
    const [bal] = await t.adminSql<{ unbalanced: number }[]>`
      SELECT count(*)::int AS unbalanced FROM (
        SELECT journal_id FROM ledger_entries GROUP BY journal_id
        HAVING sum(CASE direction WHEN 'DEBIT' THEN amount ELSE -amount END) <> 0) x`;
    expect(bal!.unbalanced).toBe(0);
  });

  it('timeline lists every transition; payouts/mine shows the paid payout with a masked account', async () => {
    const tl = await call(t, p.buyer, 'GET', `/v1/transactions/${tx.id}/timeline`);
    expect(tl.status).toBe(200);
    expect(tl.body.events.map((e: any) => e.to)).toEqual([
      'REQUEST_CREATED', 'MATCHED', 'AWAITING_PAYMENT', 'PAYMENT_SECURED', 'PURCHASE_APPROVED', 'PURCHASED', 'TRAVELING', 'ARRIVED', 'READY_FOR_HANDOVER', 'DELIVERED', 'BUYER_CONFIRMED', 'COMPLETED',
    ]);
    const mine = await call(t, p.traveler, 'GET', '/v1/payouts/mine');
    expect(mine.status).toBe(200);
    expect(mine.body.data[0].status).toBe('PAID');
    expect(mine.body.data[0].destination.accountMask).toMatch(/^\*{4}\d{4}$/);
    expect(mine.body.summary.paidIdr).toBe(
      lineAmount(quote, 'ITEM_PRICE') + lineAmount(quote, 'TRAVELER_FEE') + lineAmount(quote, 'CUSTOMS_DUTY') + lineAmount(quote, 'IMPORT_TAX'),
    );
    const list = await call(t, p.buyer, 'GET', '/v1/transactions?role=buyer');
    expect(list.body.data[0]).toMatchObject({ id: tx.id, status: 'COMPLETED', role: 'BUYER' });
  });

  it('the audit hash chain is intact', async () => {
    const [row] = await t.adminSql<{ ok: boolean }[]>`SELECT verify_audit_chain() IS NULL AS ok`;
    expect(row!.ok).toBe(true);
  });
});
