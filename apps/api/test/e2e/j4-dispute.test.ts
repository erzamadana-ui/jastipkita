/**
 * J4 — item damaged at hand-over → buyer opens a dispute with photo evidence → traveler answers with evidence → admin
 * (disputes.manage, TOTP step-up, Idempotency-Key) resolves REFUND_PARTIAL → partial refund to the buyer, remainder
 * released to the traveler → COMPLETED → payout auto-released (SYSTEM) once the dispute is closed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../helpers';
import {
  type Actor,
  adminWithMfa,
  api,
  emailTemplates,
  extraTrip,
  HELD,
  idem,
  meetupHandover,
  ok,
  purchase,
  securedDeal,
  tag,
  tick,
  travelToHandover,
  txLedger,
  txStatus,
  unbalancedJournals,
  upload,
  world,
  type World,
} from './support';

let t: TestContext;
let w: World;
let finance: Actor;

beforeAll(async () => {
  t = await createTestContext();
  w = await world(t);
  finance = await adminWithMfa(t, ['FINANCE']);
});
afterAll(async () => {
  await t.close();
});

describe('J4 dispute (DAMAGED_ITEM) → admin partial refund → COMPLETED with remainder to traveler', () => {
  it('runs end to end with evidence, SLA fields, money execution, notifications and a balanced ledger', async () => {
    const trip = await extraTrip(t, w);
    const d = await securedDeal(t, w, { tripId: trip.id });
    await purchase(t, w.traveler, d.tx.id, 6000);
    await travelToHandover(t, w.traveler, d.tx.id, trip.id);
    await meetupHandover(t, d.buyer, w.traveler, d.tx.id);

    // buyer opens a dispute within the window, with a photo
    const opened = await ok(api(t, d.buyer, 'POST', `/v1/transactions/${d.tx.id}/disputes`, { type: 'DAMAGED_ITEM', description: 'Resleting jaket rusak dan ada sobekan di lengan kiri', requestedResolution: 'REFUND_PARTIAL' }), 201);
    expect(opened).toMatchObject({ status: 'EVIDENCE_COLLECTION', transactionStatus: 'DISPUTED', openedByRole: 'BUYER' });
    expect(opened.number).toMatch(/^DSP-\d{6}-[0-9A-Z]{6}$/);
    const photo = await upload(t, d.buyer, 'EVIDENCE');
    await ok(api(t, d.buyer, 'POST', `/v1/disputes/${opened.id}/evidence`, { type: 'PHOTO', fileId: photo, note: 'Foto sobekan saat serah terima' }), 201);
    // traveler answers citing the purchase proof photo of this transaction
    const detailT = await ok(api(t, w.traveler, 'GET', `/v1/transactions/${d.tx.id}`));
    const proofPhoto = detailT.purchaseProof.files.find((f: any) => f.kind === 'PRODUCT_PHOTO').id;
    await ok(api(t, w.traveler, 'POST', `/v1/disputes/${opened.id}/evidence`, { type: 'PHOTO', fileId: proofPhoto, note: 'Kondisi saat dibeli masih baik' }), 201);
    // no auto-confirm / payout while disputed
    const confirm = await api(t, d.buyer, 'POST', `/v1/transactions/${d.tx.id}/confirm-receipt`, undefined, idem());
    expect(confirm.status).toBe(422);

    // admin handles the case
    const queue = await ok(api(t, w.admin, 'GET', '/v1/admin/disputes?assignee=none'));
    expect(queue.data.find((x: any) => x.id === opened.id)).toMatchObject({ status: 'EVIDENCE_COLLECTION', slaState: 'ON_TRACK' });
    await ok(api(t, w.admin, 'POST', `/v1/admin/disputes/${opened.id}/assign`, {}));
    const detail = await ok(api(t, w.admin, 'GET', `/v1/admin/disputes/${opened.id}`));
    expect(detail.evidence).toHaveLength(2);
    const escrow = detail.transaction.escrowHeldIdr as number;
    expect(escrow).toBeGreaterThan(300_000);
    await ok(api(t, w.admin, 'POST', `/v1/admin/disputes/${opened.id}/review`, { closeEvidenceWindow: true, note: 'Bukti kedua pihak lengkap' }));
    const body = { resolution: 'REFUND_PARTIAL', amountIdr: 300_000, note: 'Kerusakan sebagian; kompensasi Rp300.000' };
    expect((await api(t, w.admin, 'POST', `/v1/admin/disputes/${opened.id}/resolve`, body)).status).toBe(400); // Idempotency-Key required
    const key = idem();
    const res = await ok(api(t, w.admin, 'POST', `/v1/admin/disputes/${opened.id}/resolve`, body, key));
    expect(res).toMatchObject({ status: 'RESOLVED', transactionStatus: 'COMPLETED', resolutionAmountIdr: 300_000 });
    expect(res.refunds[0]).toMatchObject({ amountIdr: 300_000, status: 'SUCCEEDED' });
    const replay = await ok(api(t, w.admin, 'POST', `/v1/admin/disputes/${opened.id}/resolve`, body, key));
    expect(replay.execution.refundIds).toEqual(res.execution.refundIds);
    expect(await txStatus(t, d.tx.id)).toBe('COMPLETED');

    // payout waits while the dispute is RESOLVED but not CLOSED; closing releases it
    await tick(t, 5);
    const [po1] = await t.adminSql<{ status: string }[]>`SELECT status FROM payouts WHERE transaction_id = ${d.tx.id}`;
    expect(po1!.status).not.toBe('PAID');
    const close = await ok(api(t, w.admin, 'POST', `/v1/admin/disputes/${opened.id}/close`, { note: 'Refund parsial selesai' }));
    expect(close.status).toBe('CLOSED');
    // the processor put the payout ON_HOLD (DISPUTE_OPEN) while the dispute was RESOLVED-not-CLOSED (money design, admin.md §3);
    // once the dispute is CLOSED and no risk review is open, the next payout run releases it automatically (SYSTEM,
    // audited `payout.auto_released`) — FINANCE only has to release holds that still have an open risk review.
    expect(po1!.status).toBe('ON_HOLD');
    const held = await ok(api(t, finance, 'GET', `/v1/admin/payouts?status=ON_HOLD`));
    expect(held.data.find((x: any) => x.transactionId === d.tx.id)).toMatchObject({ holdReason: 'DISPUTE_OPEN' });
    await tick(t, 5);
    const [auto] = await t.adminSql<{ actor_type: string }[]>`
      SELECT a.actor_type FROM audit_logs a JOIN payouts p ON p.id::text = a.entity_id WHERE p.transaction_id = ${d.tx.id} AND a.action = 'payout.auto_released'`;
    expect(auto?.actor_type).toBe('SYSTEM');
    const [po] = await t.adminSql<{ status: string; amount_idr: number }[]>`SELECT status, amount_idr FROM payouts WHERE transaction_id = ${d.tx.id}`;
    expect(po!.status).toBe('PAID');

    // money: refund + payout + platform take = what the buyer paid; nothing left in escrow
    const l = await txLedger(t, d.tx.id);
    for (const b of HELD) expect(l[b] ?? 0, b).toBe(0);
    expect(await unbalancedJournals(t)).toBe(0);
    const refunded = t.payment.refunds.filter((r) => r.amountIdr === 300_000);
    expect(refunded).toHaveLength(1);
    const [rt] = await t.adminSql<{ refunds_total: number }[]>`SELECT coalesce(sum(amount_idr),0)::bigint AS refunds_total FROM refunds WHERE transaction_id = ${d.tx.id} AND status = 'SUCCEEDED'`;
    expect(Number(rt!.refunds_total) + Number(po!.amount_idr) + (l.PLATFORM_REVENUE ?? 0) + (l.TAX_PAYABLE ?? 0) + (l.PAYMENT_FEE ?? 0)).toBe(d.quote.totalIdr);

    await t.drain();
    expect(emailTemplates(t, d.buyer.email)).toEqual(expect.arrayContaining([tag('dispute.opened'), tag('dispute.resolved'), tag('refund.succeeded')]));
    expect(emailTemplates(t, w.traveler.email)).toEqual(expect.arrayContaining([tag('dispute.opened'), tag('dispute.resolved')]));
    const mine = await ok(api(t, w.traveler, 'GET', '/v1/disputes/mine'));
    expect(mine.data.find((x: any) => x.id === opened.id)).toMatchObject({ status: 'CLOSED' });
    const audit = await t.adminSql`SELECT 1 FROM audit_logs WHERE action = 'disputes.resolved' AND entity_id = ${opened.id}`;
    expect(audit).toHaveLength(1);
  });
});
