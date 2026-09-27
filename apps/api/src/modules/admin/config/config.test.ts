import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../../../../test/helpers';
import { jsonDiff } from './service';
import { type Admin, as, auditRows, createAdmin } from '../test-support';

let t: TestContext;
let superA: Admin;
let superB: Admin;
let fsa: Admin;
let finance: Admin;
let ops: Admin;

beforeAll(async () => {
  t = await createTestContext();
  superA = await createAdmin(t, ['SUPER_ADMIN']);
  superB = await createAdmin(t, ['SUPER_ADMIN'], { mfa: false });
  fsa = await createAdmin(t, ['FINANCE_SUPER_ADMIN']);
  finance = await createAdmin(t, ['FINANCE']);
  ops = await createAdmin(t, ['OPERATIONS']);
});
afterAll(async () => {
  await t.close();
});

const SLA = { hoursByPriority: { URGENT: 2, HIGH: 12, NORMAL: 24, LOW: 72 } };

describe('business config maker-checker', () => {
  it('jsonDiff reports changed / added / removed paths', () => {
    expect(jsonDiff({ a: 1, b: { c: [1, 2] } }, { a: 2, b: { c: [1] }, d: true })).toEqual([
      { path: 'a', op: 'changed', before: 1, after: 2 },
      { path: 'b.c[1]', op: 'removed', before: 2 },
      { path: 'd', op: 'added', after: true },
    ]);
  });

  it('list shows every key with its active version; OPERATIONS can read but not propose', async () => {
    const list = await as(t, ops, 'GET', '/v1/admin/config');
    expect(list.status).toBe(200);
    const sla = list.body.data.find((d: any) => d.key === 'support.sla');
    expect(sla).toMatchObject({ active: { version: 1, status: 'ACTIVE' }, pendingApprovals: 0 });
    const denied = await as(t, ops, 'POST', '/v1/admin/config/support.sla/versions', { value: SLA, changeReason: 'Percepat SLA urgent' });
    expect(denied.status).toBe(403);
    const unknownKey = await as(t, ops, 'GET', '/v1/admin/config/nope.key');
    expect(unknownKey.status).toBe(404);
  });

  it('invalid values are rejected with validator errors', async () => {
    const bad = await as(t, superA, 'POST', '/v1/admin/config/support.sla/versions', { value: { hoursByPriority: { URGENT: -1 } }, changeReason: 'Nilai yang salah untuk uji' });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('CONFIG_INVALID');
    expect(bad.body.error.details.errors.length).toBeGreaterThan(0);
  });

  it('propose → diff → proposer cannot approve → approver without MFA blocked → FINANCE_SUPER_ADMIN approves → cache invalidated', async () => {
    expect((await t.deps.config.get('support.sla')).hoursByPriority.URGENT).toBe(4);
    const p = await as(t, superA, 'POST', '/v1/admin/config/support.sla/versions', { value: SLA, changeReason: 'Percepat SLA tiket urgent jadi 2 jam', notes: 'Rapat ops mingguan' });
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    expect(p.body).toMatchObject({ version: 2, status: 'PENDING_APPROVAL', diffFromActive: [{ path: 'hoursByPriority.URGENT', op: 'changed', before: 4, after: 2 }] });
    const dup = await as(t, superA, 'POST', '/v1/admin/config/support.sla/versions', { value: SLA, changeReason: 'Percepat SLA tiket urgent jadi 2 jam' });
    expect(dup.status).toBe(409);

    const diff = await as(t, finance, 'GET', '/v1/admin/config/support.sla/diff?version=2');
    expect(diff.body.changes).toHaveLength(1);

    const self = await as(t, superA, 'POST', `/v1/admin/config-versions/${p.body.id}/approve`, {});
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe('MAKER_CHECKER_VIOLATION');
    const noMfa = await as(t, superB, 'POST', `/v1/admin/config-versions/${p.body.id}/approve`, {});
    expect(noMfa.body.error.code).toBe('MFA_REQUIRED');
    const byFinance = await as(t, finance, 'POST', `/v1/admin/config-versions/${p.body.id}/approve`, {});
    expect(byFinance.status).toBe(403);

    const ok = await as(t, fsa, 'POST', `/v1/admin/config-versions/${p.body.id}/approve`, {});
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ version: 2, status: 'ACTIVE', approvedBy: fsa.id });
    expect((await t.deps.config.get('support.sla')).hoursByPriority.URGENT).toBe(2);

    const detail = await as(t, ops, 'GET', '/v1/admin/config/support.sla');
    expect(detail.body.history.map((h: any) => [h.version, h.status])).toEqual([[2, 'ACTIVE'], [1, 'SUPERSEDED']]);
    const audits = await auditRows(t, 'config.approved', 'support.sla');
    expect(audits).toHaveLength(1);
    expect(audits[0]!.meta).toMatchObject({ makerId: superA.id });
  });

  it('no-op proposals are refused; rejection keeps the active version', async () => {
    const same = await as(t, superA, 'POST', '/v1/admin/config/support.sla/versions', { value: SLA, changeReason: 'Tidak ada perubahan apa pun' });
    expect(same.body.error.code).toBe('CONFIG_NO_CHANGE');
    const p = await as(t, superA, 'POST', '/v1/admin/config/support.sla/versions', { value: { hoursByPriority: { URGENT: 1, HIGH: 12, NORMAL: 24, LOW: 72 } }, changeReason: 'SLA 1 jam untuk urgent', isAssumption: true });
    expect(p.status).toBe(201);
    const rej = await as(t, fsa, 'POST', `/v1/admin/config-versions/${p.body.id}/reject`, { reason: 'Tim CS belum siap' });
    expect(rej.status).toBe(200);
    expect(rej.body.status).toBe('REJECTED');
    expect((await t.deps.config.get('support.sla')).hoursByPriority.URGENT).toBe(2);
  });
});
