/**
 * J1 — full happy path through HTTP only: sign-up (OTP) → consents → phone → KYC (admin + TOTP) → payout account →
 * trip + e-ticket → admin verification → publish → request from a URL → matching → offer → MATCHED → quote (11 lines,
 * paymentOptions) → checkout (Idempotency-Key) → provider webhook → PAYMENT_SECURED → DO NOT PURCHASE gate → price check
 * → PURCHASE_APPROVED → purchase proof → TRAVELING → ARRIVED → CUSTOMS_PROCESS (+declaration) → READY_FOR_HANDOVER →
 * PIN meet-up → DELIVERED → buyer confirms → COMPLETED → payout PAID → ratings; notifications/e-mails per lifecycle step,
 * chat STATUS messages, ledger, admin KPIs and the audit chain.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../helpers';
import {
  type Actor,
  adminWithMfa,
  api,
  buyerL2,
  emailTemplates,
  emailsTo,
  HELD,
  idem,
  line,
  matchViaOffer,
  ok,
  onboardTraveler,
  providerPays,
  requestFromUrl,
  tag,
  tick,
  txLedger,
  txStatus,
  unbalancedJournals,
  upload,
} from './support';

let t: TestContext;
let admin: Actor;
let buyer: Actor;
let traveler: Actor;
let trip: any;
let request: any;
let tx: { id: string; number: string };
let quote: any;
let paymentId: string;
let pin: string;

beforeAll(async () => {
  t = await createTestContext();
});
afterAll(async () => {
  await t.close();
});

describe('J1 happy path (HTTP only)', () => {
  it('onboarding: admin (TOTP), buyer (e-mail OTP + consents + phone → L2), traveler (KYC → L3, payout, verified trip → L4)', async () => {
    admin = await adminWithMfa(t, ['OPERATIONS', 'COMPLIANCE']);
    buyer = await buyerL2(t, { label: 'buyer' });
    const reqs = await ok(api(t, buyer, 'GET', '/v1/consents/requirements'));
    expect(reqs.signup.satisfied).toBe(true);
    const onboarding = await onboardTraveler(t, admin);
    traveler = onboarding.traveler;
    trip = onboarding.trip;
    expect(trip).toMatchObject({ status: 'ACTIVE', verified: true });
    // public discovery shows the trip without PII
    const disc = await ok(api(t, null, 'GET', '/v1/trips?originCountry=JP'));
    const listed = disc.data.find((x: any) => x.id === trip.id);
    expect(listed).toBeTruthy();
    expect(JSON.stringify(listed)).not.toContain(traveler.email);
    const kyc = await ok(api(t, traveler, 'GET', '/v1/kyc/status'));
    expect(kyc.level).toBe(4);
  });

  it('request from a merchant URL (extraction) → OPEN; recommendations; offer → accept → MATCHED', async () => {
    request = await requestFromUrl(t, buyer);
    expect(request.sourceType).toBe('URL');
    expect(request.images[0].url).toMatch(/^https:\/\//);
    const m = await matchViaOffer(t, buyer, traveler, request.id, trip.id);
    tx = m.tx;
    expect(tx.number).toMatch(/^JK-\d{6}-[0-9A-Z]{6}$/);
    expect(await txStatus(t, tx.id)).toBe('MATCHED');
  });

  it('quote: 11 price lines in §10 order, totals add up, paymentOptions for every channel', async () => {
    quote = await ok(api(t, buyer, 'POST', `/v1/transactions/${tx.id}/quote`, { channel: 'QRIS' }), 201);
    expect(quote.lines.map((l: any) => l.type)).toEqual([
      'ITEM_PRICE', 'TRAVELER_FEE', 'CUSTOMS_DUTY', 'IMPORT_TAX', 'PROTECTION_FEE', 'PLATFORM_FEE', 'SERVICE_TAX', 'PAYMENT_FEE', 'DISCOUNT', 'REFERRAL_CREDIT', 'TOTAL',
    ]);
    const sum = quote.lines.filter((l: any) => l.type !== 'TOTAL').reduce((s: number, l: any) => s + l.amountIdr, 0);
    expect(sum).toBe(quote.totalIdr);
    expect(line(quote, 'TOTAL')).toBe(quote.totalIdr);
    for (const l of quote.lines.filter((x: any) => x.type !== 'TOTAL')) expect(l.bucket, l.type).toBeTruthy();
    expect(quote.lines.find((l: any) => l.type === 'CUSTOMS_DUTY').isEstimate).toBe(true);
    expect(quote.fx).toMatchObject({ base: 'JPY', lockedAt: expect.any(String), expiresAt: expect.any(String) });
    expect(quote.paymentOptions.map((o: any) => o.channel)).toEqual(['VA', 'QRIS', 'EWALLET', 'CARD']);
    const qris = quote.paymentOptions.find((o: any) => o.channel === 'QRIS');
    expect(qris).toMatchObject({ selected: true, totalIdr: quote.totalIdr, available: true });
    const va = quote.paymentOptions.find((o: any) => o.channel === 'VA');
    expect(va.refundable).toBe(false);
    expect(va.totalIdr).toBe(quote.totalIdr - line(quote, 'PAYMENT_FEE') + va.feeIdr);
    // detail echoes the same quote & options; traveler is gated
    const tv = await ok(api(t, traveler, 'GET', `/v1/transactions/${tx.id}`));
    expect(tv.purchaseGate).toMatchObject({ canPurchase: false, banner: 'DO_NOT_PURCHASE' });
  });

  it('checkout with Idempotency-Key → AWAITING_PAYMENT (SANDBOX) → provider webhook → PAYMENT_SECURED', async () => {
    const co = await ok(api(t, buyer, 'POST', `/v1/transactions/${tx.id}/checkout`, { quoteId: quote.quoteId }, idem()), 201);
    expect(co).toMatchObject({ amountIdr: quote.totalIdr, providerEnv: 'TEST', sandbox: true });
    paymentId = co.paymentId;
    expect(await txStatus(t, tx.id)).toBe('AWAITING_PAYMENT');
    const pay = await ok(api(t, traveler, 'GET', `/v1/transactions/${tx.id}/payment`));
    expect(JSON.stringify(pay)).not.toContain(co.checkoutUrl); // checkout URL is buyer-only
    const { res } = await providerPays(t, paymentId);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'PROCESSED', outcome: 'SECURED' });
    expect(await txStatus(t, tx.id)).toBe('PAYMENT_SECURED');
  });

  it('golden rule: DO NOT PURCHASE until PURCHASE_APPROVED (purchase proof refused before the price check)', async () => {
    const d = await ok(api(t, traveler, 'GET', `/v1/transactions/${tx.id}`));
    expect(d.purchaseGate).toMatchObject({ canPurchase: false, banner: 'DO_NOT_PURCHASE', paymentBadge: 'PAYMENT_SECURED' });
    expect(d.allowedActions).toContain('PRICE_CHECK');
    expect(d.allowedActions).not.toContain('SUBMIT_PURCHASE_PROOF');
    const receipt = await upload(t, traveler, 'RECEIPT');
    const photo = await upload(t, traveler, 'PRODUCT_PHOTO');
    const early = await api(t, traveler, 'POST', `/v1/transactions/${tx.id}/purchase-proof`, {
      receiptFileId: receipt, productPhotoFileIds: [photo], merchantName: 'UNIQLO Ginza', actualPriceMinor: 6000, currency: 'JPY', purchasedAt: t.clock.now().toISOString(),
    });
    expect(early.status).toBe(422);
    expect(early.body.error.code).toBe('PURCHASE_NOT_APPROVED');
    expect(early.body.error.details.banner).toBe('DO_NOT_PURCHASE');
  });

  it('price check within tolerance (+1%) → PURCHASE_APPROVED; purchase proof → PURCHASED', async () => {
    const pc = await ok(api(t, traveler, 'POST', `/v1/transactions/${tx.id}/price-check`, { actualUnitPriceMinor: 6060, currency: 'JPY' }));
    expect(pc).toMatchObject({ outcome: 'WITHIN_TOLERANCE', transactionStatus: 'PURCHASE_APPROVED' });
    const d = await ok(api(t, traveler, 'GET', `/v1/transactions/${tx.id}`));
    expect(d.purchaseGate).toMatchObject({ canPurchase: true, banner: 'PURCHASE_APPROVED' });
    expect(d.purchaseCeilingMinor).toBe(6060);
    const over = await api(t, traveler, 'POST', `/v1/transactions/${tx.id}/purchase-proof`, {
      receiptFileId: await upload(t, traveler, 'RECEIPT'), productPhotoFileIds: [await upload(t, traveler, 'PRODUCT_PHOTO')], merchantName: 'UNIQLO Ginza', actualPriceMinor: 6500, currency: 'JPY', purchasedAt: t.clock.now().toISOString(),
    });
    expect(over.body.error?.code).toBe('PURCHASE_PRICE_EXCEEDS_APPROVED');
    const receipt = await upload(t, traveler, 'RECEIPT', 'application/pdf');
    const photo = await upload(t, traveler, 'PRODUCT_PHOTO');
    const pp = await ok(api(t, traveler, 'POST', `/v1/transactions/${tx.id}/purchase-proof`, {
      receiptFileId: receipt, productPhotoFileIds: [photo], merchantName: 'UNIQLO Ginza', actualPriceMinor: 6060, currency: 'JPY', purchasedAt: t.clock.now().toISOString(), receiptNumber: 'UQ-2026-0001',
    }), 201);
    expect(pp).toMatchObject({ status: 'ACCEPTED', flagged: false, transactionStatus: 'PURCHASED' });
    // buyer sees the proof files (content URLs are absolute, API-served)
    const bd = await ok(api(t, buyer, 'GET', `/v1/transactions/${tx.id}`));
    expect(bd.purchaseProof.files.map((f: any) => f.kind).sort()).toEqual(['PRODUCT_PHOTO', 'RECEIPT']);
    for (const f of bd.purchaseProof.files) expect(f.contentUrl).toMatch(/^http:\/\/api\.test\/v1\/files\//);
  });

  it('travel: trip departs → TRAVELING → ARRIVED → CUSTOMS_PROCESS (+declaration with receipt) → READY_FOR_HANDOVER', async () => {
    const early = await api(t, traveler, 'POST', `/v1/transactions/${tx.id}/status`, { to: 'TRAVELING' });
    expect(early.body.error?.code).toBe('TRIP_NOT_TRAVELING');
    const dep = await ok(api(t, traveler, 'POST', `/v1/trips/${trip.id}/depart`));
    expect(dep.status).toBe('TRAVELING');
    for (const to of ['TRAVELING', 'ARRIVED', 'CUSTOMS_PROCESS']) {
      const r = await ok(api(t, traveler, 'POST', `/v1/transactions/${tx.id}/status`, { to }));
      expect(r.transactionStatus).toBe(to);
    }
    const noProof = await api(t, traveler, 'POST', `/v1/transactions/${tx.id}/status`, { to: 'READY_FOR_HANDOVER' });
    expect(noProof.body.error?.code).toBe('CUSTOMS_PROOF_MISSING');
    const bpn = await upload(t, traveler, 'RECEIPT', 'application/pdf');
    const decl = await ok(api(t, traveler, 'POST', `/v1/transactions/${tx.id}/customs-declaration`, {
      dutyPaidIdr: line(quote, 'CUSTOMS_DUTY'), vatPaidIdr: line(quote, 'IMPORT_TAX'), incomeTaxPaidIdr: 0, receiptFileId: bpn, declarationRef: 'CD-SOETTA-E2E-1',
    }));
    expect(decl.status).toBe('PAID');
    const ready = await ok(api(t, traveler, 'POST', `/v1/transactions/${tx.id}/status`, { to: 'READY_FOR_HANDOVER' }));
    expect(ready.transactionStatus).toBe('READY_FOR_HANDOVER');
  });

  it('meet-up: buyer reveals the PIN (never to the traveler, never in notifications) → traveler verifies → DELIVERED', async () => {
    await ok(api(t, traveler, 'POST', `/v1/transactions/${tx.id}/delivery`, { method: 'MEETUP', meetupPoint: 'Stasiun MRT Blok M' }));
    expect((await api(t, traveler, 'GET', `/v1/transactions/${tx.id}/delivery/pin`)).status).toBe(403);
    const bd = await ok(api(t, buyer, 'GET', `/v1/transactions/${tx.id}`));
    expect(bd.delivery.pinAvailable).toBe(true);
    const r = await api(t, buyer, 'GET', `/v1/transactions/${tx.id}/delivery/pin`);
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toContain('no-store');
    pin = r.body.pin;
    expect(pin).toMatch(/^\d{6}$/);
    const ok1 = await ok(api(t, traveler, 'POST', `/v1/transactions/${tx.id}/delivery/verify`, { pin }));
    expect(ok1).toMatchObject({ transactionStatus: 'DELIVERED', confirmedVia: 'PIN', alreadyConfirmed: false });
  });

  it('buyer confirms receipt → COMPLETED; drain → payout PAID; all held buckets zero; platform revenue as quoted', async () => {
    const c = await ok(api(t, buyer, 'POST', `/v1/transactions/${tx.id}/confirm-receipt`, undefined, idem()));
    expect(c.transactionStatus).toBe('COMPLETED');
    const scheduled = await ok(api(t, traveler, 'GET', '/v1/payouts/mine'));
    expect(scheduled.data[0].status).toBe('SCHEDULED');
    // new payout account cooldown (money.md §5.7): the account was added during onboarding, < 24 h ago
    const cooldownUntil = scheduled.data[0].cooldownUntil as string;
    expect(cooldownUntil).toBeTruthy();
    expect(scheduled.data[0].scheduledFor).toBe(cooldownUntil);
    await tick(t, 5); // next money.process_payouts window: still waiting
    expect((await ok(api(t, traveler, 'GET', '/v1/payouts/mine'))).data[0].status).toBe('SCHEDULED');
    t.clock.set(new Date(Date.parse(cooldownUntil) + 60_000));
    await tick(t, 5); // first payout run after the cooldown
    const po = await ok(api(t, traveler, 'GET', '/v1/payouts/mine'));
    expect(po.data[0]).toMatchObject({ status: 'PAID' });
    expect(po.data[0].destination.accountMask).toMatch(/^\*{4}\d{4}$/);
    const l = await txLedger(t, tx.id);
    for (const b of HELD.filter((x) => x !== 'PROMOTION_CREDIT')) expect(l[b] ?? 0, b).toBe(0);
    expect(l.PLATFORM_REVENUE).toBe(line(quote, 'PLATFORM_FEE') + line(quote, 'PROTECTION_FEE'));
    expect(l.TAX_PAYABLE).toBe(line(quote, 'SERVICE_TAX'));
    // the +1% within-tolerance price increase is absorbed by the platform (PROMOTION_CREDIT debit, §04 COMPLETION_RELEASE)
    const absorbed = -(l.PROMOTION_CREDIT ?? 0);
    expect(absorbed).toBeGreaterThan(0);
    expect(absorbed).toBeLessThanOrEqual(Math.min(50_000, Math.ceil(line(quote, 'ITEM_PRICE') * 0.02)));
    const [po0] = await t.adminSql<{ amount_idr: number }[]>`SELECT amount_idr FROM payouts WHERE transaction_id = ${tx.id}`;
    const customs = line(quote, 'CUSTOMS_DUTY') + line(quote, 'IMPORT_TAX');
    expect(Number(po0!.amount_idr)).toBe(line(quote, 'ITEM_PRICE') + absorbed + line(quote, 'TRAVELER_FEE') + customs);
    // cash left at the provider = platform take − absorbed tolerance
    expect(-l.PROVIDER_CASH!).toBe(l.PLATFORM_REVENUE! + l.TAX_PAYABLE! + l.PAYMENT_FEE! - absorbed);
    expect(await unbalancedJournals(t)).toBe(0);
    const tl = await ok(api(t, buyer, 'GET', `/v1/transactions/${tx.id}/timeline`));
    expect(tl.events.map((e: any) => e.to)).toEqual([
      'REQUEST_CREATED', 'MATCHED', 'AWAITING_PAYMENT', 'PAYMENT_SECURED', 'PURCHASE_APPROVED', 'PURCHASED', 'TRAVELING', 'ARRIVED', 'CUSTOMS_PROCESS', 'READY_FOR_HANDOVER', 'DELIVERED', 'BUYER_CONFIRMED', 'COMPLETED',
    ]);
  });

  it('ratings both ways after COMPLETED', async () => {
    const b = await ok(api(t, buyer, 'POST', `/v1/transactions/${tx.id}/ratings`, { overall: 5, communication: 5, accuracy: 5, timeliness: 4, comment: 'Barang original, serah terima cepat' }), 201);
    expect(b).toMatchObject({ direction: 'BUYER_TO_TRAVELER', rateeId: traveler.id });
    const tr = await ok(api(t, traveler, 'POST', `/v1/transactions/${tx.id}/ratings`, { overall: 5, communication: 5, timeliness: 5 }), 201);
    expect(tr).toMatchObject({ direction: 'TRAVELER_TO_BUYER', rateeId: buyer.id });
    await t.drain();
    const sum = await ok(api(t, null, 'GET', `/v1/users/${traveler.id}/rating-summary`));
    expect(sum.asTraveler.count).toBe(1);
  });

  it('notifications: in-app inbox and lifecycle e-mails per step for buyer and traveler; no PIN anywhere', async () => {
    await t.drain();
    const buyerMails = emailTemplates(t, buyer.email);
    expect(buyerMails).toEqual(
      [
        'account.welcome', 'request.created', 'transaction.matched', 'payment.checkout_created', 'transaction.payment_secured', 'transaction.purchase_approved',
        'transaction.purchased', 'purchase.receipt_available', 'transaction.traveling', 'transaction.arrived', 'transaction.customs', 'transaction.ready_for_handover',
        'delivery.pin_ready', 'transaction.delivered', 'transaction.completed', 'receipt.final',
      ].map(tag),
    );
    const travelerMails = emailTemplates(t, traveler.email);
    expect(travelerMails).toEqual(
      [
        'account.welcome', 'kyc.submitted', 'kyc.approved', 'payout_account.verified', 'trip.verified', 'transaction.matched', 'transaction.payment_secured',
        'transaction.purchase_approved', 'transaction.delivered', 'transaction.buyer_confirmed', 'payout.scheduled', 'transaction.completed', 'payout.paid',
      ].map(tag),
    );
    // subjects carry the transaction number; the PIN never leaves the buyer's app
    const matched = emailsTo(t, buyer.email).find((m) => m.tags!.template === tag('transaction.matched'))!;
    expect(matched.subject).toContain(tx.number);
    for (const m of t.email.outbox) {
      expect(m.html).not.toContain(pin);
      expect(m.text).not.toContain(pin);
    }
    for (const p of t.push.sent) expect(JSON.stringify(p)).not.toContain(pin);
    const inbox = await ok(api(t, buyer, 'GET', '/v1/notifications?limit=50'));
    const inAppKeys = inbox.data.map((n: any) => n.type);
    expect(inAppKeys).toEqual(expect.arrayContaining(['transaction.payment_secured', 'delivery.pin_ready', 'transaction.completed']));
    const unread = await ok(api(t, buyer, 'GET', '/v1/notifications/unread-count'));
    expect(unread.count).toBeGreaterThan(0);
  });

  it('chat: conversation exists for the transaction with STATUS system messages; a user cannot post SYSTEM', async () => {
    const conv = await ok(api(t, buyer, 'GET', `/v1/transactions/${tx.id}/conversation`));
    expect(conv.conversationId).toBeTruthy();
    const msgs = await ok(api(t, traveler, 'GET', `/v1/conversations/${conv.conversationId}/messages?limit=100`));
    const status = msgs.data.filter((m: any) => m.type === 'STATUS');
    expect(status.length).toBeGreaterThanOrEqual(10);
    expect(msgs.data.every((m: any) => !String(m.body ?? '').includes(pin))).toBe(true);
    const sent = await ok(api(t, buyer, 'POST', `/v1/conversations/${conv.conversationId}/messages`, { type: 'TEXT', body: 'Terima kasih, barangnya bagus!' }), 201);
    expect(sent.type).toBe('TEXT');
    const sys = await api(t, buyer, 'POST', `/v1/conversations/${conv.conversationId}/messages`, { type: 'SYSTEM', body: 'Pembayaran aman' });
    expect(sys.body.error.code).toBe('MESSAGE_TYPE_SYSTEM_ONLY');
    const stranger = await buyerL2(t, { label: 'stranger' });
    expect((await api(t, stranger, 'GET', `/v1/conversations/${conv.conversationId}/messages`)).status).toBe(404);
  });

  it('admin: transaction ledger balanced, dashboard KPIs reflect GMV, audit chain verifies', async () => {
    const d = await ok(api(t, admin, 'GET', `/v1/admin/transactions/${tx.id}`));
    expect(d.ledger.balanced).toBe(true);
    const k = await ok(api(t, admin, 'GET', '/v1/admin/dashboard/kpis'));
    const m = Object.fromEntries(k.metrics.map((x: any) => [x.key, x]));
    expect(m.gmv.value).toBe(line(quote, 'ITEM_PRICE'));
    expect(m.completedTransactions.value).toBe(1);
    expect(m.platformRevenue.value).toBe(line(quote, 'PLATFORM_FEE') + line(quote, 'PROTECTION_FEE'));
    expect(m.ledgerPlatformRevenue.value).toBe(line(quote, 'PLATFORM_FEE') + line(quote, 'PROTECTION_FEE'));
    const v = await ok(api(t, admin, 'GET', '/v1/admin/audit-logs/verify'));
    expect(v).toMatchObject({ status: 'OK', brokenAtId: null });
    // trip can be completed now that every transaction is handed over
    const done = await ok(api(t, traveler, 'POST', `/v1/trips/${trip.id}/complete`));
    expect(done.status).toBe('COMPLETED');
  });
});
