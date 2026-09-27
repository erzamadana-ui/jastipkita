/**
 * Client contract (Flutter / admin): typed transaction detail & list, cancellation preview, per-channel payment
 * options. Responses are validated against the published zod/OpenAPI schemas, not just spot-checked.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_BUSINESS_CONFIG } from '@jastipkita/core';
import { createTestContext, type TestContext } from '../../../test/helpers';
import { paymentOptionsFor } from '../checkout/service';
import { CancellationPreviewSchema } from '../cancellation/routes';
import { QuoteSchema, TransactionDetailSchema, TransactionListSchema } from './schemas';
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
  txStatus,
  type MatchedTx,
  type Parties,
} from './test-fixtures';

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

function expectSchema(schema: { safeParse: (v: unknown) => { success: boolean; error?: unknown } }, body: unknown) {
  const r = schema.safeParse(body);
  expect(r.success, JSON.stringify((r as { error?: { issues?: unknown } }).error ?? null)).toBe(true);
}

/** PAYMENT_SECURED → PURCHASE_APPROVED → PURCHASED through the real API. */
async function purchase(tx: MatchedTx) {
  const pc = await call(t, p.traveler, 'POST', `/v1/transactions/${tx.id}/price-check`, { actualUnitPriceMinor: 20000, currency: 'JPY' });
  expect(pc.status, JSON.stringify(pc.body)).toBe(200);
  const pp = await call(t, p.traveler, 'POST', `/v1/transactions/${tx.id}/purchase-proof`, {
    receiptFileId: await createFile(t, p.traveler.id, 'RECEIPT'),
    productPhotoFileIds: [await createFile(t, p.traveler.id, 'PRODUCT_PHOTO'), await createFile(t, p.traveler.id, 'PRODUCT_PHOTO')],
    merchantName: 'Yodobashi Camera Akiba',
    actualPriceMinor: 20000,
    currency: 'JPY',
    purchasedAt: t.clock.now().toISOString(),
  });
  expect(pp.status, JSON.stringify(pp.body)).toBe(201);
}

describe('GET /v1/transactions/{id} & list — typed contract', () => {
  it('detail carries item, public profiles, trip route, ceiling, proof files, delivery (no PIN), payout, conversationId', async () => {
    const tx = await createMatchedTx(t, p, { productName: 'Figur Gundam RX-78 Master Grade' });
    await t.adminSql`INSERT INTO request_images (request_id, source_url, sort) VALUES (${tx.requestId}, 'https://img.example.com/gundam.jpg', 0)`;
    const [avatar] = await t.adminSql<{ id: string }[]>`
      INSERT INTO files (owner_id, purpose, storage_provider, storage_key, mime, size_bytes, scan_status, scanned_at, completed_at)
      VALUES (${p.buyer.id}, 'AVATAR', 'MOCK', ${`test/${crypto.randomUUID()}`}, 'image/jpeg', 10, 'CLEAN', now(), now()) RETURNING id`;
    await t.adminSql`UPDATE users SET avatar_file_id = ${avatar!.id}, trust_score = 72 WHERE id = ${p.buyer.id}`;

    const { quote } = await quoteAndPay(t, p, tx);
    await purchase(tx);
    const del = await call(t, p.traveler, 'POST', `/v1/transactions/${tx.id}/delivery`, { method: 'MEETUP', meetupPoint: 'Stasiun MRT Bundaran HI' });
    expect(del.status, JSON.stringify(del.body)).toBe(200);

    const b = await call(t, p.buyer, 'GET', `/v1/transactions/${tx.id}`);
    expect(b.status).toBe(200);
    expectSchema(TransactionDetailSchema, b.body);
    expect(b.body.item).toMatchObject({
      productName: 'Figur Gundam RX-78 Master Grade',
      merchantName: 'Yodobashi Camera',
      merchantCountry: 'JP',
      categoryCode: 'TOYS_HOBBIES',
      variant: null,
      quantity: 1,
      unitPriceMinor: 20000,
      currency: 'JPY',
      priceCurrency: 'JPY',
      imageUrl: 'https://img.example.com/gundam.jpg',
    });
    expect(b.body.buyer).toMatchObject({
      id: p.buyer.id,
      displayName: 'Penitip U.',
      avatarUrl: `http://api.test/v1/files/${avatar!.id}/content`,
      trustScore: 72,
      trustTier: { tier: 'GOOD', label: 'Baik', labelEn: 'Good' },
      kycLevel: 3,
      ratingSummary: { asTraveler: { average: null, count: 0 }, asBuyer: { average: null, count: 0 } },
    });
    expect(b.body.traveler).toMatchObject({ id: p.traveler.id, displayName: 'Traveler U.', avatarUrl: null, kycLevel: 4 });
    expect(JSON.stringify([b.body.buyer, b.body.traveler])).not.toMatch(/Uji|@|\+62/);
    expect(b.body.trip).toMatchObject({ id: tx.tripId, originCountry: 'JP', originCity: 'Tokyo', destinationCountry: 'ID', destinationCity: 'Jakarta' });
    expect(b.body.trip.departureDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(b.body.purchaseCeilingIdr).toBeGreaterThan(0);
    expect(b.body.purchaseCeiling).toEqual({ minor: expect.any(Number), idr: b.body.purchaseCeilingIdr });
    expect(b.body.deliveryMethod).toBe('MEETUP');
    expect(b.body.payout).toBeNull();
    expect(b.body.quote.quoteId).toBe(quote.quoteId);
    expect(b.body.quote.paymentOptions.map((o: any) => o.channel)).toEqual(['VA', 'QRIS', 'EWALLET', 'CARD']);
    // purchase proof: both parties see the evidence files it references (absolute URLs), never fraud data
    expect(b.body.purchaseProof.files.map((f: any) => f.kind)).toEqual(['RECEIPT', 'PRODUCT_PHOTO', 'PRODUCT_PHOTO']);
    for (const f of b.body.purchaseProof.files) {
      expect(f.contentUrl).toBe(`http://api.test/v1/files/${f.id}/content`);
      expect(f.mime).toBe('image/jpeg');
    }
    expect(JSON.stringify(b.body.purchaseProof)).not.toMatch(/fraud/i);
    expect(b.body.purchaseProof.serialNumber).toBeNull();
    // delivery: buyer learns a PIN can be revealed; the PIN/QR and their hashes never appear
    expect(b.body.delivery).toMatchObject({ method: 'MEETUP', pinAvailable: true, pin: { locked: false, revealEndpoint: `/v1/transactions/${tx.id}/delivery/pin` } });
    expect(JSON.stringify(b.body)).not.toMatch(/pinHash|qrTokenHash|pin_hash|qr_token/);
    expect(b.body.allowedActions).toContain('VIEW_HANDOVER_PIN');
    // conversation: created by the MATCHED outbox handler
    expect(b.body.conversationId).toBeNull();
    await t.drain();
    const [conv] = await t.adminSql<{ id: string }[]>`SELECT id FROM conversations WHERE transaction_id = ${tx.id}`;
    expect((await call(t, p.buyer, 'GET', `/v1/transactions/${tx.id}`)).body.conversationId).toBe(conv!.id);

    const tr = await call(t, p.traveler, 'GET', `/v1/transactions/${tx.id}`);
    expectSchema(TransactionDetailSchema, tr.body);
    expect(tr.body.delivery).not.toHaveProperty('pinAvailable');
    expect(tr.body.delivery.pin).not.toHaveProperty('revealEndpoint');
    expect(tr.body.item.maxBudgetIdr).toBeNull();
    expect(tr.body.purchaseGate.banner).toBe('ALREADY_PURCHASED');

    // list: compact summary with image, counterparty and total
    const lb = await call(t, p.buyer, 'GET', '/v1/transactions?role=buyer&limit=5');
    expectSchema(TransactionListSchema, lb.body);
    const row = lb.body.data.find((x: any) => x.id === tx.id);
    expect(row).toMatchObject({
      number: tx.number,
      status: 'PURCHASED',
      totalIdr: quote.totalIdr,
      item: { productName: 'Figur Gundam RX-78 Master Grade', imageUrl: 'https://img.example.com/gundam.jpg' },
      counterparty: { id: p.traveler.id, role: 'TRAVELER', displayName: 'Traveler U.', avatarUrl: null },
    });
    expect(row.updatedAt).toMatch(/Z$/);
    const lt = await call(t, p.traveler, 'GET', '/v1/transactions?role=traveler&limit=5');
    expect(lt.body.data.find((x: any) => x.id === tx.id).counterparty).toEqual({
      id: p.buyer.id,
      role: 'BUYER',
      displayName: 'Penitip U.',
      avatarUrl: `http://api.test/v1/files/${avatar!.id}/content`,
    });

    // through handover → completion: the traveler (only) sees the payout
    await setTripStatus(t, tx.tripId, ['ACTIVE', 'TRAVELING']);
    for (const to of ['TRAVELING', 'ARRIVED', 'READY_FOR_HANDOVER']) {
      expect((await call(t, p.traveler, 'POST', `/v1/transactions/${tx.id}/status`, { to })).status).toBe(200);
    }
    const pin = await call(t, p.buyer, 'GET', `/v1/transactions/${tx.id}/delivery/pin`);
    expect((await call(t, p.traveler, 'POST', `/v1/transactions/${tx.id}/delivery/verify`, { pin: pin.body.pin })).status).toBe(200);
    expect((await call(t, p.buyer, 'GET', `/v1/transactions/${tx.id}`)).body.delivery.pinAvailable).toBe(false);
    expect((await call(t, p.buyer, 'POST', `/v1/transactions/${tx.id}/confirm-receipt`, {}, idem())).status).toBe(200);
    const done = await call(t, p.traveler, 'GET', `/v1/transactions/${tx.id}`);
    expectSchema(TransactionDetailSchema, done.body);
    expect(done.body.status).toBe('COMPLETED');
    expect(done.body.payout).toMatchObject({ status: expect.stringMatching(/SCHEDULED|ON_HOLD|PROCESSING|PAID/), amountIdr: expect.any(Number) });
    expect(done.body.payout.scheduledAt).toMatch(/Z$/);
    expect((await call(t, p.buyer, 'GET', `/v1/transactions/${tx.id}`)).body.payout).toBeNull();
  });
});

describe('GET /v1/transactions/{id}/cancel/preview', () => {
  it('before payment: allowed, no refund, and no side effects', async () => {
    const tx = await createMatchedTx(t, p);
    const [cBefore] = await t.adminSql<{ n: number }[]>`SELECT count(*)::int AS n FROM transaction_events WHERE transaction_id = ${tx.id}`;
    const res = await call(t, p.buyer, 'GET', `/v1/transactions/${tx.id}/cancel/preview`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expectSchema(CancellationPreviewSchema, res.body);
    expect(res.body).toMatchObject({ actor: 'BUYER', allowed: true, canCancel: true, stage: 'AFTER_MATCH', refundIdr: 0, transitionPath: ['CANCELLED'], blockedBy: null });
    expect(await txStatus(t, tx.id)).toBe('MATCHED');
    const [cAfter] = await t.adminSql<{ n: number }[]>`SELECT count(*)::int AS n FROM transaction_events WHERE transaction_id = ${tx.id}`;
    expect(cAfter!.n).toBe(cBefore!.n);
    // validation / access
    expect((await t.request('GET', `/v1/transactions/${tx.id}/cancel/preview`, { token: (await t.createUser()).accessToken })).status).toBe(404);
    expect((await call(t, p.buyer, 'GET', `/v1/transactions/${tx.id}/cancel/preview?cause=bad`)).status).toBe(400);
    const na = await call(t, p.buyer, 'GET', `/v1/transactions/${tx.id}/cancel/preview?cause=PRICE_CHANGE_REJECTED`);
    expect(na.status).toBe(422);
    expect(na.body.error.code).toBe('CAUSE_NOT_APPLICABLE');
  });

  it('after payment: the preview equals what POST /cancel then does (refund, per line, compensation, penalty)', async () => {
    const tx = await createMatchedTx(t, p);
    const { quote } = await quoteAndPay(t, p, tx);
    const asTraveler = await call(t, p.traveler, 'GET', `/v1/transactions/${tx.id}/cancel/preview`);
    expect(asTraveler.body).toMatchObject({ actor: 'TRAVELER', stage: 'AFTER_PAYMENT', paymentCaptured: true });
    const preview = await call(t, p.buyer, 'GET', `/v1/transactions/${tx.id}/cancel/preview`);
    expectSchema(CancellationPreviewSchema, preview.body);
    expect(preview.body).toMatchObject({ actor: 'BUYER', stage: 'AFTER_PAYMENT', paymentCaptured: true, paidIdr: quote.totalIdr, canCancel: true });
    const sumByLine = Object.values(preview.body.refundByLine as Record<string, number>).reduce((a, b) => a + b, 0);
    expect(sumByLine).toBeGreaterThanOrEqual(preview.body.refundIdr);
    const res = await call(t, p.buyer, 'POST', `/v1/transactions/${tx.id}/cancel`, { reason: 'Berubah pikiran' }, idem());
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.cancellation).toMatchObject({
      stage: preview.body.stage,
      refundIdr: preview.body.refundIdr,
      travelerCompensationIdr: preview.body.travelerCompensationIdr,
      platformRetainedIdr: preview.body.platformRetainedIdr,
      paymentFeeRetainedIdr: preview.body.paymentFeeRetainedIdr,
      trustPenalty: preview.body.trustPenalty,
    });
    const [refund] = await t.adminSql<{ breakdown: any }[]>`SELECT breakdown FROM refunds WHERE transaction_id = ${tx.id}`;
    expect(refund!.breakdown.cancellation.refundByLine).toEqual(preview.body.refundByLine);
  });

  it('after purchase: not allowed — preview returns the 422 POST /cancel would give', async () => {
    const tx = await createMatchedTx(t, p);
    await quoteAndPay(t, p, tx);
    await purchase(tx);
    const preview = await call(t, p.buyer, 'GET', `/v1/transactions/${tx.id}/cancel/preview`);
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ allowed: false, canCancel: false, stage: 'AFTER_PURCHASE', blockedBy: { code: 'CANCELLATION_NOT_ALLOWED' } });
    const res = await call(t, p.buyer, 'POST', `/v1/transactions/${tx.id}/cancel`, { reason: 'Tidak jadi' }, idem());
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe(preview.body.blockedBy.code);
    expect(res.body.error.message).toBe(preview.body.blockedBy.message);
  });
});

describe('quote paymentOptions', () => {
  it('fee & total for every configured channel, identical to re-quoting with that channel', async () => {
    const tx = await createMatchedTx(t, p);
    const q = await call(t, p.buyer, 'POST', `/v1/transactions/${tx.id}/quote`, { channel: 'QRIS' });
    expect(q.status, JSON.stringify(q.body)).toBe(201);
    expectSchema(QuoteSchema, q.body);
    const opts = q.body.paymentOptions as any[];
    expect(opts.map((o) => o.channel)).toEqual(['VA', 'QRIS', 'EWALLET', 'CARD']);
    const payable = q.body.totalIdr - lineAmount(q.body, 'PAYMENT_FEE');
    for (const o of opts) expect(o.totalIdr).toBe(payable + o.feeIdr);
    const qris = opts.find((o) => o.channel === 'QRIS');
    expect(qris).toMatchObject({ selected: true, feeIdr: lineAmount(q.body, 'PAYMENT_FEE'), totalIdr: q.body.totalIdr, refundable: true, maxAmountIdr: 10_000_000, available: true, bearer: 'BUYER' });
    const va = opts.find((o) => o.channel === 'VA');
    expect(va).toMatchObject({ selected: false, refundable: false, feeIdr: 4500, maxAmountIdr: 50_000_000, minAmountIdr: 10_000 });
    expect(opts.find((o) => o.channel === 'EWALLET').refundable).toBe(true);

    for (const ch of ['VA', 'CARD']) {
      const rq = await call(t, p.buyer, 'POST', `/v1/transactions/${tx.id}/quote`, { channel: ch });
      expect(rq.status).toBe(201);
      const predicted = opts.find((o) => o.channel === ch);
      expect(rq.body.totalIdr, ch).toBe(predicted.totalIdr);
      expect(lineAmount(rq.body, 'PAYMENT_FEE'), ch).toBe(predicted.feeIdr);
      expect(rq.body.paymentOptions.find((o: any) => o.selected).channel).toBe(ch);
    }
    const detail = await call(t, p.buyer, 'GET', `/v1/transactions/${tx.id}`);
    expect(detail.body.quote.paymentOptions.find((o: any) => o.selected).channel).toBe('CARD');
  });

  it('flags channels whose nominal cap the total exceeds (QRIS Rp10.000.000)', () => {
    const opts = paymentOptionsFor(10_000_000, DEFAULT_BUSINESS_CONFIG['pricing.payment_fees'], 'VA');
    expect(opts.find((o) => o.channel === 'QRIS')).toMatchObject({ available: false, unavailableReason: 'ABOVE_CHANNEL_MAX', maxAmountIdr: 10_000_000 });
    expect(opts.find((o) => o.channel === 'VA')).toMatchObject({ available: true, selected: true, feeIdr: 4500, totalIdr: 10_004_500 });
    const tiny = paymentOptionsFor(5_000, DEFAULT_BUSINESS_CONFIG['pricing.payment_fees'], 'QRIS');
    expect(tiny.find((o) => o.channel === 'VA')).toMatchObject({ available: false, unavailableReason: 'BELOW_CHANNEL_MIN' });
    expect(paymentOptionsFor(0, DEFAULT_BUSINESS_CONFIG['pricing.payment_fees'], 'QRIS').every((o) => o.feeIdr === 0)).toBe(true);
  });
});
