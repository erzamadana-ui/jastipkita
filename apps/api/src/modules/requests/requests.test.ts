import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../../../test/helpers';
import { expireRequests } from '../../jobs/marketplace';
import { createActiveTrip, createOpenRequest, day, insertFile, outboxEvents, requestBody } from '../trips/fixtures';

const NOW = new Date('2026-10-05T03:00:00Z');
let t: TestContext;
beforeAll(async () => {
  t = await createTestContext({ now: NOW });
});
afterAll(async () => {
  await t.close();
});

describe('POST /v1/requests', () => {
  it('requires auth', async () => {
    expect((await t.request('POST', '/v1/requests', { body: requestBody(t) })).status).toBe(401);
  });

  it('creates a DRAFT with restriction class, spot IDR value and request.created event', async () => {
    const buyer = await t.createUser({ kycLevel: 2 });
    const photo = await insertFile(t, buyer.id, 'PRODUCT_PHOTO');
    const res = await t.request('POST', '/v1/requests', {
      token: buyer.accessToken,
      body: { ...requestBody(t), notes: 'Warna hitam, ukuran L', imageUrls: ['https://image.uniqlo.com/x.jpg'], imageFileIds: [photo] },
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      status: 'DRAFT',
      productName: 'Uniqlo AIRism Cotton Oversized T-Shirt',
      quantity: 2,
      unitPriceMinor: 2990,
      priceCurrency: 'JPY',
      restriction: { classification: 'ALLOWED', requiresAcknowledgement: false, blocksPublishing: false },
      notes: 'Warna hitam, ukuran L',
      pendingOffers: 0,
    });
    expect(res.body.itemValueIdr).toBeGreaterThan(600_000); // ¥5.980 × ~113.7
    expect(res.body.images).toEqual([
      // file-backed images get absolute API URLs (contract fix: every returned file URL is absolute)
      { fileId: photo, url: `http://api.test/v1/files/${photo}/content`, contentUrl: `http://api.test/v1/files/${photo}/content` },
      { fileId: null, url: 'https://image.uniqlo.com/x.jpg', contentUrl: null },
    ]);
    const ev = await outboxEvents(t, 'request.created', res.body.id);
    expect(ev[0]!.payload).toMatchObject({ requestId: res.body.id, buyerId: buyer.id, status: 'DRAFT' });
  });

  it('validates minimum item value, budget, dates, countries, currency', async () => {
    const buyer = await t.createUser({ kycLevel: 2 });
    const cases: [Record<string, unknown>, number, string][] = [
      [{ unitPriceMinor: 300, quantity: 1 }, 422, 'BELOW_MINIMUM_TRANSACTION'],
      [{ maxBudgetIdr: 100_000 }, 422, 'BUDGET_BELOW_ITEM_VALUE'],
      [{ neededBy: day(t, -1) }, 422, 'DATE_IN_PAST'],
      [{ merchantCountry: 'CN' }, 422, 'COUNTRY_NOT_SUPPORTED'],
      [{ priceCurrency: 'XXX' }, 422, 'UNKNOWN_CURRENCY'],
      [{ categoryCode: 'NOPE' }, 422, 'CATEGORY_UNKNOWN'],
      [{ productUrl: 'javascript:alert(1)' }, 400, 'VALIDATION_ERROR'],
      [{ quantity: 0 }, 400, 'VALIDATION_ERROR'],
    ];
    for (const [o, status, code] of cases) {
      const res = await t.request('POST', '/v1/requests', { token: buyer.accessToken, body: requestBody(t, o) });
      expect({ o, status: res.status, code: res.body.error?.code }).toEqual({ o, status, code });
    }
    const other = await t.createUser();
    const foreignPhoto = await insertFile(t, other.id, 'PRODUCT_PHOTO');
    const img = await t.request('POST', '/v1/requests', { token: buyer.accessToken, body: requestBody(t, { imageFileIds: [foreignPhoto] }) });
    expect(img.status).toBe(404);
  });

  it('restricted items need acknowledgement before publishing', async () => {
    const buyer = await t.createUser({ kycLevel: 2 });
    const draft = await t.request('POST', '/v1/requests', {
      token: buyer.accessToken,
      body: requestBody(t, { productName: 'COSRX Advanced Snail 96 Mucin Power Essence', categoryCode: 'COSMETICS_SKINCARE', merchantCountry: 'KR', priceCurrency: 'KRW', unitPriceMinor: 25000, quantity: 2, neededBy: day(t, 10) }),
    });
    expect(draft.status).toBe(201);
    expect(draft.body.restriction).toMatchObject({ classification: 'RESTRICTED', requiresAcknowledgement: true, acknowledgedAt: null, blocksPublishing: true });
    expect(draft.body.restriction.ruleRef).toMatch(/RI_ID_COSMETICS_CATEGORY/);

    const noAck = await t.request('POST', `/v1/requests/${draft.body.id}/publish`, { token: buyer.accessToken });
    expect(noAck.status).toBe(422);
    expect(noAck.body.error.code).toBe('RESTRICTION_ACK_REQUIRED');
    expect(noAck.body.error.details.messages.length).toBeGreaterThan(0);

    const ok = await t.request('POST', `/v1/requests/${draft.body.id}/publish`, { token: buyer.accessToken, body: { acknowledgeRestriction: true } });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('OPEN');
    expect(ok.body.restriction.acknowledgedAt).toBe(NOW.toISOString());
    // expires at the end of needed_by (WIB), capped at REQUEST_TTL_DAYS
    expect(ok.body.expiresAt).toBe(new Date(`${day(t, 10)}T23:59:59.999+07:00`).toISOString());
    expect(await outboxEvents(t, 'request.published', draft.body.id)).toHaveLength(1);
  });

  it('PROHIBITED items can be drafted but never published', async () => {
    const buyer = await t.createUser({ kycLevel: 2 });
    const body = requestBody(t, { productName: 'Suntory Hibiki Harmony Whisky 700ml', categoryCode: 'ALCOHOL', unitPriceMinor: 9800, quantity: 1 });
    const direct = await t.request('POST', '/v1/requests', { token: buyer.accessToken, body: { ...body, publish: true, acknowledgeRestriction: true } });
    expect(direct.status).toBe(422);
    expect(direct.body.error.code).toBe('ITEM_PROHIBITED');
    const draft = await t.request('POST', '/v1/requests', { token: buyer.accessToken, body });
    expect(draft.status).toBe(201);
    expect(draft.body.restriction).toMatchObject({ classification: 'PROHIBITED', blocksPublishing: true });
    const pub = await t.request('POST', `/v1/requests/${draft.body.id}/publish`, { token: buyer.accessToken, body: { acknowledgeRestriction: true } });
    expect(pub.status).toBe(422);
    expect(pub.body.error.code).toBe('ITEM_PROHIBITED');
  });
});

describe('PATCH / cancel / views', () => {
  it('re-evaluates restriction on edit and resets the acknowledgement when the class changes', async () => {
    const buyer = await t.createUser({ kycLevel: 2 });
    const open = await createOpenRequest(t, buyer, { productName: 'Muji Aroma Diffuser', categoryCode: 'HOME_APPLIANCES', unitPriceMinor: 6990, quantity: 1 });
    expect(open.restriction.classification).toBe('ALLOWED');
    // switching an OPEN request to a restricted item without ack is refused (would be unpublishable)
    const bad = await t.request('PATCH', `/v1/requests/${open.id}`, { token: buyer.accessToken, body: { categoryCode: 'PERFUME', productName: 'Jo Malone Wood Sage Cologne' } });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('RESTRICTION_ACK_REQUIRED');
    const good = await t.request('PATCH', `/v1/requests/${open.id}`, {
      token: buyer.accessToken,
      body: { categoryCode: 'PERFUME', productName: 'Jo Malone Wood Sage Cologne', acknowledgeRestriction: true, version: open.version },
    });
    expect(good.status).toBe(200);
    expect(good.body.restriction).toMatchObject({ classification: 'RESTRICTED', acknowledgedAt: NOW.toISOString() });
    expect(good.body.version).toBe(open.version + 1);
    const stale = await t.request('PATCH', `/v1/requests/${open.id}`, { token: buyer.accessToken, body: { notes: 'x', version: open.version } });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');
  });

  it('locks item details while offers are pending; cancel declines pending offers', async () => {
    const buyer = await t.createUser({ kycLevel: 2, displayName: 'Rina Susanti' });
    const traveler = await t.createUser({ kycLevel: 3 });
    const trip = await createActiveTrip(t, traveler);
    const req = await createOpenRequest(t, buyer);
    const offer = await t.request('POST', `/v1/requests/${req.id}/offers`, { token: traveler.accessToken, body: { tripId: trip.id } });
    expect(offer.status).toBe(201);

    const locked = await t.request('PATCH', `/v1/requests/${req.id}`, { token: buyer.accessToken, body: { quantity: 3 } });
    expect(locked.status).toBe(409);
    expect(locked.body.error.code).toBe('REQUEST_HAS_PENDING_OFFERS');
    const notes = await t.request('PATCH', `/v1/requests/${req.id}`, { token: buyer.accessToken, body: { notes: 'Tolong simpan struk' } });
    expect(notes.status).toBe(200);

    // traveler sees the listing view: no notes, buyer = public profile only
    const tv = await t.request('GET', `/v1/requests/${req.id}`, { token: traveler.accessToken });
    expect(tv.body.view).toBe('LISTING');
    expect(tv.body.request.notes).toBeUndefined();
    expect(tv.body.request.buyer).toMatchObject({ id: buyer.id, displayName: 'Rina S.' });
    expect(JSON.stringify(tv.body)).not.toContain(buyer.email);

    const cancel = await t.request('POST', `/v1/requests/${req.id}/cancel`, { token: buyer.accessToken, body: { reason: 'Sudah beli sendiri' } });
    expect(cancel.status).toBe(200);
    expect(cancel.body.status).toBe('CANCELLED');
    const [o] = await t.adminSql<{ status: string; decline_reason: string }[]>`SELECT status, decline_reason FROM offers WHERE id = ${offer.body.id}`;
    expect(o).toMatchObject({ status: 'DECLINED', decline_reason: 'REQUEST_CANCELLED' });
    expect((await outboxEvents(t, 'offer.declined', offer.body.id)).length).toBe(1);
    expect((await t.request('PATCH', `/v1/requests/${req.id}`, { token: buyer.accessToken, body: { notes: 'x' } })).status).toBe(409);
  });

  it('drafts are private; /requests/mine lists own requests', async () => {
    const buyer = await t.createUser({ kycLevel: 2 });
    const other = await t.createUser({ kycLevel: 3 });
    const draft = await t.request('POST', '/v1/requests', { token: buyer.accessToken, body: requestBody(t) });
    expect((await t.request('GET', `/v1/requests/${draft.body.id}`, { token: other.accessToken })).status).toBe(404);
    expect((await t.request('POST', `/v1/requests/${draft.body.id}/publish`, { token: other.accessToken })).status).toBe(404);
    const mine = await t.request('GET', '/v1/requests/mine?status=DRAFT', { token: buyer.accessToken });
    expect(mine.body.data.map((r: { id: string }) => r.id)).toEqual([draft.body.id]);
  });
});

describe('GET /v1/requests/open (traveler)', () => {
  it("returns OPEN requests matching the traveler's ACTIVE trips only", async () => {
    const t2 = await createTestContext({ now: NOW });
    try {
      const traveler = await t2.createUser({ kycLevel: 3 });
      const buyer = await t2.createUser({ kycLevel: 2 });
      const none = await t2.request('GET', '/v1/requests/open', { token: traveler.accessToken });
      expect(none.body.data).toEqual([]);

      const trip = await createActiveTrip(t2, traveler, { excludedCategories: ['FOOD_SNACKS'] });
      const jp = await createOpenRequest(t2, buyer);
      await createOpenRequest(t2, buyer, { merchantCountry: 'KR', priceCurrency: 'KRW', unitPriceMinor: 60000, productName: 'Musinsa Standard Hoodie' });
      await createOpenRequest(t2, buyer, { categoryCode: 'FOOD_SNACKS', productName: 'Tokyo Banana Box 8 pcs', unitPriceMinor: 1500, quantity: 4 });
      await createOpenRequest(t2, buyer, { neededBy: day(t2, 5), productName: 'Uniqlo Heattech Extra Warm' }); // trip arrives too late
      await createOpenRequest(t2, traveler, { productName: 'Traveler own request' });

      const res = await t2.request('GET', '/v1/requests/open', { token: traveler.accessToken });
      expect(res.status).toBe(200);
      expect(res.body.data.map((r: { id: string }) => r.id)).toEqual([jp.id]);
      expect(res.body.data[0].matchingTripIds).toEqual([trip.id]);
      expect(res.body.data[0].notes).toBeUndefined();
    } finally {
      await t2.close();
    }
  });
});

describe('request expiry job', () => {
  it('expires OPEN requests past needed_by and their pending offers', async () => {
    const t3 = await createTestContext({ now: NOW });
    try {
      const traveler = await t3.createUser({ kycLevel: 3 });
      const buyer = await t3.createUser({ kycLevel: 2 });
      const trip = await createActiveTrip(t3, traveler);
      const req = await createOpenRequest(t3, buyer, { neededBy: day(t3, 20) });
      const offer = await t3.request('POST', `/v1/requests/${req.id}/offers`, { token: traveler.accessToken, body: { tripId: trip.id } });
      expect(offer.status).toBe(201);
      expect((await expireRequests(t3.deps)).expired).toBe(0);
      t3.clock.advance(21 * 86_400_000);
      expect((await expireRequests(t3.deps)).expired).toBe(1);
      const [r] = await t3.adminSql<{ status: string }[]>`SELECT status FROM requests WHERE id = ${req.id}`;
      expect(r!.status).toBe('EXPIRED');
      const [o] = await t3.adminSql<{ status: string }[]>`SELECT status FROM offers WHERE id = ${offer.body.id}`;
      expect(o!.status).toBe('EXPIRED');
      expect(await outboxEvents(t3, 'request.expired', req.id)).toHaveLength(1);
    } finally {
      await t3.close();
    }
  });
});
