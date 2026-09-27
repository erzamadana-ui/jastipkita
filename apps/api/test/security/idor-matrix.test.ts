/**
 * IDOR / role matrix (security review 2026-09, scope item 2). Builds one real object graph — a paid, purchased
 * transaction (buyer A, traveler B) with conversation, dispute, refund, support ticket, notification, files,
 * trip, request, pending offer, payout account, session and device — and asserts, for EVERY user route that takes
 * a path id:
 *   - an unrelated, fully verified user C gets 403/404 (never data, never a state change);
 *   - the counterparty cannot run the other role's actions (buyer ↔ traveler);
 *   - C cannot read the delivery PIN, and valid bodies are sent so validation cannot mask a missing check.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { purchasedTx } from '../../src/modules/admin/test-support';
import { call, createFile, createPayoutAccount, idem, type Parties, type Party } from '../../src/modules/transactions/test-fixtures';
import { createTestContext, type TestContext } from '../helpers';

let t: TestContext;
let p: Parties;
let C: Party;
type Key = 'tx' | 'trip' | 'request' | 'conversation' | 'message' | 'receiptFile' | 'evidenceFile' | 'dispute' | 'evidence' | 'ticket'
  | 'notification' | 'refund' | 'openRequest' | 'offer' | 'strangerTrip' | 'kycFile' | 'payoutAccount' | 'session' | 'device' | 'pc';
const ids = {} as Record<Key, string>;

beforeAll(async () => {
  t = await createTestContext();
  const purchased = await purchasedTx(t);
  p = purchased.p;
  ids.tx = purchased.tx.id;
  ids.trip = purchased.tx.tripId;
  ids.request = purchased.tx.requestId;
  // the money fixture inserts the request directly; a matched request is MATCHED in production (not publicly listed)
  await t.adminSql`UPDATE requests SET status = 'MATCHED' WHERE id = ${ids.request}`;
  const c = await t.createUser({ kycLevel: 4, mode: 'TRAVELER', displayName: 'Stranger' });
  C = { ...c, tokenIssuedAt: t.clock.now().getTime() };
  await createPayoutAccount(t, C.id);

  const conv = await call(t, p.buyer, 'GET', `/v1/transactions/${ids.tx}/conversation`);
  expect(conv.status, JSON.stringify(conv.body)).toBe(200);
  ids.conversation = conv.body.id ?? conv.body.conversation?.id;
  expect(ids.conversation, JSON.stringify(conv.body)).toBeTruthy();
  const msg = await call(t, p.buyer, 'POST', `/v1/conversations/${ids.conversation}/messages`, { type: 'TEXT', body: 'halo, kapan sampai?' });
  expect(msg.status, JSON.stringify(msg.body)).toBe(201);
  ids.message = msg.body.id;

  const [pf] = await t.adminSql<{ receipt_file_id: string }[]>`SELECT receipt_file_id FROM purchase_proofs WHERE transaction_id = ${ids.tx}`;
  ids.receiptFile = pf!.receipt_file_id;
  ids.evidenceFile = await createFile(t, p.buyer.id, 'EVIDENCE');
  const d = await call(t, p.buyer, 'POST', `/v1/transactions/${ids.tx}/disputes`, { type: 'WRONG_ITEM', description: 'Barang yang dibeli berbeda warna dari pesanan saya.', requestedResolution: 'REFUND_FULL' });
  expect(d.status, JSON.stringify(d.body)).toBe(201);
  ids.dispute = d.body.id;
  const ev = await call(t, p.buyer, 'POST', `/v1/disputes/${ids.dispute}/evidence`, { type: 'PHOTO', fileId: ids.evidenceFile, note: 'foto barang' });
  expect(ev.status, JSON.stringify(ev.body)).toBe(201);
  ids.evidence = ev.body.id;

  const tk = await call(t, p.buyer, 'POST', '/v1/support/tickets', { category: 'TRANSACTION', subject: 'Pertanyaan transaksi', message: 'Halo tim, mohon bantu cek.', transactionId: ids.tx });
  expect(tk.status, JSON.stringify(tk.body)).toBe(201);
  ids.ticket = tk.body.id;

  await t.drain();
  const [n] = await t.adminSql<{ id: string }[]>`SELECT id FROM notifications WHERE user_id = ${p.buyer.id} LIMIT 1`;
  ids.notification = n!.id;
  const [rf] = await t.adminSql<{ id: string }[]>`
    INSERT INTO refunds (transaction_id, payment_id, amount_idr, reason_code, status, type, idempotency_key, breakdown)
    SELECT ${ids.tx}, id, 1000, 'OTHER', 'REQUESTED', 'PARTIAL', ${`sec-idor:${ids.tx}`}, '{"method":"PAYOUT_TO_BUYER"}'::jsonb
      FROM payments WHERE transaction_id = ${ids.tx} LIMIT 1
    RETURNING id`;
  ids.refund = rf!.id;

  // an OPEN request of A with a PENDING traveler offer from B
  const [rq] = await t.adminSql<{ id: string }[]>`
    INSERT INTO requests (buyer_id, source_type, product_name, merchant_country, category_code, quantity, unit_price_minor, price_currency,
                          destination_country, destination_city, status)
    VALUES (${p.buyer.id}, 'MANUAL', 'Sepatu lari', 'JP', 'TOYS_HOBBIES', 1, 10000, 'JPY', 'ID', 'Jakarta', 'OPEN') RETURNING id`;
  ids.openRequest = rq!.id;
  const [of] = await t.adminSql<{ id: string }[]>`
    INSERT INTO offers (request_id, trip_id, traveler_id, initiated_by, traveler_fee_idr, status, expires_at)
    VALUES (${ids.openRequest}, ${ids.trip}, ${p.traveler.id}, 'TRAVELER', 100000, 'PENDING', now() + interval '2 days') RETURNING id`;
  ids.offer = of!.id;
  const [cTrip] = await t.adminSql<{ id: string }[]>`
    INSERT INTO trips (traveler_id, origin_country, origin_city, destination_country, destination_city, departure_date, arrival_date, capacity_kg, fee_type, fee_value, status)
    VALUES (${C.id}, 'JP', 'Osaka', 'ID', 'Jakarta', current_date + 3, current_date + 4, 5, 'FIXED', 100000, 'DRAFT') RETURNING id`;
  ids.strangerTrip = cTrip!.id;

  ids.kycFile = await createFile(t, p.buyer.id, 'EVIDENCE');
  await t.adminSql`UPDATE files SET purpose = 'KYC', encrypted = true, enc_key_id = 'k1' WHERE id = ${ids.kycFile}`;
  ids.payoutAccount = p.payoutAccountId;
  ids.session = p.buyer.sessionId;
  const dev = await call(t, p.buyer, 'POST', '/v1/me/devices', { platform: 'ANDROID', fingerprint: `fp-${crypto.randomUUID()}` });
  expect(dev.status, JSON.stringify(dev.body)).toBeLessThan(300);
  ids.device = dev.body.id;
  ids.pc = crypto.randomUUID();
});
afterAll(() => t?.close());

type Case = [method: string, path: string, body?: unknown, headers?: Record<string, string>];

function strangerCases(): Case[] {
  const { tx, trip, request, openRequest, offer, conversation, dispute, evidence, refund, ticket, notification, receiptFile, kycFile, payoutAccount, session, device, pc, message, strangerTrip } = ids;
  return [
    ['DELETE', `/v1/auth/sessions/${session}`],
    ['DELETE', `/v1/me/devices/${device}`],
    ['POST', `/v1/files/${receiptFile}/complete`],
    ['GET', `/v1/files/${receiptFile}`],
    ['GET', `/v1/files/${receiptFile}/url`],
    ['GET', `/v1/files/${receiptFile}/content`],
    ['GET', `/v1/files/${kycFile}/content`],
    ['DELETE', `/v1/kyc/payout-accounts/${payoutAccount}`],
    ['POST', `/v1/kyc/payout-accounts/${payoutAccount}/default`],
    ['PATCH', `/v1/trips/${trip}`, { notes: 'hijack' }],
    ['POST', `/v1/trips/${trip}/verification`, { docType: 'ETICKET', fileId: receiptFile }],
    ['POST', `/v1/trips/${trip}/publish`],
    ['POST', `/v1/trips/${trip}/depart`],
    ['POST', `/v1/trips/${trip}/complete`],
    ['POST', `/v1/trips/${trip}/cancel`, { reason: 'Saya batalkan trip orang lain' }],
    ['GET', `/v1/trips/${trip}/recommended-requests`],
    ['PATCH', `/v1/requests/${request}`, { notes: 'hijack' }],
    ['PATCH', `/v1/requests/${openRequest}`, { notes: 'hijack' }],
    ['POST', `/v1/requests/${openRequest}/publish`, {}],
    ['POST', `/v1/requests/${openRequest}/cancel`, { reason: 'hijack' }],
    ['GET', `/v1/requests/${request}`],
    ['GET', `/v1/requests/${openRequest}/recommended-travelers`],
    ['GET', `/v1/requests/${request}/offers`],
    ['POST', `/v1/trips/${trip}/invites`, { requestId: openRequest }],
    ['POST', `/v1/offers/${offer}/accept`],
    ['POST', `/v1/offers/${offer}/decline`, { reason: 'hijack' }],
    ['POST', `/v1/offers/${offer}/withdraw`],
    ['GET', `/v1/transactions/${tx}`],
    ['GET', `/v1/transactions/${tx}/timeline`],
    ['POST', `/v1/transactions/${tx}/quote`, { channel: 'QRIS' }],
    ['POST', `/v1/transactions/${tx}/checkout`, { quoteId: crypto.randomUUID() }, idem()],
    ['GET', `/v1/transactions/${tx}/payment`],
    ['POST', `/v1/transactions/${tx}/price-check`, { actualUnitPriceMinor: 1, currency: 'JPY' }],
    ['POST', `/v1/transactions/${tx}/price-confirmations/${pc}/respond`, { action: 'APPROVE' }, idem()],
    ['POST', `/v1/transactions/${tx}/price-confirmations/${pc}/clarify`, { note: 'harga naik sedikit' }],
    ['POST', `/v1/transactions/${tx}/purchase-proof`, { receiptFileId: receiptFile, productPhotoFileIds: [receiptFile], merchantName: 'Toko Palsu', actualPriceMinor: 1, currency: 'JPY', purchasedAt: new Date().toISOString() }],
    ['POST', `/v1/transactions/${tx}/status`, { to: 'TRAVELING' }],
    ['POST', `/v1/transactions/${tx}/customs-declaration`, { dutyPaidIdr: 0, vatPaidIdr: 0, incomeTaxPaidIdr: 0 }],
    ['POST', `/v1/transactions/${tx}/delivery`, { method: 'MEETUP', meetupPoint: 'Monas' }],
    ['GET', `/v1/transactions/${tx}/delivery/pin`],
    ['POST', `/v1/transactions/${tx}/delivery/verify`, { pin: '123456' }],
    ['POST', `/v1/transactions/${tx}/delivery/shipped`, { trackingNumber: 'JNE123' }],
    ['POST', `/v1/transactions/${tx}/delivery/delivered`, { proofFileIds: [receiptFile] }],
    ['POST', `/v1/transactions/${tx}/confirm-receipt`, undefined, idem()],
    ['GET', `/v1/transactions/${tx}/cancel/preview`],
    ['POST', `/v1/transactions/${tx}/cancel`, { reason: 'hijack cancel' }, idem()],
    ['GET', `/v1/transactions/${tx}/refunds`],
    ['POST', `/v1/refunds/${refund}/destination`, { bankCode: 'BCA', accountNumber: '1234567890', accountHolderName: 'Penyerang' }],
    ['POST', `/v1/notifications/${notification}/read`],
    ['GET', `/v1/conversations/${conversation}`],
    ['GET', `/v1/transactions/${tx}/conversation`],
    ['GET', `/v1/conversations/${conversation}/messages`],
    ['POST', `/v1/conversations/${conversation}/messages`, { type: 'TEXT', body: 'hai' }],
    ['POST', `/v1/conversations/${conversation}/read`, { messageId: message }],
    ['POST', `/v1/transactions/${tx}/ratings`, { overall: 1 }],
    ['POST', `/v1/transactions/${tx}/disputes`, { type: 'OTHER', description: 'Saya pihak ketiga yang ingin ikut campur.' }],
    ['GET', `/v1/disputes/${dispute}`],
    ['POST', `/v1/disputes/${dispute}/evidence`, { type: 'OTHER', note: 'x' }],
    ['GET', `/v1/disputes/${dispute}/evidence/${evidence}/file-url`],
    ['POST', `/v1/disputes/${dispute}/appeal`, { reason: 'Saya tidak setuju dengan keputusan ini.' }],
    ['POST', `/v1/disputes/${dispute}/withdraw`, { reason: 'x' }],
    ['GET', `/v1/support/tickets/${ticket}`],
    ['POST', `/v1/support/tickets/${ticket}/messages`, { body: 'hai' }],
    // C cannot make an offer in the name of B's trip, nor invite C's own trip onto A's request
    ['POST', `/v1/requests/${openRequest}/offers`, { tripId: trip }],
    ['POST', `/v1/trips/${strangerTrip}/invites`, { requestId: openRequest }],
  ];
}

describe('IDOR matrix — unrelated verified user', () => {
  it('gets 403/404 on every user route with a path id (and no state changes)', async () => {
    const before = await t.adminSql`SELECT status, version FROM transactions WHERE id = ${ids.tx}`;
    const problems: string[] = [];
    for (const [method, path, body, headers] of strangerCases()) {
      const r = await call(t, C, method, path, body, headers ?? {});
      if (![403, 404].includes(r.status)) problems.push(`${method} ${path} → ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
    }
    expect(problems).toEqual([]);
    expect(await t.adminSql`SELECT status, version FROM transactions WHERE id = ${ids.tx}`).toEqual(before);
    const [dev] = await t.adminSql<{ revoked_at: Date | null }[]>`SELECT revoked_at FROM user_devices WHERE device_id = ${ids.device} AND user_id = ${p.buyer.id}`;
    expect(dev!.revoked_at).toBeNull();
    const [dest] = await t.adminSql<{ n: number }[]>`SELECT count(*)::int AS n FROM refund_destinations WHERE refund_id = ${ids.refund}`;
    expect(dest!.n).toBe(0);
  });
});

describe('role matrix — counterparty cannot act for the other role', () => {
  it('buyer cannot run traveler-only actions', async () => {
    const { tx, receiptFile, trip, pc } = ids;
    const cases: Case[] = [
      ['POST', `/v1/transactions/${tx}/price-check`, { actualUnitPriceMinor: 1, currency: 'JPY' }],
      ['POST', `/v1/transactions/${tx}/price-confirmations/${pc}/clarify`, { note: 'harga naik sedikit' }],
      ['POST', `/v1/transactions/${tx}/purchase-proof`, { receiptFileId: receiptFile, productPhotoFileIds: [receiptFile], merchantName: 'Toko Palsu', actualPriceMinor: 1, currency: 'JPY', purchasedAt: new Date().toISOString() }],
      ['POST', `/v1/transactions/${tx}/status`, { to: 'TRAVELING' }],
      ['POST', `/v1/transactions/${tx}/customs-declaration`, { dutyPaidIdr: 0, vatPaidIdr: 0, incomeTaxPaidIdr: 0 }],
      ['POST', `/v1/transactions/${tx}/delivery`, { method: 'MEETUP', meetupPoint: 'Monas' }],
      ['POST', `/v1/transactions/${tx}/delivery/verify`, { pin: '123456' }],
      ['POST', `/v1/transactions/${tx}/delivery/shipped`, { trackingNumber: 'JNE123' }],
      ['POST', `/v1/transactions/${tx}/delivery/delivered`, { proofFileIds: [receiptFile] }],
      ['PATCH', `/v1/trips/${trip}`, { notes: 'x' }],
      ['POST', `/v1/offers/${ids.offer}/withdraw`],
    ];
    const problems: string[] = [];
    for (const [m, path, body, headers] of cases) {
      const r = await call(t, p.buyer, m, path, body, headers ?? {});
      if (![403, 404].includes(r.status)) problems.push(`${m} ${path} → ${r.status} ${r.body?.error?.code}`);
    }
    expect(problems).toEqual([]);
  });

  it('traveler cannot run buyer-only actions nor read the delivery PIN', async () => {
    const { tx, refund, pc } = ids;
    const cases: Case[] = [
      ['POST', `/v1/transactions/${tx}/quote`, { channel: 'QRIS' }],
      ['POST', `/v1/transactions/${tx}/checkout`, { quoteId: crypto.randomUUID() }, idem()],
      ['POST', `/v1/transactions/${tx}/price-confirmations/${pc}/respond`, { action: 'APPROVE' }, idem()],
      ['GET', `/v1/transactions/${tx}/delivery/pin`],
      ['POST', `/v1/transactions/${tx}/confirm-receipt`, undefined, idem()],
      ['POST', `/v1/refunds/${refund}/destination`, { bankCode: 'BCA', accountNumber: '1234567890', accountHolderName: 'Traveler' }],
      ['PATCH', `/v1/requests/${ids.openRequest}`, { notes: 'x' }],
      ['POST', `/v1/offers/${ids.offer}/accept`],
    ];
    const problems: string[] = [];
    for (const [m, path, body, headers] of cases) {
      const r = await call(t, p.traveler, m, path, body, headers ?? {});
      if (![403, 404].includes(r.status)) problems.push(`${m} ${path} → ${r.status} ${r.body?.error?.code}`);
    }
    expect(problems).toEqual([]);
    const detail = await call(t, p.traveler, 'GET', `/v1/transactions/${tx}`);
    expect(JSON.stringify(detail.body)).not.toMatch(/pin_hash|pinHash|qr_token|account_number_enc|_enc"/);
  });

  it('the counterparty sees the shared receipt but never the other party\'s KYC document', async () => {
    expect((await call(t, p.buyer, 'GET', `/v1/files/${ids.receiptFile}`)).status).toBe(200);
    expect((await call(t, p.traveler, 'GET', `/v1/files/${ids.kycFile}/content`)).status).toBe(403);
    expect((await call(t, p.buyer, 'GET', `/v1/files/${ids.kycFile}/content`)).status).toBe(403); // not even the owner
  });
});
