import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext, type TestUser } from '../../../test/helpers';
import { createTransaction } from '../notifications/testing/fixtures';

let t: TestContext;
let user: TestUser;
let other: TestUser;

beforeAll(async () => {
  t = await createTestContext();
  user = await t.createUser({ kycLevel: 2 });
  other = await t.createUser({ kycLevel: 2 });
  await t.adminSql`
    INSERT INTO faq_articles (slug, locale, category, question, answer_md, tags, sort_order, status, published_at) VALUES
      ('cara-refund', 'id', 'PAYMENT', 'Bagaimana cara refund?', 'Refund diproses otomatis ke metode pembayaran asal.', '{refund,uang}', 50, 'PUBLISHED', now()),
      ('cara-refund', 'en', 'PAYMENT', 'How do refunds work?', 'Refunds go back to the original payment method automatically.', '{refund}', 50, 'PUBLISHED', now()),
      ('draft-artikel', 'id', 'GENERAL', 'Artikel draft', 'Belum terbit', '{}', 99, 'DRAFT', NULL)
    ON CONFLICT DO NOTHING`;
});
afterAll(async () => {
  await t.close();
});

describe('FAQ', () => {
  it('lists published articles with locale fallback and filters by category', async () => {
    let res = await t.request('GET', '/v1/support/faq');
    expect(res.status).toBe(200);
    const slugs = res.body.data.map((a: { slug: string }) => a.slug);
    expect(slugs).toEqual(expect.arrayContaining(['apa-itu-jastipkita', 'estimasi-bea-masuk', 'cara-refund']));
    expect(slugs).not.toContain('draft-artikel');
    res = await t.request('GET', '/v1/support/faq?locale=en');
    const refund = res.body.data.find((a: { slug: string }) => a.slug === 'cara-refund');
    expect(refund).toMatchObject({ locale: 'en', question: 'How do refunds work?' });
    expect(res.body.data.find((a: { slug: string }) => a.slug === 'apa-itu-safepay').locale).toBe('id'); // no en translation → id
    res = await t.request('GET', '/v1/support/faq?category=CUSTOMS');
    expect(res.body.data.every((a: { category: string }) => a.category === 'CUSTOMS')).toBe(true);
  });

  it('searches with pg_trgm (typo tolerant) and ranks the best match first', async () => {
    let res = await t.request('GET', '/v1/support/faq?q=bea%20masuk');
    expect(res.status).toBe(200);
    expect(res.body.data[0].slug).toBe('estimasi-bea-masuk');
    expect(res.body.data[0].score).toBeGreaterThan(0);
    res = await t.request('GET', '/v1/support/faq?q=safepey');
    expect(res.body.data.map((a: { slug: string }) => a.slug)).toContain('apa-itu-safepay');
    res = await t.request('GET', '/v1/support/faq?q=zzzzqqq');
    expect(res.body.data).toHaveLength(0);
    expect((await t.request('GET', '/v1/support/faq?q=a')).status).toBe(400);
  });

  it('returns an article by slug (Markdown) with fallback and 404s', async () => {
    let res = await t.request('GET', '/v1/support/faq/apa-itu-safepay?locale=en');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ slug: 'apa-itu-safepay', locale: 'id' });
    expect(res.body.answerMd).toContain('SafePay');
    res = await t.request('GET', '/v1/support/faq/draft-artikel');
    expect(res.status).toBe(404);
    res = await t.request('GET', '/v1/support/faq/Bad_Slug');
    expect(res.status).toBe(400);
  });
});

describe('tickets', () => {
  it('creates a TKT ticket linked to my transaction with SLA by priority and lists/reads it', async () => {
    const tx = await createTransaction(t, { buyerId: user.id, travelerId: other.id, to: 'PAYMENT_SECURED' });
    let res = await t.request('POST', '/v1/support/tickets', {
      token: user.accessToken,
      body: { category: 'PAYMENT', subject: 'Pembayaran sudah terpotong dua kali', message: 'Saldo e-wallet terpotong dua kali untuk transaksi ini.', transactionId: tx.id },
    });
    expect(res.status).toBe(201);
    const ticket = res.body;
    expect(ticket.number).toMatch(/^TKT-\d{6}-[0-9A-Z]{6}$/);
    expect(ticket).toMatchObject({ status: 'OPEN', priority: 'HIGH', transactionId: tx.id, category: 'PAYMENT' });
    expect(Math.round((new Date(ticket.slaDueAt).getTime() - t.clock.now().getTime()) / 3600_000)).toBe(12);
    expect(ticket.messages).toHaveLength(1);
    expect(ticket.messages[0]).toMatchObject({ authorType: 'USER', mine: true });
    const [ev] = await t.adminSql<{ payload: Record<string, unknown> }[]>`SELECT payload FROM outbox_events WHERE event_type = 'support.ticket_updated' AND aggregate_id = ${ticket.id}`;
    expect(ev!.payload).toMatchObject({ ticketId: ticket.id, userId: user.id, status: 'OPEN', actorType: 'USER' });

    res = await t.request('POST', '/v1/support/tickets', { token: user.accessToken, body: { category: 'ACCOUNT', subject: 'Ganti email', message: 'Bagaimana cara ganti email?' } });
    expect(res.body.priority).toBe('NORMAL');

    res = await t.request('GET', '/v1/support/tickets?limit=1', { token: user.accessToken });
    expect(res.body.data).toHaveLength(1);
    expect(res.body.nextCursor).toBeTruthy();
    res = await t.request('GET', '/v1/support/tickets?status=OPEN&limit=10', { token: user.accessToken });
    expect(res.body.data).toHaveLength(2);
    expect((await t.request('GET', `/v1/support/tickets/${ticket.id}`, { token: other.accessToken })).status).toBe(404);
    expect((await t.request('GET', `/v1/support/tickets/${ticket.id}`)).status).toBe(401);
  });

  it('rejects linking someone else’s transaction', async () => {
    const tx = await createTransaction(t, { buyerId: other.id, travelerId: user.id });
    const stranger = await t.createUser();
    const res = await t.request('POST', '/v1/support/tickets', { token: stranger.accessToken, body: { category: 'TRANSACTION', subject: 'Cek status', message: 'Halo', transactionId: tx.id } });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('TRANSACTION_NOT_LINKABLE');
  });

  it('user replies re-open waiting tickets; closed tickets refuse replies; agent updates notify the user', async () => {
    const created = await t.request('POST', '/v1/support/tickets', { token: user.accessToken, body: { category: 'OTHER', subject: 'Pertanyaan umum', message: 'Apakah bisa titip parfum?' } });
    const id = created.body.id;
    // agent answers (admin group) and waits for the user
    await t.adminSql`INSERT INTO ticket_messages (ticket_id, author_type, body) VALUES (${id}, 'AGENT', 'Bisa, dengan batas 100 ml per botol.')`;
    await t.adminSql`INSERT INTO ticket_messages (ticket_id, author_type, body, internal_note) VALUES (${id}, 'AGENT', 'catatan internal', true)`;
    await t.adminSql`UPDATE support_tickets SET status = 'PENDING_USER', first_response_at = now() WHERE id = ${id}`;
    await t.adminSql`SELECT jk_outbox('support_ticket', ${id}, 'support.ticket_updated', ${t.adminSql.json({ ticketId: id, userId: user.id, status: 'PENDING_USER' } as never)}::jsonb)`;
    await t.drain();
    const n = await t.adminSql<{ title: string }[]>`SELECT title FROM notifications WHERE user_id = ${user.id} AND event_type = 'support.ticket_updated'`;
    expect(n).toHaveLength(1); // the user's own actions do not notify them
    expect(n[0]!.title).toContain(created.body.number);

    let res = await t.request('POST', `/v1/support/tickets/${id}/messages`, { token: user.accessToken, body: { body: 'Terima kasih! Kalau 2 botol boleh?' } });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('OPEN');
    expect(res.body.messages.map((m: { authorType: string }) => m.authorType)).toEqual(['USER', 'AGENT', 'USER']);
    expect(res.body.messages.some((m: { body: string }) => m.body === 'catatan internal')).toBe(false);

    await t.adminSql`UPDATE support_tickets SET status = 'CLOSED', closed_at = now() WHERE id = ${id}`;
    res = await t.request('POST', `/v1/support/tickets/${id}/messages`, { token: user.accessToken, body: { body: 'Halo lagi' } });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('TICKET_CLOSED');
  });
});
