/**
 * Behaviour against the API contract of docs/api/CHANGELOG.md (2026-09-27), with the API mocked in the browser:
 * consent versions from GET /v1/consents/requirements (+ 422 retry, + build-time fallback), legal versions from
 * GET /v1/legal/documents, and the new PublicProfile trust fields in trip discovery.
 */
import { expect, test, type Page, type Route } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = '/jastipkita';
const here = dirname(fileURLToPath(import.meta.url));
const tosVersion = /^version:\s*"?([^"\n]+)"?/m.exec(readFileSync(resolve(here, '../../../docs/legal/terms-of-service.md'), 'utf8'))![1]!;

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
async function json(route: Route, status: number, body: unknown) {
  if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
  return route.fulfill({ status, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(body) });
}
const apiError = (code: string, message: string, details: Record<string, unknown> = {}) => ({ error: { code, message, details, requestId: 'test' } });
function requirement(type: string, required: boolean, version: string) {
  return { type, required, version, acceptedVersions: [version], versionEnforced: true, title: `Dokumen ${type}`, summary: null, url: `https://antarkitaindonesia.com/jastipkita/legal/${type.toLowerCase()}/`, documentUrl: null, granted: null, grantedVersion: null, upToDate: null };
}
async function offlineByDefault(page: Page) {
  await page.route(/^https?:\/\/(?!localhost)/, (r) => r.abort('internetdisconnected'));
}
async function mockOtp(page: Page) {
  await page.route('**/v1/auth/otp/request', (r) => json(r, 200, { challengeId: '00000000-0000-4000-8000-000000000001', expiresAt: new Date(Date.now() + 300_000).toISOString(), resendAvailableAt: new Date().toISOString() }));
  await page.route('**/v1/me', (r) => json(r, 401, apiError('UNAUTHORIZED', 'Unauthorized')));
}
async function startOtp(page: Page) {
  await page.goto(`${BASE}/masuk/`);
  await page.click('[data-consent-choice="necessary"]');
  await page.fill('#destination', 'baru@example.com');
  await page.click('#req-btn');
  await page.fill('#code', '123456');
  await page.click('#ver-btn');
}

test('signup sends the consent versions from GET /v1/consents/requirements and retries once after 422', async ({ page }) => {
  await offlineByDefault(page);
  await mockOtp(page);
  let reqCalls = 0;
  await page.route('**/v1/consents/requirements*', (r) => {
    if (r.request().method() === 'OPTIONS') return json(r, 204, null);
    reqCalls++;
    const v = reqCalls === 1 ? '0.0-stale' : '0.1-template'; // the first answer is outdated on purpose
    return json(r, 200, { locale: 'id', signup: { required: [requirement('TOS', true, v), requirement('PRIVACY', true, v)], optional: [requirement('MARKETING', false, v)], satisfied: null }, kyc: { required: [requirement('KYC', true, v)], optional: [], satisfied: null } });
  });
  const verifyBodies: Array<{ consents?: Array<{ type: string; version: string; granted: boolean }> }> = [];
  await page.route('**/v1/auth/otp/verify', (r) => {
    if (r.request().method() === 'OPTIONS') return json(r, 204, null);
    const body = r.request().postDataJSON();
    verifyBodies.push(body);
    if (!body.consents) return json(r, 422, apiError('CONSENT_REQUIRED', 'Setujui dokumen', { required: ['TOS', 'PRIVACY'] }));
    if (body.consents.some((c: { version: string }) => c.version !== '0.1-template')) {
      return json(r, 422, apiError('CONSENT_VERSION_INVALID', 'Versi dokumen persetujuan tidak berlaku', { type: 'TOS', allowedVersions: ['0.1-template'] }));
    }
    return json(r, 200, { purpose: 'LOGIN', verified: true, isNewUser: true, user: {}, tokens: { tokenType: 'Bearer', accessToken: 'at', accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(), refreshToken: 'rt', refreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString(), sessionId: 's' } });
  });

  await startOtp(page);
  await expect(page.locator('#consent-form')).toBeVisible();
  await expect(page.locator('#consent-list')).toContainText('Dokumen TOS');
  await page.check('input[data-consent-type="TOS"]');
  await page.check('input[data-consent-type="PRIVACY"]');
  await page.click('#consent-btn');
  await expect(page).toHaveURL(/\/jastipkita\/akun\/$/);

  expect(reqCalls).toBe(2); // fetched before submitting, re-fetched once after the 422
  expect(verifyBodies).toHaveLength(3);
  expect(verifyBodies[0]!.consents).toBeUndefined();
  expect(verifyBodies[1]!.consents!.map((c) => c.version)).toEqual(['0.0-stale', '0.0-stale', '0.0-stale']);
  expect(verifyBodies[2]!.consents).toEqual([
    { type: 'TOS', version: '0.1-template', granted: true },
    { type: 'PRIVACY', version: '0.1-template', granted: true },
    { type: 'MARKETING', version: '0.1-template', granted: false },
  ]);
});

test('signup falls back to the docs/legal front-matter version when requirements are unreachable', async ({ page }) => {
  await offlineByDefault(page);
  await mockOtp(page);
  const verifyBodies: Array<{ consents?: Array<{ type: string; version: string }> }> = [];
  await page.route('**/v1/auth/otp/verify', (r) => {
    if (r.request().method() === 'OPTIONS') return json(r, 204, null);
    const body = r.request().postDataJSON();
    verifyBodies.push(body);
    if (!body.consents) return json(r, 422, apiError('CONSENT_REQUIRED', 'Setujui dokumen', { required: ['TOS', 'PRIVACY'] }));
    return json(r, 200, { purpose: 'LOGIN', verified: true, isNewUser: true, user: {}, tokens: { tokenType: 'Bearer', accessToken: 'at', accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(), refreshToken: 'rt', refreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString(), sessionId: 's' } });
  });
  await startOtp(page);
  await expect(page.locator('#consent-source')).toContainText('salinan situs');
  await page.check('input[data-consent-type="TOS"]');
  await page.check('input[data-consent-type="PRIVACY"]');
  await page.check('input[data-consent-type="MARKETING"]');
  await page.click('#consent-btn');
  await expect(page).toHaveURL(/\/jastipkita\/akun\/$/);
  expect(tosVersion).toBe('0.1-template');
  expect(verifyBodies[1]!.consents).toEqual([
    { type: 'TOS', version: tosVersion, granted: true },
    { type: 'PRIVACY', version: tosVersion, granted: true },
    { type: 'MARKETING', version: tosVersion, granted: true },
  ]);
});

test('legal pages show the API latest published version & effective date when reachable', async ({ page }) => {
  await offlineByDefault(page);
  await page.route('**/v1/legal/documents*', (r) =>
    json(r, 200, { data: [{ type: 'TOS', version: '0.2', locale: 'id', title: 'Syarat & Ketentuan Penggunaan', summary: null, effectiveAt: '2026-10-01T00:00:00Z', publishedAt: '2026-09-30T00:00:00Z', slug: 'terms-of-service', url: 'x', contentUrl: 'y', isTemplate: false, consentType: true }] }),
  );
  await page.goto(`${BASE}/legal/terms-of-service/`);
  await expect(page.locator('[data-legal-version]').first()).toHaveText('0.2');
  await expect(page.locator('[data-legal-effective]').first()).toHaveText('1 Okt 2026');
  await expect(page.locator('[data-legal-newer]')).toBeVisible();
  await page.goto(`${BASE}/legal/`);
  await expect(page.locator('[data-legal-slug="terms-of-service"] [data-legal-version]')).toHaveText('0.2');
  await expect(page.locator('[data-legal-slug="privacy-policy"] [data-legal-version]')).toHaveText(tosVersion);
});

test('legal pages keep the static version when the API is unreachable', async ({ page }) => {
  await offlineByDefault(page);
  await page.goto(`${BASE}/legal/privacy-policy/`);
  await page.waitForTimeout(300);
  await expect(page.locator('[data-legal-version]').first()).toHaveText(tosVersion);
  await expect(page.locator('[data-legal-newer]')).toBeHidden();
  await expect(page.locator('[data-legal-live]')).toBeHidden();
});

test('trip discovery renders trustScore / trustTier / kycLevel from PublicProfile', async ({ page }) => {
  await offlineByDefault(page);
  await page.route('**/v1/trips*', (r) =>
    json(r, 200, {
      nextCursor: null,
      data: [{
        id: '00000000-0000-4000-8000-000000000002', status: 'ACTIVE', originCountry: 'JP', originCity: 'Tokyo', destinationCountry: 'ID', destinationCity: 'Jakarta',
        departureDate: '2026-10-10', arrivalDate: '2026-10-12', capacityRemainingKg: 6, itemsRemaining: 4,
        fee: { type: 'PERCENT', value: 1000, label: '10% harga barang' }, excludedCategories: [], verified: true,
        traveler: { id: '00000000-0000-4000-8000-000000000003', displayName: 'Budi S.', trustBadge: { tier: 'TRAVELER_VERIFIED', label: 'Traveler terverifikasi' }, trustScore: 88, trustTier: { tier: 'EXCELLENT', label: 'Sangat tepercaya', labelEn: 'Excellent' }, kycLevel: 4, identityVerified: true, rating: { average: null, count: 0 }, completedTransactions: 0 },
      }],
    }),
  );
  await page.goto(`${BASE}/trip/`);
  const card = page.locator('.trip-card');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('Trust 88 · Sangat tepercaya');
  await expect(card).toContainText('KYC 4');
  await expect(card).toContainText('Belum ada ulasan');
});
