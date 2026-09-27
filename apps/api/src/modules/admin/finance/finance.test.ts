import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../../../../test/helpers';
import { recordRiskAssessment } from '../../../services/risk';
import { releaseClearedDisputeHolds } from '../../payouts/service';
import { txStatus } from '../../transactions/test-fixtures';
import { type Admin, as, auditRows, createAdmin, idem, ledgerCheck, purchasedTx } from '../test-support';

let t: TestContext;
let superA: Admin;
let fsa: Admin;
let financeA: Admin;
let financeB: Admin;
let support: Admin;
let ops: Admin;

beforeAll(async () => {
  t = await createTestContext();
  superA = await createAdmin(t, ['SUPER_ADMIN']);
  fsa = await createAdmin(t, ['FINANCE_SUPER_ADMIN']);
  financeA = await createAdmin(t, ['FINANCE']);
  financeB = await createAdmin(t, ['FINANCE']);
  support = await createAdmin(t, ['SUPPORT']);
  ops = await createAdmin(t, ['OPERATIONS']);
  // lower the auto-approve ceiling through the config maker-checker so admin refunds need a second approver
  const cur = await as(t, superA, 'GET', '/v1/admin/config/money.policy');
  const value = { ...cur.body.active.value, refundAutoApproveMaxIdr: 100_000 };
  const p = await as(t, superA, 'POST', '/v1/admin/config/money.policy/versions', { value, changeReason: 'Uji maker-checker refund di atas 100 ribu' });
  if (p.status !== 201) throw new Error(JSON.stringify(p.body));
  const a = await as(t, fsa, 'POST', `/v1/admin/config-versions/${p.body.id}/approve`, {});
  if (a.status !== 200) throw new Error(JSON.stringify(a.body));
});
afterAll(async () => {
  await t.close();
});

describe('refund approval (maker-checker + MFA + idempotency)', () => {
  let refundId: string;
  let txId: string;

  it('admin refund above the ceiling → PENDING_APPROVAL; SUPPORT cannot request or approve', async () => {
    const { tx } = await purchasedTx(t);
    txId = tx.id;
    const denied = await as(t, support, 'POST', `/v1/admin/transactions/${tx.id}/refund`, { amountIdr: 500_000, reason: 'Kompensasi keterlambatan', remainderTo: 'TRAVELER' }, idem());
    expect(denied.status).toBe(403);
    const res = await as(t, superA, 'POST', `/v1/admin/transactions/${tx.id}/refund`, { amountIdr: 500_000, reason: 'Kompensasi keterlambatan', remainderTo: 'TRAVELER' }, idem());
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe('REFUND_PENDING');
    expect(res.body.refunds[0]).toMatchObject({ status: 'PENDING_APPROVAL', amountIdr: 500_000, reasonCode: 'ADMIN' });
    expect(res.body.note).toMatch(/maker-checker/);
    refundId = res.body.refunds[0].id;
    expect(await auditRows(t, 'transactions.admin_refund', tx.id)).toHaveLength(1);

    const queueDenied = await as(t, support, 'GET', '/v1/admin/refunds');
    expect(queueDenied.status).toBe(403);
    const queue = await as(t, financeA, 'GET', '/v1/admin/refunds');
    expect(queue.body.data.find((r: any) => r.id === refundId)).toMatchObject({ status: 'PENDING_APPROVAL', canApprove: true });
    const own = await as(t, superA, 'GET', '/v1/admin/refunds');
    expect(own.body.data.find((r: any) => r.id === refundId).canApprove).toBe(false);
  });

  it('requester cannot approve; approval needs Idempotency-Key; another admin approves → SUCCEEDED → COMPLETED', async () => {
    const self = await as(t, superA, 'POST', `/v1/admin/refunds/${refundId}/approve`, undefined, idem());
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe('MAKER_CHECKER_VIOLATION');
    expect((await as(t, financeA, 'POST', `/v1/admin/refunds/${refundId}/approve`)).status).toBe(400);
    const ok = await as(t, financeA, 'POST', `/v1/admin/refunds/${refundId}/approve`, undefined, idem());
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ status: 'SUCCEEDED', approvedBy: financeA.id });
    expect(await txStatus(t, txId)).toBe('COMPLETED');
    expect((await ledgerCheck(t, txId)).balanced).toBe(true);
    const [r] = await t.adminSql<{ approved_by: string; requested_by: string }[]>`SELECT approved_by, requested_by FROM refunds WHERE id = ${refundId}`;
    expect(r).toMatchObject({ approved_by: financeA.id, requested_by: superA.id });
  });

  it('rejection returns the allocation to escrow and flags the transaction for review', async () => {
    const { tx } = await purchasedTx(t);
    const before = await ledgerCheck(t, tx.id);
    const res = await as(t, superA, 'POST', `/v1/admin/transactions/${tx.id}/refund`, { amountIdr: 400_000, reason: 'Salah hitung ongkir', remainderTo: 'TRAVELER' }, idem());
    const id = res.body.refunds[0].id;
    const rej = await as(t, financeB, 'POST', `/v1/admin/refunds/${id}/reject`, { reason: 'Tidak ada dasar kompensasi' }, idem());
    expect(rej.status, JSON.stringify(rej.body)).toBe(200);
    expect(rej.body).toMatchObject({ status: 'REJECTED', transactionFollowUp: 'REVIEW_REQUIRED' });
    const after = await ledgerCheck(t, tx.id);
    expect(after.balanced).toBe(true);
    expect(after.buckets.PRODUCT_FUND).toBe(before.buckets.PRODUCT_FUND);
    expect(after.buckets.REFUND ?? 0).toBe(0);
  });
});

describe('payout hold / release (holder ≠ releaser)', () => {
  it('hold → same admin cannot release → another admin releases; SUPPORT has no payouts.manage', async () => {
    const [po] = await t.adminSql<{ id: string; transaction_id: string }[]>`SELECT id, transaction_id FROM payouts WHERE status = 'SCHEDULED' LIMIT 1`;
    expect(po).toBeDefined();
    expect((await as(t, support, 'GET', '/v1/admin/payouts')).status).toBe(403);
    const list = await as(t, financeA, 'GET', '/v1/admin/payouts?status=SCHEDULED');
    expect(list.body.data.find((x: any) => x.id === po!.id)).toMatchObject({ status: 'SCHEDULED', destination: { bankCode: 'BCA' } });

    const hold = await as(t, financeA, 'POST', `/v1/admin/payouts/${po!.id}/hold`, { reason: 'Verifikasi ulang rekening traveler' }, idem());
    expect(hold.status, JSON.stringify(hold.body)).toBe(200);
    expect(hold.body.status).toBe('ON_HOLD');
    const [ev] = await t.adminSql<{ payload: Record<string, unknown> }[]>`SELECT payload FROM outbox_events WHERE event_type = 'payout.on_hold' AND aggregate_id = ${po!.id}`;
    expect(ev!.payload).toMatchObject({ payoutId: po!.id, reason: 'ADMIN_HOLD' });

    const self = await as(t, financeA, 'POST', `/v1/admin/payouts/${po!.id}/release`, { note: 'Rekening sudah dicek' }, idem());
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe('MAKER_CHECKER_VIOLATION');
    const rel = await as(t, financeB, 'POST', `/v1/admin/payouts/${po!.id}/release`, { note: 'Rekening sudah dicek' }, idem());
    expect(rel.status, JSON.stringify(rel.body)).toBe(200);
    expect(rel.body).toMatchObject({ status: 'SCHEDULED', releasedBy: financeB.id });
    const [row] = await t.adminSql<{ held_by: string; released_by: string; status: string }[]>`SELECT held_by, released_by, status FROM payouts WHERE id = ${po!.id}`;
    expect(row).toMatchObject({ held_by: financeA.id, released_by: financeB.id, status: 'SCHEDULED' });
    expect(await auditRows(t, 'payouts.released', po!.id)).toHaveLength(1);

    const retry = await as(t, financeB, 'POST', `/v1/admin/payouts/${po!.id}/retry`, { note: 'coba lagi' }, idem());
    expect(retry.body.error.code).toBe('PAYOUT_NOT_FAILED');
  });

  it('release is blocked while a risk review on the transaction is open', async () => {
    const [po] = await t.adminSql<{ id: string; transaction_id: string }[]>`SELECT id, transaction_id FROM payouts WHERE status = 'SCHEDULED' LIMIT 1`;
    await as(t, financeA, 'POST', `/v1/admin/payouts/${po!.id}/hold`, { reason: 'Indikasi penipuan' }, idem());
    await recordRiskAssessment(t.adminSql, 'TRANSACTION', po!.transaction_id, { score: 80, decision: 'REVIEW', reasons: [{ code: 'VELOCITY' }] }, {});
    const res = await as(t, financeB, 'POST', `/v1/admin/payouts/${po!.id}/release`, { note: 'lepas' }, idem());
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('RISK_REVIEW_OPEN');
  });
});

describe('payout dispute hold auto-release (SYSTEM)', () => {
  async function systemDisputeHold(): Promise<{ id: string; transaction_id: string }> {
    // a small admin refund (auto-approved) with the remainder to the traveler completes the deal → payout SCHEDULED
    const { tx } = await purchasedTx(t);
    const r = await as(t, superA, 'POST', `/v1/admin/transactions/${tx.id}/refund`, { amountIdr: 50_000, reason: 'Kompensasi kecil', remainderTo: 'TRAVELER' }, idem());
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const [found] = await t.adminSql<{ id: string; transaction_id: string }[]>`SELECT id, transaction_id FROM payouts WHERE transaction_id = ${tx.id} AND status = 'SCHEDULED'`;
    expect(found).toBeDefined();
    const payout = found!;
    await t.adminSql.begin(async (db) => {
      await db`SELECT set_config('jk.actor_type', 'SYSTEM', true)`;
      await db`UPDATE payouts SET status = 'ON_HOLD', hold_reason = 'DISPUTE_OPEN', held_by = NULL WHERE id = ${payout.id}`;
    });
    return payout;
  }

  it('released automatically once no dispute and no risk review is open; an open risk review keeps it for FINANCE', async () => {
    const a = await systemDisputeHold();
    await recordRiskAssessment(t.adminSql, 'TRANSACTION', a.transaction_id, { score: 60, decision: 'REVIEW', reasons: [{ code: 'VELOCITY' }] }, {});
    expect(await releaseClearedDisputeHolds(t.deps, { transactionId: a.transaction_id })).toBe(0);
    const [still] = await t.adminSql<{ status: string }[]>`SELECT status FROM payouts WHERE id = ${a.id}`;
    expect(still!.status).toBe('ON_HOLD');
    // the review is closed → the next payout run releases it (SYSTEM, audited)
    await t.adminSql`UPDATE risk_reviews SET status = 'CLEARED', resolved_at = now(), resolved_by = ${financeA.id} WHERE subject_type = 'TRANSACTION' AND subject_id = ${a.transaction_id}`;
    expect(await releaseClearedDisputeHolds(t.deps, { transactionId: a.transaction_id })).toBe(1);
    const [row] = await t.adminSql<{ status: string; hold_reason: string | null; released_by: string | null }[]>`SELECT status, hold_reason, released_by FROM payouts WHERE id = ${a.id}`;
    expect(row).toMatchObject({ status: 'SCHEDULED', hold_reason: null, released_by: null });
    const [au] = await t.adminSql<{ actor_type: string }[]>`SELECT actor_type FROM audit_logs WHERE action = 'payout.auto_released' AND entity_id = ${a.id}`;
    expect(au!.actor_type).toBe('SYSTEM');
  });

  it('an ADMIN hold (held_by set) is never auto-released', async () => {
    const po = await systemDisputeHold();
    await t.adminSql`UPDATE payouts SET held_by = ${financeA.id} WHERE id = ${po.id}`; // an admin put/kept it on hold
    expect(await releaseClearedDisputeHolds(t.deps, { transactionId: po.transaction_id })).toBe(0);
    const [row] = await t.adminSql<{ status: string }[]>`SELECT status FROM payouts WHERE id = ${po.id}`;
    expect(row!.status).toBe('ON_HOLD');
  });
});

describe('admin transaction views & overrides', () => {
  it('SUPPORT reads list/detail (masked parties, ledger) but cannot override; OPERATIONS cancels with MFA + idempotency', async () => {
    const { tx, p } = await purchasedTx(t);
    const list = await as(t, support, 'GET', `/v1/admin/transactions?q=${tx.number}`);
    expect(list.status).toBe(200);
    expect(list.body.data.map((x: any) => x.id)).toEqual([tx.id]);
    const detail = await as(t, support, 'GET', `/v1/admin/transactions/${tx.id}`);
    expect(detail.body).toMatchObject({ status: 'PURCHASED', ledger: { balanced: true } });
    expect(detail.body.buyer.displayName).toBe('Penitip U.');
    expect(detail.body.payments[0]).toMatchObject({ status: 'SECURED' });
    expect(detail.body.adminAllowedTransitions).toContain('REFUND_PENDING');
    expect(JSON.stringify(detail.body)).not.toContain(p.buyer.email);

    const body = { reason: 'Traveler batal berangkat karena sakit', approvalNote: 'Disetujui lead operasional via tiket' };
    expect((await as(t, support, 'POST', `/v1/admin/transactions/${tx.id}/cancel`, body, idem())).status).toBe(403);
    expect((await as(t, ops, 'POST', `/v1/admin/transactions/${tx.id}/cancel`, body)).status).toBe(400);
    const res = await as(t, ops, 'POST', `/v1/admin/transactions/${tx.id}/cancel`, body, idem());
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(['REFUNDED', 'CANCELLED', 'REFUND_PENDING']).toContain(res.body.status);
    expect((await ledgerCheck(t, tx.id)).balanced).toBe(true);
    const a = await auditRows(t, 'transactions.admin_cancel', tx.id);
    expect(a).toHaveLength(1);
    expect(a[0]!.meta).toMatchObject({ approvalNote: body.approvalNote });
  });
});
