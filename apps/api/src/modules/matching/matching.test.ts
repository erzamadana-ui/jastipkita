import { linearRankingStrategy } from '@jastipkita/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext, type TestUser } from '../../../test/helpers';
import { createActiveTrip, createOpenRequest, day } from '../trips/fixtures';
import { useRankingStrategy } from './service';

const NOW = new Date('2026-10-05T03:00:00Z');
let t: TestContext;
let buyer: TestUser;
let request: { id: string };
let tripA: { id: string };
let tripB: { id: string };
let tripD: { id: string };
let a: TestUser;

beforeAll(async () => {
  t = await createTestContext({ now: NOW });
  buyer = await t.createUser({ kycLevel: 2, displayName: 'Rina Susanti' });
  a = await t.createUser({ kycLevel: 4, displayName: 'Ayu Lestari' });
  const b = await t.createUser({ kycLevel: 3, displayName: 'Bima' });
  const c = await t.createUser({ kycLevel: 3 });
  const d = await t.createUser({ kycLevel: 3 });
  await t.adminSql`UPDATE users SET trust_score = 90 WHERE id = ${a.id}`;
  await t.adminSql`INSERT INTO user_rating_summaries (user_id, as_traveler_count, as_traveler_avg, as_traveler_weighted) VALUES (${a.id}, 20, 4.90, 4.90)`;
  tripA = await createActiveTrip(t, a, { departureDate: day(t, 5), arrivalDate: day(t, 5), destinationCity: 'Jakarta' });
  tripB = await createActiveTrip(t, b, { departureDate: day(t, 25), arrivalDate: day(t, 26), destinationCity: 'Surabaya', fee: { type: 'FIXED', value: 150000 } });
  await createActiveTrip(t, c, { originCountry: 'KR', originCity: 'Seoul', departureDate: day(t, 6), arrivalDate: day(t, 6) });
  tripD = await createActiveTrip(t, d, { departureDate: day(t, 7), arrivalDate: day(t, 7), excludedCategories: ['FASHION_APPAREL'] });
  request = await createOpenRequest(t, buyer, { neededBy: day(t, 30) });
});
afterAll(async () => {
  await t.close();
});

describe('GET /v1/requests/{id}/recommended-travelers', () => {
  it('ranks by core linear model with Indonesian reasons; hard filters exclude others', async () => {
    const res = await t.request('GET', `/v1/requests/${request.id}/recommended-travelers`, { token: buyer.accessToken });
    expect(res.status).toBe(200);
    expect(res.body.strategy).toEqual({ name: 'linear', version: 'match-linear-v1' });
    expect(res.body.data.map((x: { trip: { id: string } }) => x.trip.id)).toEqual([tripA.id, tripB.id]);
    expect(res.body.excludedCount).toBe(1); // trip D excludes FASHION_APPAREL (KR trip is not even a candidate)
    const [first, second] = res.body.data;
    expect(first.score).toBeGreaterThan(second.score);
    expect(first.reasons).toEqual(
      expect.arrayContaining(['Trust Score 90', 'Rating 4,9 (20 ulasan)', 'Kota tujuan cocok (Jakarta)', 'Sisa kapasitas 10,0 kg']),
    );
    expect(first.reasons[0]).toMatch(/^Tiba \d+ hari sebelum batas$/);
    expect(second.reasons).toEqual(expect.arrayContaining(['Beda kota (Surabaya)', 'Belum ada rating', 'Fee Rp150.000 masuk anggaran']));
    expect(first.trip.traveler).toMatchObject({ displayName: 'Ayu L.', trustBadge: { tier: 'TRAVELER_VERIFIED' } });
    expect(first.estimatedTravelerFeeIdr).toBeGreaterThanOrEqual(25_000); // PERCENT fee clamped to the Rp25.000 minimum
    expect(Object.keys(first.features).sort()).toEqual(['capacity', 'date', 'history', 'price', 'rating', 'routeExactness', 'trust']);
    expect(tripD.id).toBeTruthy();
  });

  it('only the buyer can see recommendations', async () => {
    const res = await t.request('GET', `/v1/requests/${request.id}/recommended-travelers`, { token: a.accessToken });
    expect(res.status).toBe(404);
  });

  it('RankingStrategy seam: a custom strategy changes the order', async () => {
    const prev = useRankingStrategy({
      name: 'ai-stub',
      version: 'test-1',
      score: (f) => Math.round((1 - f.routeExactness) * 100 + f.capacity), // prefers other cities (for the test)
    });
    try {
      const res = await t.request('GET', `/v1/requests/${request.id}/recommended-travelers`, { token: buyer.accessToken });
      expect(res.body.strategy).toEqual({ name: 'ai-stub', version: 'test-1' });
      expect(res.body.data[0].trip.id).toBe(tripB.id);
    } finally {
      useRankingStrategy(prev);
    }
    expect(prev).toBe(linearRankingStrategy);
  });
});

describe('GET /v1/trips/{id}/recommended-requests', () => {
  it('ranks open requests for the trip owner and excludes non-matching ones', async () => {
    const other = await t.createUser({ kycLevel: 2, displayName: 'Dewi' });
    const bandung = await createOpenRequest(t, other, { destinationCity: 'Bandung', maxBudgetIdr: null, productName: 'Uniqlo Ultra Light Down Jacket', unitPriceMinor: 5990, quantity: 1 });
    await createOpenRequest(t, other, { merchantCountry: 'KR', priceCurrency: 'KRW', unitPriceMinor: 90000, quantity: 1, maxBudgetIdr: null, productName: 'Gentle Monster sunglasses case' });
    const res = await t.request('GET', `/v1/trips/${tripA.id}/recommended-requests`, { token: a.accessToken });
    expect(res.status).toBe(200);
    const ids = res.body.data.map((x: { request: { id: string } }) => x.request.id);
    expect(ids).toEqual([request.id, bandung.id]);
    expect(res.body.data[0].reasons).toEqual(expect.arrayContaining(['Kota tujuan cocok (Jakarta)']));
    expect(res.body.data[1].reasons).toEqual(expect.arrayContaining(['Beda kota (Jakarta)']));
    expect(res.body.data[0].request.buyer).toMatchObject({ displayName: 'Rina S.' });
    expect(JSON.stringify(res.body)).not.toContain(buyer.email);

    // trip D excludes FASHION_APPAREL → everything excluded
    const d = await t.request('GET', `/v1/trips/${tripD.id}/recommended-requests`, { token: a.accessToken });
    expect(d.status).toBe(404); // not the owner
  });
});
