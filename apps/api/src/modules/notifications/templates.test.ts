import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../../../test/helpers';
import type { OutboxEvent } from '../../jobs/types';
import { NOTIFICATION_BUILDERS, NOTIFIED_EVENT_TYPES } from './handlers';
import { EMAIL_LIFECYCLE } from './lifecycle';
import { TEMPLATES, getTemplate } from './templates/catalog';
import { renderNotification } from './templates/render';
import type { TxView } from './templates/types';
import { createTransaction } from './testing/fixtures';

const TX: TxView = {
  id: '5b3f6c2e-8a1d-4f7e-9c0b-2d4e6f8a1b3c',
  number: 'JK-260927-7K2M9Q',
  status: 'PAYMENT_SECURED',
  buyerId: '0e9d8c7b-6a5f-4e3d-8c1b-0a9f8e7d6c5b',
  travelerId: '1f2e3d4c-5b6a-4978-8695-a4b3c2d1e0f9',
  productName: 'Nintendo Switch OLED',
  quantity: 1,
  variant: null,
  merchantName: 'Bic Camera',
  travelerPublicName: 'Dimas P.',
  buyerPublicName: 'Rina W.',
  originCountry: 'JP',
  originCity: 'Tokyo',
  destinationCity: 'Jakarta',
  departureDate: '2026-10-01',
  arrivalDate: '2026-10-02',
  deliveryMethod: 'MEETUP',
  totalIdr: 8_931_623,
  lines: [
    { type: 'ITEM_PRICE', labelId: 'Harga Barang', labelEn: 'Item Price', amountIdr: 5_565_927, isEstimate: false },
    { type: 'TRAVELER_FEE', labelId: 'Traveler Fee', labelEn: 'Traveler Fee', amountIdr: 556_593, isEstimate: false },
    { type: 'CUSTOMS_DUTY', labelId: 'Bea Masuk', labelEn: 'Customs Duty', amountIdr: 549_000, isEstimate: true },
    { type: 'IMPORT_TAX', labelId: 'Pajak Impor', labelEn: 'Import Tax', amountIdr: 1_871_000, isEstimate: true },
    { type: 'PROTECTION_FEE', labelId: 'JastipKita Protection', labelEn: 'JastipKita Protection', amountIdr: 83_489, isEstimate: false },
    { type: 'PLATFORM_FEE', labelId: 'Platform Fee', labelEn: 'Platform Fee', amountIdr: 278_296, isEstimate: false },
    { type: 'SERVICE_TAX', labelId: 'Pajak atas layanan', labelEn: 'Service Tax', amountIdr: 39_796, isEstimate: false },
    { type: 'PAYMENT_FEE', labelId: 'Biaya Pembayaran', labelEn: 'Payment Fee', amountIdr: 62_522, isEstimate: false },
    { type: 'DISCOUNT', labelId: 'Diskon promo', labelEn: 'Promo discount', amountIdr: -50_000, isEstimate: false },
    { type: 'REFERRAL_CREDIT', labelId: 'JastipKita Credit', labelEn: 'JastipKita Credit', amountIdr: -25_000, isEstimate: false },
    { type: 'TOTAL', labelId: 'Total Landed Cost', labelEn: 'Total Landed Cost', amountIdr: 8_931_623, isEstimate: true },
  ],
};

const render = (key: string, opts: { locale?: 'id' | 'en'; role?: 'BUYER' | 'TRAVELER'; vars?: Record<string, unknown>; tx?: TxView | undefined } = {}) =>
  renderNotification({
    key,
    locale: opts.locale ?? 'id',
    role: opts.role,
    recipientDisplayName: 'Rina Wulandari',
    tx: 'tx' in opts ? opts.tx : TX,
    vars: opts.vars ?? {},
    refs: { disputeId: '9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d' },
    webBaseUrl: 'https://jastipkita.id',
  });

describe('e-mail templates (snapshot)', () => {
  it('payment secured (buyer, id) — subject/text snapshot, accessible dark-mode-safe HTML with the §10 breakdown', () => {
    const r = render('transaction.payment_secured', { role: 'BUYER', vars: { txStatus: 'PAYMENT_SECURED' } });
    expect({ subject: r.email.subject, text: r.email.text }).toMatchSnapshot();
    const h = r.email.html;
    expect(h).toContain('<html lang="id"');
    expect(h).toContain('alt="JastipKita"');
    expect(h).toContain('src="https://jastipkita.id/brand/logo-email.png"');
    expect(h).toContain('<meta name="color-scheme" content="light dark">');
    expect(h).toContain('@media (prefers-color-scheme: dark)');
    expect(h).toContain('role="presentation"');
    expect(h).toContain('<th scope="col"');
    expect(h).toContain('#047857'); // emerald-700 banner (AA with white text)
    expect(h).toContain('href="https://jastipkita.id/app/transactions/5b3f6c2e-8a1d-4f7e-9c0b-2d4e6f8a1b3c"');
    expect(h).toContain('href="jastipkita://transactions/5b3f6c2e-8a1d-4f7e-9c0b-2d4e6f8a1b3c"');
    expect(h).toContain('/app/transactions/5b3f6c2e-8a1d-4f7e-9c0b-2d4e6f8a1b3c/receipt');
    expect(h).toContain('E-mail ini dikirim otomatis');
    expect(h).toContain('https://jastipkita.id/bantuan');
    expect(h).toContain('https://jastipkita.id/legal/privasi');
    // breakdown rows in display order, tabular figures
    const order = ['Harga Barang', 'Traveler Fee', 'Bea Masuk (estimasi)', 'Pajak Impor (estimasi)', 'JastipKita Protection', 'Platform Fee', 'Pajak atas layanan', 'Biaya Pembayaran', 'Diskon promo', 'JastipKita Credit', 'Total Landed Cost'];
    const idx = order.map((l) => h.indexOf(l));
    expect(idx.every((i) => i > 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    expect(h).toContain('Rp 8.931.623');
    expect(h).toContain('−Rp 50.000');
    expect(h).toContain("font-feature-settings:'tnum'");
  });

  it('price adjustment requested (en)', () => {
    const r = render('price.change_requested', {
      locale: 'en',
      role: 'BUYER',
      vars: { originalIdr: 5_565_927, actualIdr: 5_685_927, expiresAt: '2026-09-27T03:15:00Z' },
    });
    expect({ subject: r.email.subject, text: r.email.text }).toMatchSnapshot();
    expect(r.email.html).toContain('<html lang="en"');
    expect(r.push.body).toBe('Price changed Rp 5,565,927 → Rp 5,685,927. Respond before 27 Sep 2026, 10:15 WIB.');
  });

  it('PIN ready never contains a PIN, only an instruction to open the app', () => {
    const r = render('delivery.pin_ready', { role: 'BUYER' });
    expect({ subject: r.email.subject, text: r.email.text }).toMatchSnapshot();
    expect(r.body).toContain('PIN tidak pernah dikirim');
  });

  it('request accepted (traveler) shows DO NOT PURCHASE and only item + traveler fee', () => {
    const r = render('transaction.matched', { role: 'TRAVELER', vars: { txStatus: 'MATCHED' } });
    expect({ subject: r.email.subject, text: r.email.text }).toMatchSnapshot();
    expect(r.email.html).toContain('JANGAN BELI DULU / DO NOT PURCHASE');
    expect(r.email.html).toContain('Rincian untuk traveler');
    expect(r.email.html).not.toContain('Platform Fee');
    expect(r.email.html).toContain('Penitip'); // buyer public name row for the traveler
  });

  it('escapes user-controlled values', () => {
    const r = render('transaction.purchased', { tx: { ...TX, productName: '<script>alert(1)</script> & "x"' } });
    expect(r.email.html).not.toContain('<script>');
    expect(r.email.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;x&quot;');
  });

  it('every template renders in id and en, for both roles, without placeholders leaking', () => {
    for (const def of TEMPLATES) {
      for (const locale of ['id', 'en'] as const) {
        for (const role of ['BUYER', 'TRAVELER'] as const) {
          const r = render(def.key, {
            locale,
            role,
            vars: { amountIdr: 25_000, expiresAt: '2026-12-26T00:00:00Z', status: 'REJECTED', txStatus: 'COMPLETED', disputeNumber: 'DSP-260927-ABCDEF', type: 'DAMAGED_ITEM', resolution: 'REFUND_PARTIAL', resolutionAmountIdr: 100_000, targetLevel: 3, ticketNumber: 'TKT-260927-ABCDEF', route: 'Tokyo → Jakarta', productName: 'Tas', preview: 'Halo', senderName: 'Dimas P.' },
          });
          for (const s of [r.title, r.body, r.email.subject, r.email.text, r.email.html]) {
            expect(s.length).toBeGreaterThan(0);
            expect(s).not.toMatch(/undefined|NaN|\[object Object\]/);
          }
          expect(r.email.html).toContain(`lang="${locale}"`);
        }
      }
    }
  });
});

describe('lifecycle coverage', () => {
  let t: TestContext;
  beforeAll(async () => {
    t = await createTestContext();
  });
  afterAll(async () => {
    await t.close();
  });

  it('every lifecycle step from the brief maps (through the real outbox builders) to an e-mail template', async () => {
    const buyer = await t.createUser({ kycLevel: 2 });
    const traveler = await t.createUser({ kycLevel: 4, mode: 'TRAVELER' });
    const tx = await createTransaction(t, { buyerId: buyer.id, travelerId: traveler.id, to: 'PURCHASED' });
    const [d] = await t.adminSql<{ id: string }[]>`
      INSERT INTO disputes (transaction_id, opened_by, opened_by_role, type, description, evidence_due_at, sla_due_at)
      VALUES (${tx.id}, ${buyer.id}, 'BUYER', 'DAMAGED_ITEM', 'Layar retak saat diterima', now() + interval '3 days', now() + interval '8 days') RETURNING id`;
    const payloadFor = (e: (typeof EMAIL_LIFECYCLE)[number]): Record<string, unknown> => ({
      userId: buyer.id,
      transactionId: tx.id,
      buyerId: buyer.id,
      travelerId: traveler.id,
      requestId: tx.requestId,
      disputeId: d!.id,
      to: e.event === 'dispute.status_changed' ? 'UNDER_REVIEW' : e.status,
      from: e.status === 'PAYMENT_SECURED' ? 'AWAITING_PAYMENT' : 'X',
      status: 'APPROVED',
      amountIdr: 100_000,
      targetLevel: 3,
    });

    for (const e of EMAIL_LIFECYCLE) {
      expect(NOTIFIED_EVENT_TYPES, e.step).toContain(e.event);
      const def = getTemplate(e.template);
      expect(def.channels, e.step).toContain('EMAIL');
      const ev: OutboxEvent = { id: 1, eventId: crypto.randomUUID(), aggregateType: 'x', aggregateId: 'x', eventType: e.event, payload: payloadFor(e), createdAt: new Date(), attempts: 1 };
      const intents = await NOTIFICATION_BUILDERS[e.event]!(t.deps, ev);
      const match = intents.find((i) => i.template === e.template && (!e.role || i.role === e.role));
      expect(match, `${e.step} → ${e.template}`).toBeTruthy();
      for (const locale of ['id', 'en'] as const) {
        const r = renderNotification({
          key: e.template,
          locale,
          role: match!.role,
          recipientDisplayName: 'Rina',
          tx: e.event.startsWith('user.') || e.event.startsWith('kyc.') ? undefined : TX,
          vars: match!.vars ?? {},
          refs: match!.refs ?? {},
          webBaseUrl: 'https://jastipkita.id',
        });
        expect(r.email.subject.length, e.step).toBeGreaterThan(3);
        if (!e.event.startsWith('user.') && !e.event.startsWith('kyc.')) {
          expect(r.email.html, e.step).toContain(TX.number);
          expect(r.email.html, e.step).toContain('Nintendo Switch OLED');
        }
      }
    }
  });
});
