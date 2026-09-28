import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../../../../test/helpers';
import { type Admin, as, auditRows, createAdmin, idem, purchasedTx } from '../test-support';

let t: TestContext;
let finance: Admin;
let financeNoMfa: Admin;
let support: Admin;
let marketing: Admin;

beforeAll(async () => {
  t = await createTestContext();
  finance = await createAdmin(t, ['FINANCE']);
  financeNoMfa = await createAdmin(t, ['FINANCE'], { mfa: false });
  support = await createAdmin(t, ['SUPPORT']);
  marketing = await createAdmin(t, ['MARKETING']);
});
afterAll(async () => {
  await t.close();
});

describe('admin reconciliation', () => {
  let runId: string;

  it('manual run for a past period → MATCHED for real captures; RBAC + MFA + idempotency + period rules', async () => {
    const { tx } = await purchasedTx(t);
    expect(tx.id).toBeTruthy();
    t.clock.advance(60_000);
    const now = t.clock.now().getTime();
    const body = { periodStart: new Date(now - 86_400_000).toISOString(), periodEnd: new Date(now).toISOString(), reason: 'Cek ulang setelah insiden webhook' };

    expect((await as(t, support, 'POST', '/v1/admin/reconciliation/runs', body, idem())).status).toBe(403);
    const noMfa = await as(t, financeNoMfa, 'POST', '/v1/admin/reconciliation/runs', body, idem());
    expect(noMfa.body.error.code).toBe('MFA_REQUIRED');
    expect((await as(t, finance, 'POST', '/v1/admin/reconciliation/runs', body)).status).toBe(400); // Idempotency-Key required

    const future = await as(t, finance, 'POST', '/v1/admin/reconciliation/runs', { ...body, periodEnd: new Date(now + 3_600_000).toISOString() }, idem());
    expect(future.body.error.code).toBe('PERIOD_IN_FUTURE');
    const tooLong = await as(t, finance, 'POST', '/v1/admin/reconciliation/runs', { ...body, periodStart: new Date(now - 40 * 86_400_000).toISOString() }, idem());
    expect(tooLong.body.error.code).toBe('PERIOD_TOO_LONG');

    const key = idem();
    const res = await as(t, finance, 'POST', '/v1/admin/reconciliation/runs', body, key);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ status: 'MATCHED', mismatches: 0 });
    expect(res.body.payments).toBeGreaterThanOrEqual(1);
    const replay = await as(t, finance, 'POST', '/v1/admin/reconciliation/runs', body, key);
    expect(replay.body.runId).toBe(res.body.runId);
    const [n] = await t.adminSql<{ n: number }[]>`SELECT count(*)::int AS n FROM reconciliation_runs WHERE id = ${res.body.runId}`;
    expect(n!.n).toBe(1);
    expect(await auditRows(t, 'reconciliation.manual_run', res.body.runId)).toHaveLength(1);

    const list = await as(t, finance, 'GET', '/v1/admin/reconciliation/runs');
    expect(list.status).toBe(200);
    expect(list.body.data[0]).toMatchObject({ id: res.body.runId, status: 'MATCHED', manual: true, sandbox: true, openItems: 0 });
    expect((await as(t, marketing, 'GET', '/v1/admin/reconciliation/runs')).status).toBe(403);
  });

  it('open differences are listed and resolved with an audited note (never twice)', async () => {
    // a run with differences as the daily job would record them (MOCK provider, TEST env)
    const now = t.clock.now();
    const [run] = await t.adminSql<{ id: string }[]>`
      INSERT INTO reconciliation_runs (provider, provider_env, period_start, period_end, status, totals, started_at, finished_at)
      VALUES ('MOCK', 'TEST', ${new Date(now.getTime() - 2 * 86_400_000)}, ${new Date(now.getTime() - 86_400_000)}, 'COMPLETED_WITH_DIFFS',
              ${t.adminSql.json({ payments: 3, mismatches: 2, internalCapturedIdr: 900_000, providerSecuredIdr: 1_000_000 } as never)}, ${now}, ${now})
      RETURNING id`;
    runId = run!.id;
    const items = await t.adminSql<{ id: string; status: string }[]>`
      INSERT INTO reconciliation_items (run_id, item_type, provider_ref, internal_amount_idr, provider_amount_idr, status) VALUES
        (${runId}, 'PAYMENT', 'mock_a', 400000, 500000, 'MISMATCH'),
        (${runId}, 'PAYMENT', 'mock_b', NULL, 500000, 'MISSING_INTERNAL'),
        (${runId}, 'PAYMENT', 'mock_c', 500000, 500000, 'MATCHED')
      RETURNING id, status`;
    const mismatch = items.find((i) => i.status === 'MISMATCH')!;

    const runs = await as(t, finance, 'GET', '/v1/admin/reconciliation/runs?status=COMPLETED_WITH_DIFFS');
    expect(runs.body.data.find((r: any) => r.id === runId)).toMatchObject({ openItems: 2, resolvedItems: 0, mismatches: 2, manual: false });

    const open = await as(t, finance, 'GET', `/v1/admin/reconciliation/runs/${runId}/items`);
    expect(open.status).toBe(200);
    expect(open.body.data.map((i: any) => i.status).sort()).toEqual(['MISMATCH', 'MISSING_INTERNAL']);
    expect(open.body.data.find((i: any) => i.id === mismatch.id)).toMatchObject({ internalAmountIdr: 400_000, providerAmountIdr: 500_000, diffIdr: 100_000 });
    const all = await as(t, finance, 'GET', `/v1/admin/reconciliation/runs/${runId}/items?status=MATCHED,MISMATCH,MISSING_INTERNAL`);
    expect(all.body.data).toHaveLength(3);
    expect((await as(t, finance, 'GET', `/v1/admin/reconciliation/runs/${crypto.randomUUID()}/items`)).status).toBe(404);

    const short = await as(t, finance, 'POST', `/v1/admin/reconciliation/items/${mismatch.id}/resolve`, { note: 'ok' });
    expect(short.status).toBe(400);
    const ok = await as(t, finance, 'POST', `/v1/admin/reconciliation/items/${mismatch.id}/resolve`, { note: 'Selisih biaya kanal, dikoreksi lewat jurnal penyesuaian #123' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ status: 'RESOLVED', previousStatus: 'MISMATCH', runId });
    const again = await as(t, finance, 'POST', `/v1/admin/reconciliation/items/${mismatch.id}/resolve`, { note: 'Selisih biaya kanal, dikoreksi lagi' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('RECONCILIATION_ITEM_NOT_OPEN');
    const matched = items.find((i) => i.status === 'MATCHED')!;
    expect((await as(t, finance, 'POST', `/v1/admin/reconciliation/items/${matched.id}/resolve`, { note: 'Tidak ada selisih sama sekali' })).status).toBe(409);
    expect((await as(t, support, 'POST', `/v1/admin/reconciliation/items/${mismatch.id}/resolve`, { note: 'Support mencoba menutup item' })).status).toBe(403);

    const [row] = await t.adminSql<{ status: string; resolved_by: string; resolution_note: string }[]>`
      SELECT status, resolved_by, resolution_note FROM reconciliation_items WHERE id = ${mismatch.id}`;
    expect(row).toMatchObject({ status: 'RESOLVED', resolved_by: finance.id });
    expect(await auditRows(t, 'reconciliation.item_resolved', mismatch.id)).toHaveLength(1);
    const after = await as(t, finance, 'GET', '/v1/admin/reconciliation/runs?status=COMPLETED_WITH_DIFFS');
    expect(after.body.data.find((r: any) => r.id === runId)).toMatchObject({ openItems: 1, resolvedItems: 1 });
  });
});
