import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext, type TestUser } from '../../../test/helpers';
import { retryDeliveryJob } from './dispatcher';
import { addDevice, advance, createTransaction, transition } from './testing/fixtures';

let t: TestContext;
let buyer: TestUser;
let traveler: TestUser;

beforeAll(async () => {
  t = await createTestContext();
  buyer = await t.createUser({ kycLevel: 2, displayName: 'Rina Wulandari' });
  traveler = await t.createUser({ kycLevel: 4, mode: 'TRAVELER', displayName: 'Dimas Pratama' });
  await addDevice(t, buyer.id, 'fcm-buyer-1');
  await addDevice(t, traveler.id, 'fcm-traveler-1');
});
afterAll(async () => {
  await t.close();
});

async function notificationsOf(userId: string, type?: string) {
  return t.adminSql<{ id: string; event_type: string; in_app: boolean; outbox_event_id: string; title: string }[]>`
    SELECT id, event_type, in_app, outbox_event_id, title FROM notifications
     WHERE user_id = ${userId} ${type ? t.adminSql`AND event_type = ${type}` : t.adminSql``} ORDER BY created_at`;
}

async function deliveriesOf(notificationId: string) {
  return t.adminSql<{ channel: string; status: string; skip_reason: string | null; provider_env: string | null }[]>`
    SELECT channel, status, skip_reason, provider_env FROM notification_deliveries WHERE notification_id = ${notificationId} ORDER BY channel`;
}

describe('outbox → notifications', () => {
  it('transaction.status_changed → PAYMENT_SECURED sends in-app + push + e-mail with the price breakdown to the buyer', async () => {
    const tx = await createTransaction(t, { buyerId: buyer.id, travelerId: traveler.id, to: 'AWAITING_PAYMENT' });
    await t.drain();
    const mailsBefore = t.email.outbox.length;
    const pushBefore = t.push.sent.length;
    await transition(t, tx.id, 'PAYMENT_SECURED', 'SYSTEM');
    await t.drain();

    const [n] = await notificationsOf(buyer.id, 'transaction.payment_secured');
    expect(n).toBeTruthy();
    expect(n!.in_app).toBe(true);
    const d = await deliveriesOf(n!.id);
    expect(d.map((x) => [x.channel, x.status])).toEqual([
      ['EMAIL', 'SENT'],
      ['PUSH', 'SENT'],
    ]);
    expect(d[0]!.provider_env).toBe('TEST');

    const mails = t.email.outbox.slice(mailsBefore).filter((m) => m.to === buyer.email);
    expect(mails).toHaveLength(1);
    const mail = mails[0]!;
    expect(mail.subject).toBe(`Pembayaran aman untuk ${tx.number}`);
    expect(mail.idempotencyKey).toMatch(/^notif-/);
    // breakdown table (§10 order) with the TOTAL and estimate marker
    expect(mail.html).toContain('Rincian harga');
    expect(mail.html).toContain('Harga Barang');
    expect(mail.html).toContain('Bea Masuk (estimasi)');
    expect(mail.html).toContain(`Rp ${tx.totalIdr.toLocaleString('de-DE')}`);
    expect(mail.html).toContain(`http://web.test/app/transactions/${tx.id}`);
    expect(mail.html).toContain(`jastipkita://transactions/${tx.id}`);
    expect(mail.html).toContain('http://web.test/brand/logo-email.png');
    expect(mail.html).toContain('Dimas P.'); // traveler public name, never the full name
    expect(mail.html).not.toContain('Pratama');
    expect(mail.text).toContain('Total Landed Cost');

    const push = t.push.sent.slice(pushBefore).find((p) => p.tokens.includes('fcm-buyer-1'));
    expect(push?.title).toBe('Pembayaran aman');
    expect(push?.data).toMatchObject({ type: 'transaction.payment_secured', transactionId: tx.id, deepLink: `jastipkita://transactions/${tx.id}` });
    expect(push?.channelId).toBe('payments');

    // traveler: DO NOT PURCHASE copy, breakdown limited to item + traveler fee
    const [tn] = await notificationsOf(traveler.id, 'transaction.payment_secured');
    expect(tn!.title).toBe('Dana penitip sudah aman');
    const tmail = t.email.outbox.slice(mailsBefore).find((m) => m.to === traveler.email)!;
    expect(tmail.html).toContain('JANGAN BELI DULU');
    expect(tmail.html).toContain('Rincian untuk traveler');
    expect(tmail.html).not.toContain('Platform Fee');
  });

  it('duplicate delivery of the same outbox event does not duplicate notifications, pushes or e-mails', async () => {
    const tx = await createTransaction(t, { buyerId: buyer.id, travelerId: traveler.id, to: 'PURCHASE_APPROVED' });
    await t.drain();
    await transition(t, tx.id, 'PURCHASED', 'TRAVELER');
    await t.drain();
    const count = async () => (await notificationsOf(buyer.id, 'transaction.purchased')).length;
    expect(await count()).toBe(1);
    const mails = t.email.outbox.length;
    const pushes = t.push.sent.length;
    // at-least-once: the relay publishes the same event again
    await t.adminSql`UPDATE outbox_events SET published_at = NULL, available_at = now() - interval '1 second'
                      WHERE aggregate_id = ${tx.id} AND event_type = 'transaction.status_changed' AND payload->>'to' = 'PURCHASED'`;
    const r = await t.drain();
    expect(r.outboxProcessed).toBeGreaterThanOrEqual(1);
    expect(await count()).toBe(1);
    expect(t.email.outbox.length).toBe(mails);
    expect(t.push.sent.length).toBe(pushes);
  });

  it('respects a disabled non-critical channel but always delivers critical ones', async () => {
    const b2 = await t.createUser({ kycLevel: 2 });
    await addDevice(t, b2.id, 'fcm-b2');
    let res = await t.request('PUT', '/v1/notifications/preferences', {
      token: b2.accessToken,
      body: {
        preferences: [
          { group: 'TRANSACTION', channel: 'EMAIL', enabled: false },
          { group: 'TRANSACTION', channel: 'PUSH', enabled: false },
          { group: 'PAYMENT', channel: 'PUSH', enabled: false },
        ],
      },
    });
    expect(res.status).toBe(200);
    const tx = await createTransaction(t, { buyerId: b2.id, travelerId: traveler.id, to: 'PURCHASE_APPROVED' });
    await t.drain();
    await transition(t, tx.id, 'PURCHASED', 'TRAVELER');
    await t.drain();
    const [n] = await notificationsOf(b2.id, 'transaction.purchased');
    expect(n!.in_app).toBe(true); // IN_APP is locked for TRANSACTION
    expect((await deliveriesOf(n!.id)).map((d) => [d.channel, d.status, d.skip_reason])).toEqual([
      ['EMAIL', 'SKIPPED', 'PREFERENCE_DISABLED'],
      ['PUSH', 'SKIPPED', 'PREFERENCE_DISABLED'],
    ]);

    // price change request is critical: PUSH + EMAIL even though PAYMENT push is off
    await t.adminSql`SELECT jk_outbox('price_confirmation', ${tx.id}, 'price_confirmation.requested',
      ${t.adminSql.json({ transactionId: tx.id, buyerId: b2.id, travelerId: traveler.id, originalIdr: 1_000_000, actualIdr: 1_150_000, expiresAt: new Date(Date.now() + 900_000).toISOString() } as never)}::jsonb)`;
    await t.drain();
    const [pc] = await notificationsOf(b2.id, 'price.change_requested');
    expect((await deliveriesOf(pc!.id)).map((d) => [d.channel, d.status])).toEqual([
      ['EMAIL', 'SENT'],
      ['PUSH', 'SENT'],
    ]);
    const mail = t.email.outbox.find((m) => m.to === b2.email && m.subject.includes('perubahan harga'))!;
    expect(mail.html).toContain('Rp 1.150.000');
    expect(mail.html).toContain('dikembalikan penuh');

    // locked channels cannot be disabled
    res = await t.request('PUT', '/v1/notifications/preferences', { token: b2.accessToken, body: { preferences: [{ group: 'PAYMENT', channel: 'EMAIL', enabled: false }] } });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('PREFERENCE_LOCKED');
  });

  it('sends to users.transaction_email when set and cleans invalid push tokens', async () => {
    const b3 = await t.createUser({ kycLevel: 2 });
    await t.adminSql`UPDATE users SET transaction_email = 'finance@toko-rina.example' WHERE id = ${b3.id}`;
    const dev = await addDevice(t, b3.id, 'invalid-token-b3');
    const tx = await createTransaction(t, { buyerId: b3.id, travelerId: traveler.id, to: 'TRAVELING' });
    await t.drain();
    expect(t.email.outbox.some((m) => m.to === 'finance@toko-rina.example' && m.subject.includes(tx.number))).toBe(true);
    expect(t.email.outbox.some((m) => m.to === b3.email)).toBe(false);
    const [d] = await t.adminSql<{ push_token: string | null }[]>`SELECT push_token FROM devices WHERE id = ${dev}`;
    expect(d!.push_token).toBeNull();
    // first push found only the invalid token → removed; later ones have no device left
    const [first] = await notificationsOf(b3.id, 'transaction.matched');
    expect((await deliveriesOf(first!.id)).find((x) => x.channel === 'PUSH')).toMatchObject({ status: 'SKIPPED', skip_reason: 'NO_VALID_DEVICE' });
    const [later] = await notificationsOf(b3.id, 'transaction.traveling');
    expect((await deliveriesOf(later!.id)).find((x) => x.channel === 'PUSH')).toMatchObject({ status: 'SKIPPED', skip_reason: 'NO_DEVICE' });
  });

  it('a provider failure marks the delivery FAILED and queues a retry that later succeeds', async () => {
    const b4 = await t.createUser({ kycLevel: 2 });
    const tx = await createTransaction(t, { buyerId: b4.id, travelerId: traveler.id, to: 'PURCHASED' });
    await t.drain();
    const original = t.email.send.bind(t.email);
    t.email.send = async () => {
      throw new Error('Resend 503');
    };
    try {
      await transition(t, tx.id, 'TRAVELING', 'TRAVELER');
      const r = await t.drain();
      expect(r.outboxFailed).toBe(0); // provider outages never block the outbox
    } finally {
      t.email.send = original;
    }
    const [n] = await notificationsOf(b4.id, 'transaction.traveling');
    const [del] = await t.adminSql<{ id: string; status: string; attempts: number }[]>`
      SELECT id, status, attempts FROM notification_deliveries WHERE notification_id = ${n!.id} AND channel = 'EMAIL'`;
    expect(del).toMatchObject({ status: 'FAILED', attempts: 1 });
    const jobs = await t.adminSql`SELECT 1 FROM jobs WHERE queue = 'engagement.notifications' AND dedupe_key = ${`delivery:${del!.id}`} AND status = 'QUEUED'`;
    expect(jobs).toHaveLength(1);
    expect(await retryDeliveryJob(t.deps, { deliveryId: del!.id })).toEqual({ outcome: 'SENT' });
    expect(t.email.outbox.some((m) => m.to === b4.email && m.subject.includes('dalam perjalanan'))).toBe(true);
  });

  it('never includes the handover PIN — delivery.pin_ready tells the buyer to open the app', async () => {
    const tx = await createTransaction(t, { buyerId: buyer.id, travelerId: traveler.id, to: 'READY_FOR_HANDOVER' });
    await t.drain();
    await t.adminSql`SELECT jk_outbox('transaction', ${tx.id}, 'delivery.pin_ready', ${t.adminSql.json({ transactionId: tx.id, buyerId: buyer.id } as never)}::jsonb)`;
    await t.drain();
    const mail = t.email.outbox.find((m) => m.to === buyer.email && m.subject.startsWith('PIN serah terima'))!;
    expect(mail.text).toContain('buka aplikasi');
    // no standalone 6-digit code anywhere (transaction number & ids removed first)
    const scrubbed = mail.text.replaceAll(tx.number, '').replaceAll(tx.id, '');
    expect(scrubbed).not.toMatch(/(?<![\d.])\d{6}(?![\d.])/);
    expect(mail.html).toContain('Jangan berikan PIN sebelum barang sesuai');
  });
});

describe('notification endpoints', () => {
  it('lists, counts, marks read and hides other users’ notifications', async () => {
    let res = await t.request('GET', '/v1/notifications');
    expect(res.status).toBe(401);

    res = await t.request('GET', '/v1/notifications?limit=2', { token: buyer.accessToken });
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.nextCursor).toBeTruthy();
    const first = res.body.data[0];
    expect(first).toMatchObject({ readAt: null });
    expect(first.data.deepLink).toMatch(/^jastipkita:\/\//);

    const page2 = await t.request('GET', `/v1/notifications?limit=2&cursor=${encodeURIComponent(res.body.nextCursor)}`, { token: buyer.accessToken });
    expect(page2.status).toBe(200);
    expect(page2.body.data[0].id).not.toBe(first.id);

    const before = (await t.request('GET', '/v1/notifications/unread-count', { token: buyer.accessToken })).body.count;
    expect(before).toBeGreaterThan(1);
    res = await t.request('POST', `/v1/notifications/${first.id}/read`, { token: buyer.accessToken });
    expect(res.status).toBe(200);
    expect(res.body.readAt).toBeTruthy();
    expect((await t.request('GET', '/v1/notifications/unread-count', { token: buyer.accessToken })).body.count).toBe(before - 1);

    // someone else's notification → 404
    res = await t.request('POST', `/v1/notifications/${first.id}/read`, { token: traveler.accessToken });
    expect(res.status).toBe(404);
    res = await t.request('POST', '/v1/notifications/not-a-uuid/read', { token: buyer.accessToken });
    expect(res.status).toBe(400);

    res = await t.request('GET', '/v1/notifications?unreadOnly=true&limit=100', { token: buyer.accessToken });
    expect(res.body.data.every((n: { readAt: string | null }) => n.readAt === null)).toBe(true);

    res = await t.request('POST', '/v1/notifications/read-all', { token: buyer.accessToken });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(before - 1);
    expect((await t.request('GET', '/v1/notifications/unread-count', { token: buyer.accessToken })).body.count).toBe(0);
  });

  it('returns the preference matrix with locked critical channels', async () => {
    const u = await t.createUser();
    const res = await t.request('GET', '/v1/notifications/preferences', { token: u.accessToken });
    expect(res.status).toBe(200);
    const payment = res.body.groups.find((g: { group: string }) => g.group === 'PAYMENT');
    expect(payment.channels).toEqual([
      { channel: 'PUSH', enabled: true, locked: false },
      { channel: 'EMAIL', enabled: true, locked: true },
      { channel: 'IN_APP', enabled: true, locked: true },
    ]);
    const chat = res.body.groups.find((g: { group: string }) => g.group === 'CHAT');
    expect(chat.channels.find((c: { channel: string }) => c.channel === 'IN_APP').enabled).toBe(false);
    const bad = await t.request('PUT', '/v1/notifications/preferences', { token: u.accessToken, body: { preferences: [{ group: 'NOPE', channel: 'PUSH', enabled: true }] } });
    expect(bad.status).toBe(400);
    const ok = await t.request('PUT', '/v1/notifications/preferences', { token: u.accessToken, body: { preferences: [{ group: 'PROMOTION', channel: 'EMAIL', enabled: true }] } });
    expect(ok.body.groups.find((g: { group: string }) => g.group === 'PROMOTION').channels.find((c: { channel: string }) => c.channel === 'EMAIL').enabled).toBe(true);
  });

  it('delivers to COMPLETED transactions for both sides (smoke of the full path)', async () => {
    const tx = await createTransaction(t, { buyerId: buyer.id, travelerId: traveler.id, to: 'BUYER_CONFIRMED' });
    await t.drain();
    await advance(t, tx.id, 'COMPLETED');
    await t.drain();
    expect((await notificationsOf(buyer.id, 'transaction.completed')).length).toBeGreaterThanOrEqual(1);
    expect((await notificationsOf(traveler.id, 'transaction.completed')).length).toBeGreaterThanOrEqual(1);
  });
});
