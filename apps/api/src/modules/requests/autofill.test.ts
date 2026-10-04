import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext, type TestUser } from '../../../test/helpers';
import { createActiveTrip, requestBody } from '../trips/fixtures';
import { autoFillOf } from './service';

// L13 — AI-content label (Permendag 19/2026): product data auto-filled from POST /v1/requests/extract stays labelled.
const NOW = new Date('2026-10-05T03:00:00Z');
let t: TestContext;
let buyer: TestUser;

beforeAll(async () => {
  t = await createTestContext({ now: NOW });
  buyer = await t.createUser({ kycLevel: 2 });
});
afterAll(async () => {
  await t.close();
});

async function create(body: Record<string, unknown>) {
  const res = await t.request('POST', '/v1/requests', { token: buyer.accessToken, body: requestBody(t, body) });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

describe('request autoFill (extraction label)', () => {
  it('a request created from an extraction draft carries autoFill {sourceType, mode} in the owner view, list and after edits', async () => {
    const ex = await t.request('POST', '/v1/requests/extract', { token: buyer.accessToken, body: { url: 'https://www.uniqlo.com/jp/ja/products/E465185-000' } });
    expect(ex.status).toBe(200);
    expect(ex.body.mode).toBe('MOCK');
    const created = await create({ sourceType: 'URL', productUrl: 'https://www.uniqlo.com/jp/ja/products/E465185-000', extraction: { mode: ex.body.mode, confidence: ex.body.confidence } });
    expect(created.autoFill).toEqual({ sourceType: 'URL', mode: 'MOCK' });

    const mine = await t.request('GET', '/v1/requests/mine', { token: buyer.accessToken });
    expect(mine.body.data.find((r: { id: string }) => r.id === created.id).autoFill).toEqual({ sourceType: 'URL', mode: 'MOCK' });

    // the label stays after the buyer edits the auto-filled data (it was still created from extraction)
    const patched = await t.request('PATCH', `/v1/requests/${created.id}`, { token: buyer.accessToken, body: { productName: 'Uniqlo AIRism (dicek manual)' } });
    expect(patched.status).toBe(200);
    expect(patched.body.autoFill).toEqual({ sourceType: 'URL', mode: 'MOCK' });
  });

  it('manual requests, sources without applied extraction metadata and unknown modes', async () => {
    expect((await create({ sourceType: 'MANUAL' })).autoFill).toBeNull();
    // extraction metadata is ignored for MANUAL (the buyer switched to typing everything in)
    expect((await create({ sourceType: 'MANUAL', extraction: { mode: 'MOCK', confidence: 0.9 } })).autoFill).toBeNull();
    // URL tab whose extraction failed → nothing was auto-filled
    expect((await create({ sourceType: 'URL', productUrl: 'https://shop.example.jp/p/1' })).autoFill).toBeNull();
    expect((await create({ sourceType: 'PHOTO', extraction: { confidence: 0.2 } })).autoFill).toEqual({ sourceType: 'PHOTO', mode: null });
    expect((await create({ sourceType: 'SEARCH', extraction: { mode: 'GPT', confidence: 1 } })).autoFill).toEqual({ sourceType: 'SEARCH', mode: null });
  });

  it('travelers see the label in the listing view and in /requests/open', async () => {
    const traveler = await t.createUser({ kycLevel: 3 });
    await createActiveTrip(t, traveler);
    const res = await t.request('POST', '/v1/requests', {
      token: buyer.accessToken,
      body: { ...requestBody(t, { sourceType: 'SEARCH', extraction: { mode: 'MOCK', confidence: 0.4 } }), publish: true },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const listing = await t.request('GET', `/v1/requests/${res.body.id}`, { token: traveler.accessToken });
    expect(listing.body.view).toBe('LISTING');
    expect(listing.body.request.autoFill).toEqual({ sourceType: 'SEARCH', mode: 'MOCK' });
    const open = await t.request('GET', '/v1/requests/open', { token: traveler.accessToken });
    expect(open.status).toBe(200);
    expect(open.body.data.find((r: { id: string }) => r.id === res.body.id)?.autoFill).toEqual({ sourceType: 'SEARCH', mode: 'MOCK' });
  });

  it('autoFillOf is defensive about stored JSON', () => {
    expect(autoFillOf({ source_type: 'URL', extraction: {} })).toBeNull();
    expect(autoFillOf({ source_type: 'URL', extraction: null as unknown as Record<string, unknown> })).toBeNull();
    expect(autoFillOf({ source_type: 'URL', extraction: [1] as unknown as Record<string, unknown> })).toBeNull();
    expect(autoFillOf({ source_type: 'PHOTO', extraction: { mode: 'LIVE' } })).toEqual({ sourceType: 'PHOTO', mode: 'LIVE' });
  });
});
