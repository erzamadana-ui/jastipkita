import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext, type TestUser } from '../../../test/helpers';
import { addDevice, createTransaction, shareDevice, type TxFixture } from '../notifications/testing/fixtures';

let t: TestContext;
let buyer: TestUser;
let traveler: TestUser;
let done: TxFixture;

beforeAll(async () => {
  t = await createTestContext();
  buyer = await t.createUser({ kycLevel: 2 });
  traveler = await t.createUser({ kycLevel: 4, mode: 'TRAVELER' });
  done = await createTransaction(t, { buyerId: buyer.id, travelerId: traveler.id, to: 'COMPLETED' });
});
afterAll(async () => {
  await t.close();
});

const rate = (u: TestUser, txId: string, body: Record<string, unknown>) => t.request('POST', `/v1/transactions/${txId}/ratings`, { token: u.accessToken, body });

describe('POST /v1/transactions/{id}/ratings', () => {
  it('is only possible after COMPLETED', async () => {
    const open = await createTransaction(t, { buyerId: buyer.id, travelerId: traveler.id, to: 'DELIVERED' });
    const res = await rate(buyer, open.id, { overall: 5 });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('TRANSACTION_NOT_COMPLETED');
  });

  it('lets each side rate once, with the direction derived from the role', async () => {
    let res = await rate(buyer, done.id, { overall: 5, communication: 5, accuracy: 4, timeliness: 5, comment: 'Mantap, barang sesuai!' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ direction: 'BUYER_TO_TRAVELER', rateeId: traveler.id, overall: 5, accuracy: 4, comment: 'Mantap, barang sesuai!', status: 'PUBLISHED' });
    const [ev] = await t.adminSql<{ payload: Record<string, unknown> }[]>`SELECT payload FROM outbox_events WHERE event_type = 'rating.created' AND aggregate_id = ${res.body.id}`;
    expect(ev!.payload).toMatchObject({ rateeId: traveler.id, direction: 'BUYER_TO_TRAVELER' });

    res = await rate(buyer, done.id, { overall: 1 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ALREADY_RATED');

    res = await rate(traveler, done.id, { overall: 4, accuracy: 3 });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('DIMENSION_NOT_APPLICABLE');
    res = await rate(traveler, done.id, { overall: 4, communication: 5, timeliness: 4 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ direction: 'TRAVELER_TO_BUYER', rateeId: buyer.id, accuracy: null, timeliness: 4 });
  });

  it('rejects strangers, invalid scores and closed windows', async () => {
    const stranger = await t.createUser();
    expect((await rate(stranger, done.id, { overall: 5 })).status).toBe(404);
    expect((await rate(buyer, done.id, { overall: 6 })).status).toBe(400);
    expect((await t.request('POST', `/v1/transactions/${done.id}/ratings`, { body: { overall: 5 } })).status).toBe(401);
    const old = await createTransaction(t, { buyerId: buyer.id, travelerId: traveler.id, to: 'COMPLETED' });
    await t.adminSql`UPDATE transactions SET completed_at = now() - interval '15 days' WHERE id = ${old.id}`;
    const res = await rate(buyer, old.id, { overall: 5 });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('RATING_WINDOW_CLOSED');
  });

  it('masks profanity and contact details in comments', async () => {
    const b = await t.createUser({ kycLevel: 2 });
    const tx = await createTransaction(t, { buyerId: b.id, travelerId: traveler.id, to: 'COMPLETED' });
    const res = await rate(b, tx.id, { overall: 2, comment: 'Traveler goblok, telat. Hubungi saya di 0812-9999-8888' });
    expect(res.status).toBe(201);
    expect(res.body.comment).toBe('Traveler g*****, telat. Hubungi saya di [disembunyikan]');
    const [row] = await t.adminSql<{ moderation_reason: string }[]>`SELECT moderation_reason FROM ratings WHERE id = ${res.body.id}`;
    expect(row!.moderation_reason).toBe('PROFANITY_MASKED,CONTACT_MASKED');
  });
});

describe('anti-abuse weighting & public summary', () => {
  it('down-weights linked accounts (0) and tiny-value outliers (0.25) and keeps a Bayesian summary', async () => {
    const trav = await t.createUser({ kycLevel: 4, mode: 'TRAVELER' });
    const devT = await addDevice(t, trav.id);
    const scores: [number, number][] = [
      [5, 1_000_000],
      [5, 1_000_000],
      [5, 1_000_000],
    ];
    for (const [s, v] of scores) {
      const b = await t.createUser({ kycLevel: 2 });
      const tx = await createTransaction(t, { buyerId: b.id, travelerId: trav.id, to: 'COMPLETED', itemIdr: v });
      expect((await rate(b, tx.id, { overall: s })).status).toBe(201);
    }
    // low-value transaction with an outlier score
    const small = await t.createUser({ kycLevel: 2 });
    const txSmall = await createTransaction(t, { buyerId: small.id, travelerId: trav.id, to: 'COMPLETED', itemIdr: 100_000 });
    const lowRes = await rate(small, txSmall.id, { overall: 1 });
    // colluding account on the traveler's device
    const friend = await t.createUser({ kycLevel: 2 });
    await shareDevice(t, devT, friend.id);
    const txF = await createTransaction(t, { buyerId: friend.id, travelerId: trav.id, to: 'COMPLETED' });
    const linkedRes = await rate(friend, txF.id, { overall: 5 });

    const weights = await t.adminSql<{ id: string; weight: string; moderation_reason: string | null }[]>`SELECT id, weight, moderation_reason FROM ratings WHERE ratee_id = ${trav.id}`;
    expect(Number(weights.find((w) => w.id === linkedRes.body.id)!.weight)).toBe(0);
    expect(weights.find((w) => w.id === linkedRes.body.id)!.moderation_reason).toBe('LINKED_ACCOUNT');
    expect(Number(weights.find((w) => w.id === lowRes.body.id)!.weight)).toBe(0.25);

    const res = await t.request('GET', `/v1/users/${trav.id}/rating-summary`);
    expect(res.status).toBe(200);
    expect(res.body.asTraveler.count).toBe(5);
    expect(res.body.asTraveler.average).toBe(4.2); // raw (5+5+5+1+5)/5
    // weighted: (15 + 0.25) / 3.25 = 4.69 ; Bayesian (4×5 + 15.25) / (5 + 3.25) = 4.27
    expect(res.body.asTraveler.weightedAverage).toBe(4.69);
    expect(res.body.asTraveler.bayesianScore).toBe(4.27);
    expect(res.body.asTraveler.effectiveCount).toBe(3.25);
    expect(res.body.asBuyer.count).toBe(0);

    expect((await t.request('GET', `/v1/users/${crypto.randomUUID()}/rating-summary`)).status).toBe(404);
  });
});
