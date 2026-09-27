/**
 * SEC-04 (docs/security/review-2026-09.md): after a failed attempt (5xx / thrown error) the Idempotency-Key row is
 * FAILED and a retry may run again — but concurrent retries of the same key must run the handler ONCE.
 * Before the fix the retry path did an unconditional UPDATE … SET status = 'IN_PROGRESS', so every concurrent retry
 * executed the financial handler.
 */
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppEnv } from '../../src/context';
import { requireAuth } from '../../src/middleware/auth';
import { requireIdempotency } from '../../src/middleware/idempotency';
import { errorResponse, requestContext } from '../../src/middleware/request';
import { createTestContext, type TestContext } from '../helpers';

let t: TestContext;
beforeAll(async () => {
  t = await createTestContext();
});
afterAll(() => t?.close());

function probeApp() {
  let calls = 0;
  const app = new Hono<AppEnv>();
  app.use('*', requestContext(t.deps));
  app.onError((err, c) => errorResponse(c, err));
  app.post('/v1/sec/pay', requireAuth, requireIdempotency, async (c) => {
    calls++;
    if (calls === 1) throw new Error('provider timeout'); // first attempt fails → key FAILED
    await new Promise((r) => setTimeout(r, 50));
    return c.json({ charged: calls }, 201);
  });
  return { app, calls: () => calls };
}

describe('SEC-04 idempotency retry claim is atomic', () => {
  it('five concurrent retries of a FAILED key execute the handler once and replay its response', async () => {
    const u = await t.createUser();
    const { app, calls } = probeApp();
    const key = crypto.randomUUID();
    const send = () =>
      app.request('/v1/sec/pay', {
        method: 'POST',
        headers: { authorization: `Bearer ${u.accessToken}`, 'content-type': 'application/json', 'idempotency-key': key },
        body: JSON.stringify({ amountIdr: 100000 }),
      });
    expect((await send()).status).toBe(500);
    expect(calls()).toBe(1);

    // Deterministic race: hold the key's row lock while five retries pass the INSERT/SELECT phase and queue on
    // the claim UPDATE, then release them all at once.
    let rs: Response[] = [];
    await t.adminSql.begin(async (tx) => {
      await tx`SELECT 1 FROM idempotency_keys WHERE user_id = ${u.id} AND key = ${key} FOR UPDATE`;
      const pending = Promise.all([1, 2, 3, 4, 5].map(() => send()));
      await new Promise((r) => setTimeout(r, 400));
      void pending.then((x) => (rs = x));
    });
    for (let i = 0; i < 100 && rs.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    const statuses = rs.map((r) => r.status).sort();
    expect(calls()).toBe(2); // exactly one retry reached the handler
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(4);

    const replay = await send();
    expect(replay.status).toBe(201);
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    expect(await replay.json()).toEqual({ charged: 2 });
    expect(calls()).toBe(2);
  });

  it('the same key with a different body or path is rejected, never executed', async () => {
    const u = await t.createUser();
    const { app, calls } = probeApp();
    const key = crypto.randomUUID();
    const headers = { authorization: `Bearer ${u.accessToken}`, 'content-type': 'application/json', 'idempotency-key': key };
    await app.request('/v1/sec/pay', { method: 'POST', headers, body: JSON.stringify({ amountIdr: 1 }) });
    const other = await app.request('/v1/sec/pay', { method: 'POST', headers, body: JSON.stringify({ amountIdr: 999999 }) });
    expect(other.status).toBe(422);
    expect(((await other.json()) as { error: { code: string } }).error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(calls()).toBe(1);
    // keys are scoped per user: another user's identical key is independent
    const v = await t.createUser();
    const mine = await app.request('/v1/sec/pay', { method: 'POST', headers: { ...headers, authorization: `Bearer ${v.accessToken}` }, body: JSON.stringify({ amountIdr: 1 }) });
    expect(mine.status).toBe(201);
  });
});

describe('BUG-QA-05 transient responses are never replayed', () => {
  function transientApp(first: 429 | 503) {
    let calls = 0;
    const app = new Hono<AppEnv>();
    app.use('*', requestContext(t.deps));
    app.onError((err, c) => errorResponse(c, err));
    app.post('/v1/sec/transient', requireAuth, requireIdempotency, async (c) => {
      calls++;
      if (calls === 1) return c.json({ error: { code: first === 429 ? 'RATE_LIMITED' : 'PROVIDER_UNAVAILABLE' } }, first);
      return c.json({ charged: calls }, 201);
    });
    return { app, calls: () => calls };
  }

  for (const first of [429, 503] as const) {
    it(`a ${first} marks the key FAILED; the retry with the same key runs the handler and its 201 is what gets replayed`, async () => {
      const u = await t.createUser();
      const { app, calls } = transientApp(first);
      const key = crypto.randomUUID();
      const send = () =>
        app.request('/v1/sec/transient', {
          method: 'POST',
          headers: { authorization: `Bearer ${u.accessToken}`, 'content-type': 'application/json', 'idempotency-key': key },
          body: JSON.stringify({ amountIdr: 5000 }),
        });
      expect((await send()).status).toBe(first);
      const [row] = await t.adminSql<{ status: string; response_status: number | null }[]>`SELECT status, response_status FROM idempotency_keys WHERE user_id = ${u.id} AND key = ${key}`;
      expect(row).toMatchObject({ status: 'FAILED', response_status: null });
      const retry = await send();
      expect(retry.status).toBe(201);
      expect(retry.headers.get('idempotent-replayed')).toBeNull();
      const replay = await send();
      expect(replay.status).toBe(201);
      expect(replay.headers.get('idempotent-replayed')).toBe('true');
      expect(await replay.json()).toEqual({ charged: 2 });
      expect(calls()).toBe(2);
    });
  }

  it('money routes rate-limit BEFORE the idempotency claim: a throttled checkout leaves no key behind', async () => {
    const u = await t.createUser({ kycLevel: 2 });
    const fake = '00000000-0000-4000-8000-000000000000';
    let last: { status: number } = { status: 0 };
    const keys: string[] = [];
    for (let i = 0; i < 11; i++) {
      const key = crypto.randomUUID();
      keys.push(key);
      last = await t.request('POST', `/v1/transactions/${fake}/checkout`, { token: u.accessToken, body: { quoteId: fake }, headers: { 'idempotency-key': key } });
    }
    expect(last.status).toBe(429);
    const [row] = await t.adminSql`SELECT 1 FROM idempotency_keys WHERE user_id = ${u.id} AND key = ${keys.at(-1)!}`;
    expect(row).toBeUndefined();
  });
});
