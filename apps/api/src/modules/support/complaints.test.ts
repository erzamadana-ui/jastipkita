import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../../env';
import { createTestContext, TEST_ENV_BASE, type TestContext, type TestUser } from '../../../test/helpers';
import { createTransaction } from '../notifications/testing/fixtures';
import { setConfig } from '../trips/fixtures';
import { ESCALATION, normalizeWhatsapp, publishedChannels } from './complaint-info';
import { defaultPriority } from './service';

const HOUR = 3600_000;

describe('consumer complaint channel (L12, Permendag 19/2026)', () => {
  let t: TestContext;
  let user: TestUser;
  let other: TestUser;

  beforeAll(async () => {
    t = await createTestContext();
    user = await t.createUser({ kycLevel: 2 });
    other = await t.createUser({ kycLevel: 2 });
  });
  afterAll(async () => {
    await t.close();
  });

  const slaHours = (ticket: { slaDueAt: string }) => Math.round((new Date(ticket.slaDueAt).getTime() - t.clock.now().getTime()) / HOUR);

  it('GET /v1/support/complaint-info is public, cacheable and answers null channels while none are announced', async () => {
    const res = await t.request('GET', '/v1/support/complaint-info');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');
    expect(res.headers.get('x-ratelimit-limit')).toBe('120');
    expect(res.body.channels).toEqual({
      inApp: { ticketCategory: 'COMPLAINT', endpoint: '/v1/support/tickets' },
      whatsapp: null,
      email: null,
      webUrl: 'http://web.test/pengaduan/',
    });
    expect(res.body.sla).toEqual({
      basis: 'FIRST_RESPONSE',
      complaintPriority: 'HIGH',
      complaintFirstResponseHours: 12,
      hoursByPriority: { URGENT: 4, HIGH: 12, NORMAL: 24, LOW: 72 },
      configKey: 'support.sla',
      isAssumption: true,
    });
    expect(res.body.escalation).toMatchObject({
      authority: 'Direktorat Jenderal Perlindungan Konsumen dan Tertib Niaga (Ditjen PKTN)',
      ministry: 'Kementerian Perdagangan Republik Indonesia',
      whatsapp: { number: '6285311111010', display: '0853-1111-1010', url: 'https://wa.me/6285311111010' },
      email: 'pengaduan.konsumen@kemendag.go.id',
      verification: { status: 'VERIFIED', accessedAt: '2026-10-04' },
    });
    expect(res.body.escalation.verification.sources.length).toBeGreaterThanOrEqual(2);
    for (const u of [res.body.escalation.website, ...res.body.escalation.verification.sources]) expect(u).toMatch(/^https:\/\//);
    expect(res.body.escalation.outOfCourt).toContain('BPSK');
    expect(res.body.disputeFlow.endpoint).toBe('/v1/transactions/{id}/disputes');
    expect(res.body.legalBasis).toEqual(expect.arrayContaining([expect.stringContaining('UU No. 8 Tahun 1999'), expect.stringContaining('Permendag No. 19 Tahun 2026')]));
  });

  it('files a COMPLAINT ticket: default priority HIGH, SLA from config support.sla, linked to my transaction', async () => {
    const tx = await createTransaction(t, { buyerId: user.id, travelerId: other.id, to: 'PAYMENT_SECURED' });
    const res = await t.request('POST', '/v1/support/tickets', {
      token: user.accessToken,
      body: { category: 'COMPLAINT', subject: 'Pengaduan: traveler tidak membalas', message: 'Sudah 3 hari traveler tidak membalas chat setelah saya bayar.', transactionId: tx.id },
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ category: 'COMPLAINT', priority: 'HIGH', status: 'OPEN', transactionId: tx.id });
    expect(res.body.number).toMatch(/^TKT-\d{6}-[0-9A-Z]{6}$/);
    expect(slaHours(res.body)).toBe(12);
    const [ev] = await t.adminSql<{ payload: Record<string, unknown> }[]>`
      SELECT payload FROM outbox_events WHERE event_type = 'support.ticket_updated' AND aggregate_id = ${res.body.id}`;
    expect(ev!.payload).toMatchObject({ action: 'CREATED', actorType: 'USER', priority: 'HIGH', category: 'COMPLAINT' });
    const list = await t.request('GET', '/v1/support/tickets?limit=10', { token: user.accessToken });
    expect(list.body.data.map((x: { category: string }) => x.category)).toContain('COMPLAINT');
  });

  it('honours an explicit user priority (LOW/NORMAL/HIGH) and refuses URGENT (agent-only)', async () => {
    let res = await t.request('POST', '/v1/support/tickets', {
      token: user.accessToken,
      body: { category: 'COMPLAINT', subject: 'Saran perbaikan', message: 'Tampilan rincian harga membingungkan.', priority: 'NORMAL' },
    });
    expect(res.status).toBe(201);
    expect(res.body.priority).toBe('NORMAL');
    expect(slaHours(res.body)).toBe(24);
    res = await t.request('POST', '/v1/support/tickets', { token: user.accessToken, body: { category: 'OTHER', subject: 'Pertanyaan', message: 'Halo tim', priority: 'LOW' } });
    expect(res.body).toMatchObject({ category: 'OTHER', priority: 'LOW' });
    expect(slaHours(res.body)).toBe(72);
    res = await t.request('POST', '/v1/support/tickets', { token: user.accessToken, body: { category: 'COMPLAINT', subject: 'Darurat', message: 'Tolong segera', priority: 'URGENT' } });
    expect(res.status).toBe(400);
    res = await t.request('POST', '/v1/support/tickets', { token: user.accessToken, body: { category: 'COMPLAINTS', subject: 'Typo', message: 'x' } });
    expect(res.status).toBe(400);
    expect((await t.request('POST', '/v1/support/tickets', { body: { category: 'COMPLAINT', subject: 'Anonim', message: 'x' } })).status).toBe(401);
  });

  it('follows a new ACTIVE support.sla version (maker-checker) for tickets and the published SLA', async () => {
    await setConfig(t, 'support.sla', { hoursByPriority: { URGENT: 2, HIGH: 6, NORMAL: 24, LOW: 48 } });
    const info = await t.request('GET', '/v1/support/complaint-info');
    expect(info.body.sla).toMatchObject({ complaintFirstResponseHours: 6, hoursByPriority: { URGENT: 2, HIGH: 6, NORMAL: 24, LOW: 48 } });
    const res = await t.request('POST', '/v1/support/tickets', {
      token: other.accessToken,
      body: { category: 'COMPLAINT', subject: 'Pengaduan biaya', message: 'Ada biaya yang tidak saya pahami di rincian.' },
    });
    expect(res.status).toBe(201);
    expect(slaHours(res.body)).toBe(6);
    const refund = await t.request('POST', '/v1/support/tickets', { token: other.accessToken, body: { category: 'REFUND', subject: 'Refund', message: 'Kapan refund saya masuk?' } });
    expect(refund.body.priority).toBe('HIGH');
    expect(slaHours(refund.body)).toBe(6);
  });

  it('rate-limits the public endpoint per IP like other public reads', async () => {
    const t2 = await createTestContext();
    try {
      let last = 200;
      for (let i = 0; i < 121; i++) last = (await t2.request('GET', '/v1/support/complaint-info', { headers: { 'x-forwarded-for': '203.0.113.9' } })).status;
      expect(last).toBe(429);
    } finally {
      await t2.close();
    }
  });
});

describe('complaint channels from env (SUPPORT_WHATSAPP / SUPPORT_EMAIL)', () => {
  it('publishes the configured WhatsApp (digits only) and e-mail', async () => {
    const t = await createTestContext({ env: { SUPPORT_WHATSAPP: '+62 811-7805-600', SUPPORT_EMAIL: 'cs@example.com', WEB_BASE_URL: 'https://example.com/jastipkita/' } });
    try {
      const res = await t.request('GET', '/v1/support/complaint-info');
      expect(res.status).toBe(200);
      expect(res.body.channels).toMatchObject({
        whatsapp: { number: '628117805600', url: 'https://wa.me/628117805600' },
        email: 'cs@example.com',
        webUrl: 'https://example.com/jastipkita/pengaduan/',
      });
    } finally {
      await t.close();
    }
  });

  it('rejects malformed values at boot and treats empty values as unset', () => {
    const base = { ...TEST_ENV_BASE, DATABASE_URL: 'postgres://x@localhost/x' };
    expect(() => loadEnv({ ...base, SUPPORT_EMAIL: 'not-an-email' })).toThrow(/SUPPORT_EMAIL/);
    expect(() => loadEnv({ ...base, SUPPORT_WHATSAPP: 'call us' })).toThrow(/SUPPORT_WHATSAPP/);
    const env = loadEnv({ ...base, SUPPORT_WHATSAPP: '', SUPPORT_EMAIL: '  ' });
    expect(publishedChannels(env)).toMatchObject({ whatsapp: null, email: null });
  });

  it('pure helpers', () => {
    expect(normalizeWhatsapp('0811 78')).toBeNull();
    expect(normalizeWhatsapp(undefined)).toBeNull();
    expect(normalizeWhatsapp('(+62) 811-7805-600')).toBe('628117805600');
    expect(defaultPriority('COMPLAINT')).toBe('HIGH');
    expect(defaultPriority('DISPUTE')).toBe('HIGH');
    expect(defaultPriority('ACCOUNT')).toBe('NORMAL');
    expect(ESCALATION.whatsapp.url).toBe(`https://wa.me/${ESCALATION.whatsapp.number}`);
  });
});
