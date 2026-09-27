import { crossRate, markupBpsFor, quoteRate } from '@jastipkita/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../../../test/helpers';
import { FrankfurterFxProvider, FxProviderError } from '../../providers/fx/frankfurter';
import { MOCK_USD_RATES, StaticFxProvider } from '../../providers/mock';
import type { FxProvider } from '../../providers/types';
import { createFxLock, refreshFxRates } from './service';

const NOW = new Date('2026-10-05T03:00:00Z'); // Monday 10:00 WIB
let t: TestContext;
beforeAll(async () => {
  t = await createTestContext({ now: NOW });
});
afterAll(async () => {
  await t.close();
});

function failingProvider(source = 'frankfurter-ecb'): FxProvider {
  return {
    mode: 'LIVE',
    source,
    latest: async () => {
      throw new FxProviderError('FX_PROVIDER_HTTP', 'down');
    },
  };
}

describe('Frankfurter adapter', () => {
  it('requests ECB symbols only and reports the ECB reference time as asOf', async () => {
    const calls: string[] = [];
    const p = new FrankfurterFxProvider({
      baseUrl: 'https://fx.example/v1/',
      now: () => NOW,
      fetch: async (url) => {
        calls.push(url);
        return new Response(JSON.stringify({ amount: 1, base: 'EUR', date: '2026-10-02', rates: { IDR: 20410.5, JPY: 179.2, USD: 1.14 } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    const snap = await p.latest('EUR', ['IDR', 'JPY', 'USD', 'TWD', 'EUR']);
    expect(calls[0]).toBe('https://fx.example/v1/latest?base=EUR&symbols=IDR,JPY,USD');
    expect(snap).toMatchObject({ source: 'frankfurter-ecb', base: 'EUR', rates: { IDR: 20410.5, JPY: 179.2, USD: 1.14 } });
    // Friday's ECB rate fetched on Monday: asOf stays Friday (weekend staleness is visible, not hidden)
    expect(snap.asOf.toISOString()).toBe('2026-10-02T14:00:00.000Z');
  });

  it('times out, rejects HTTP errors and malformed payloads', async () => {
    const hang = new FrankfurterFxProvider({
      baseUrl: 'https://fx.example/v1',
      timeoutMs: 30,
      fetch: (_u, init) =>
        new Promise((_res, rej) => {
          init?.signal?.addEventListener('abort', () => rej(new Error('aborted')));
        }),
    });
    await expect(hang.latest('EUR', ['IDR'])).rejects.toMatchObject({ code: 'FX_PROVIDER_TIMEOUT' });
    const http = new FrankfurterFxProvider({ baseUrl: 'https://fx.example/v1', fetch: async () => new Response('nope', { status: 502 }) });
    await expect(http.latest('EUR', ['IDR'])).rejects.toMatchObject({ code: 'FX_PROVIDER_HTTP' });
    const bad = new FrankfurterFxProvider({
      baseUrl: 'https://fx.example/v1',
      fetch: async () => new Response(JSON.stringify({ base: 'EUR', date: '2026-10-02', rates: { IDR: 0 } })),
    });
    await expect(bad.latest('EUR', ['IDR'])).rejects.toMatchObject({ code: 'FX_PROVIDER_BAD_RESPONSE' });
  });
});

describe('GET /v1/fx/rates (static MOCK provider)', () => {
  it('returns spot + markup-applied rate with asOf and source, derived via core cross rates', async () => {
    const res = await t.request('GET', '/v1/fx/rates?base=jpy&quote=IDR');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('max-age=60');
    const [r] = res.body.data;
    const table = { base: 'USD', asOf: NOW, rates: Object.fromEntries(Object.entries(MOCK_USD_RATES).map(([k, v]) => [k, String(v)])) };
    const expectedSpot = crossRate(table, 'JPY', 'IDR');
    expect(r).toMatchObject({
      base: 'JPY',
      quote: 'IDR',
      spotRate: expectedSpot,
      markupBps: markupBpsFor('JPY', { defaultBps: 150, perCurrency: { KRW: 200, JPY: 150 } }),
      rate: quoteRate(expectedSpot, 150),
      source: 'static-mock',
      pivot: 'USD',
      asOf: NOW.toISOString(),
    });
    expect(res.body.mode).toBe('MOCK');
    // stored in fx_rates (append-only) by the on-demand refresh
    const [cnt] = await t.adminSql<{ n: number }[]>`SELECT count(*)::int AS n FROM fx_rates WHERE source = 'static-mock'`;
    expect(cnt!.n).toBeGreaterThan(5);
  });

  it('lists all active currencies against IDR and flags unavailable ones', async () => {
    const res = await t.request('GET', '/v1/fx/rates');
    expect(res.status).toBe(200);
    const bases = res.body.data.map((r: { base: string }) => r.base);
    expect(bases).toEqual(expect.arrayContaining(['JPY', 'KRW', 'SGD', 'USD', 'EUR']));
    expect(res.body.data.find((r: { base: string }) => r.base === 'KRW').markupBps).toBe(200);
    expect(res.body.unavailable.map((u: { currency: string }) => u.currency)).toContain('VND');
  });

  it('rejects unknown currencies', async () => {
    const res = await t.request('GET', '/v1/fx/rates?base=XXX');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('UNKNOWN_CURRENCY');
  });
});

describe('POST /v1/fx/locks', () => {
  it('requires auth', async () => {
    const res = await t.request('POST', '/v1/fx/locks', { body: { base: 'JPY' } });
    expect(res.status).toBe(401);
  });

  it('creates an ACTIVE lock with markup and lock window from config', async () => {
    const u = await t.createUser({ kycLevel: 2 });
    const res = await t.request('POST', '/v1/fx/locks', { token: u.accessToken, body: { base: 'JPY', quote: 'IDR' } });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ base: 'JPY', quote: 'IDR', markupBps: 150, status: 'ACTIVE', source: 'static-mock' });
    expect(res.body.lockedRate).toBe(quoteRate(res.body.spotRate, 150));
    expect(new Date(res.body.expiresAt).getTime() - new Date(res.body.lockedAt).getTime()).toBe(30 * 60_000);
    const [row] = await t.adminSql<{ status: string; source_rate_id: string | null }[]>`SELECT status, source_rate_id FROM fx_locks WHERE id = ${res.body.id}`;
    expect(row).toMatchObject({ status: 'ACTIVE' });
    expect(row!.source_rate_id).toBeTruthy();
  });

  it('rejects same-currency pairs and currencies outside the provider table', async () => {
    const u = await t.createUser();
    const same = await t.request('POST', '/v1/fx/locks', { token: u.accessToken, body: { base: 'IDR', quote: 'IDR' } });
    expect(same.status).toBe(400);
    expect(same.body.error.code).toBe('INVALID_FX_PAIR');
    const vnd = await t.request('POST', '/v1/fx/locks', { token: u.accessToken, body: { base: 'VND' } });
    expect(vnd.body.error.code).toBe('FX_RATE_UNAVAILABLE');
  });

  it('exposes createFxLock for the money group (same transaction as the caller)', async () => {
    const lock = await t.deps.sql.begin((tx) => createFxLock(tx, t.deps, { base: 'SGD', quote: 'IDR', userId: null }));
    expect(lock).toMatchObject({ base: 'SGD', quote: 'IDR', markupBps: 150, status: 'ACTIVE' });
  });
});

describe('staleness (ECB weekend gap and provider outage)', () => {
  it('accepts a Friday ECB rate on Monday (within fx.lock.maxRateAgeMinutes = 72 h)', async () => {
    const t2 = await createTestContext({ now: NOW });
    try {
      t2.deps.providers.fx = failingProvider();
      const friday = new Date('2026-10-02T14:00:00Z'); // 61 h before NOW
      await t2.adminSql`INSERT INTO fx_rates (base, quote, rate, source, as_of) VALUES
        ('EUR','JPY',179.2,'frankfurter-ecb',${friday}), ('EUR','IDR',20410.5,'frankfurter-ecb',${friday})`;
      const res = await t2.request('GET', '/v1/fx/rates?base=JPY');
      expect(res.status).toBe(200);
      expect(res.body.data[0]).toMatchObject({ source: 'frankfurter-ecb', pivot: 'EUR', asOf: friday.toISOString(), ageMinutes: 61 * 60 });
      expect(res.body.data[0].spotRate).toBe(crossRate({ base: 'EUR', asOf: friday, rates: { JPY: '179.2', IDR: '20410.5' } }, 'JPY', 'IDR'));
    } finally {
      await t2.close();
    }
  });

  it('refuses stale rates with FX_RATE_STALE when the provider cannot refresh', async () => {
    const t2 = await createTestContext({ now: NOW });
    try {
      t2.deps.providers.fx = failingProvider();
      const old = new Date(NOW.getTime() - 5 * 86_400_000);
      await t2.adminSql`INSERT INTO fx_rates (base, quote, rate, source, as_of) VALUES
        ('EUR','JPY',179.2,'frankfurter-ecb',${old}), ('EUR','IDR',20410.5,'frankfurter-ecb',${old})`;
      const res = await t2.request('GET', '/v1/fx/rates?base=JPY');
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('FX_RATE_STALE');
      const u = await t2.createUser();
      const lock = await t2.request('POST', '/v1/fx/locks', { token: u.accessToken, body: { base: 'JPY' } });
      expect(lock.status).toBe(503);
      expect(lock.body.error.code).toBe('FX_RATE_STALE');
      // no data at all → FX_RATE_UNAVAILABLE
      const krw = await t2.request('GET', '/v1/fx/rates?base=KRW');
      expect(krw.status).toBe(503);
      expect(krw.body.error.code).toBe('FX_RATE_UNAVAILABLE');
    } finally {
      await t2.close();
    }
  });

  it('refreshFxRates stores one snapshot per as_of (idempotent)', async () => {
    const t2 = await createTestContext({ now: NOW });
    try {
      t2.deps.providers.fx = new StaticFxProvider(() => NOW);
      const a = await refreshFxRates(t2.sql, t2.deps);
      const b = await refreshFxRates(t2.sql, t2.deps);
      expect(a.stored).toBeGreaterThan(5);
      expect(b.stored).toBe(0);
      expect(a).toMatchObject({ source: 'static-mock', pivot: 'USD', asOf: NOW.toISOString() });
    } finally {
      await t2.close();
    }
  });
});
