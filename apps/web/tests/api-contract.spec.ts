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

/**
 * CORS like the real API: the auth endpoints are credentialed (cookie transport, SEC-14), so the mock echoes the exact
 * Origin with Access-Control-Allow-Credentials and the requested headers (a `*` wildcard is invalid with credentials).
 */
function cors(route: Route): Record<string, string> {
  const h = route.request().headers();
  return {
    'access-control-allow-origin': h['origin'] ?? '*',
    'access-control-allow-credentials': 'true',
    'access-control-allow-headers': h['access-control-request-headers'] ?? 'content-type,authorization,x-jk-token-transport',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    vary: 'Origin',
  };
}
async function json(route: Route, status: number, body: unknown) {
  if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors(route) });
  return route.fulfill({ status, headers: { ...cors(route), 'content-type': 'application/json' }, body: JSON.stringify(body) });
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

const ME = { id: 'u1', email: 'baru@example.com', emailVerified: true, phone: null, phoneVerified: false, displayName: 'Rina M.', avatarFileId: null, locale: 'id', countryCode: 'ID', status: 'ACTIVE', kycLevel: 2, activeMode: 'BUYER', trustScore: 50, referralCode: 'RINA-1234', transactionEmail: null, roles: [], mfaEnabled: false, deletionScheduledFor: null, createdAt: '2026-09-28T00:00:00Z' };
/** Cookie-transport token payload: the API omits refreshToken from the body (it is in the HttpOnly jk_rt cookie). */
const cookieTokens = (access: string) => ({ tokenType: 'Bearer', accessToken: access, accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(), refreshTokenExpiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(), sessionId: 's' });

test('web session (SEC-14 cookie transport): no refresh token in web storage, silent restore via the cookie, logout revokes + wipes jk: keys', async ({ page }) => {
  await offlineByDefault(page);
  await mockOtp(page);
  const verifyHeaders: Record<string, string>[] = [];
  await page.route('**/v1/auth/otp/verify', (r) => {
    if (r.request().method() === 'OPTIONS') return json(r, 204, null);
    verifyHeaders.push(r.request().headers());
    return json(r, 200, { purpose: 'LOGIN', verified: true, isNewUser: false, user: {}, tokens: cookieTokens('access-1') });
  });
  let signedIn = false;
  const refreshCalls: Array<{ body: string | null; transport: string | undefined }> = [];
  await page.route('**/v1/auth/refresh', (r) => {
    if (r.request().method() === 'OPTIONS') return json(r, 204, null);
    refreshCalls.push({ body: r.request().postData(), transport: r.request().headers()['x-jk-token-transport'] });
    if (!signedIn) return json(r, 401, apiError('REFRESH_MISSING', 'Sesi tidak ditemukan, silakan masuk kembali'));
    return json(r, 200, { tokens: cookieTokens('access-2') });
  });
  const meCalls: Array<{ auth: string; transport: string | undefined }> = [];
  await page.unroute('**/v1/me');
  await page.route('**/v1/me', (r) => {
    if (r.request().method() === 'OPTIONS') return json(r, 204, null);
    meCalls.push({ auth: r.request().headers()['authorization'] ?? '', transport: r.request().headers()['x-jk-token-transport'] });
    return json(r, 200, ME);
  });
  const logouts: Array<{ auth: string; transport: string | undefined; body: string | null }> = [];
  await page.route('**/v1/auth/logout', (r) => {
    if (r.request().method() === 'OPTIONS') return json(r, 204, null);
    logouts.push({ auth: r.request().headers()['authorization'] ?? '', transport: r.request().headers()['x-jk-token-transport'], body: r.request().postData() });
    signedIn = false;
    return json(r, 200, { ok: true });
  });

  await page.goto(`${BASE}/masuk/`);
  // anonymous visitor: one silent restore attempt, answered "no session"
  await expect.poll(() => refreshCalls.length).toBe(1);
  // a refresh token left by an older build must disappear on the next page load
  await page.evaluate(() => sessionStorage.setItem('jk:refresh', 'legacy-refresh-token-0001'));
  await page.click('[data-consent-choice="necessary"]');
  await page.fill('#destination', 'lama@example.com');
  await page.click('#req-btn');
  await page.fill('#code', '123456');
  signedIn = true; // from now on the browser holds the (mocked) HttpOnly cookie
  await page.click('#ver-btn');
  await expect(page).toHaveURL(/\/jastipkita\/akun\/$/);
  await expect(page.locator('#acc-name')).toHaveText('Rina M.');

  expect(verifyHeaders[0]!['x-jk-token-transport']).toBe('cookie');
  // new page load: the access token was not persisted; the session came back through the cookie (no body)
  expect(refreshCalls).toHaveLength(2);
  for (const c of refreshCalls) expect(c).toEqual({ body: null, transport: 'cookie' });
  expect(meCalls).toEqual([{ auth: 'Bearer access-2', transport: undefined }]); // non-auth endpoints stay cookie-less
  const storage = await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }));
  expect(Object.keys(storage.session)).not.toContain('jk:refresh');
  expect(Object.keys(storage.local)).not.toContain('jk:refresh');
  for (const [k, v] of [...Object.entries(storage.local), ...Object.entries(storage.session)]) {
    expect(k.startsWith('jk:'), k).toBe(true);
    expect(String(v)).not.toMatch(/access-|refresh/);
  }

  await page.click('#acc-logout');
  await expect(page.locator('#acc-signed-out')).toBeVisible();
  expect(logouts).toEqual([{ auth: 'Bearer access-2', transport: 'cookie', body: null }]);
  const after = await page.evaluate(() => [...Object.keys(localStorage), ...Object.keys(sessionStorage)].filter((k) => k.startsWith('jk:')));
  expect(after).toEqual([]); // logout wipes every jk: key (session + preferences)
  expect(refreshCalls).toHaveLength(3); // the reload tried once more and got "no session"
});

test('signed-in visitor on /masuk/ is sent to the account page by the silent restore', async ({ page }) => {
  await offlineByDefault(page);
  await page.route('**/v1/auth/refresh', (r) => json(r, 200, { tokens: cookieTokens('access-9') }));
  await page.route('**/v1/me', (r) => json(r, 200, ME));
  await page.goto(`${BASE}/masuk/`);
  await expect(page).toHaveURL(/\/jastipkita\/akun\/$/);
  await expect(page.locator('#acc-name')).toHaveText('Rina M.');
});

test('refreshes are serialized across tabs (one rotating cookie → no reuse-detection logout)', async ({ context }) => {
  await context.route(/^https?:\/\/(?!localhost)/, (r) => r.abort('internetdisconnected'));
  let inFlight = 0;
  let maxInFlight = 0;
  let calls = 0;
  await context.route('**/v1/auth/refresh', async (r) => {
    if (r.request().method() === 'OPTIONS') return json(r, 204, null);
    calls++;
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((res) => setTimeout(res, 400));
    inFlight--;
    return json(r, 200, { tokens: cookieTokens(`access-tab-${calls}`) });
  });
  await context.route('**/v1/me', (r) => json(r, 200, ME));
  const [a, b] = [await context.newPage(), await context.newPage()];
  await Promise.all([a.goto(`${BASE}/akun/`), b.goto(`${BASE}/akun/`)]);
  await expect(a.locator('#acc-name')).toHaveText('Rina M.');
  await expect(b.locator('#acc-name')).toHaveText('Rina M.');
  expect(calls).toBe(2);
  expect(maxInFlight).toBe(1);
});
