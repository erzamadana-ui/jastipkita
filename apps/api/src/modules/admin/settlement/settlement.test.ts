import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../../../../test/helpers';
import { type Admin, as, auditRows, createAdmin, idem } from '../test-support';

const ACCOUNT = '1234567890961';
const SECRETS = JSON.stringify({
  SETTLEMENT_MAIN: { bankCode: 'BCA', accountNumber: ACCOUNT, holderName: 'PT JastipKita Indonesia' },
  SETTLEMENT_TAX: { bankCode: 'MANDIRI', accountNumber: '9876543210442' },
});

let t: TestContext;
let finance: Admin;
let fsaA: Admin;
let fsaB: Admin;
let fsaNoMfa: Admin;
let superAdmin: Admin;
let marketing: Admin;

beforeAll(async () => {
  t = await createTestContext({ env: { SETTLEMENT_SECRETS_JSON: SECRETS } });
  finance = await createAdmin(t, ['FINANCE']);
  fsaA = await createAdmin(t, ['FINANCE_SUPER_ADMIN']);
  fsaB = await createAdmin(t, ['FINANCE_SUPER_ADMIN']);
  fsaNoMfa = await createAdmin(t, ['FINANCE_SUPER_ADMIN'], { mfa: false });
  superAdmin = await createAdmin(t, ['SUPER_ADMIN']);
  marketing = await createAdmin(t, ['MARKETING']);
});
afterAll(async () => {
  await t.close();
});

const create = (over: Record<string, unknown> = {}) => ({
  changeType: 'CREATE',
  label: 'Rekening pendapatan utama',
  purpose: 'PLATFORM_REVENUE',
  bankCode: 'BCA',
  secretRef: 'SETTLEMENT_MAIN',
  accountMask: '****0961',
  holderNameMask: 'PT J*** K*** I***',
  isPrimary: true,
  reason: 'Rekening settlement pertama untuk peluncuran',
  ...over,
});

describe('settlement accounts (masked, maker-checker, secret store)', () => {
  it('MARKETING cannot read; FINANCE reads masked list', async () => {
    const denied = await as(t, marketing, 'GET', '/v1/admin/settlement-accounts');
    expect(denied.status).toBe(403);
    const ok = await as(t, finance, 'GET', '/v1/admin/settlement-accounts');
    expect(ok.status).toBe(200);
  });

  it('request validation: secret must exist, mask must match its last digits, bank must match; raw numbers rejected', async () => {
    const missing = await as(t, finance, 'POST', '/v1/admin/settlement-accounts/changes', create({ secretRef: 'SETTLEMENT_NOPE' }), idem());
    expect(missing.status).toBe(422);
    expect(missing.body.error.code).toBe('SETTLEMENT_SECRET_NOT_FOUND');
    const mask = await as(t, finance, 'POST', '/v1/admin/settlement-accounts/changes', create({ accountMask: '****1111' }), idem());
    expect(mask.body.error.code).toBe('SETTLEMENT_MASK_MISMATCH');
    const bank = await as(t, finance, 'POST', '/v1/admin/settlement-accounts/changes', create({ bankCode: 'BNI' }), idem());
    expect(bank.body.error.code).toBe('SETTLEMENT_BANK_MISMATCH');
    const raw = await as(t, finance, 'POST', '/v1/admin/settlement-accounts/changes', create({ secretRef: ACCOUNT }), idem());
    expect(raw.status).toBe(400);
    const noIdem = await as(t, finance, 'POST', '/v1/admin/settlement-accounts/changes', create());
    expect(noIdem.status).toBe(400);
  });

  it('FINANCE requests → FINANCE / SUPER_ADMIN cannot approve → FSA without MFA blocked → another FSA applies', async () => {
    const req = await as(t, finance, 'POST', '/v1/admin/settlement-accounts/changes', create(), idem());
    expect(req.status, JSON.stringify(req.body)).toBe(201);
    expect(req.body).toMatchObject({ status: 'PENDING', changeType: 'CREATE', proposed: { accountMask: '****0961', secretConfigured: true } });
    expect(req.body.proposed.secretRef).toBeUndefined();
    const id = req.body.id;

    const byFinance = await as(t, finance, 'POST', `/v1/admin/settlement-accounts/changes/${id}/approve`, {}, idem());
    expect(byFinance.status).toBe(403);
    const bySuper = await as(t, superAdmin, 'POST', `/v1/admin/settlement-accounts/changes/${id}/approve`, {}, idem());
    expect(bySuper.status).toBe(403);
    expect(bySuper.body.error.details.missing).toEqual(['finance.settlement.approve_change']);
    const noMfa = await as(t, fsaNoMfa, 'POST', `/v1/admin/settlement-accounts/changes/${id}/approve`, {}, idem());
    expect(noMfa.body.error.code).toBe('MFA_REQUIRED');

    const ok = await as(t, fsaA, 'POST', `/v1/admin/settlement-accounts/changes/${id}/approve`, { note: 'Sesuai dokumen bank' }, idem());
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ status: 'APPLIED', account: { accountMask: '****0961', isPrimary: true, status: 'ACTIVE', bankCode: 'BCA', secretConfigured: true } });

    const list = await as(t, finance, 'GET', '/v1/admin/settlement-accounts');
    const text = JSON.stringify(list.body);
    expect(text).not.toContain(ACCOUNT);
    expect(text).not.toContain('secret://');
    expect(list.body.data).toHaveLength(1);

    // the number is never in the DB — only the reference + mask
    const [dump] = await t.adminSql<{ j: string }[]>`
      SELECT (SELECT coalesce(json_agg(s)::text, '') FROM settlement_accounts s) || (SELECT coalesce(json_agg(c)::text, '') FROM settlement_account_changes c)
             || (SELECT coalesce(json_agg(a)::text, '') FROM audit_logs a) AS j`;
    expect(dump!.j).not.toContain(ACCOUNT);
    expect(dump!.j).toContain('secret://SETTLEMENT_MAIN');
    const audits = await auditRows(t, 'finance.settlement_change_requested');
    expect(JSON.stringify(audits)).not.toContain('secret://');
    expect(await auditRows(t, 'finance.settlement_change_approved', ok.body.account.id)).toHaveLength(1);
  });

  it('an FSA who requested cannot approve their own change (maker-checker); rejection works', async () => {
    const [acc] = await t.adminSql<{ id: string }[]>`SELECT id FROM settlement_accounts LIMIT 1`;
    const req = await as(t, fsaB, 'POST', '/v1/admin/settlement-accounts/changes', { changeType: 'UPDATE', settlementAccountId: acc!.id, label: 'Rekening pendapatan (BCA)', reason: 'Penyesuaian label rekening' }, idem());
    expect(req.status, JSON.stringify(req.body)).toBe(201);
    const self = await as(t, fsaB, 'POST', `/v1/admin/settlement-accounts/changes/${req.body.id}/approve`, {}, idem());
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe('MAKER_CHECKER_VIOLATION');
    const rej = await as(t, fsaA, 'POST', `/v1/admin/settlement-accounts/changes/${req.body.id}/reject`, { note: 'Label tidak perlu diubah' }, idem());
    expect(rej.status).toBe(200);
    const again = await as(t, fsaA, 'POST', `/v1/admin/settlement-accounts/changes/${req.body.id}/approve`, {}, idem());
    expect(again.body.error.code).toBe('SETTLEMENT_CHANGE_NOT_PENDING');
  });
});
