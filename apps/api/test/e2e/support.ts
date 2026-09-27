/**
 * E2E support (NOT a test file). Every user-facing step goes through the public HTTP API exactly like the
 * mobile/web clients: OTP sign-up with `devCode`, consents read from `/v1/consents/requirements`, presigned
 * uploads through the dev storage route, admin work through `/v1/admin/**` with a real TOTP step-up.
 *
 * Allowed shortcuts (documented in docs/checklists/test-scenarios.md):
 *  - admin role grants are inserted into `user_roles` (the bootstrap CLI does the same; there is no public API
 *    that makes the first admin),
 *  - provider overrides (fake extraction fetch, bank name inquiry) — the providers are the system boundary,
 *  - DB reads for assertions (ledger views, outbox, deliveries).
 */
import { randomBytes } from 'node:crypto';
import { expect } from 'vitest';
import { totpAt } from '../../src/lib/crypto';
import { clearPermissionCache } from '../../src/middleware/auth';
import { HeuristicExtractionProvider } from '../../src/providers/extraction/heuristic';
import type { TestContext } from '../helpers';

// ------------------------------------------------------------------ actors & HTTP

export interface Actor {
  id: string;
  label: string;
  email: string;
  phone: string | null;
  ip: string;
  accessToken: string;
  refreshToken: string;
  sessionId: string;
  issuedAt: number;
  /** Admins only: TOTP secret + last used time step (replay protection). */
  totpSecret?: string;
  lastStep?: number;
  mfa?: boolean;
}

export interface Res {
  status: number;
  body: any;
  headers: Headers;
}

let ipSeq = 10;
const nextIp = () => `198.51.100.${(ipSeq++ % 240) + 10}`;

let seq = 0;
export const uniq = (p: string) => `${p}-${Date.now().toString(36)}-${(seq++).toString(36)}-${randomBytes(2).toString('hex')}`;

let phoneSeq = 0;
/** Unique per test process (collisions would be a 409 PHONE_IN_USE flake): +62817 · pid (3) · counter (5). */
export function randomPhone(): string {
  return `+62817${String(process.pid % 1000).padStart(3, '0')}${String(phoneSeq++ % 100000).padStart(5, '0')}`;
}

/** Calls the API as `who`. Refreshes the session through POST /v1/auth/refresh when the (test) clock outran the 15-minute access token. */
export async function api(t: TestContext, who: Actor | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
  if (who) await ensureFresh(t, who);
  return t.request(method, path, {
    ...(who ? { token: who.accessToken } : {}),
    ...(body !== undefined ? { body } : {}),
    headers: { 'x-forwarded-for': who?.ip ?? '203.0.113.200', ...headers },
  });
}

/** Asserts a status and returns the body (with a readable failure message). */
export async function ok(p: Promise<Res>, status = 200): Promise<any> {
  const r = await p;
  expect(r.status, `${status} expected, got ${r.status}: ${JSON.stringify(r.body)}`).toBe(status);
  return r.body;
}

export const idem = () => ({ 'idempotency-key': crypto.randomUUID() });

/** Advance the clock (scheduled jobs dedupe per window) and run the worker until idle — what production workers do. */
export async function tick(t: TestContext, minutes: number) {
  t.clock.advance(minutes * 60_000);
  return t.drain();
}

async function ensureFresh(t: TestContext, who: Actor) {
  if (t.clock.now().getTime() - who.issuedAt < 12 * 60_000) return;
  const r = await t.request('POST', '/v1/auth/refresh', { body: { refreshToken: who.refreshToken }, headers: { 'x-forwarded-for': who.ip } });
  expect(r.status, `refresh failed for ${who.label}: ${JSON.stringify(r.body)}`).toBe(200);
  who.accessToken = r.body.tokens.accessToken;
  who.refreshToken = r.body.tokens.refreshToken;
  who.issuedAt = t.clock.now().getTime();
  // refreshing drops mfa_at → admins step up again with a fresh TOTP code
  if (who.totpSecret && who.mfa) await stepUp(t, who);
}

// ------------------------------------------------------------------ sign-up / login

export async function consentRequirements(t: TestContext, who?: Actor) {
  const r = who ? await api(t, who, 'GET', '/v1/consents/requirements') : await t.request('GET', '/v1/consents/requirements');
  expect(r.status).toBe(200);
  return r.body as {
    signup: { required: { type: string; version: string }[]; optional: { type: string; version: string }[]; satisfied?: boolean };
    kyc: { required: { type: string; version: string }[]; satisfied?: boolean };
  };
}

export interface SignUpOpts {
  email?: string;
  ip?: string;
  fingerprint?: string;
  marketing?: boolean;
  label?: string;
}

/**
 * E-mail OTP sign-up (registration = first LOGIN verification): consents from GET /v1/consents/requirements.
 * The account starts at level 1 with a verified login e-mail (so lifecycle e-mails have a destination).
 */
export async function signUpByEmail(t: TestContext, o: SignUpOpts = {}): Promise<Actor> {
  const email = (o.email ?? `${uniq(o.label ?? 'user')}@example.com`).toLowerCase();
  const ip = o.ip ?? nextIp();
  const reqs = await consentRequirements(t);
  const consents = [
    ...reqs.signup.required.map((c) => ({ type: c.type, version: c.version, granted: true })),
    ...reqs.signup.optional.map((c) => ({ type: c.type, version: c.version, granted: o.marketing ?? false })),
  ];
  const rq = await t.request('POST', '/v1/auth/otp/request', { body: { channel: 'EMAIL', destination: email, purpose: 'LOGIN' }, headers: { 'x-forwarded-for': ip } });
  expect(rq.status, JSON.stringify(rq.body)).toBe(200);
  expect(rq.body.devCode).toMatch(/^\d{6}$/);
  const device = { platform: 'ANDROID', fingerprint: o.fingerprint ?? `fp-${randomBytes(12).toString('hex')}`, appVersion: '1.0.0' };
  const v = await t.request('POST', '/v1/auth/otp/verify', {
    body: { challengeId: rq.body.challengeId, code: rq.body.devCode, consents, device },
    headers: { 'x-forwarded-for': ip },
  });
  expect(v.status, JSON.stringify(v.body)).toBe(200);
  expect(v.body.isNewUser).toBe(true);
  expect(v.body.user.kycLevel).toBe(1);
  return {
    id: v.body.user.id,
    label: o.label ?? 'user',
    email,
    phone: null,
    ip,
    accessToken: v.body.tokens.accessToken,
    refreshToken: v.body.tokens.refreshToken,
    sessionId: v.body.tokens.sessionId,
    issuedAt: t.clock.now().getTime(),
  };
}

/** VERIFY_PHONE OTP (authenticated) → level 2. */
export async function verifyPhone(t: TestContext, who: Actor, phone = randomPhone()): Promise<void> {
  const rq = await api(t, who, 'POST', '/v1/auth/otp/request', { channel: 'SMS', destination: phone, purpose: 'VERIFY_PHONE' });
  expect(rq.status, JSON.stringify(rq.body)).toBe(200);
  expect(t.sms.sent.at(-1)!.to).toBe(phone);
  const v = await api(t, who, 'POST', '/v1/auth/otp/verify', { challengeId: rq.body.challengeId, code: rq.body.devCode });
  expect(v.status, JSON.stringify(v.body)).toBe(200);
  expect(v.body).toMatchObject({ purpose: 'VERIFY_PHONE', verified: true });
  expect(v.body.user.kycLevel).toBeGreaterThanOrEqual(2);
  who.phone = phone;
}

/** Buyer: e-mail sign-up + phone verification (level 2). */
export async function buyerL2(t: TestContext, o: SignUpOpts = {}): Promise<Actor> {
  const b = await signUpByEmail(t, { label: 'buyer', ...o });
  await verifyPhone(t, b);
  return b;
}

// ------------------------------------------------------------------ admin (role grant shortcut + real TOTP)

/** Admin = normal sign-up + role grant (bootstrap shortcut) + TOTP enroll/confirm + step-up verify. */
export async function adminWithMfa(t: TestContext, roles: string[]): Promise<Actor> {
  const a = await signUpByEmail(t, { label: `admin-${roles.join('+').toLowerCase()}` });
  for (const role of roles) await t.adminSql`INSERT INTO user_roles (user_id, role_code, reason) VALUES (${a.id}, ${role}, 'e2e bootstrap grant')`;
  clearPermissionCache(a.id);
  const enr = await ok(api(t, a, 'POST', '/v1/auth/mfa/totp/enroll'));
  expect(enr.secret).toMatch(/^[A-Z2-7]{32}$/);
  a.totpSecret = enr.secret;
  const step = Math.floor(t.clock.now().getTime() / 30_000);
  const conf = await ok(api(t, a, 'POST', '/v1/auth/mfa/totp/confirm', { code: await totpAt(enr.secret, step) }));
  expect(conf.recoveryCodes).toHaveLength(10);
  a.lastStep = step;
  a.accessToken = conf.accessToken; // step-up token for the same session
  a.mfa = true;
  await stepUp(t, a); // explicit /mfa/verify as well (what the admin app does before sensitive actions)
  return a;
}

/** POST /v1/auth/mfa/verify with the next unused TOTP step (moves the clock 30 s when needed). */
export async function stepUp(t: TestContext, a: Actor): Promise<void> {
  let step = Math.floor(t.clock.now().getTime() / 30_000);
  if (a.lastStep !== undefined && step <= a.lastStep) {
    t.clock.advance((a.lastStep - step + 1) * 30_000);
    step = Math.floor(t.clock.now().getTime() / 30_000);
  }
  const r = await t.request('POST', '/v1/auth/mfa/verify', { token: a.accessToken, body: { code: await totpAt(a.totpSecret!, step) }, headers: { 'x-forwarded-for': a.ip } });
  expect(r.status, `mfa verify: ${JSON.stringify(r.body)}`).toBe(200);
  expect(r.body.method).toBe('TOTP');
  a.lastStep = step;
  a.accessToken = r.body.accessToken;
}

// ------------------------------------------------------------------ files (presigned dev storage)

export const JPEG = (n = 256, seed = 7) =>
  new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, ...Array.from({ length: n }, (_, i) => (i * seed + n) % 251)]);
export const PDF = (label = 'e-ticket') => new TextEncoder().encode(`%PDF-1.7\n1 0 obj << /Type /Catalog /Title (${label}) >> endobj\ntrailer\n%%EOF`);

let fileSeed = 3;
/** POST /files/uploads → PUT presigned (dev storage) → POST /files/{id}/complete (magic bytes + scan). */
export async function upload(t: TestContext, who: Actor, purpose: string, contentType = 'image/jpeg', bytes?: Uint8Array): Promise<string> {
  const data = bytes ?? (contentType === 'application/pdf' ? PDF(uniq('doc')) : JPEG(200 + (fileSeed % 50), fileSeed++));
  const c = await api(t, who, 'POST', '/v1/files/uploads', { purpose, contentType, sizeBytes: data.length });
  expect(c.status, JSON.stringify(c.body)).toBe(201);
  const u = new URL(c.body.upload.url);
  const put = await t.app.request(u.pathname + u.search, { method: 'PUT', headers: c.body.upload.headers, body: new Uint8Array(data) });
  expect(put.status).toBe(200);
  const done = await api(t, who, 'POST', `/v1/files/${c.body.fileId}/complete`);
  expect(done.status, JSON.stringify(done.body)).toBe(200);
  return c.body.fileId as string;
}

// ------------------------------------------------------------------ traveler onboarding

let nikSeq = 0;
export const nik = () => `3174${String(Date.now()).slice(-8)}${String(nikSeq++ % 10000).padStart(4, '0')}`;

/** KYC consent (version from requirements) + KTP/selfie/liveness uploads + submission; the admin approves (MFA) → level 3. */
export async function kycApproved(t: TestContext, who: Actor, admin: Actor, fullName = 'Budi Santoso'): Promise<{ submissionId: string }> {
  const reqs = await consentRequirements(t, who);
  expect(reqs.kyc.satisfied).toBe(false);
  await ok(api(t, who, 'POST', '/v1/me/consents', { type: 'KYC', version: reqs.kyc.required[0]!.version }), 201);
  const idFront = await upload(t, who, 'KYC');
  const selfie = await upload(t, who, 'KYC');
  const live1 = await upload(t, who, 'KYC');
  const live2 = await upload(t, who, 'KYC');
  const sub = await ok(
    api(t, who, 'POST', '/v1/kyc/submissions', {
      idType: 'KTP',
      idNumber: nik(),
      fullName,
      dateOfBirth: '1991-04-12',
      documents: { idFront, selfie, livenessFileIds: [live1, live2] },
    }),
    201,
  );
  expect(['PENDING', 'IN_REVIEW']).toContain(sub.submission.status); // KYC_PROVIDER=manual → admin queue
  const q = await ok(api(t, admin, 'GET', '/v1/admin/kyc/submissions'));
  expect(q.data.map((x: any) => x.id)).toContain(sub.submission.id);
  const detail = await ok(api(t, admin, 'GET', `/v1/admin/kyc/submissions/${sub.submission.id}`));
  expect(detail.documents.map((d: any) => d.type)).toEqual(expect.arrayContaining(['KTP', 'SELFIE', 'LIVENESS']));
  const appr = await ok(api(t, admin, 'POST', `/v1/admin/kyc/submissions/${sub.submission.id}/approve`, { livenessPassed: true, documentMatches: true, note: 'KTP, selfie & liveness cocok' }));
  expect(appr).toMatchObject({ status: 'APPROVED', kycLevel: 3 });
  return { submissionId: sub.submission.id };
}

/**
 * SEC-12 step-up: SENSITIVE_ACTION OTP bound to (action, targetId), delivered to the actor's VERIFIED phone (SMS) or
 * e-mail — what the app does before a refund destination / payout account change. Returns the `stepUp` proof.
 */
export async function sensitiveOtp(
  t: TestContext,
  who: Actor,
  action: 'REFUND_DESTINATION_SET' | 'PAYOUT_ACCOUNT_ADD' | 'PAYOUT_ACCOUNT_SET_DEFAULT',
  targetId: string,
): Promise<{ challengeId: string; code: string }> {
  const channels = [
    ...(who.phone ? [{ channel: 'SMS', destination: who.phone }] : []),
    { channel: 'EMAIL', destination: who.email },
  ] as const;
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const ch of channels) {
      const rq = await api(t, who, 'POST', '/v1/auth/otp/request', { ...ch, purpose: 'SENSITIVE_ACTION', action, targetId });
      if (rq.status === 200) {
        expect(rq.body.devCode).toMatch(/^\d{6}$/);
        if (ch.channel === 'SMS') expect(t.sms.sent.at(-1)!.to).toBe(ch.destination);
        return { challengeId: rq.body.challengeId, code: rq.body.devCode };
      }
      expect(rq.status, JSON.stringify(rq.body)).toBe(429); // resend cooldown on that destination (a login OTP just went out)
    }
    t.clock.advance(61_000);
  }
  throw new Error('step-up OTP could not be requested');
}

/** Payout account through the API (with step-up OTP); the provider's bank-name inquiry returns the identity name. */
export async function payoutAccount(t: TestContext, who: Actor, holderName = 'BUDI SANTOSO'): Promise<{ id: string; mask: string }> {
  const original = t.payment.validateBankAccount.bind(t.payment);
  t.payment.validateBankAccount = (async (i: { accountNumber: string }) => ({ valid: /^\d{6,20}$/.test(i.accountNumber), holderName })) as typeof t.payment.validateBankAccount;
  try {
    const accountNumber = `55${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
    const stepUp = await sensitiveOtp(t, who, 'PAYOUT_ACCOUNT_ADD', who.id);
    const r = await ok(api(t, who, 'POST', '/v1/kyc/payout-accounts', { bankCode: 'BCA', accountNumber, holderName, stepUp }), 201);
    expect(r).toMatchObject({ verificationStatus: 'VERIFIED', isDefault: true, accountMask: `****${accountNumber.slice(-4)}` });
    expect(JSON.stringify(r)).not.toContain(accountNumber);
    return { id: r.id, mask: r.accountMask };
  } finally {
    t.payment.validateBankAccount = original;
  }
}

export function wibDay(t: TestContext, offsetDays = 0): string {
  return new Date(t.clock.now().getTime() + 7 * 3600_000 + offsetDays * 86400_000).toISOString().slice(0, 10);
}

/** Trip DRAFT → e-ticket upload (TRIP_DOC pdf) → verification → admin approves → publish (ACTIVE). */
export async function publishedTrip(t: TestContext, traveler: Actor, admin: Actor, o: Record<string, unknown> = {}): Promise<any> {
  const draft = await ok(
    api(t, traveler, 'POST', '/v1/trips', {
      originCountry: 'JP',
      originCity: 'Tokyo',
      destinationCountry: 'ID',
      destinationCity: 'Jakarta',
      departureDate: wibDay(t, 1),
      arrivalDate: wibDay(t, 1),
      capacityKg: 20,
      maxItems: 10,
      fee: { type: 'FIXED', value: 100_000 },
      notes: 'Bisa COD di Jakarta Selatan',
      ...o,
    }),
    201,
  );
  expect(draft.status).toBe('DRAFT');
  const early = await api(t, traveler, 'POST', `/v1/trips/${draft.id}/publish`);
  expect([early.status, early.body.error?.code]).toEqual([422, 'TRIP_NOT_VERIFIED']);
  const ticket = await upload(t, traveler, 'TRIP_DOC', 'application/pdf');
  const ver = await ok(api(t, traveler, 'POST', `/v1/trips/${draft.id}/verification`, { docType: 'ETICKET', fileId: ticket, flightNumber: 'GA875', flightDate: draft.departureDate }));
  expect(ver.status).toBe('VERIFICATION_PENDING');
  const queue = await ok(api(t, admin, 'GET', '/v1/admin/trips/verifications'));
  expect(queue.data.map((x: any) => x.id)).toContain(draft.id);
  const appr = await ok(api(t, admin, 'POST', `/v1/admin/trips/${draft.id}/verification/approve`, { note: 'E-ticket GA875 valid' }));
  expect(appr.status).toBe('VERIFIED');
  const pub = await ok(api(t, traveler, 'POST', `/v1/trips/${draft.id}/publish`));
  expect(pub.status).toBe('ACTIVE');
  return pub;
}

/** Traveler: sign-up + phone + TRAVELER mode + KYC (admin) + payout account + published verified trip → drain → level 4. */
export async function onboardTraveler(t: TestContext, admin: Actor, o: { label?: string; trip?: Record<string, unknown>; fullName?: string } = {}) {
  const traveler = await signUpByEmail(t, { label: o.label ?? 'traveler' });
  await verifyPhone(t, traveler);
  const mode = await ok(api(t, traveler, 'POST', '/v1/me/mode', { mode: 'TRAVELER' }));
  expect(mode.activeMode).toBe('TRAVELER');
  await kycApproved(t, traveler, admin, o.fullName ?? 'Budi Santoso');
  const payout = await payoutAccount(t, traveler, (o.fullName ?? 'Budi Santoso').toUpperCase());
  const trip = await publishedTrip(t, traveler, admin, o.trip ?? {});
  await t.drain(); // trip.verified → level recompute (identity consumer)
  const me = await ok(api(t, traveler, 'GET', '/v1/me'));
  expect(me.kycLevel).toBe(4);
  return { traveler, trip, payout };
}

// ------------------------------------------------------------------ request via URL extraction (fake fetch)

export function productPage(o: { name: string; priceMinor: number; currency: string; image: string; brand?: string | undefined }) {
  return `<!doctype html><html><head><title>${o.name}</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":${JSON.stringify(o.name)},
"brand":{"@type":"Brand","name":${JSON.stringify(o.brand ?? 'UNIQLO')}},"image":[${JSON.stringify(o.image)}],
"offers":{"@type":"Offer","price":"${o.priceMinor}","priceCurrency":"${o.currency}","availability":"https://schema.org/InStock"}}</script>
</head><body>…</body></html>`;
}

/** Installs a heuristic extraction provider whose fetch serves `pages` (URL → HTML) — never the real network. */
export function installFakeMerchant(t: TestContext, pages: Record<string, string>) {
  const fetched: string[] = [];
  t.deps.providers.extraction = new HeuristicExtractionProvider({
    timeoutMs: 500,
    fetch: async (url: string) => {
      fetched.push(url);
      const html = pages[url];
      if (!html) return new Response('not found', { status: 404, headers: { 'content-type': 'text/html' } });
      return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    },
    resolve: async () => ['93.184.215.14'],
  });
  return fetched;
}

export const DEFAULT_PRODUCT = {
  url: 'https://www.uniqlo.com/jp/ja/products/E477133-000/00',
  name: 'Ultra Light Down Parka Jacket',
  priceMinor: 6000,
  currency: 'JPY',
  image: 'https://image.uniqlo.com/UQ/ST3/jp/imagesgoods/477133/item/goods_09_477133.jpg',
  brand: 'UNIQLO',
};

/** POST /v1/requests/extract {url} → draft → POST /v1/requests (publish) — the app's "paste a link" flow. */
export async function requestFromUrl(
  t: TestContext,
  buyer: Actor,
  o: { url?: string; name?: string; priceMinor?: number; currency?: string; image?: string; quantity?: number; categoryCode?: string; estWeightKg?: number; maxBudgetIdr?: number; neededInDays?: number } = {},
) {
  const product = { ...DEFAULT_PRODUCT, ...(o.url ? { url: o.url } : {}), ...(o.name ? { name: o.name } : {}), ...(o.priceMinor ? { priceMinor: o.priceMinor } : {}), ...(o.currency ? { currency: o.currency } : {}), ...(o.image ? { image: o.image } : {}) };
  installFakeMerchant(t, { [product.url]: productPage(product) });
  const ex = await ok(api(t, buyer, 'POST', '/v1/requests/extract', { url: product.url }));
  const d = ex.drafts[0];
  expect(d).toMatchObject({ sourceType: 'URL', productUrl: product.url, productName: expect.stringContaining(product.name.split(' ').at(-1)!), unitPriceMinor: product.priceMinor, priceCurrency: product.currency, merchantCountry: 'JP' });
  const created = await ok(
    api(t, buyer, 'POST', '/v1/requests', {
      sourceType: 'URL',
      productUrl: d.productUrl,
      productName: d.productName,
      merchantName: d.merchantName,
      merchantCountry: d.merchantCountry,
      categoryCode: o.categoryCode ?? 'FASHION_APPAREL',
      quantity: o.quantity ?? 1,
      unitPriceMinor: d.unitPriceMinor,
      priceCurrency: d.priceCurrency,
      estWeightKg: o.estWeightKg ?? 0.8,
      maxBudgetIdr: o.maxBudgetIdr ?? 3_000_000,
      neededBy: wibDay(t, o.neededInDays ?? 20),
      destinationCountry: 'ID',
      destinationCity: 'Jakarta',
      imageUrls: d.imageUrl ? [d.imageUrl] : [],
      extraction: { confidence: ex.confidence, mode: ex.mode },
      publish: true,
      acknowledgeRestriction: true,
    }),
    201,
  );
  expect(created.status).toBe('OPEN');
  return created;
}

/** Traveler offers on the request with the trip; buyer sees recommendations, accepts → MATCHED transaction. */
export async function matchViaOffer(t: TestContext, buyer: Actor, traveler: Actor, requestId: string, tripId: string, fee?: number) {
  const rec = await ok(api(t, buyer, 'GET', `/v1/requests/${requestId}/recommended-travelers`));
  expect(rec.data.map((x: any) => x.trip.id)).toContain(tripId);
  const offer = await ok(api(t, traveler, 'POST', `/v1/requests/${requestId}/offers`, { tripId, message: 'Siap bantu, beli langsung di toko resmi', ...(fee ? { travelerFeeIdr: fee } : {}) }), 201);
  expect(offer.status).toBe('PENDING');
  const acc = await ok(api(t, buyer, 'POST', `/v1/offers/${offer.id}/accept`));
  expect(acc.transaction.status).toBe('MATCHED');
  return { offer, tx: acc.transaction as { id: string; number: string; tripId: string } };
}

// ------------------------------------------------------------------ money helpers

export async function sendWebhook(t: TestContext, rawBody: string, token = 'mock-webhook-token') {
  return t.request('POST', '/v1/webhooks/payments/mock', { rawBody, headers: { 'content-type': 'application/json', 'x-callback-token': token } });
}

export async function providerRefOf(t: TestContext, paymentId: string): Promise<string> {
  const [p] = await t.adminSql<{ provider_ref: string }[]>`SELECT provider_ref FROM payments WHERE id = ${paymentId}`;
  return p!.provider_ref;
}

/** The provider calls our webhook for a payment (MOCK signature). */
export async function providerPays(t: TestContext, paymentId: string, channel = 'QRIS') {
  const ref = await providerRefOf(t, paymentId);
  const body = t.payment.buildPaymentWebhook(ref, 'SUCCEEDED', { channel });
  const res = await sendWebhook(t, body);
  return { res, body };
}

/** quote (channel) → checkout (Idempotency-Key) → provider webhook → PAYMENT_SECURED. */
export async function quoteAndPay(t: TestContext, buyer: Actor, txId: string, o: { channel?: string; quoteBody?: Record<string, unknown> } = {}) {
  const channel = o.channel ?? 'QRIS';
  const quote = await ok(api(t, buyer, 'POST', `/v1/transactions/${txId}/quote`, { channel, ...(o.quoteBody ?? {}) }), 201);
  const co = await ok(api(t, buyer, 'POST', `/v1/transactions/${txId}/checkout`, { quoteId: quote.quoteId, acknowledgeRestricted: true }, idem()), 201);
  const { res } = await providerPays(t, co.paymentId, channel);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(res.body.outcome).toBe('SECURED');
  return { quote, checkout: co };
}

export function line(quote: { lines: { type: string; amountIdr: number }[] }, type: string): number {
  return quote.lines.find((l) => l.type === type)?.amountIdr ?? 0;
}

export async function txStatus(t: TestContext, id: string): Promise<string> {
  const [r] = await t.adminSql<{ status: string }[]>`SELECT status FROM transactions WHERE id = ${id}`;
  return r!.status;
}

/** Escrow per bucket for one transaction (credit-positive, v_transaction_ledger). */
export async function txLedger(t: TestContext, id: string): Promise<Record<string, number>> {
  const rows = await t.adminSql<{ bucket: string; net_credit: string }[]>`SELECT bucket, net_credit::text FROM v_transaction_ledger WHERE transaction_id = ${id}`;
  return Object.fromEntries(rows.map((r) => [r.bucket, Number(r.net_credit)]));
}

export async function unbalancedJournals(t: TestContext): Promise<number> {
  const [r] = await t.adminSql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM (SELECT journal_id FROM ledger_entries GROUP BY journal_id
      HAVING sum(CASE direction WHEN 'DEBIT' THEN amount ELSE -amount END) <> 0) x`;
  return r!.n;
}

export const HELD = ['PRODUCT_FUND', 'CUSTOMS_RESERVE', 'CLEARING', 'REFUND', 'TRAVELER_EARNING', 'PROMOTION_CREDIT'] as const;

/** Traveler: price check at the quoted price → purchase proof (receipt + photo uploaded) → PURCHASED. */
export async function purchase(t: TestContext, traveler: Actor, txId: string, unitPriceMinor: number, currency = 'JPY') {
  const pc = await ok(api(t, traveler, 'POST', `/v1/transactions/${txId}/price-check`, { actualUnitPriceMinor: unitPriceMinor, currency }));
  expect(pc.transactionStatus).toBe('PURCHASE_APPROVED');
  const receipt = await upload(t, traveler, 'RECEIPT', 'application/pdf');
  const photo = await upload(t, traveler, 'PRODUCT_PHOTO');
  const pp = await ok(
    api(t, traveler, 'POST', `/v1/transactions/${txId}/purchase-proof`, {
      receiptFileId: receipt,
      productPhotoFileIds: [photo],
      merchantName: 'UNIQLO Ginza',
      actualPriceMinor: unitPriceMinor,
      currency,
      purchasedAt: t.clock.now().toISOString(),
      receiptNumber: uniq('RCPT'),
    }),
    201,
  );
  expect(pp).toMatchObject({ status: 'ACCEPTED', flagged: false, transactionStatus: 'PURCHASED' });
  return { receipt, photo };
}

/** Trip departs → TRAVELING → ARRIVED → READY_FOR_HANDOVER (no customs paid). */
export async function travelToHandover(t: TestContext, traveler: Actor, txId: string, tripId: string) {
  const dep = await api(t, traveler, 'POST', `/v1/trips/${tripId}/depart`);
  expect([200, 409, 422]).toContain(dep.status); // may already be TRAVELING (another tx of the same trip)
  for (const to of ['TRAVELING', 'ARRIVED', 'READY_FOR_HANDOVER']) {
    const r = await ok(api(t, traveler, 'POST', `/v1/transactions/${txId}/status`, { to }));
    expect(r.transactionStatus).toBe(to);
  }
}

/** The e-mail tag of a template key (the dispatcher sanitises tags to [A-Za-z0-9_-]). */
export const tag = (templateKey: string) => templateKey.replace(/[^A-Za-z0-9_-]/g, '_');

/** Template tags of the lifecycle e-mails sent to `email` (MOCK e-mail provider), in send order. */
export function emailTemplates(t: TestContext, email: string): string[] {
  return t.email.outbox.filter((m) => m.to === email && m.tags?.template).map((m) => m.tags!.template!);
}

export function emailsTo(t: TestContext, email: string) {
  return t.email.outbox.filter((m) => m.to === email && m.tags?.template);
}

// ------------------------------------------------------------------ shared world & journey building blocks

export interface World {
  admin: Actor;
  traveler: Actor;
  trip: any;
}

/** One admin (OPERATIONS + COMPLIANCE, TOTP) and one fully onboarded traveler with a published, verified trip. */
export async function world(t: TestContext, o: { roles?: string[]; trip?: Record<string, unknown> } = {}): Promise<World> {
  const admin = await adminWithMfa(t, o.roles ?? ['OPERATIONS', 'COMPLIANCE']);
  const { traveler, trip } = await onboardTraveler(t, admin, { trip: { maxItems: 30, capacityKg: 30, ...(o.trip ?? {}) } });
  return { admin, traveler, trip };
}

/** New L2 buyer → request from URL → offer by the world's traveler → accepted → MATCHED. */
export async function matchedDeal(t: TestContext, w: World, o: { buyer?: Actor; tripId?: string; product?: Parameters<typeof requestFromUrl>[2] } = {}) {
  const buyer = o.buyer ?? (await buyerL2(t));
  const request = await requestFromUrl(t, buyer, o.product ?? {});
  const { tx } = await matchViaOffer(t, buyer, w.traveler, request.id, o.tripId ?? w.trip.id);
  return { buyer, request, tx };
}

/** Another published, verified trip for the world's traveler (a journey that departs needs its own trip). */
export async function extraTrip(t: TestContext, w: World, o: Record<string, unknown> = {}) {
  return publishedTrip(t, w.traveler, w.admin, { maxItems: 30, capacityKg: 30, ...o });
}

/** matchedDeal + quote/checkout/webhook → PAYMENT_SECURED. */
export async function securedDeal(t: TestContext, w: World, o: { buyer?: Actor; tripId?: string; channel?: string; product?: Parameters<typeof requestFromUrl>[2]; quoteBody?: Record<string, unknown> } = {}) {
  const d = await matchedDeal(t, w, o);
  const { quote, checkout } = await quoteAndPay(t, d.buyer, d.tx.id, { ...(o.channel ? { channel: o.channel } : {}), ...(o.quoteBody ? { quoteBody: o.quoteBody } : {}) });
  expect(await txStatus(t, d.tx.id)).toBe('PAYMENT_SECURED');
  return { ...d, quote, checkout };
}

/** MEETUP: traveler sets the meet-up, buyer reveals the PIN, traveler verifies → DELIVERED. */
export async function meetupHandover(t: TestContext, buyer: Actor, traveler: Actor, txId: string) {
  await ok(api(t, traveler, 'POST', `/v1/transactions/${txId}/delivery`, { method: 'MEETUP', meetupPoint: 'Lobby Grand Indonesia' }));
  const pin = await ok(api(t, buyer, 'GET', `/v1/transactions/${txId}/delivery/pin`));
  const v = await ok(api(t, traveler, 'POST', `/v1/transactions/${txId}/delivery/verify`, { pin: pin.pin }));
  expect(v.transactionStatus).toBe('DELIVERED');
  return pin.pin as string;
}

export async function outboxTypes(t: TestContext, transactionId: string): Promise<string[]> {
  const rows = await t.adminSql<{ event_type: string }[]>`
    SELECT event_type FROM outbox_events WHERE aggregate_id = ${transactionId} OR payload->>'transactionId' = ${transactionId} ORDER BY id`;
  return rows.map((r) => r.event_type);
}
