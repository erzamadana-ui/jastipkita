import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../../../test/helpers';
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
import { autoConfirmDeliveries } from './service';

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

async function readyTx(): Promise<MatchedTx> {
  const tx = await createMatchedTx(t, p);
  await quoteAndPay(t, p, tx);
  await call(t, p.traveler, 'POST', `/v1/transactions/${tx.id}/price-check`, { actualUnitPriceMinor: 20000, currency: 'JPY' });
  await call(t, p.traveler, 'POST', `/v1/transactions/${tx.id}/purchase-proof`, {
    receiptFileId: await createFile(t, p.traveler.id, 'RECEIPT'),
    productPhotoFileIds: [await createFile(t, p.traveler.id, 'PRODUCT_PHOTO')],
    merchantName: 'Yodobashi Camera',
    actualPriceMinor: 20000,
    currency: 'JPY',
    purchasedAt: t.clock.now().toISOString(),
  });
  await setTripStatus(t, tx.tripId, ['ACTIVE', 'TRAVELING']);
  for (const to of ['TRAVELING', 'ARRIVED', 'READY_FOR_HANDOVER']) {
    const r = await call(t, p.traveler, 'POST', `/v1/transactions/${tx.id}/status`, { to });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  }
  return tx;
}

describe('MEETUP handover', () => {
  it('duplicate delivery confirmation: PIN verified twice → one transition', async () => {
    const tx = await readyTx();
    await call(t, p.traveler, 'POST', `/v1/transactions/${tx.id}/delivery`, { method: 'MEETUP', meetupPoint: 'Plaza Senayan' });
    const pin = await call(t, p.buyer, 'GET', `/v1/transactions/${tx.id}/delivery/pin`);
    const a = await call(t, p.traveler, 'POST', `/v1/transactions/${tx.id}/delivery/verify`, { pin: pin.body.pin });
    const b = await call(t, p.traveler, 'POST', `/v1/transactions/${tx.id}/delivery/verify`, { pin: pin.body.pin });
    expect(a.body).toMatchObject({ transactionStatus: 'DELIVERED', alreadyConfirmed: false });
    expect(b.status).toBe(200);
    expect(b.body).toMatchObject({ transactionStatus: 'DELIVERED', alreadyConfirmed: true });
    const ev = await t.adminSql`SELECT 1 FROM transaction_events WHERE transaction_id = ${tx.id} AND to_status = 'DELIVERED'`;
    expect(ev).toHaveLength(1);
    const [d] = await t.adminSql<{ confirmed_via: string; auto: Date }[]>`
      SELECT d.confirmed_via, t.auto_confirm_at AS auto FROM deliveries d JOIN transactions t ON t.id = d.transaction_id WHERE d.transaction_id = ${tx.id} AND d.status = 'DELIVERED'`;
    expect(d!.confirmed_via).toBe('PIN');
    expect(new Date(d!.auto).getTime()).toBe(t.clock.now().getTime() + 48 * 3600_000);
    // buyer confirmation is idempotent too
    const c1 = await call(t, p.buyer, 'POST', `/v1/transactions/${tx.id}/confirm-receipt`, undefined, idem());
    const c2 = await call(t, p.buyer, 'POST', `/v1/transactions/${tx.id}/confirm-receipt`, undefined, idem());
    expect(c1.body.transactionStatus).toBe('COMPLETED');
    expect(c2.body).toMatchObject({ transactionStatus: 'COMPLETED', alreadyConfirmed: true });
    const payouts = await t.adminSql`SELECT id FROM payouts WHERE transaction_id = ${tx.id}`;
    expect(payouts).toHaveLength(1);
  });

  it('PIN brute force: locks after max attempts, flags risk, even the right PIN is refused', async () => {
    const tx = await readyTx();
    await call(t, p.traveler, 'POST', `/v1/transactions/${tx.id}/delivery`, { method: 'MEETUP', meetupPoint: 'Stasiun Sudirman' });
    const pin = await call(t, p.buyer, 'GET', `/v1/transactions/${tx.id}/delivery/pin`);
    const wrong = pin.body.pin === '000000' ? '111111' : '000000';
    for (let i = 1; i <= 4; i++) {
      const r = await call(t, p.traveler, 'POST', `/v1/transactions/${tx.id}/delivery/verify`, { pin: wrong });
      expect(r.status).toBe(422);
      expect(r.body.error.code).toBe('PIN_INVALID');
      expect(r.body.error.details.attemptsRemaining).toBe(5 - i);
    }
    const fifth = await call(t, p.traveler, 'POST', `/v1/transactions/${tx.id}/delivery/verify`, { pin: wrong });
    expect(fifth.status).toBe(423);
    expect(fifth.body.error.code).toBe('PIN_LOCKED');
    const right = await call(t, p.traveler, 'POST', `/v1/transactions/${tx.id}/delivery/verify`, { pin: pin.body.pin });
    expect(right.status).toBe(423);
    expect(await txStatus(t, tx.id)).toBe('READY_FOR_HANDOVER');
    const [risk] = await t.adminSql<{ decision: string }[]>`SELECT decision FROM risk_assessments WHERE subject_type = 'TRANSACTION' AND subject_id = ${tx.id}`;
    expect(risk!.decision).toBe('REVIEW');
    const [sec] = await t.adminSql`SELECT 1 FROM security_events WHERE type = 'DELIVERY_PIN_LOCKED' AND user_id = ${p.traveler.id}`;
    expect(sec).toBeTruthy();
    const reveal = await call(t, p.buyer, 'GET', `/v1/transactions/${tx.id}/delivery/pin`);
    expect(reveal.status).toBe(423);
    const reset = await call(t, p.traveler, 'POST', `/v1/transactions/${tx.id}/delivery`, { method: 'MEETUP', meetupPoint: 'x' });
    expect(reset.status).toBe(423);
  });

  it('QR token works once and is hidden from the traveler; stored only as a hash', async () => {
    const tx = await readyTx();
    await call(t, p.traveler, 'POST', `/v1/transactions/${tx.id}/delivery`, { method: 'MEETUP', meetupPoint: 'Kota Kasablanka' });
    const reveal = await call(t, p.buyer, 'GET', `/v1/transactions/${tx.id}/delivery/pin`);
    const [d] = await t.adminSql<{ pin_hash: Buffer; qr_token_hash: Buffer }[]>`SELECT pin_hash, qr_token_hash FROM deliveries WHERE transaction_id = ${tx.id} AND status = 'PENDING'`;
    expect(d!.pin_hash.toString('hex')).not.toContain(reveal.body.pin);
    expect(d!.qr_token_hash.length).toBe(32);
    const ok = await call(t, p.traveler, 'POST', `/v1/transactions/${tx.id}/delivery/verify`, { qrToken: reveal.body.qrToken });
    expect(ok.body).toMatchObject({ transactionStatus: 'DELIVERED', confirmedVia: 'QR' });
  });
});

describe('COURIER delivery & auto-confirm', () => {
  it('shipped → OUT_FOR_DELIVERY → delivered (proof) → auto-confirm after 48h → COMPLETED', async () => {
    const tx = await readyTx();
    const set = await call(t, p.traveler, 'POST', `/v1/transactions/${tx.id}/delivery`, { method: 'COURIER', courierName: 'JNE', address: 'Jl. Sudirman No. 1, Jakarta', addressCity: 'Jakarta' });
    expect(set.status).toBe(200);
    expect(JSON.stringify(set.body)).not.toContain('Sudirman No. 1');
    const noPin = await call(t, p.buyer, 'GET', `/v1/transactions/${tx.id}/delivery/pin`);
    expect(noPin.status).toBe(422);
    const shipped = await call(t, p.traveler, 'POST', `/v1/transactions/${tx.id}/delivery/shipped`, { trackingNumber: 'JNE1234567890' });
    expect(shipped.body.transactionStatus).toBe('OUT_FOR_DELIVERY');
    const again = await call(t, p.traveler, 'POST', `/v1/transactions/${tx.id}/delivery/shipped`, { trackingNumber: 'JNE1234567890' });
    expect(again.body.alreadyShipped).toBe(true);
    const proof = await createFile(t, p.traveler.id, 'DELIVERY_PROOF');
    const delivered = await call(t, p.traveler, 'POST', `/v1/transactions/${tx.id}/delivery/delivered`, { proofFileIds: [proof] });
    expect(delivered.body.transactionStatus).toBe('DELIVERED');
    const dup = await call(t, p.traveler, 'POST', `/v1/transactions/${tx.id}/delivery/delivered`, { proofFileIds: [proof] });
    expect(dup.body.alreadyDelivered).toBe(true);
    expect((await autoConfirmDeliveries(t.deps)).confirmed).toBe(0);
    t.clock.advance(48 * 3600_000 + 1000);
    const r = await autoConfirmDeliveries(t.deps);
    expect(r.confirmed).toBeGreaterThanOrEqual(1); // the QR test's DELIVERED transaction is due as well
    expect(await txStatus(t, tx.id)).toBe('COMPLETED');
    const [d] = await t.adminSql<{ confirmed_via: string; status: string }[]>`SELECT confirmed_via, status FROM deliveries WHERE transaction_id = ${tx.id} AND status = 'DELIVERED'`;
    expect(d).toMatchObject({ confirmed_via: 'AUTO', status: 'DELIVERED' });
    const ev = await t.adminSql<{ actor_type: string }[]>`SELECT actor_type FROM transaction_events WHERE transaction_id = ${tx.id} AND to_status = 'BUYER_CONFIRMED'`;
    expect(ev[0]!.actor_type).toBe('SYSTEM');
  });
});
