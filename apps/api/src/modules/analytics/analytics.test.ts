import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../../../test/helpers';
import { createTransaction } from '../notifications/testing/fixtures';
import { isPiiKey, redactValue, sanitizeProperties } from './sanitize';

let t: TestContext;
beforeAll(async () => {
  t = await createTestContext();
});
afterAll(async () => {
  await t.close();
});

describe('sanitize (pure)', () => {
  it('drops PII keys, nested objects and oversized payloads; redacts PII-looking values', () => {
    const r = sanitizeProperties({
      screen: 'checkout',
      screenName: 'Checkout',
      email: 'a@b.co',
      phoneNumber: '0812',
      user_address: 'Jl. Sudirman',
      query: 'kirim ke dimas@gmail.com atau 081234567890',
      nested: { a: 1 },
      amountIdr: 1250000,
      tags: ['a', 'b'],
      'bad key': 1,
    });
    expect(r.properties).toEqual({ screen: 'checkout', screenName: 'Checkout', query: 'kirim ke [REDACTED] atau [REDACTED]', amountIdr: 1250000, tags: ['a', 'b'] });
    expect(r.dropped.sort()).toEqual(['bad key', 'email', 'nested', 'phoneNumber', 'user_address'].sort());
    expect(isPiiKey('displayName')).toBe(true);
    expect(isPiiKey('screen_name')).toBe(false);
    expect(redactValue('rek 1234 5678 9012')).toBe('rek [REDACTED]');
    const big = sanitizeProperties(Object.fromEntries(Array.from({ length: 19 }, (_, i) => [`k${i}`, 'x'.repeat(200)])));
    expect(new TextEncoder().encode(JSON.stringify(big.properties)).length).toBeLessThanOrEqual(2048);
  });
});

describe('POST /v1/analytics/events', () => {
  const post = (body: unknown, token?: string) => t.request('POST', '/v1/analytics/events', { body, ...(token ? { token } : {}), headers: { 'x-forwarded-for': `10.0.0.${Math.floor(Math.random() * 200)}` } });

  it('accepts anonymous batches with anonymousId, enforces the allowlist and strips PII', async () => {
    const anon = `anon-${randomUUID()}`;
    let res = await post({ platform: 'WEB', events: [{ name: 'app_open' }] });
    expect(res.status).toBe(400);
    res = await post({
      anonymousId: anon,
      platform: 'ANDROID',
      appVersion: '1.2.0',
      events: [
        { name: 'app_open' },
        { name: 'screen_view', properties: { screen: 'home', email: 'x@y.com' } },
        { name: 'hack_the_planet' },
        { name: 'search', occurredAt: '2020-01-01T00:00:00Z', properties: { query: 'switch' } },
      ],
    });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ accepted: 2, duplicates: 0 });
    expect(res.body.rejected).toEqual([
      { index: 2, reason: 'EVENT_NOT_ALLOWED' },
      { index: 3, reason: 'OCCURRED_AT_OUT_OF_RANGE' },
    ]);
    expect(res.body.droppedProperties).toEqual([{ index: 1, keys: ['email'] }]);
    const rows = await t.adminSql<{ event_name: string; user_id: string | null; properties: Record<string, unknown>; platform: string }[]>`
      SELECT event_name, user_id, properties, platform FROM analytics_events WHERE anonymous_id = ${anon} ORDER BY id`;
    expect(rows.map((r) => r.event_name)).toEqual(['app_open', 'screen_view']);
    expect(rows[1]!.properties).toEqual({ screen: 'home' });
    expect(rows[0]).toMatchObject({ user_id: null, platform: 'ANDROID' });
  });

  it('attributes events to the signed-in user and is idempotent per client eventId', async () => {
    const u = await t.createUser();
    const eventId = randomUUID();
    const body = { platform: 'IOS', events: [{ name: 'referral_shared', eventId, properties: { channel: 'whatsapp' } }] };
    expect((await post(body, u.accessToken)).body).toMatchObject({ accepted: 1, duplicates: 0 });
    expect((await post(body, u.accessToken)).body).toMatchObject({ accepted: 0, duplicates: 1 });
    const rows = await t.adminSql`SELECT 1 FROM analytics_events WHERE user_id = ${u.id} AND event_name = 'referral_shared'`;
    expect(rows).toHaveLength(1);
  });

  it('limits batches to 50 events and rate-limits per IP', async () => {
    const anon = `anon-${randomUUID()}`;
    const events = Array.from({ length: 51 }, () => ({ name: 'app_open' }));
    expect((await post({ anonymousId: anon, platform: 'WEB', events })).status).toBe(400);
    let last = 0;
    for (let i = 0; i < 125; i++) {
      const r = await t.request('POST', '/v1/analytics/events', { body: { anonymousId: anon, platform: 'WEB', events: [{ name: 'app_open' }] }, headers: { 'x-forwarded-for': '203.0.113.9' } });
      last = r.status;
      if (r.status === 429) break;
    }
    expect(last).toBe(429);
  });
});

describe('server-side funnel events from the outbox', () => {
  it('records payment_secured / purchase_completed / transaction_completed once, platform SERVER', async () => {
    const b = await t.createUser({ kycLevel: 2 });
    const tr = await t.createUser({ kycLevel: 4, mode: 'TRAVELER' });
    await createTransaction(t, { buyerId: b.id, travelerId: tr.id, to: 'COMPLETED' });
    await t.drain();
    await t.adminSql`UPDATE outbox_events SET published_at = NULL, available_at = now() - interval '1 second' WHERE event_type = 'transaction.status_changed'`;
    await t.drain();
    const rows = await t.adminSql<{ event_name: string; user_id: string; platform: string }[]>`
      SELECT event_name, user_id, platform FROM analytics_events WHERE user_id IN (${b.id}, ${tr.id}) ORDER BY id`;
    expect(rows.map((r) => [r.event_name, r.user_id === b.id ? 'buyer' : 'traveler'])).toEqual([
      ['payment_secured', 'buyer'],
      ['purchase_completed', 'traveler'],
      ['delivery_confirmed', 'buyer'],
      ['transaction_completed', 'buyer'],
    ]);
    expect(rows.every((r) => r.platform === 'SERVER')).toBe(true);
  });
});
