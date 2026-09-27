import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, TEST_ENV_BASE, type TestContext } from './helpers';

let t: TestContext;
beforeAll(async () => {
  t = await createTestContext({ env: { WEB_BASE_URL: 'https://antarkitaindonesia.com/jastipkita' } });
});
afterAll(async () => {
  await t.close();
});

describe('Cloudflare Workers entry', () => {
  it('builds the app once per isolate and serves requests with a per-request DB client', async () => {
    const worker = (await import('../src/worker')).default;
    const bindings = { ...TEST_ENV_BASE, DATABASE_URL: t.env.DATABASE_URL, LOG_LEVEL: 'error' };
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => void waits.push(p) };
    for (let i = 0; i < 3; i++) {
      const res = await worker.fetch(new Request('http://api.test/v1/health'), bindings, ctx);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { database: { ok: boolean } };
      expect(body.database.ok).toBe(true);
    }
    await Promise.all(waits);
  });
});

describe('CORS', () => {
  it('allows the web origin even when WEB_BASE_URL has a path', async () => {
    const res = await t.app.request('/v1/health', { headers: { origin: 'https://antarkitaindonesia.com' } });
    expect(res.headers.get('access-control-allow-origin')).toBe('https://antarkitaindonesia.com');
  });
  it('rejects unknown origins', async () => {
    const res = await t.app.request('/v1/health', { headers: { origin: 'https://evil.example' } });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});
