/**
 * SEC-06 (docs/security/review-2026-09.md): per-IP limits must key on an address the client cannot choose.
 * Before the fix the LEFT-most X-Forwarded-For entry (client-controlled) was used, so rotating a fake XFF value
 * bypassed the OTP per-IP quota, in-memory rate limits and signup-risk IP signals on Node deployments.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clientIp } from '../../src/middleware/request';
import { createTestContext, type TestContext } from '../helpers';
import { randomPhone } from '../../src/modules/auth/test-support';

let t: TestContext;
beforeAll(async () => {
  t = await createTestContext();
});
afterAll(() => t?.close());

describe('SEC-06 client IP extraction', () => {
  it('prefers CF-Connecting-IP, then the right-most X-Forwarded-For hop, and ignores junk', () => {
    expect(clientIp('198.51.100.1', '1.2.3.4, 5.6.7.8', '9.9.9.9')).toBe('198.51.100.1');
    expect(clientIp(undefined, '1.2.3.4, 5.6.7.8', undefined)).toBe('5.6.7.8');
    expect(clientIp(undefined, '203.0.113.10', undefined)).toBe('203.0.113.10');
    expect(clientIp(undefined, undefined, '2001:db8::1')).toBe('2001:db8::1');
    expect(clientIp('not an ip <script>', undefined, undefined)).toBeUndefined();
    expect(clientIp(undefined, '1.2.3.4, evil', '9.9.9.9')).toBe('9.9.9.9');
  });

  it('the OTP per-IP quota cannot be bypassed by rotating a spoofed left-most X-Forwarded-For', async () => {
    const statuses: { status: number; code?: string; scope?: unknown }[] = [];
    for (let i = 0; i < 22; i++) {
      const r = await t.request('POST', '/v1/auth/otp/request', {
        body: { channel: 'SMS', destination: randomPhone(), purpose: 'LOGIN' },
        headers: { 'x-forwarded-for': `10.${i}.${i}.${i}, 198.51.100.77` },
      });
      statuses.push({ status: r.status, code: r.body?.error?.code });
    }
    expect(statuses.slice(0, 20).every((s) => s.status === 200)).toBe(true);
    expect(statuses[20]).toMatchObject({ status: 429, code: 'OTP_RATE_LIMITED' });
    const [ev] = await t.adminSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM security_events WHERE type = 'OTP_RATE_LIMITED' AND meta->>'scope' = 'IP_HOUR'`;
    expect(ev!.n).toBeGreaterThanOrEqual(1);
  });
});
