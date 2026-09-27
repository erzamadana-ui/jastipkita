import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../../../../test/helpers';
import { type Admin, as, auditRows, createAdmin } from '../test-support';

let t: TestContext;
let compA: Admin;
let compB: Admin;
let compNoMfa: Admin;
let ops: Admin;
let today: string;

beforeAll(async () => {
  t = await createTestContext();
  compA = await createAdmin(t, ['COMPLIANCE']);
  compB = await createAdmin(t, ['COMPLIANCE']);
  compNoMfa = await createAdmin(t, ['COMPLIANCE'], { mfa: false });
  ops = await createAdmin(t, ['OPERATIONS']);
  today = new Date(t.clock.now().getTime() + 7 * 3600_000).toISOString().slice(0, 10);
});
afterAll(async () => {
  await t.close();
});

const sample = { originCountry: 'JP', categoryCode: 'TOYS_HOBBIES', unitPriceMinor: 20000, currency: 'JPY', quantity: 1, fx: { itemToIdr: '109.1125', usdToIdr: '16500' } };

describe('customs rules (versioned, maker-checker, preview)', () => {
  it('new version of an ACTIVE code: DRAFT → preview shows the delta → submit → author cannot approve → another approves; previous version closed', async () => {
    expect((await as(t, ops, 'GET', '/v1/admin/customs-rules')).status).toBe(403);
    const list = await as(t, compA, 'GET', '/v1/admin/customs-rules?code=ID_PAX_NON_PERSONAL');
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    const v1 = list.body.data.find((r: any) => r.version === 1);
    expect(v1.status).toBe('ACTIVE');

    const create = await as(t, compA, 'POST', '/v1/admin/customs-rules', {
      code: 'ID_PAX_NON_PERSONAL',
      treatment: 'NON_PERSONAL',
      formulaCode: 'ID_PASSENGER_V2025',
      dutyRate: '0.15',
      vatRate: '0.12',
      vatDppFactor: '0.916667',
      incomeTaxRate: '0.05',
      rounding: 'CEIL_1000',
      effectiveFrom: today,
      sourceReference: 'Simulasi kenaikan BM (uji internal, bukan regulasi)',
      lastVerifiedAt: today,
    });
    expect(create.status, JSON.stringify(create.body)).toBe(201);
    expect(create.body).toMatchObject({ status: 'DRAFT', version: 3 });
    expect(Number(create.body.dutyRate)).toBe(0.15);
    const id = create.body.id;

    const patched = await as(t, compA, 'PATCH', `/v1/admin/customs-rules/${id}`, { notes: 'hanya catatan' });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(Number(patched.body.dutyRate)).toBe(0.15); // PATCH never resets unspecified fields
    expect(patched.body.rounding).toBe('CEIL_1000');

    const prev = await as(t, compA, 'POST', `/v1/admin/customs-rules/${id}/preview`, sample);
    expect(prev.status, JSON.stringify(prev.body)).toBe(200);
    expect(prev.body.proposedRuleSelected).toBe(true);
    expect(prev.body.current.ruleVersion).toBe(1);
    expect(prev.body.delta.dutyIdr).toBeGreaterThan(0);

    const draftApprove = await as(t, compB, 'POST', `/v1/admin/customs-rules/${id}/approve`, {});
    expect(draftApprove.status).toBe(422); // must be submitted first
    const sub = await as(t, compA, 'POST', `/v1/admin/customs-rules/${id}/submit`, {});
    expect(sub.body.status).toBe('PENDING_APPROVAL');
    const self = await as(t, compA, 'POST', `/v1/admin/customs-rules/${id}/approve`, {});
    expect(self.body.error.code).toBe('MAKER_CHECKER_VIOLATION');
    expect((await as(t, compNoMfa, 'POST', `/v1/admin/customs-rules/${id}/approve`, {})).body.error.code).toBe('MFA_REQUIRED');
    const ok = await as(t, compB, 'POST', `/v1/admin/customs-rules/${id}/approve`, {});
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.status).toBe('ACTIVE');
    expect(ok.body.superseded[0]).toMatchObject({ version: 1 });

    const [old] = await t.adminSql<{ status: string; effective_until: string | null }[]>`
      SELECT status, effective_until::text FROM customs_rules WHERE code = 'ID_PAX_NON_PERSONAL' AND version = 1`;
    expect(old!.status === 'RETIRED' || (old!.effective_until !== null && old!.effective_until < today)).toBe(true);
    expect(await auditRows(t, 'customs.rule_activated', id)).toHaveLength(1);
  });

  it('reject sends the version back to DRAFT with the note; drafts are discarded (append-only history)', async () => {
    const c = await as(t, compA, 'POST', '/v1/admin/customs-rules', {
      code: 'JP_TOYS_TEST', originCountry: 'JP', categoryCode: 'TOYS_HOBBIES', formulaCode: 'FLAT_RATES', dutyRate: '0.2', vatRate: '0.11',
      effectiveFrom: today, sourceReference: 'Uji penolakan', lastVerifiedAt: today,
    });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    await as(t, compA, 'POST', `/v1/admin/customs-rules/${c.body.id}/submit`, {});
    const rej = await as(t, compB, 'POST', `/v1/admin/customs-rules/${c.body.id}/reject`, { reason: 'Sumber regulasi belum ada' });
    expect(rej.body.status).toBe('DRAFT');
    const del = await as(t, compA, 'POST', `/v1/admin/customs-rules/${c.body.id}/discard`, { reason: 'Tidak jadi dipakai' });
    expect(del.status, JSON.stringify(del.body)).toBe(200);
    const after = await as(t, compA, 'GET', `/v1/admin/customs-rules/${c.body.id}`);
    expect(after.body.status).toBe('RETIRED');
    expect(after.body.notes).toMatch(/^\[DISCARDED DRAFT\] Tidak jadi dipakai/);
    expect((await as(t, compA, 'POST', `/v1/admin/customs-rules/${c.body.id}/discard`, { reason: 'dua kali' })).body.error.code).toBe('RULE_NOT_EDITABLE');
  });
});

describe('restricted items', () => {
  it('create PROHIBITED keyword rule → preview changes the classification → approve by another admin', async () => {
    const c = await as(t, compA, 'POST', '/v1/admin/restricted-items', {
      code: 'RI_TEST_DURIAN',
      keywords: ['durian'],
      classification: 'PROHIBITED',
      effectiveFrom: today,
      sourceReference: 'Uji internal: larangan maskapai',
      lastVerifiedAt: today,
      messageId: 'Durian dilarang dibawa di kabin pesawat.',
      messageEn: 'Durian is prohibited on board.',
    });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    const prev = await as(t, compA, 'POST', `/v1/admin/restricted-items/${c.body.id}/preview`, { ...sample, categoryCode: 'FOOD_SNACKS', productName: 'Durian Musang King beku' });
    expect(prev.status, JSON.stringify(prev.body)).toBe(200);
    expect(prev.body.proposed.classification).toBe('PROHIBITED');
    expect(prev.body.changed).toBe(prev.body.current.classification !== 'PROHIBITED');
    await as(t, compA, 'POST', `/v1/admin/restricted-items/${c.body.id}/submit`, {});
    const ok = await as(t, compB, 'POST', `/v1/admin/restricted-items/${c.body.id}/approve`, {});
    expect(ok.body.status).toBe('ACTIVE');
    const rv = await as(t, compB, 'POST', `/v1/admin/restricted-items/${c.body.id}/reverify`, { lastVerifiedAt: today, verifiedBy: 'Tim legal' });
    expect(rv.status, JSON.stringify(rv.body)).toBe(200);
  });
});
