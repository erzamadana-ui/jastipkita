import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers';

let t: TestContext;
beforeAll(async () => {
  t = await createTestContext();
});
afterAll(async () => {
  await t.close();
});

describe('skeleton', () => {
  it('reports health with schema version and MOCK integrations', async () => {
    const res = await t.request('GET', '/v1/health');
    expect(res.status).toBe(200);
    expect(res.body.database.ok).toBe(true);
    expect(res.body.database.schemaVersion).toMatch(/^\d{4}$/);
    expect(res.body.integrations.payments).toBe('MOCK');
  });

  it('serves an OpenAPI 3.1 document', async () => {
    const res = await t.request('GET', '/v1/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe('3.1.0');
  });

  it('returns the standard error shape for unknown routes', async () => {
    const res = await t.request('GET', '/v1/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.error.requestId).toBeTruthy();
  });

  it('app role can read config and write audit via jk_audit', async () => {
    const cfg = await t.deps.config.get('pricing.platform_fee');
    expect(cfg.rateBps).toBe(500);
    await t.sql`SELECT jk_audit('SYSTEM', NULL, 'system.smoke_test', 'system', 'smoke', NULL, NULL, '{}'::jsonb)`;
    const [row] = await t.adminSql<{ ok: boolean }[]>`SELECT verify_audit_chain() IS NULL AS ok`;
    expect(row!.ok).toBe(true);
  });

  it('issues sessions and rotates refresh tokens with reuse detection', async () => {
    const u = await t.createUser({ kycLevel: 2 });
    const { rotateRefreshToken } = await import('../src/services/session');
    const r1 = await rotateRefreshToken(t.deps, u.refreshToken);
    expect(r1.userId).toBe(u.id);
    await expect(rotateRefreshToken(t.deps, u.refreshToken)).rejects.toMatchObject({ code: 'REFRESH_REVOKED' });
    // whole family revoked after reuse
    await expect(rotateRefreshToken(t.deps, r1.refreshToken)).rejects.toMatchObject({ code: 'REFRESH_REVOKED' });
  });

  it('worker tick runs with no handlers', async () => {
    const r = await t.drain();
    expect(r.jobsFailed).toBe(0);
  });
});
