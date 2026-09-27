import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../../../test/helpers';
import { processPayouts } from '../payouts/service';
import {
  call,
  createFile,
  createMatchedTx,
  idem,
  quoteAndPay,
  seedFx,
  setTripStatus,
  setupParties,
  txStatus,
  type MatchedTx,
  type Parties,
} from '../transactions/test-fixtures';

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

async function approvedTx(o: Parameters<typeof createMatchedTx>[2] = {}) {
  const tx = await createMatchedTx(t, p, o);
  await quoteAndPay(t, p, tx);
  const chk = await call(t, p.traveler, 'POST', `/v1/transactions/${tx.id}/price-check`, { actualUnitPriceMinor: o.unitPriceMinor ?? 20000, currency: 'JPY' });
  expect(chk.body.transactionStatus).toBe('PURCHASE_APPROVED');
  return tx;
}

async function proofBody(content?: string, extra: Record<string, unknown> = {}) {
  return {
    receiptFileId: await createFile(t, p.traveler.id, 'RECEIPT', content ? { content } : {}),
    productPhotoFileIds: [await createFile(t, p.traveler.id, 'PRODUCT_PHOTO')],
    merchantName: 'Yodobashi Camera',
    actualPriceMinor: 20000,
    currency: 'JPY',
    purchasedAt: t.clock.now().toISOString(),
    ...extra,
  };
}

async function deliverAndComplete(tx: MatchedTx) {
  await setTripStatus(t, tx.tripId, ['ACTIVE', 'TRAVELING']);
  for (const to of ['TRAVELING', 'ARRIVED', 'READY_FOR_HANDOVER']) {
    const r = await call(t, p.traveler, 'POST', `/v1/transactions/${tx.id}/status`, { to });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  }
  await call(t, p.traveler, 'POST', `/v1/transactions/${tx.id}/delivery`, { method: 'MEETUP', meetupPoint: 'Grand Indonesia' });
  const pin = await call(t, p.buyer, 'GET', `/v1/transactions/${tx.id}/delivery/pin`);
  await call(t, p.traveler, 'POST', `/v1/transactions/${tx.id}/delivery/verify`, { pin: pin.body.pin });
  return call(t, p.buyer, 'POST', `/v1/transactions/${tx.id}/confirm-receipt`, undefined, idem());
}

describe('purchase proof (golden rule)', () => {
  it('traveler cannot submit proof before PURCHASE_APPROVED (PAYMENT_SECURED)', async () => {
    const tx = await createMatchedTx(t, p);
    await quoteAndPay(t, p, tx);
    const res = await call(t, p.traveler, 'POST', `/v1/transactions/${tx.id}/purchase-proof`, await proofBody());
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('PURCHASE_NOT_APPROVED');
    expect(res.body.error.details.banner).toBe('DO_NOT_PURCHASE');
    expect(await txStatus(t, tx.id)).toBe('PAYMENT_SECURED');
  });

  it('purchase above the approved ceiling is rejected', async () => {
    const tx = await approvedTx();
    const res = await call(t, p.traveler, 'POST', `/v1/transactions/${tx.id}/purchase-proof`, await proofBody(undefined, { actualPriceMinor: 20001 }));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('PURCHASE_PRICE_EXCEEDS_APPROVED');
    expect(await txStatus(t, tx.id)).toBe('PURCHASE_APPROVED');
    const wrongCcy = await call(t, p.traveler, 'POST', `/v1/transactions/${tx.id}/purchase-proof`, await proofBody(undefined, { currency: 'USD' }));
    expect(wrongCcy.body.error.code).toBe('CURRENCY_MISMATCH');
  });

  it('files must belong to the traveler; the buyer cannot submit', async () => {
    const tx = await approvedTx();
    const foreign = await createFile(t, p.buyer.id, 'RECEIPT');
    const res = await call(t, p.traveler, 'POST', `/v1/transactions/${tx.id}/purchase-proof`, { ...(await proofBody()), receiptFileId: foreign });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('FILE_INVALID');
    const asBuyer = await call(t, p.buyer, 'POST', `/v1/transactions/${tx.id}/purchase-proof`, await proofBody());
    expect(asBuyer.status).toBe(403);
  });

  it('category requiring a serial number (ELECTRONICS_AUDIO) rejects proofs without it', async () => {
    const tx = await approvedTx({ categoryCode: 'ELECTRONICS_AUDIO', productName: 'Sony WH-1000XM6' });
    const res = await call(t, p.traveler, 'POST', `/v1/transactions/${tx.id}/purchase-proof`, await proofBody());
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('SERIAL_REQUIRED');
    const ok = await call(t, p.traveler, 'POST', `/v1/transactions/${tx.id}/purchase-proof`, await proofBody(undefined, { serialNumber: 'SN-XM6-0001' }));
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
  });

  it('receipt reuse across transactions is FLAGGED → risk review + payout ON_HOLD', async () => {
    const tx1 = await approvedTx();
    const first = await call(t, p.traveler, 'POST', `/v1/transactions/${tx1.id}/purchase-proof`, await proofBody('same-receipt-bytes'));
    expect(first.body).toMatchObject({ status: 'ACCEPTED', flagged: false });
    const tx2 = await approvedTx();
    const second = await call(t, p.traveler, 'POST', `/v1/transactions/${tx2.id}/purchase-proof`, await proofBody('same-receipt-bytes'));
    expect(second.status).toBe(201);
    expect(second.body).toMatchObject({ status: 'FLAGGED', flagged: true, transactionStatus: 'PURCHASED' });
    const [risk] = await t.adminSql<{ decision: string; reasons: { code: string }[] }[]>`
      SELECT a.decision, a.reasons FROM risk_assessments a JOIN purchase_proofs pp ON pp.id = a.subject_id WHERE pp.transaction_id = ${tx2.id}`;
    expect(risk!.decision).toBe('HOLD');
    expect(risk!.reasons.map((r) => r.code)).toContain('DUPLICATE_RECEIPT_IMAGE');
    const [ev] = await t.adminSql<{ payload: { flagged: boolean } }[]>`SELECT payload FROM outbox_events WHERE event_type = 'purchase.proof_submitted' AND aggregate_id = ${tx2.id}`;
    expect(ev!.payload.flagged).toBe(true);
    const done = await deliverAndComplete(tx2);
    expect(done.body.transactionStatus).toBe('COMPLETED');
    const [po] = await t.adminSql<{ status: string; hold_reason: string }[]>`SELECT status, hold_reason FROM payouts WHERE transaction_id = ${tx2.id}`;
    expect(po!.status).toBe('ON_HOLD');
    expect(po!.hold_reason).toContain('PURCHASE_PROOF_FLAGGED');
    const run = await processPayouts(t.deps, { transactionId: tx2.id });
    expect(run.paid).toBe(0);
    const [hold] = await t.adminSql`SELECT 1 FROM outbox_events WHERE event_type = 'payout.on_hold' AND payload->>'transactionId' = ${tx2.id}`;
    expect(hold).toBeTruthy();
  });

  it('merchant: brand store vs URL domain is a match; a different merchant is only a low-weight REVIEW signal (payout not held)', async () => {
    // request created from a URL (merchant = domain) → proof names the official brand store → no signal at all
    const txA = await approvedTx({ merchantName: 'pokemoncenter-online.com' });
    const a = await call(t, p.traveler, 'POST', `/v1/transactions/${txA.id}/purchase-proof`, await proofBody('brand-store-receipt', { merchantName: 'Pokemon Center Tokyo DX' }));
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(a.body).toMatchObject({ status: 'ACCEPTED', flagged: false });
    // a genuinely different shop → soft MERCHANT_MISMATCH: accepted, REVIEW risk assessment, no payout hold
    const txB = await approvedTx({ merchantName: 'uniqlo.com' });
    const b = await call(t, p.traveler, 'POST', `/v1/transactions/${txB.id}/purchase-proof`, await proofBody('other-shop-receipt', { merchantName: 'Don Quijote Shibuya' }));
    expect(b.body).toMatchObject({ status: 'ACCEPTED', flagged: false });
    const [risk] = await t.adminSql<{ decision: string; reasons: { code: string; weight?: number }[] }[]>`
      SELECT a.decision, a.reasons FROM risk_assessments a JOIN purchase_proofs pp ON pp.id = a.subject_id WHERE pp.transaction_id = ${txB.id}`;
    expect(risk!.decision).toBe('REVIEW');
    expect(risk!.reasons.map((r) => r.code)).toEqual(['MERCHANT_MISMATCH']);
    const [hold] = await t.adminSql<{ payout_hold_reason: string | null }[]>`SELECT payout_hold_reason FROM transactions WHERE id = ${txB.id}`;
    expect(hold!.payout_hold_reason).toBeNull();
    const done = await deliverAndComplete(txB);
    expect(done.body.transactionStatus).toBe('COMPLETED');
    await processPayouts(t.deps, { transactionId: txB.id });
    const [po] = await t.adminSql<{ status: string }[]>`SELECT status FROM payouts WHERE transaction_id = ${txB.id}`;
    expect(po!.status).toBe('PAID');
  });

  it('proof with purchase time before PAYMENT_SECURED is flagged', async () => {
    const tx = await approvedTx();
    const res = await call(t, p.traveler, 'POST', `/v1/transactions/${tx.id}/purchase-proof`, await proofBody(undefined, { purchasedAt: new Date(t.clock.now().getTime() - 86400_000).toISOString() }));
    expect(res.body.flagged).toBe(true);
  });
});

describe('travel status & customs', () => {
  it('CUSTOMS_PROCESS → READY_FOR_HANDOVER needs a customs declaration (with receipt when paid)', async () => {
    const tx = await approvedTx();
    await call(t, p.traveler, 'POST', `/v1/transactions/${tx.id}/purchase-proof`, await proofBody());
    await setTripStatus(t, tx.tripId, ['ACTIVE', 'TRAVELING']);
    for (const to of ['TRAVELING', 'ARRIVED', 'CUSTOMS_PROCESS']) {
      expect((await call(t, p.traveler, 'POST', `/v1/transactions/${tx.id}/status`, { to })).status).toBe(200);
    }
    const blocked = await call(t, p.traveler, 'POST', `/v1/transactions/${tx.id}/status`, { to: 'READY_FOR_HANDOVER' });
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.code).toBe('CUSTOMS_PROOF_MISSING');
    const noReceipt = await call(t, p.traveler, 'POST', `/v1/transactions/${tx.id}/customs-declaration`, { dutyPaidIdr: 100000, vatPaidIdr: 0, incomeTaxPaidIdr: 0 });
    expect(noReceipt.body.error.code).toBe('CUSTOMS_RECEIPT_REQUIRED');
    const receipt = await createFile(t, p.traveler.id, 'RECEIPT');
    const decl = await call(t, p.traveler, 'POST', `/v1/transactions/${tx.id}/customs-declaration`, { dutyPaidIdr: 100000, vatPaidIdr: 50000, incomeTaxPaidIdr: 0, receiptFileId: receipt });
    expect(decl.status).toBe(200);
    const ok = await call(t, p.traveler, 'POST', `/v1/transactions/${tx.id}/status`, { to: 'READY_FOR_HANDOVER' });
    expect(ok.body.transactionStatus).toBe('READY_FOR_HANDOVER');
    const back = await call(t, p.traveler, 'POST', `/v1/transactions/${tx.id}/status`, { to: 'TRAVELING' });
    expect(back.status).toBe(422);
  });
});
