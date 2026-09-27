import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext, type TestUser } from '../../../test/helpers';
import { createTransaction, transition } from '../notifications/testing/fixtures';
import { ConversationLookupSchema, ConversationSchema } from './schemas';

let t: TestContext;
let buyer: TestUser;
let traveler: TestUser;
let stranger: TestUser;

beforeAll(async () => {
  t = await createTestContext();
  buyer = await t.createUser({ kycLevel: 2, displayName: 'Rina Wulandari' });
  traveler = await t.createUser({ kycLevel: 4, mode: 'TRAVELER', displayName: 'Dimas Pratama' });
  stranger = await t.createUser({ kycLevel: 2 });
});
afterAll(async () => {
  await t.close();
});

describe('GET /v1/transactions/{id}/conversation & GET /v1/conversations/{id}', () => {
  it('creates the conversation lazily (once) for a MATCHED transaction; participants only', async () => {
    const tx = await createTransaction(t, { buyerId: buyer.id, travelerId: traveler.id });
    await transition(t, tx.id, 'MATCHED', 'BUYER'); // outbox NOT drained → no conversation yet
    expect(await t.adminSql`SELECT id FROM conversations WHERE transaction_id = ${tx.id}`).toHaveLength(0);

    const first = await t.request('GET', `/v1/transactions/${tx.id}/conversation`, { token: buyer.accessToken });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(ConversationLookupSchema.safeParse(first.body).success).toBe(true);
    expect(first.body).toMatchObject({
      transactionId: tx.id,
      created: true,
      conversation: { myRole: 'BUYER', status: 'OPEN', counterpart: { id: traveler.id, name: 'Dimas P.', role: 'TRAVELER' }, transaction: { id: tx.id } },
    });
    const again = await t.request('GET', `/v1/transactions/${tx.id}/conversation`, { token: traveler.accessToken });
    expect(again.body).toMatchObject({ conversationId: first.body.conversationId, created: false, conversation: { myRole: 'TRAVELER' } });
    // the MATCHED outbox handler later adopts the same conversation (no duplicate)
    await t.drain();
    expect(await t.adminSql`SELECT id FROM conversations WHERE transaction_id = ${tx.id}`).toHaveLength(1);
    expect((await t.request('GET', `/v1/transactions/${tx.id}`, { token: buyer.accessToken })).body.conversationId).toBe(first.body.conversationId);

    const one = await t.request('GET', `/v1/conversations/${first.body.conversationId}`, { token: traveler.accessToken });
    expect(one.status).toBe(200);
    expect(ConversationSchema.safeParse(one.body).success).toBe(true);
    expect(one.body).toMatchObject({ id: first.body.conversationId, myRole: 'TRAVELER', counterpart: { id: buyer.id, name: 'Rina W.' } });
    expect(one.body.lastMessage?.type).toBe('STATUS');

    // non-participants: 404 (no existence leak)
    expect((await t.request('GET', `/v1/conversations/${first.body.conversationId}`, { token: stranger.accessToken })).status).toBe(404);
    expect((await t.request('GET', `/v1/transactions/${tx.id}/conversation`, { token: stranger.accessToken })).status).toBe(404);
    expect((await t.request('GET', `/v1/conversations/${crypto.randomUUID()}`, { token: buyer.accessToken })).status).toBe(404);
    expect((await t.request('GET', `/v1/conversations/${first.body.conversationId}`)).status).toBe(401);
  });

  it('409 CONVERSATION_NOT_AVAILABLE before MATCHED', async () => {
    const tx = await createTransaction(t, { buyerId: buyer.id, travelerId: traveler.id }); // REQUEST_CREATED
    const res = await t.request('GET', `/v1/transactions/${tx.id}/conversation`, { token: buyer.accessToken });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONVERSATION_NOT_AVAILABLE');
    expect(await t.adminSql`SELECT id FROM conversations WHERE transaction_id = ${tx.id}`).toHaveLength(0);
  });
});
