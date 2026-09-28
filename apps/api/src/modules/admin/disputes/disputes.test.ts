import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../../../../test/helpers';
import { call, createFile, type Parties, txStatus } from '../../transactions/test-fixtures';
import { type Admin, as, auditRows, createAdmin, idem, ledgerCheck, purchasedTx } from '../test-support';

let t: TestContext;
let ops: Admin;
let opsB: Admin;
let opsNoMfa: Admin;
let marketing: Admin;
let support: Admin;

beforeAll(async () => {
  t = await createTestContext();
  ops = await createAdmin(t, ['OPERATIONS']);
  opsB = await createAdmin(t, ['OPERATIONS']);
  opsNoMfa = await createAdmin(t, ['OPERATIONS'], { mfa: false });
  marketing = await createAdmin(t, ['MARKETING']);
  support = await createAdmin(t, ['SUPPORT']);
});
afterAll(async () => {
  await t.close();
});

async function disputed(requestedResolution = 'REFUND_FULL') {
  const { p, tx, quote } = await purchasedTx(t);
  const d = await call(t, p.buyer, 'POST', `/v1/transactions/${tx.id}/disputes`, { type: 'DAMAGED_ITEM', description: 'Kotak penyok dan figur patah saat dicek di bandara', requestedResolution });
  if (d.status !== 201) throw new Error(`open dispute failed: ${JSON.stringify(d.body)}`);
  return { p, tx, quote, disputeId: d.body.id as string };
}

const resolve = (who: Admin, id: string, body: Record<string, unknown>, headers: Record<string, string> = idem()) =>
  as(t, who, 'POST', `/v1/admin/disputes/${id}/resolve`, body, headers);

describe('dispute queue & review', () => {
  it('permission: MARKETING / SUPPORT have no disputes.manage; queue shows SLA state; detail shows escrow + allowed actions', async () => {
    const { disputeId, tx, p } = await disputed();
    const photo = await createFile(t, p.buyer.id, 'EVIDENCE');
    const addEv = await call(t, p.buyer, 'POST', `/v1/disputes/${disputeId}/evidence`, { type: 'PHOTO', fileId: photo, note: 'Foto figur patah' });
    expect(addEv.status, JSON.stringify(addEv.body)).toBe(201);
    expect((await as(t, marketing, 'GET', '/v1/admin/disputes')).status).toBe(403);
    expect((await as(t, support, 'GET', '/v1/admin/disputes')).status).toBe(403);
    const q = await as(t, ops, 'GET', '/v1/admin/disputes?assignee=none');
    expect(q.status, JSON.stringify(q.body)).toBe(200);
    const row = q.body.data.find((d: any) => d.id === disputeId);
    expect(row).toMatchObject({ status: 'EVIDENCE_COLLECTION', transactionStatus: 'DISPUTED', slaState: 'ON_TRACK', assigneeId: null });
    const detail = await as(t, ops, 'GET', `/v1/admin/disputes/${disputeId}`);
    expect(detail.body).toMatchObject({ transaction: { id: tx.id, preDisputeStatus: 'PURCHASED' }, allowedActions: ['REQUEST_EVIDENCE', 'START_REVIEW', 'CLOSE'] });
    expect(detail.body.transaction.escrowHeldIdr).toBeGreaterThan(0);
    // resolve preview: the exact REFUND_FULL amount (≤ what is still held)
    expect(detail.body.transaction.refundableIdr).toBeGreaterThan(0);
    expect(detail.body.transaction.refundableIdr).toBeLessThanOrEqual(detail.body.transaction.escrowHeldIdr);
    // file URLs are absolute (contract fix)
    expect(detail.body.evidence.find((e: any) => e.fileId === photo)).toMatchObject({
      fileUrlEndpoint: `http://api.test/v1/files/${photo}/url`,
      contentUrl: `http://api.test/v1/files/${photo}/content`,
    });

    const assign = await as(t, ops, 'POST', `/v1/admin/disputes/${disputeId}/assign`, { assigneeId: support.id });
    expect(assign.body.error.code).toBe('ASSIGNEE_NOT_ALLOWED');
    expect((await as(t, ops, 'POST', `/v1/admin/disputes/${disputeId}/assign`, {})).body.assigneeId).toBe(ops.id);

    const early = await resolve(ops, disputeId, { resolution: 'REFUND_FULL', note: 'Bukti foto cukup jelas' });
    expect(early.body.error.code).toBe('DISPUTE_NOT_UNDER_REVIEW');
    const open = await as(t, ops, 'POST', `/v1/admin/disputes/${disputeId}/review`, {});
    expect(open.body.error.code).toBe('EVIDENCE_WINDOW_OPEN');
    const rev = await as(t, ops, 'POST', `/v1/admin/disputes/${disputeId}/review`, { closeEvidenceWindow: true, note: 'Bukti lengkap' });
    expect(rev.status, JSON.stringify(rev.body)).toBe(200);
    const ev = await as(t, ops, 'POST', `/v1/admin/disputes/${disputeId}/request-evidence`, { note: 'Mohon video unboxing', dueHours: 24 });
    expect(ev.body.status).toBe('EVIDENCE_COLLECTION');
    expect(await auditRows(t, 'disputes.evidence_requested', disputeId)).toHaveLength(1);
  });

  it('closing a pre-delivery dispute without a resolution is refused', async () => {
    const { disputeId } = await disputed();
    const res = await as(t, ops, 'POST', `/v1/admin/disputes/${disputeId}/close`, { note: 'Pembeli menarik keluhan' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('RESOLUTION_REQUIRED');
  });
});

describe('dispute resolution → money', () => {
  it('REFUND_FULL: MFA + idempotency required → refund executed → REFUNDED, ledger balanced, escrow empty, event + audit', async () => {
    const { disputeId, tx, quote, p } = await disputed();
    await as(t, ops, 'POST', `/v1/admin/disputes/${disputeId}/review`, { closeEvidenceWindow: true });
    const body = { resolution: 'REFUND_FULL', note: 'Foto menunjukkan barang rusak sebelum serah terima' };
    expect((await resolve(ops, disputeId, body, {})).status).toBe(400);
    expect((await resolve(opsNoMfa, disputeId, body)).body.error.code).toBe('MFA_REQUIRED');

    const key = idem();
    const res = await resolve(ops, disputeId, body, key);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ status: 'RESOLVED', execution: { status: 'REFUND_REQUESTED' }, transactionStatus: 'REFUNDED', resolutionAmountIdr: quote.totalIdr });
    expect(res.body.refunds.map((r: any) => r.status)).toEqual(['SUCCEEDED']);
    const replay = await resolve(ops, disputeId, body, key);
    expect(replay.status).toBe(200);
    expect(replay.body.execution.refundIds).toEqual(res.body.execution.refundIds);

    const l = await ledgerCheck(t, tx.id);
    expect(l.balanced).toBe(true);
    expect(l.buckets.PRODUCT_FUND ?? 0).toBe(0);
    expect(l.buckets.CUSTOMS_RESERVE ?? 0).toBe(0);
    expect(l.buckets.CLEARING ?? 0).toBe(0);
    expect(l.buckets.REFUND ?? 0).toBe(0);
    const detail = await as(t, ops, 'GET', `/v1/admin/transactions/${tx.id}`);
    expect(detail.body.ledger.balanced).toBe(true);
    expect(detail.body.disputes[0]).toMatchObject({ status: 'RESOLVED', resolution: 'REFUND_FULL' });

    const [ev] = await t.adminSql<{ payload: Record<string, unknown> }[]>`SELECT payload FROM outbox_events WHERE event_type = 'dispute.resolved' AND aggregate_id = ${disputeId}`;
    expect(ev!.payload).toMatchObject({ disputeId, transactionId: tx.id, buyerId: p.buyer.id, resolution: 'REFUND_FULL', execution: 'REFUND_REQUESTED' });
    const a = await auditRows(t, 'disputes.resolved', disputeId);
    expect(a).toHaveLength(1);
    expect(a[0]!.actor_id).toBe(ops.id);

    const close = await as(t, ops, 'POST', `/v1/admin/disputes/${disputeId}/close`, { note: 'Refund selesai diproses' });
    expect(close.body).toMatchObject({ status: 'CLOSED', transactionFollowUp: 'NONE' });
  });

  it('REFUND_PARTIAL: amount must be below the held escrow; the rest goes to the traveler (→ COMPLETED + payout)', async () => {
    const { disputeId, tx, quote } = await disputed('REFUND_PARTIAL');
    await as(t, opsB, 'POST', `/v1/admin/disputes/${disputeId}/review`, { closeEvidenceWindow: true });
    const noAmount = await resolve(opsB, disputeId, { resolution: 'REFUND_PARTIAL', note: 'Kerusakan kecil pada kemasan' });
    expect(noAmount.status).toBe(400);
    const tooMuch = await resolve(opsB, disputeId, { resolution: 'REFUND_PARTIAL', amountIdr: quote.totalIdr, note: 'Kerusakan kecil pada kemasan' });
    expect(tooMuch.body.error.code).toBe('PARTIAL_AMOUNT_TOO_LARGE');
    const res = await resolve(opsB, disputeId, { resolution: 'REFUND_PARTIAL', amountIdr: 300_000, note: 'Kerusakan kecil pada kemasan' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.refunds[0]).toMatchObject({ amountIdr: 300_000, status: 'SUCCEEDED' });
    expect(res.body.transactionStatus).toBe('COMPLETED');
    const l = await ledgerCheck(t, tx.id);
    expect(l.balanced).toBe(true);
    expect(l.buckets.PRODUCT_FUND ?? 0).toBe(0);
    const [po] = await t.adminSql<{ status: string }[]>`SELECT status FROM payouts WHERE transaction_id = ${tx.id}`;
    expect(po!.status).toBe('SCHEDULED');
  });

  it('NO_REFUND before delivery needs explicit releaseBeforeDelivery; then BUYER_CONFIRMED → COMPLETED', async () => {
    const { disputeId, tx } = await disputed('REFUND_FULL');
    await as(t, ops, 'POST', `/v1/admin/disputes/${disputeId}/review`, { closeEvidenceWindow: true });
    const body = { resolution: 'NO_REFUND', note: 'Bukti tidak mendukung klaim kerusakan' };
    const guard = await resolve(ops, disputeId, body);
    expect(guard.status).toBe(422);
    expect(guard.body.error.code).toBe('PRE_DELIVERY_RELEASE_CONFIRMATION_REQUIRED');
    expect(await txStatus(t, tx.id)).toBe('DISPUTED');
    const ok = await resolve(ops, disputeId, { ...body, releaseBeforeDelivery: true });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ execution: { status: 'BUYER_CONFIRMED' }, transactionStatus: 'COMPLETED' });
    // no dispute refund; only the completion's automatic return of the unused customs reserve (no declaration filed)
    expect(ok.body.refunds.filter((r: any) => r.reasonCode === 'DISPUTE_RESOLUTION')).toEqual([]);
    expect((await ledgerCheck(t, tx.id)).balanced).toBe(true);
  });

  it('admin cancel / refund refuse a DISPUTED transaction (use the dispute resolution instead)', async () => {
    const { tx } = await disputed();
    const c = await as(t, ops, 'POST', `/v1/admin/transactions/${tx.id}/cancel`, { reason: 'Pembatalan manual', approvalNote: 'Disetujui kepala operasional' }, idem());
    expect(c.body.error.code).toBe('USE_DISPUTE_RESOLUTION');
  });
});

export type { Parties };
