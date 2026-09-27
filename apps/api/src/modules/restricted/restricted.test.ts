import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../../../test/helpers';
import { classifyRequestItem } from './service';

const NOW = new Date('2026-10-05T03:00:00Z');
let t: TestContext;
beforeAll(async () => {
  t = await createTestContext({ now: NOW });
});
afterAll(async () => {
  await t.close();
});

describe('POST /v1/restricted/check', () => {
  it('PROHIBITED item blocks checkout (alcohol category)', async () => {
    const res = await t.request('POST', '/v1/restricted/check', {
      body: { originCountry: 'JP', categoryCode: 'ALCOHOL', productName: 'Hibiki 17 Japanese Whisky', quantity: 1 },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ classification: 'PROHIBITED', blocksCheckout: true, requiresAcknowledgement: false, locale: 'id' });
    expect(res.body.messages.length).toBeGreaterThan(0);
    expect(res.body.matches[0].sourceReference).toBeTruthy();
    expect(res.body.ruleRef).toMatch(/^restricted_items:RI_ID_/);
  });

  it('DECLARATION_REQUIRED / RESTRICTED items need acknowledgement, not blocked; messages follow locale', async () => {
    const id = await t.request('POST', '/v1/restricted/check', {
      body: { originCountry: 'KR', categoryCode: 'COSMETICS_SKINCARE', productName: 'COSRX Snail Mucin Essence', quantity: 2 },
    });
    expect(id.status).toBe(200);
    expect(id.body.blocksCheckout).toBe(false);
    expect(id.body.requiresAcknowledgement).toBe(true);
    expect(['RESTRICTED', 'DECLARATION_REQUIRED', 'PERMIT_REQUIRED']).toContain(id.body.classification);

    const en = await t.request('POST', '/v1/restricted/check', {
      headers: { 'accept-language': 'en-US,en;q=0.9' },
      body: { originCountry: 'KR', categoryCode: 'COSMETICS_SKINCARE', productName: 'COSRX Snail Mucin Essence', quantity: 2 },
    });
    expect(en.body.locale).toBe('en');
    expect(en.body.messages[0]).not.toBe(id.body.messages[0]);
  });

  it('DECLARATION_REQUIRED: one phone (IMEI registration) — acknowledgement, not blocked', async () => {
    const res = await t.request('POST', '/v1/restricted/check', {
      body: { originCountry: 'JP', categoryCode: 'MOBILE_PHONES', productName: 'Google Pixel 10 smartphone', quantity: 1, locale: 'en' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ classification: 'DECLARATION_REQUIRED', blocksCheckout: false, requiresAcknowledgement: true, locale: 'en' });
    expect(res.body.matches.map((m: { code: string }) => m.code)).toEqual(expect.arrayContaining(['RI_ID_MOBILE_PHONES_CATEGORY', 'RI_ID_HKT_KEYWORD']));
    expect(res.body.disclaimer).toMatch(/final decision/);
  });

  it('plain allowed item', async () => {
    const res = await t.request('POST', '/v1/restricted/check', {
      body: { originCountry: 'JP', categoryCode: 'FASHION_APPAREL', productName: 'Uniqlo AIRism T-Shirt', quantity: 1 },
    });
    expect(res.body).toMatchObject({ classification: 'ALLOWED', blocksCheckout: false, requiresAcknowledgement: false, ruleRef: null });
  });

  it('validates input', async () => {
    const res = await t.request('POST', '/v1/restricted/check', { body: { originCountry: 'JP', categoryCode: 'FASHION_APPAREL', productName: 'x' } });
    expect(res.status).toBe(400);
  });

  it('classifyRequestItem escalates over-limit quantities and derives USD value from price', async () => {
    const r = await classifyRequestItem(t.sql, t.deps, {
      originCountry: 'JP',
      categoryCode: 'MOBILE_PHONES',
      productName: 'iPhone 17 Pro 256GB',
      quantity: 3,
      unitPriceMinor: 180_000,
      currency: 'JPY',
    });
    expect(r.classification).toBe('PROHIBITED');
    expect(r.blocksCheckout).toBe(true);
    expect(r.valueUsd).toMatch(/^\d+\.\d{2}$/);
    expect(r.matches.some((m) => m.limitExceeded?.kind === 'QUANTITY')).toBe(true);
  });
});
