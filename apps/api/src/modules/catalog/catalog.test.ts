import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../../../test/helpers';

let t: TestContext;
beforeAll(async () => {
  t = await createTestContext();
});
afterAll(async () => {
  await t.close();
});

describe('catalog', () => {
  it('lists only SOFT_LAUNCH/ACTIVE origins and ACTIVE destinations, cacheable', async () => {
    const res = await t.request('GET', '/v1/catalog/countries');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toMatch(/public, max-age=\d+/);
    const codes = res.body.data.map((c: { code: string }) => c.code);
    expect(codes).toEqual(expect.arrayContaining(['ID', 'JP', 'KR', 'SG', 'MY', 'AU', 'US']));
    expect(codes).not.toContain('CN'); // INACTIVE
    expect(codes).not.toContain('TW');
    const id = res.body.data.find((c: { code: string }) => c.code === 'ID');
    expect(id).toMatchObject({ isDestination: true, isOrigin: false, activation: 'ACTIVE', currencyCode: 'IDR' });
  });

  it('filters by role', async () => {
    const origins = await t.request('GET', '/v1/catalog/countries?role=origin');
    expect(origins.body.data.every((c: { isOrigin: boolean }) => c.isOrigin)).toBe(true);
    expect(origins.body.data.map((c: { code: string }) => c.code)).not.toContain('ID');
    const dest = await t.request('GET', '/v1/catalog/countries?role=destination');
    expect(dest.body.data.map((c: { code: string }) => c.code)).toEqual(['ID']);
    const bad = await t.request('GET', '/v1/catalog/countries?role=nope');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('hides countries whose activation is switched to INACTIVE', async () => {
    await t.adminSql`UPDATE countries SET activation = 'INACTIVE' WHERE code = 'AU'`;
    const res = await t.request('GET', '/v1/catalog/countries');
    expect(res.body.data.map((c: { code: string }) => c.code)).not.toContain('AU');
    await t.adminSql`UPDATE countries SET activation = 'SOFT_LAUNCH' WHERE code = 'AU'`;
  });

  it('lists categories with numeric default weight and currencies with minor units', async () => {
    const cats = await t.request('GET', '/v1/catalog/categories');
    expect(cats.status).toBe(200);
    expect(cats.headers.get('cache-control')).toContain('public');
    const fashion = cats.body.data.find((c: { code: string }) => c.code === 'FASHION_APPAREL');
    expect(fashion).toMatchObject({ nameId: 'Pakaian', riskLevel: 'LOW', defaultWeightKg: 0.5, defaultHsCode: '6109' });
    const ccy = await t.request('GET', '/v1/catalog/currencies');
    expect(ccy.status).toBe(200);
    const jpy = ccy.body.data.find((c: { code: string }) => c.code === 'JPY');
    expect(jpy).toMatchObject({ minorUnits: 0, ecbReference: true });
    const usd = ccy.body.data.find((c: { code: string }) => c.code === 'USD');
    expect(usd.minorUnits).toBe(2);
  });

  it('registers every marketplace route in the OpenAPI registry', async () => {
    // read the registry (not /v1/openapi.json) so other groups' in-progress schemas cannot break this check
    const paths = new Set(
      t.app.openAPIRegistry.definitions.flatMap((d) => (d.type === 'route' ? [`${d.route.method.toUpperCase()} ${d.route.path}`] : [])),
    );
    const expected = [
      'GET /v1/catalog/countries', 'GET /v1/catalog/categories', 'GET /v1/catalog/currencies',
      'GET /v1/fx/rates', 'POST /v1/fx/locks', 'POST /v1/customs/estimate', 'POST /v1/restricted/check',
      'GET /v1/trips', 'POST /v1/trips', 'GET /v1/trips/mine', 'GET /v1/trips/{id}', 'PATCH /v1/trips/{id}',
      'POST /v1/trips/{id}/verification', 'POST /v1/trips/{id}/publish', 'POST /v1/trips/{id}/depart',
      'POST /v1/trips/{id}/complete', 'POST /v1/trips/{id}/cancel', 'GET /v1/trips/{id}/recommended-requests',
      'POST /v1/requests/extract', 'POST /v1/requests', 'GET /v1/requests/mine', 'GET /v1/requests/open',
      'GET /v1/requests/{id}', 'PATCH /v1/requests/{id}', 'POST /v1/requests/{id}/publish', 'POST /v1/requests/{id}/cancel',
      'GET /v1/requests/{id}/recommended-travelers', 'POST /v1/requests/{id}/offers', 'POST /v1/trips/{id}/invites',
      'GET /v1/requests/{id}/offers', 'GET /v1/offers/mine', 'POST /v1/offers/{id}/accept', 'POST /v1/offers/{id}/decline',
      'POST /v1/offers/{id}/withdraw',
    ];
    for (const p of expected) expect(paths.has(p), p).toBe(true);
  });
});
