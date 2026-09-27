import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../../../../test/helpers';
import { type Admin, as, auditRows, createAdmin } from '../test-support';

let t: TestContext;
let support: Admin;
let compliance: Admin;
let complianceB: Admin;
let complianceNoMfa: Admin;
let finance: Admin;

beforeAll(async () => {
  t = await createTestContext();
  support = await createAdmin(t, ['SUPPORT']);
  compliance = await createAdmin(t, ['COMPLIANCE']);
  complianceB = await createAdmin(t, ['COMPLIANCE']);
  complianceNoMfa = await createAdmin(t, ['COMPLIANCE'], { mfa: false });
  finance = await createAdmin(t, ['FINANCE']);
});
afterAll(async () => {
  await t.close();
});

describe('FAQ', () => {
  it('create DRAFT (hidden) → publish (public) → archive; FINANCE has no faq.manage', async () => {
    const body = { slug: 'cara-klaim-refund', category: 'PAYMENT', question: 'Bagaimana cara klaim refund?', answerMd: 'Buka detail transaksi lalu pilih **Ajukan refund**.', tags: ['refund'] };
    expect((await as(t, finance, 'POST', '/v1/admin/faq', body)).status).toBe(403);
    const c = await as(t, support, 'POST', '/v1/admin/faq', body);
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    expect(c.body.status).toBe('DRAFT');
    expect((await t.request('GET', '/v1/support/faq/cara-klaim-refund')).status).toBe(404);
    const dup = await as(t, support, 'POST', '/v1/admin/faq', body);
    expect(dup.status).toBe(409);
    const pub = await as(t, support, 'POST', `/v1/admin/faq/${c.body.id}/publish`);
    expect(pub.body.status).toBe('PUBLISHED');
    const pubView = await t.request('GET', '/v1/support/faq/cara-klaim-refund');
    expect(pubView.status).toBe(200);
    expect(pubView.body.question).toBe('Bagaimana cara klaim refund?');
    const edit = await as(t, support, 'PATCH', `/v1/admin/faq/${c.body.id}`, { answerMd: 'Buka detail transaksi → **Ajukan refund**. Dana kembali 1–3 hari kerja.' });
    expect(edit.status).toBe(200);
    expect((await as(t, support, 'DELETE', `/v1/admin/faq/${c.body.id}`)).status).toBe(422);
    const arch = await as(t, support, 'POST', `/v1/admin/faq/${c.body.id}/archive`);
    expect(arch.body.status).toBe('ARCHIVED');
    expect((await t.request('GET', '/v1/support/faq/cara-klaim-refund')).status).toBe(404);
    expect(await auditRows(t, 'faq.published', c.body.id)).toHaveLength(1);
    const draft = await as(t, support, 'POST', '/v1/admin/faq', { ...body, slug: 'draf-sementara' });
    const del = await as(t, support, 'DELETE', `/v1/admin/faq/${draft.body.id}`);
    expect(del.status, JSON.stringify(del.body)).toBe(200);
    expect((await as(t, support, 'GET', `/v1/admin/faq/${draft.body.id}`)).status).toBe(404);
  });
});

describe('legal documents', () => {
  it('create → edit while unpublished → publish (MFA) retires the previous version → immutable', async () => {
    const mk = (version: string) => ({ type: 'REFUND_POLICY', version, locale: 'id', title: `Kebijakan Refund ${version}`, bodyMd: `# Kebijakan Refund\n\nVersi ${version}: dana dikembalikan ke metode pembayaran asal.` });
    expect((await as(t, support, 'POST', '/v1/admin/legal-documents', mk('2026-10'))).status).toBe(403);
    const v1 = await as(t, compliance, 'POST', '/v1/admin/legal-documents', mk('2026-10'));
    expect(v1.status, JSON.stringify(v1.body)).toBe(201);
    const p1 = await as(t, compliance, 'POST', `/v1/admin/legal-documents/${v1.body.id}/publish`, {});
    expect(p1.status, JSON.stringify(p1.body)).toBe(200);
    const v2 = await as(t, complianceB, 'POST', '/v1/admin/legal-documents', mk('2026-11'));
    const e = await as(t, complianceB, 'PATCH', `/v1/admin/legal-documents/${v2.body.id}`, { summaryOfChanges: 'Batas waktu refund diperjelas' });
    expect(e.status).toBe(200);
    expect((await as(t, complianceNoMfa, 'POST', `/v1/admin/legal-documents/${v2.body.id}/publish`, {})).body.error.code).toBe('MFA_REQUIRED');
    const p2 = await as(t, complianceB, 'POST', `/v1/admin/legal-documents/${v2.body.id}/publish`, {});
    expect(p2.status, JSON.stringify(p2.body)).toBe(200);
    expect(p2.body.retiredPrevious).toEqual([{ id: v1.body.id, version: '2026-10' }]);
    const locked = await as(t, compliance, 'PATCH', `/v1/admin/legal-documents/${v2.body.id}`, { title: 'Ubah judul setelah terbit' });
    expect(locked.status).toBe(422);
    expect(locked.body.error.code).toMatch(/PUBLISHED/);
    const list = await as(t, compliance, 'GET', '/v1/admin/legal-documents?type=REFUND_POLICY');
    const current = list.body.data.filter((d: any) => d.current);
    expect(current.map((d: any) => d.version)).toEqual(['2026-11']);
    expect(await auditRows(t, 'legal.document_published', v2.body.id)).toHaveLength(1);
  });
});
