import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext, type TestUser } from '../../../test/helpers';
import { addDevice, createTransaction, transition, type TxFixture } from '../notifications/testing/fixtures';

let t: TestContext;
let buyer: TestUser;
let traveler: TestUser;
let stranger: TestUser;
let tx: TxFixture;
let convId: string;

async function insertFile(ownerId: string, purpose = 'CHAT', mime = 'image/jpeg', scan = 'CLEAN') {
  const [f] = await t.adminSql<{ id: string }[]>`
    INSERT INTO files (owner_id, purpose, storage_provider, storage_key, mime, size_bytes, scan_status)
    VALUES (${ownerId}, ${purpose}, 'MOCK', ${`chat/${randomUUID()}`}, ${mime}, 1024, ${scan}) RETURNING id`;
  return f!.id;
}

beforeAll(async () => {
  t = await createTestContext();
  buyer = await t.createUser({ kycLevel: 2, displayName: 'Rina Wulandari' });
  traveler = await t.createUser({ kycLevel: 4, mode: 'TRAVELER', displayName: 'Dimas Pratama' });
  stranger = await t.createUser({ kycLevel: 2 });
  await addDevice(t, buyer.id, 'fcm-chat-buyer');
  tx = await createTransaction(t, { buyerId: buyer.id, travelerId: traveler.id });
});
afterAll(async () => {
  await t.close();
});

describe('conversations', () => {
  it('is created automatically (once) when the transaction reaches MATCHED, with a status message', async () => {
    let res = await t.request('GET', '/v1/conversations', { token: buyer.accessToken });
    expect(res.body.data).toHaveLength(0);
    await transition(t, tx.id, 'MATCHED', 'BUYER');
    await t.drain();
    res = await t.request('GET', '/v1/conversations', { token: buyer.accessToken });
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    const conv = res.body.data[0];
    convId = conv.id;
    expect(conv).toMatchObject({
      status: 'OPEN',
      myRole: 'BUYER',
      counterpart: { id: traveler.id, name: 'Dimas P.', role: 'TRAVELER' },
      transaction: { id: tx.id, number: tx.number, status: 'MATCHED', productName: 'Nintendo Switch OLED' },
    });
    expect(conv.lastMessage.type).toBe('STATUS');
    expect(conv.lastMessage.preview).toContain(tx.number);

    // replaying the MATCHED event creates neither a second conversation nor a second status message
    await t.adminSql`UPDATE outbox_events SET published_at = NULL, available_at = now() - interval '1 second'
                      WHERE aggregate_id = ${tx.id} AND event_type = 'transaction.status_changed'`;
    await t.drain();
    const convs = await t.adminSql`SELECT id FROM conversations WHERE transaction_id = ${tx.id}`;
    expect(convs).toHaveLength(1);
    const msgs = await t.adminSql`SELECT id FROM messages WHERE conversation_id = ${convId} AND type = 'STATUS'`;
    expect(msgs).toHaveLength(1);

    // traveler sees the same conversation from the other side
    res = await t.request('GET', '/v1/conversations', { token: traveler.accessToken });
    expect(res.body.data[0]).toMatchObject({ id: convId, myRole: 'TRAVELER', counterpart: { name: 'Rina W.', role: 'BUYER' } });
  });

  it('posts an Indonesian STATUS message on every later status change', async () => {
    await transition(t, tx.id, 'AWAITING_PAYMENT', 'BUYER');
    await t.adminSql`UPDATE quotes SET status = 'ACCEPTED', accepted_at = now() WHERE transaction_id = ${tx.id} AND status = 'ACTIVE'`;
    await transition(t, tx.id, 'PAYMENT_SECURED', 'SYSTEM');
    await t.drain();
    const res = await t.request('GET', `/v1/conversations/${convId}/messages`, { token: traveler.accessToken });
    const status = res.body.data.filter((m: { type: string }) => m.type === 'STATUS');
    expect(status.map((m: { meta: { status: string } }) => m.meta.status)).toEqual(['PAYMENT_SECURED', 'AWAITING_PAYMENT', 'MATCHED']);
    expect(status[0].body).toContain('jangan beli dulu');
    expect(status[0].senderId).toBeNull();
  });

  it('adopts a pre-match conversation for the same request & traveler', async () => {
    const b = await t.createUser({ kycLevel: 2 });
    const tx2 = await createTransaction(t, { buyerId: b.id, travelerId: traveler.id });
    const [pre] = await t.adminSql<{ id: string }[]>`
      INSERT INTO conversations (request_id, buyer_id, traveler_id) VALUES (${tx2.requestId}, ${b.id}, ${traveler.id}) RETURNING id`;
    await transition(t, tx2.id, 'MATCHED', 'BUYER');
    await t.drain();
    const rows = await t.adminSql<{ id: string }[]>`SELECT id FROM conversations WHERE transaction_id = ${tx2.id}`;
    expect(rows.map((r) => r.id)).toEqual([pre!.id]);
  });

  it('only participants can read or write', async () => {
    let res = await t.request('GET', `/v1/conversations/${convId}/messages`);
    expect(res.status).toBe(401);
    res = await t.request('GET', `/v1/conversations/${convId}/messages`, { token: stranger.accessToken });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('CONVERSATION_NOT_FOUND');
    res = await t.request('POST', `/v1/conversations/${convId}/messages`, { token: stranger.accessToken, body: { type: 'TEXT', body: 'halo' } });
    expect(res.status).toBe(404);
    res = await t.request('GET', '/v1/conversations', { token: stranger.accessToken });
    expect(res.body.data).toHaveLength(0);
  });
});

describe('messages', () => {
  it('sends text, notifies the recipient by push and tracks unread/read', async () => {
    const pushes = t.push.sent.length;
    let res = await t.request('POST', `/v1/conversations/${convId}/messages`, { token: traveler.accessToken, body: { type: 'TEXT', body: 'Halo kak, barangnya ready di Bic Camera.' } });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ type: 'TEXT', mine: true, senderId: traveler.id, moderation: { status: 'CLEAN', reasons: [] } });
    const messageId = res.body.id;
    const [ev] = await t.adminSql<{ payload: Record<string, unknown> }[]>`
      SELECT payload FROM outbox_events WHERE event_type = 'chat.message_created' AND payload->>'messageId' = ${messageId}`;
    expect(ev!.payload).toMatchObject({ conversationId: convId, senderId: traveler.id, recipientId: buyer.id, type: 'TEXT' });
    await t.drain();
    const push = t.push.sent.slice(pushes).find((p) => p.tokens.includes('fcm-chat-buyer') && p.data?.type === 'chat.message');
    expect(push).toMatchObject({ title: 'Dimas P.', body: 'Halo kak, barangnya ready di Bic Camera.', channelId: 'chat' });
    expect(push!.data!.conversationId).toBe(convId);
    // chat is not flooding the in-app inbox by default
    const [n] = await t.adminSql<{ in_app: boolean }[]>`SELECT in_app FROM notifications WHERE user_id = ${buyer.id} AND event_type = 'chat.message'`;
    expect(n!.in_app).toBe(false);

    res = await t.request('GET', '/v1/conversations', { token: buyer.accessToken });
    const conv = res.body.data.find((c: { id: string }) => c.id === convId);
    expect(conv.unreadCount).toBeGreaterThanOrEqual(1);
    expect(conv.lastMessage.preview).toBe('Halo kak, barangnya ready di Bic Camera.');

    res = await t.request('POST', `/v1/conversations/${convId}/read`, { token: buyer.accessToken });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ conversationId: convId, lastReadMessageId: messageId, unreadCount: 0 });
    res = await t.request('GET', '/v1/conversations', { token: buyer.accessToken });
    expect(res.body.data.find((c: { id: string }) => c.id === convId).unreadCount).toBe(0);

    res = await t.request('POST', `/v1/conversations/${convId}/read`, { token: buyer.accessToken, body: { messageId: randomUUID() } });
    expect(res.status).toBe(404);
  });

  it('flags off-platform payment attempts: delivered masked to both sides + safety tip; original kept for moderation', async () => {
    const res = await t.request('POST', `/v1/conversations/${convId}/messages`, {
      token: traveler.accessToken,
      body: { type: 'TEXT', body: 'Biar cepat transfer langsung aja ke BCA 1234567890 ya, atau WA 0812-3456-7890' },
    });
    expect(res.status).toBe(201);
    expect(res.body.moderation).toEqual({ status: 'FLAGGED', reasons: ['BANK_ACCOUNT', 'CONTACT_PHONE', 'OFF_PLATFORM_PAYMENT'] });
    expect(res.body.body).toBe('Biar cepat transfer langsung aja ke BCA [disembunyikan] ya, atau WA [disembunyikan]');

    const list = await t.request('GET', `/v1/conversations/${convId}/messages?limit=3`, { token: buyer.accessToken });
    const [tip, flagged] = list.body.data;
    expect(tip).toMatchObject({ type: 'SYSTEM', senderId: null, meta: { safetyTipFor: res.body.id } });
    expect(tip.body).toContain('jangan bayar');
    expect(flagged.id).toBe(res.body.id);
    expect(flagged.body).not.toContain('1234567890');
    expect(flagged.meta.maskedBody).toBeUndefined();

    const [row] = await t.adminSql<{ body: string; moderation_status: string; moderation_reason: string }[]>`SELECT body, moderation_status, moderation_reason FROM messages WHERE id = ${res.body.id}`;
    expect(row).toMatchObject({ moderation_status: 'FLAGGED', moderation_reason: 'BANK_ACCOUNT,CONTACT_PHONE,OFF_PLATFORM_PAYMENT' });
    expect(row!.body).toContain('1234567890');

    // push preview is the masked version too
    await t.drain();
    const push = t.push.sent.find((p) => p.data?.type === 'chat.message' && p.body.includes('[disembunyikan]'));
    expect(push).toBeTruthy();
  });

  it('rejects system types and empty text', async () => {
    let res = await t.request('POST', `/v1/conversations/${convId}/messages`, { token: buyer.accessToken, body: { type: 'SYSTEM', body: 'Pembayaran aman' } });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('MESSAGE_TYPE_SYSTEM_ONLY');
    res = await t.request('POST', `/v1/conversations/${convId}/messages`, { token: buyer.accessToken, body: { type: 'STATUS', body: 'x' } });
    expect(res.status).toBe(403);
    res = await t.request('POST', `/v1/conversations/${convId}/messages`, { token: buyer.accessToken, body: { type: 'TEXT', body: '   ' } });
    expect(res.status).toBe(400);
    res = await t.request('POST', `/v1/conversations/${convId}/messages`, { token: buyer.accessToken, body: { type: 'VIDEO' } });
    expect(res.status).toBe(400);
  });

  it('IMAGE requires the sender’s own clean CHAT files', async () => {
    const mine = await insertFile(buyer.id);
    const others = await insertFile(traveler.id);
    const wrongPurpose = await insertFile(buyer.id, 'EVIDENCE');
    const pending = await insertFile(buyer.id, 'CHAT', 'image/png', 'PENDING');
    let res = await t.request('POST', `/v1/conversations/${convId}/messages`, { token: buyer.accessToken, body: { type: 'IMAGE', fileIds: [mine], body: 'Warna ini ya' } });
    expect(res.status).toBe(201);
    expect(res.body.attachments).toEqual([{ fileId: mine, mime: 'image/jpeg' }]);
    res = await t.request('POST', `/v1/conversations/${convId}/messages`, { token: buyer.accessToken, body: { type: 'IMAGE', fileIds: [others] } });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('FILE_NOT_ALLOWED');
    res = await t.request('POST', `/v1/conversations/${convId}/messages`, { token: buyer.accessToken, body: { type: 'IMAGE', fileIds: [wrongPurpose] } });
    expect(res.body.error.code).toBe('FILE_PURPOSE_INVALID');
    res = await t.request('POST', `/v1/conversations/${convId}/messages`, { token: buyer.accessToken, body: { type: 'IMAGE', fileIds: [pending] } });
    expect(res.body.error.code).toBe('FILE_NOT_READY');
  });

  it('PRODUCT references the conversation’s request; RECEIPT is traveler-only and must belong to the transaction', async () => {
    let res = await t.request('POST', `/v1/conversations/${convId}/messages`, { token: buyer.accessToken, body: { type: 'PRODUCT', requestId: tx.requestId } });
    expect(res.status).toBe(201);
    expect(res.body.meta).toMatchObject({ requestId: tx.requestId, productName: 'Nintendo Switch OLED' });
    res = await t.request('POST', `/v1/conversations/${convId}/messages`, { token: buyer.accessToken, body: { type: 'PRODUCT', requestId: randomUUID() } });
    expect(res.status).toBe(422);
    res = await t.request('POST', `/v1/conversations/${convId}/messages`, { token: buyer.accessToken, body: { type: 'RECEIPT', purchaseProofId: randomUUID() } });
    expect(res.status).toBe(403);
    const receipt = await insertFile(traveler.id, 'RECEIPT', 'image/jpeg');
    const photo = await insertFile(traveler.id, 'PRODUCT_PHOTO', 'image/jpeg');
    const [proof] = await t.adminSql<{ id: string }[]>`
      INSERT INTO purchase_proofs (transaction_id, traveler_id, receipt_file_id, product_photo_file_ids, merchant_name, actual_price_minor, currency, purchased_at)
      VALUES (${tx.id}, ${traveler.id}, ${receipt}, ${t.adminSql.array([photo])}::uuid[], 'Bic Camera', 50000, 'JPY', now()) RETURNING id`;
    res = await t.request('POST', `/v1/conversations/${convId}/messages`, { token: traveler.accessToken, body: { type: 'RECEIPT', purchaseProofId: proof!.id } });
    expect(res.status).toBe(201);
    expect(res.body.meta).toEqual({ purchaseProofId: proof!.id, merchantName: 'Bic Camera' });
  });

  it('paginates messages with a cursor (newest first)', async () => {
    const p1 = await t.request('GET', `/v1/conversations/${convId}/messages?limit=2`, { token: buyer.accessToken });
    expect(p1.body.data).toHaveLength(2);
    expect(p1.body.nextCursor).toBeTruthy();
    const p2 = await t.request('GET', `/v1/conversations/${convId}/messages?limit=2&cursor=${encodeURIComponent(p1.body.nextCursor)}`, { token: buyer.accessToken });
    expect(p2.status, JSON.stringify(p2.body)).toBe(200);
    expect(p2.body.data).toHaveLength(2);
    const ids = [...p1.body.data, ...p2.body.data].map((m: { id: string }) => m.id);
    expect(new Set(ids).size).toBe(4);
    expect(new Date(p1.body.data[1].createdAt).getTime()).toBeGreaterThanOrEqual(new Date(p2.body.data[0].createdAt).getTime());
  });
});
