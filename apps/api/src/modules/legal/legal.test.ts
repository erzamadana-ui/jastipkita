import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../../../test/helpers';
import { LEGAL_SEED_PATH, readLegalTemplates, renderLegalSeed } from '../../../scripts/gen-legal-seed';
import { phoneLogin } from '../auth/test-support';
import { LEGAL_SLUGS, LEGAL_TEMPLATE_BANNER, LEGAL_TYPES } from './catalog';
import { ConsentRequirementsSchema, LegalDocumentListSchema, LegalDocumentSchema } from './schemas';

let t: TestContext;
beforeAll(async () => {
  t = await createTestContext();
});
afterAll(async () => {
  await t.close();
});

describe('legal seed', () => {
  it('db/seeds/0200_legal_documents.sql is generated from docs/legal/*.md and up to date', () => {
    const templates = readLegalTemplates();
    expect(templates.map((x) => x.type).sort()).toEqual([...LEGAL_TYPES].sort());
    for (const x of templates) expect(x.bodyMd).toContain(LEGAL_TEMPLATE_BANNER);
    expect(readFileSync(LEGAL_SEED_PATH, 'utf8')).toBe(renderLegalSeed(templates));
  });
});

describe('GET /v1/legal/documents', () => {
  it('lists the current published version of all 10 templates (public, absolute URLs, TEMPLATE flag)', async () => {
    const res = await t.request('GET', '/v1/legal/documents');
    expect(res.status).toBe(200);
    expect(LegalDocumentListSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.data.map((d: any) => d.type)).toEqual([
      'TOS',
      'PRIVACY',
      'TRAVELER_AGREEMENT',
      'REFUND_POLICY',
      'PROHIBITED_ITEMS',
      'PAYMENT_TERMS',
      'KYC',
      'MARKETING',
      'COOKIES',
      'COMMUNITY_GUIDELINES',
    ]);
    const tos = res.body.data[0];
    expect(tos).toMatchObject({
      version: '0.1-template',
      locale: 'id',
      title: 'Syarat & Ketentuan Penggunaan',
      slug: 'terms-of-service',
      url: 'http://web.test/legal/terms-of-service/',
      contentUrl: 'http://api.test/v1/legal/documents/TOS?locale=id&version=0.1-template',
      isTemplate: true,
      consentType: true,
      publishedAt: '2026-09-27T00:00:00.000Z',
      effectiveAt: '2026-09-27T00:00:00.000Z',
    });
    expect(tos.summary).toMatch(/Penitip dan Traveler/);
    expect(res.body.data.find((d: any) => d.type === 'REFUND_POLICY').consentType).toBe(false);
    expect(res.headers.get('cache-control')).toContain('max-age=300');
    expect((await t.request('GET', '/v1/legal/documents?locale=en')).body.data).toEqual([]);
    expect((await t.request('GET', '/v1/legal/documents?type=KYC')).body.data.map((d: any) => d.slug)).toEqual(['kyc-consent']);
  });

  it('GET /{type} returns the markdown body by type or slug, with Indonesian fallback, ?version and 404', async () => {
    const byType = await t.request('GET', '/v1/legal/documents/PRIVACY');
    expect(byType.status).toBe(200);
    expect(LegalDocumentSchema.safeParse(byType.body).success).toBe(true);
    expect(byType.body.bodyMd.startsWith(`> **${LEGAL_TEMPLATE_BANNER}**`)).toBe(true);
    expect(byType.body.bodyMd).not.toMatch(/^---/);
    const bySlug = await t.request('GET', `/v1/legal/documents/${LEGAL_SLUGS.COMMUNITY_GUIDELINES}`);
    expect(bySlug.body).toMatchObject({ type: 'COMMUNITY_GUIDELINES', title: 'Pedoman Komunitas', retiredAt: null });
    const en = await t.request('GET', '/v1/legal/documents/tos?locale=en');
    expect(en.body).toMatchObject({ type: 'TOS', locale: 'id', requestedLocale: 'en' });
    expect((await t.request('GET', '/v1/legal/documents/TOS?version=0.1-template')).status).toBe(200);
    expect((await t.request('GET', '/v1/legal/documents/TOS?version=9.9')).status).toBe(404);
    const nope = await t.request('GET', '/v1/legal/documents/nope');
    expect(nope.status).toBe(404);
    expect(nope.body.error.code).toBe('LEGAL_DOCUMENT_NOT_FOUND');
  });
});

describe('GET /v1/consents/requirements', () => {
  it('lists signup/KYC consents with exactly the versions POST /v1/me/consents accepts', async () => {
    const anon = await t.request('GET', '/v1/consents/requirements');
    expect(anon.status).toBe(200);
    expect(ConsentRequirementsSchema.safeParse(anon.body).success).toBe(true);
    expect(anon.body.signup.required.map((r: any) => r.type)).toEqual(['TOS', 'PRIVACY']);
    expect(anon.body.signup.optional.map((r: any) => r.type)).toEqual(['MARKETING']);
    expect(anon.body.kyc.required.map((r: any) => r.type)).toEqual(['KYC']);
    expect(anon.body.signup.required[0]).toMatchObject({
      type: 'TOS',
      required: true,
      version: '0.1-template',
      acceptedVersions: ['0.1-template'],
      versionEnforced: true,
      title: 'Syarat & Ketentuan Penggunaan',
      url: 'http://web.test/legal/terms-of-service/',
      documentUrl: 'http://api.test/v1/legal/documents/TOS?locale=id',
      granted: null,
      upToDate: null,
    });
    expect(anon.body.signup.satisfied).toBeNull();

    // signed in (signup consents given with the advertised version) → satisfied; KYC not yet
    const u = await phoneLogin(t);
    const token = u.tokens.accessToken;
    let me = await t.request('GET', '/v1/consents/requirements', { token });
    expect(me.body.signup).toMatchObject({ satisfied: true });
    expect(me.body.signup.required[0]).toMatchObject({ granted: true, grantedVersion: '0.1-template', upToDate: true });
    expect(me.body.kyc).toMatchObject({ satisfied: false, required: [{ type: 'KYC', granted: false, upToDate: false }] });

    // the advertised version is accepted; anything else is rejected with the same list
    const kycVersion = me.body.kyc.required[0].version;
    const bad = await t.request('POST', '/v1/me/consents', { token, body: { type: 'KYC', version: '2026-09' } });
    expect(bad.status).toBe(422);
    expect(bad.body.error).toMatchObject({ code: 'CONSENT_VERSION_INVALID', details: { allowedVersions: me.body.kyc.required[0].acceptedVersions } });
    expect((await t.request('POST', '/v1/me/consents', { token, body: { type: 'KYC', version: kycVersion } })).status).toBe(201);
    me = await t.request('GET', '/v1/consents/requirements', { token });
    expect(me.body.kyc.satisfied).toBe(true);

    // a newer published version becomes the advertised one; older non-retired versions stay accepted
    await t.adminSql`INSERT INTO legal_documents (type, version, locale, title, body_md, published_at)
                     VALUES ('KYC', '0.2', 'id', 'Persetujuan KYC v0.2', 'Isi persetujuan versi 0.2 ...', now() + interval '1 second')`;
    me = await t.request('GET', '/v1/consents/requirements', { token });
    expect(me.body.kyc.required[0]).toMatchObject({ version: '0.2', acceptedVersions: ['0.2', '0.1-template'], upToDate: true });
  });
});
