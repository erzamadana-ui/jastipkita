import { DEFAULT_BUSINESS_CONFIG } from '@jastipkita/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../../../test/helpers';
import { sensitiveStepUp } from '../auth/test-support';
import { processPayouts, scheduleOwedPayouts } from '../payouts/service';
import { approveRefund, processRefunds, requestRefund } from '../refunds/service';
import {
  call,
  createFile,
  createMatchedTx,
  createPayoutAccount,
  idem,
  lineAmount,
  quoteAndPay,
  seedFx,
  setupParties,
  txLedger,
  txStatus,
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

async function penaltyEvents(txId: string) {
  return t.adminSql<{ payload: { userId: string; trustPenalty: number; role: string } }[]>`
    SELECT payload FROM outbox_events WHERE event_type = 'transaction.cancelled_with_penalty' AND aggregate_id = ${txId}`;
}

describe('cancellation matrix', () => {
  it('buyer cancels after match (before payment) → CANCELLED, trust penalty signal', async () => {
    const tx = await createMatchedTx(t, p);
    const res = await call(t, p.buyer, 'POST', `/v1/transactions/${tx.id}/cancel`, { reason: 'Berubah pikiran' }, idem());
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe('CANCELLED');
    const ev = await penaltyEvents(tx.id);
    expect(ev[0]!.payload).toMatchObject({ userId: p.buyer.id, trustPenalty: 1, role: 'BUYER' });
  });

  it('buyer cancels while AWAITING_PAYMENT → CANCELLED, pending payment closed', async () => {
    const tx = await createMatchedTx(t, p);
    const q = await call(t, p.buyer, 'POST', `/v1/transactions/${tx.id}/quote`, { channel: 'QRIS' });
    const co = await call(t, p.buyer, 'POST', `/v1/transactions/${tx.id}/checkout`, { quoteId: q.body.quoteId }, idem());
    const trav = await call(t, p.traveler, 'POST', `/v1/transactions/${tx.id}/cancel`, { reason: 'Tidak jadi' }, idem());
    expect(trav.status).toBe(422);
    const res = await call(t, p.buyer, 'POST', `/v1/transactions/${tx.id}/cancel`, { reason: 'Salah pilih' }, idem());
    expect(res.body.status).toBe('CANCELLED');
    const [pay] = await t.adminSql<{ status: string }[]>`SELECT status FROM payments WHERE id = ${co.body.paymentId}`;
    expect(pay!.status).toBe('EXPIRED');
  });

  it('traveler cancels after payment → full refund incl. payment fee, penalty 5, ledger drained', async () => {
    const tx = await createMatchedTx(t, p);
    const { quote } = await quoteAndPay(t, p, tx);
    const res = await call(t, p.traveler, 'POST', `/v1/transactions/${tx.id}/cancel`, { reason: 'Penerbangan batal' }, idem());
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.cancellation.refundIdr).toBe(quote.totalIdr);
    expect(res.body.cancellation.paymentFeeRetainedIdr).toBe(0);
    expect(res.body.status).toBe('REFUNDED');
    expect(t.payment.refunds.some((r) => r.amountIdr === quote.totalIdr)).toBe(true);
    const ev = await penaltyEvents(tx.id);
    expect(ev[0]!.payload).toMatchObject({ userId: p.traveler.id, trustPenalty: 5, role: 'TRAVELER' });
    const [pay] = await t.adminSql<{ status: string; refunded_idr: number }[]>`SELECT status, refunded_idr FROM payments WHERE transaction_id = ${tx.id}`;
    expect(pay!.status).toBe('REFUNDED');
    const l = await txLedger(t, tx.id);
    for (const b of ['PRODUCT_FUND', 'CUSTOMS_RESERVE', 'CLEARING', 'REFUND', 'PROVIDER_CASH', 'PLATFORM_REVENUE', 'TAX_PAYABLE', 'PAYMENT_FEE']) expect(l[b] ?? 0).toBe(0);
    const types = (await t.adminSql<{ event_type: string }[]>`SELECT event_type FROM outbox_events WHERE payload->>'transactionId' = ${tx.id}`).map((e) => e.event_type);
    expect(types).toContain('refund.requested');
    expect(types).toContain('refund.succeeded');
  });

  it('buyer cancels after payment → payment fee retained by the platform', async () => {
    const tx = await createMatchedTx(t, p);
    const { quote } = await quoteAndPay(t, p, tx);
    const res = await call(t, p.buyer, 'POST', `/v1/transactions/${tx.id}/cancel`, { reason: 'Tidak butuh lagi' }, idem());
    expect(res.status).toBe(200);
    const fee = lineAmount(quote, 'PAYMENT_FEE');
    expect(res.body.cancellation.refundIdr).toBe(quote.totalIdr - fee);
    expect(res.body.status).toBe('REFUNDED');
    const l = await txLedger(t, tx.id);
    expect(l.PAYMENT_FEE).toBe(fee);
    expect(-l.PROVIDER_CASH!).toBe(fee);
    expect(l.PRODUCT_FUND ?? 0).toBe(0);
  });

  it('buyer cancels before purchase (PURCHASE_APPROVED) → traveler compensation payout', async () => {
    const tx = await createMatchedTx(t, p);
    const { quote } = await quoteAndPay(t, p, tx);
    await call(t, p.traveler, 'POST', `/v1/transactions/${tx.id}/price-check`, { actualUnitPriceMinor: 20000, currency: 'JPY' });
    const res = await call(t, p.buyer, 'POST', `/v1/transactions/${tx.id}/cancel`, { reason: 'Batal' }, idem());
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const comp = res.body.cancellation.travelerCompensationIdr;
    expect(comp).toBe(Math.max(10000, Math.round(lineAmount(quote, 'TRAVELER_FEE') * 0.1)));
    const [po] = await t.adminSql<{ amount_idr: number; status: string }[]>`SELECT amount_idr, status FROM payouts WHERE transaction_id = ${tx.id}`;
    expect(Number(po!.amount_idr)).toBe(comp);
    await processPayouts(t.deps, { transactionId: tx.id });
    const l = await txLedger(t, tx.id);
    expect(l.TRAVELER_EARNING ?? 0).toBe(0);
    for (const b of ['PRODUCT_FUND', 'CUSTOMS_RESERVE', 'CLEARING', 'REFUND']) expect(l[b] ?? 0).toBe(0);
  });

  it('compensation owed to a traveler without a payout account is scheduled by the sweep once an account exists', async () => {
    const q = await setupParties(t, { payoutAccount: false });
    const tx = await createMatchedTx(t, q);
    await quoteAndPay(t, q, tx);
    await call(t, q.traveler, 'POST', `/v1/transactions/${tx.id}/price-check`, { actualUnitPriceMinor: 20000, currency: 'JPY' });
    const res = await call(t, q.buyer, 'POST', `/v1/transactions/${tx.id}/cancel`, { reason: 'Batal' }, idem());
    const comp = res.body.cancellation.travelerCompensationIdr;
    expect(comp).toBeGreaterThan(0);
    expect(await t.adminSql`SELECT id FROM payouts WHERE transaction_id = ${tx.id}`).toHaveLength(0);
    expect((await scheduleOwedPayouts(t.deps)).scheduled).toBe(0);
    await createPayoutAccount(t, q.traveler.id);
    expect((await scheduleOwedPayouts(t.deps)).scheduled).toBe(1);
    await processPayouts(t.deps, { transactionId: tx.id });
    const l = await txLedger(t, tx.id);
    expect(l.TRAVELER_EARNING ?? 0).toBe(0);
    expect((await scheduleOwedPayouts(t.deps)).scheduled).toBe(0);
  });

  it('buyer cancel after purchase → 422 "gunakan Dispute Center"', async () => {
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
    const res = await call(t, p.buyer, 'POST', `/v1/transactions/${tx.id}/cancel`, { reason: 'Ingin batal' }, idem());
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('CANCELLATION_NOT_ALLOWED');
    expect(res.body.error.message).toMatch(/Dispute Center/);
    const trav = await call(t, p.traveler, 'POST', `/v1/transactions/${tx.id}/cancel`, { reason: 'Rusak' }, idem());
    expect(trav.status).toBe(422);
    expect(trav.body.error.code).toBe('ADMIN_APPROVAL_REQUIRED');
    expect(await txStatus(t, tx.id)).toBe('PURCHASED');
  });
});

describe('refunds', () => {
  it('VA channel cannot be refunded → buyer destination → payout-style disbursement → REFUNDED', async () => {
    const tx = await createMatchedTx(t, p);
    const { quote } = await quoteAndPay(t, p, tx, { channel: 'VA' });
    const res = await call(t, p.traveler, 'POST', `/v1/transactions/${tx.id}/cancel`, { reason: 'Sakit' }, idem());
    expect(res.body.status).toBe('REFUND_PENDING');
    expect(res.body.refunds[0].method).toBe('PAYOUT_TO_BUYER');
    const list = await call(t, p.buyer, 'GET', `/v1/transactions/${tx.id}/refunds`);
    expect(list.body.data[0]).toMatchObject({ destinationRequired: true, status: 'APPROVED' });
    const refundId = list.body.data[0].id;
    const [ev] = await t.adminSql`SELECT 1 FROM outbox_events WHERE event_type = 'refund.destination_required' AND aggregate_id = ${refundId}`;
    expect(ev).toBeTruthy();
    const bad = await call(t, p.buyer, 'POST', `/v1/refunds/${refundId}/destination`, { bankCode: 'BCA', accountNumber: '12AB', accountHolderName: 'Penitip' });
    expect(bad.status).toBe(400);
    const notMine = await call(t, p.traveler, 'POST', `/v1/refunds/${refundId}/destination`, { bankCode: 'BCA', accountNumber: '9876543210', accountHolderName: 'Bukan Saya' });
    expect(notMine.status).toBe(404);
    // SEC-12: a bearer token alone is not enough — fresh single-use OTP bound to this refund
    const noStepUp = await call(t, p.buyer, 'POST', `/v1/refunds/${refundId}/destination`, { bankCode: 'BCA', accountNumber: '9876543210', accountHolderName: 'Penitip Uji' });
    expect(noStepUp.status).toBe(403);
    expect(noStepUp.body.error).toMatchObject({ code: 'STEP_UP_REQUIRED', details: { purpose: 'SENSITIVE_ACTION', action: 'REFUND_DESTINATION_SET', targetId: refundId } });
    const stepUp = await sensitiveStepUp(t, p.buyer, 'REFUND_DESTINATION_SET', refundId);
    const dest = await call(t, p.buyer, 'POST', `/v1/refunds/${refundId}/destination`, { bankCode: 'BCA', accountNumber: '9876543210', accountHolderName: 'Penitip Uji', stepUp });
    expect(dest.status, JSON.stringify(dest.body)).toBe(200);
    expect(dest.body).toMatchObject({ validationStatus: 'VALID', reviewRequired: false });
    expect(dest.body.accountMask).toBe('****3210');
    expect(JSON.stringify(dest.body)).not.toContain('9876543210');
    const [row] = await t.adminSql<{ account_number_enc: Buffer }[]>`SELECT account_number_enc FROM refund_destinations WHERE refund_id = ${refundId}`;
    expect(row!.account_number_enc.toString('utf8')).not.toContain('9876543210');
    const r = await processRefunds(t.deps, { transactionId: tx.id });
    expect(r.succeeded).toBe(1);
    expect(t.payment.payouts.find((x) => x.accountNumber === '9876543210')?.amountIdr).toBe(quote.totalIdr);
    expect(await txStatus(t, tx.id)).toBe('REFUNDED');
    const l = await txLedger(t, tx.id);
    expect(l.REFUND ?? 0).toBe(0);
    expect(l.PROVIDER_CASH ?? 0).toBe(0);
  });

  it('provider refund failure → FAILED, retried within the SYSTEM budget → SUCCEEDED', async () => {
    const tx = await createMatchedTx(t, p);
    const { quote } = await quoteAndPay(t, p, tx);
    const original = t.payment.refund.bind(t.payment);
    let calls = 0;
    t.payment.refund = async (input) => {
      calls++;
      if (calls === 1) throw new Error('network timeout');
      return original(input);
    };
    try {
      const res = await call(t, p.traveler, 'POST', `/v1/transactions/${tx.id}/cancel`, { reason: 'Batal' }, idem());
      expect(res.body.status).toBe('REFUND_PENDING');
      const [r1] = await t.adminSql<{ status: string; attempts: number; failure_reason: string }[]>`SELECT status, attempts, failure_reason FROM refunds WHERE transaction_id = ${tx.id}`;
      expect(r1).toMatchObject({ status: 'FAILED', attempts: 1 });
      expect(r1!.failure_reason).toContain('network timeout');
      const run = await processRefunds(t.deps, { transactionId: tx.id });
      expect(run.succeeded).toBe(1);
      const [r2] = await t.adminSql<{ status: string; attempts: number }[]>`SELECT status, attempts FROM refunds WHERE transaction_id = ${tx.id}`;
      expect(r2).toMatchObject({ status: 'SUCCEEDED', attempts: 2 });
      expect(await txStatus(t, tx.id)).toBe('REFUNDED');
      const events = await t.adminSql<{ to_status: string }[]>`SELECT to_status FROM refund_events re JOIN refunds r ON r.id = re.refund_id WHERE r.transaction_id = ${tx.id} ORDER BY re.id`;
      expect(events.map((e) => e.to_status)).toEqual(['REQUESTED', 'APPROVED', 'PROCESSING', 'FAILED', 'PROCESSING', 'SUCCEEDED']);
      expect(t.payment.refunds.filter((r) => r.amountIdr === quote.totalIdr).length).toBeGreaterThanOrEqual(1);
    } finally {
      t.payment.refund = original;
    }
  });

  it('payout disbursement failures are retried with backoff, then held after the budget', async () => {
    const tx = await createMatchedTx(t, p);
    await quoteAndPay(t, p, tx);
    await call(t, p.traveler, 'POST', `/v1/transactions/${tx.id}/price-check`, { actualUnitPriceMinor: 20000, currency: 'JPY' });
    const res = await call(t, p.buyer, 'POST', `/v1/transactions/${tx.id}/cancel`, { reason: 'Batal' }, idem());
    expect(res.body.cancellation.travelerCompensationIdr).toBeGreaterThan(0);
    const original = t.payment.payout.bind(t.payment);
    t.payment.payout = (async () => ({ providerRef: `mock_po_fail_${crypto.randomUUID()}`, status: 'FAILED' as const })) as unknown as typeof t.payment.payout;
    try {
      for (let i = 0; i < 3; i++) {
        await processPayouts(t.deps, { transactionId: tx.id });
        t.clock.advance(3 * 3600_000);
      }
      const [po] = await t.adminSql<{ status: string; attempts: number; hold_reason: string }[]>`SELECT status, attempts, hold_reason FROM payouts WHERE transaction_id = ${tx.id}`;
      expect(po).toMatchObject({ status: 'ON_HOLD', attempts: 3 });
      expect(po!.hold_reason).toContain('REPEATED_FAILURE');
      const failed = await t.adminSql`SELECT 1 FROM outbox_events WHERE event_type = 'payout.failed' AND payload->>'transactionId' = ${tx.id}`;
      expect(failed).toHaveLength(3);
      const l = await txLedger(t, tx.id);
      expect(l.TRAVELER_EARNING).toBe(res.body.cancellation.travelerCompensationIdr); // still owed, never paid twice
    } finally {
      t.payment.payout = original;
    }
  });

  it('refund above the auto-approve threshold waits for a maker-checker approval', async () => {
    const setPolicy = async (value: Record<string, unknown>, reason: string) => {
      await t.adminSql`UPDATE business_configs SET status = 'SUPERSEDED', superseded_at = now() WHERE key = 'money.policy' AND status = 'ACTIVE'`;
      await t.adminSql`
        INSERT INTO business_configs (key, version, value, status, change_reason, approved_at)
        SELECT 'money.policy', coalesce(max(version), 0) + 1, ${t.adminSql.json(value as never)}, 'ACTIVE', ${reason}, now()
          FROM business_configs WHERE key = 'money.policy'`;
      t.deps.config.invalidate();
    };
    await setPolicy({ ...DEFAULT_BUSINESS_CONFIG['money.policy'], refundAutoApproveMaxIdr: 1000 }, 'test: low auto-approve limit');
    try {
      const tx = await createMatchedTx(t, p);
      await quoteAndPay(t, p, tx);
      const res = await call(t, p.traveler, 'POST', `/v1/transactions/${tx.id}/cancel`, { reason: 'Batal' }, idem());
      expect(res.body.refunds[0].status).toBe('PENDING_APPROVAL');
      expect(await txStatus(t, tx.id)).toBe('REFUND_PENDING');
      expect((await processRefunds(t.deps, { transactionId: tx.id })).processed).toBe(0);
      const admin = await t.createUser({ kycLevel: 2, roles: ['FINANCE'] });
      await approveRefund(t.deps, res.body.refunds[0].id, admin.id);
      await processRefunds(t.deps, { transactionId: tx.id });
      expect(await txStatus(t, tx.id)).toBe('REFUNDED');
    } finally {
      await setPolicy({ ...DEFAULT_BUSINESS_CONFIG['money.policy'] }, 'test: restore default policy');
    }
  });

  it('requestRefund (dispute resolution API): partial refund, remainder to traveler → COMPLETED', async () => {
    const tx = await createMatchedTx(t, p);
    const { quote } = await quoteAndPay(t, p, tx);
    await call(t, p.traveler, 'POST', `/v1/transactions/${tx.id}/price-check`, { actualUnitPriceMinor: 20000, currency: 'JPY' });
    await call(t, p.traveler, 'POST', `/v1/transactions/${tx.id}/purchase-proof`, {
      receiptFileId: await createFile(t, p.traveler.id, 'RECEIPT'),
      productPhotoFileIds: [await createFile(t, p.traveler.id, 'PRODUCT_PHOTO')],
      merchantName: 'Yodobashi Camera',
      actualPriceMinor: 20000,
      currency: 'JPY',
      purchasedAt: t.clock.now().toISOString(),
    });
    await t.adminSql`SELECT transition_transaction(${tx.id}, (SELECT version FROM transactions WHERE id = ${tx.id}), 'DISPUTED', 'BUYER', ${p.buyer.id}, 'barang rusak')`;
    const admin = await t.createUser({ kycLevel: 2, roles: ['FINANCE'] });
    const rows = await t.deps.sql.begin((db) =>
      requestRefund(t.deps, db, tx.id, {
        amountIdr: 500_000,
        reasonCode: 'DISPUTE_RESOLUTION',
        reasonNote: 'Kemasan rusak — refund sebagian',
        requestedBy: admin.id,
        actorType: 'ADMIN',
        remainderTo: 'TRAVELER',
        disputeResolution: 'REFUND_PARTIAL',
        idempotencyKey: `dispute:${tx.id}`,
      }),
    );
    expect(rows).toHaveLength(1);
    expect(await txStatus(t, tx.id)).toBe('REFUND_PENDING');
    // retried resolution returns the same refund
    const again = await t.deps.sql.begin((db) =>
      requestRefund(t.deps, db, tx.id, { amountIdr: 500_000, reasonCode: 'DISPUTE_RESOLUTION', requestedBy: admin.id, actorType: 'ADMIN', remainderTo: 'TRAVELER', idempotencyKey: `dispute:${tx.id}` }),
    );
    expect(again[0]!.id).toBe(rows[0]!.id);
    await processRefunds(t.deps, { transactionId: tx.id });
    expect(await txStatus(t, tx.id)).toBe('COMPLETED');
    const [po] = await t.adminSql<{ amount_idr: number }[]>`SELECT amount_idr FROM payouts WHERE transaction_id = ${tx.id}`;
    const fees = lineAmount(quote, 'PLATFORM_FEE') + lineAmount(quote, 'PROTECTION_FEE') + lineAmount(quote, 'SERVICE_TAX') + lineAmount(quote, 'PAYMENT_FEE');
    expect(Number(po!.amount_idr)).toBe(quote.totalIdr - 500_000 - fees);
    const l = await txLedger(t, tx.id);
    for (const b of ['PRODUCT_FUND', 'CUSTOMS_RESERVE', 'CLEARING', 'REFUND']) expect(l[b] ?? 0).toBe(0);
  });
});
