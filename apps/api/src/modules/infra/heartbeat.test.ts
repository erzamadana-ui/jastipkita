import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../../../test/helpers';
import { heartbeatStaleAfterSec } from './heartbeat';

let t: TestContext;
beforeAll(async () => {
  t = await createTestContext();
});
afterAll(async () => {
  await t.close();
});

describe('GET /v1/health/worker (public worker heartbeat for uptime checkers)', () => {
  it('stale thresholds follow the cron cadence: 3 × 5 min in production, 3 × 15 min elsewhere', () => {
    expect(heartbeatStaleAfterSec('production')).toBe(900);
    expect(heartbeatStaleAfterSec('staging')).toBe(2700);
  });

  it('503 before any scheduled job ran; 200 after a worker tick; 503 again once older than the threshold — no auth, nothing sensitive', async () => {
    const before = await t.request('GET', '/v1/health/worker');
    expect(before.status).toBe(503);
    expect(before.body).toMatchObject({ status: 'stale', lastScheduledJobAt: null, ageSec: null, staleAfterSec: 2700 });

    await t.drain();
    const ok = await t.request('GET', '/v1/health/worker');
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.status).toBe('ok');
    expect(Object.keys(ok.body).sort()).toEqual(['ageSec', 'checkedAt', 'lastScheduledJobAt', 'staleAfterSec', 'status']);
    expect(ok.headers.get('cache-control')).toBe('no-store');

    t.clock.advance(2701 * 1000 + 60_000);
    const stale = await t.request('GET', '/v1/health/worker');
    expect(stale.status).toBe(503);
    expect(stale.body.status).toBe('stale');
    expect(stale.body.ageSec).toBeGreaterThan(2700);
  });
});
