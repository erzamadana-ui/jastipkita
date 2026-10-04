/**
 * Trip discovery vs the 2026-10-04 contract (SEC-19, docs/api/marketplace.md): the web calls GET /v1/trips anonymously,
 * so trips arrive with `datePrecision: WEEK` and ISO-week windows → rendered as "12–18 Okt 2026" ranges with a hint that
 * exact dates appear after login in the app. Older API builds (no datePrecision) keep the exact-date rendering.
 */
import { expect, test, type Page, type Route } from '@playwright/test';

const BASE = '/jastipkita';
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
async function json(route: Route, status: number, body: unknown) {
  if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
  return route.fulfill({ status, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(body) });
}
async function offlineByDefault(page: Page) {
  await page.route(/^https?:\/\/(?!localhost)/, (r) => r.abort('internetdisconnected'));
}

const traveler = {
  id: '00000000-0000-4000-8000-000000000003', displayName: 'Budi S.', trustBadge: { tier: 'TRAVELER_VERIFIED', label: 'Traveler terverifikasi' },
  trustScore: 88, trustTier: { tier: 'EXCELLENT', label: 'Sangat tepercaya', labelEn: 'Excellent' }, kycLevel: 4, identityVerified: true,
  rating: { average: 4.8, count: 12 }, completedTransactions: 3,
};
function trip(id: string, over: Record<string, unknown>) {
  return {
    id, status: 'ACTIVE', originCountry: 'JP', originCity: 'Tokyo', destinationCountry: 'ID', destinationCity: 'Jakarta',
    capacityRemainingKg: 6, itemsRemaining: 4, fee: { type: 'PERCENT', value: 1000, label: '10% harga barang' }, excludedCategories: [], verified: true,
    traveler, ...over,
  };
}

test('anonymous discovery renders ISO-week ranges and the "exact dates in the app" hint (SEC-19)', async ({ page }) => {
  await offlineByDefault(page);
  const requests: { url: string; auth: string | undefined }[] = [];
  await page.route('**/v1/trips*', (r) => {
    if (r.request().method() !== 'OPTIONS') requests.push({ url: r.request().url(), auth: r.request().headers()['authorization'] });
    return json(r, 200, {
      nextCursor: null,
      data: [
        trip('00000000-0000-4000-8000-000000000010', {
          departureDate: '2026-10-12', arrivalDate: '2026-10-12', datePrecision: 'WEEK',
          departureWindow: { from: '2026-10-12', to: '2026-10-18' }, arrivalWindow: { from: '2026-10-12', to: '2026-10-18' },
        }),
        trip('00000000-0000-4000-8000-000000000011', {
          departureDate: '2026-09-28', arrivalDate: '2026-10-05', datePrecision: 'WEEK',
          departureWindow: { from: '2026-09-28', to: '2026-10-04' }, arrivalWindow: { from: '2026-10-05', to: '2026-10-11' },
        }),
        trip('00000000-0000-4000-8000-000000000012', {
          departureDate: '2026-12-28', arrivalDate: '2026-12-28', datePrecision: 'WEEK',
          departureWindow: { from: '2026-12-28', to: '2027-01-03' }, arrivalWindow: { from: '2026-12-28', to: '2027-01-03' },
        }),
      ],
    });
  });
  await page.goto(`${BASE}/trip/`);
  const cards = page.locator('.trip-card');
  await expect(cards).toHaveCount(3);
  await expect(cards.nth(0).locator('.trip-dates')).toHaveText('Berangkat 12–18 Okt 2026 · tiba 12–18 Okt 2026');
  await expect(cards.nth(1).locator('.trip-dates')).toHaveText('Berangkat 28 Sep – 4 Okt 2026 · tiba 5–11 Okt 2026');
  await expect(cards.nth(2).locator('.trip-dates')).toHaveText('Berangkat 28 Des 2026 – 3 Jan 2027 · tiba 28 Des 2026 – 3 Jan 2027');
  await expect(cards.nth(0).locator('.trip-dates')).toHaveAttribute('data-precision', 'WEEK');
  await expect(cards.nth(0).locator('.trip-dates')).toHaveAttribute('title', /Tanggal pasti terlihat setelah masuk di aplikasi/);
  // the window start is never presented as an exact date
  await expect(page.locator('#trip-results')).not.toContainText('Berangkat 12 Okt 2026');
  const note = page.locator('#trip-week-note');
  await expect(note).toBeVisible();
  await expect(note).toContainText('Tanggal pasti terlihat setelah kamu masuk di aplikasi JastipKita');
  // discovery is called anonymously (no bearer), so the API answers with week precision
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.every((r) => r.auth === undefined)).toBe(true);
});

test('exact dates are kept for DAY precision and for older API builds without datePrecision; no week hint', async ({ page }) => {
  await offlineByDefault(page);
  await page.route('**/v1/trips*', (r) =>
    json(r, 200, {
      nextCursor: null,
      data: [
        trip('00000000-0000-4000-8000-000000000020', {
          departureDate: '2026-10-15', arrivalDate: '2026-10-16', datePrecision: 'DAY',
          departureWindow: { from: '2026-10-15', to: '2026-10-15' }, arrivalWindow: { from: '2026-10-16', to: '2026-10-16' },
        }),
        trip('00000000-0000-4000-8000-000000000021', { departureDate: '2026-10-10', arrivalDate: '2026-10-12' }),
      ],
    }),
  );
  await page.goto(`${BASE}/trip/`);
  const cards = page.locator('.trip-card');
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0).locator('.trip-dates')).toHaveText('Berangkat 15 Okt 2026 · tiba 16 Okt 2026');
  await expect(cards.nth(1).locator('.trip-dates')).toHaveText('Berangkat 10 Okt 2026 · tiba 12 Okt 2026');
  await expect(cards.nth(0).locator('.trip-dates')).not.toHaveAttribute('data-precision', 'WEEK');
  await expect(page.locator('#trip-week-note')).toBeHidden();
});

test('the arrival filter explains week granularity', async ({ page }) => {
  await offlineByDefault(page);
  await page.goto(`${BASE}/trip/`);
  await expect(page.locator('#f-arrival-hint')).toHaveText('Dihitung per minggu (Senin–Minggu)');
  await expect(page.locator('#f-arrival')).toHaveAttribute('aria-describedby', 'f-arrival-hint');
  await expect(page.locator('.page-hero .lead')).toContainText('rentang minggu');
});
