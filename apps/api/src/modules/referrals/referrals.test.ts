import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext, type TestUser } from '../../../test/helpers';
import { addDevice, advance, createTransaction, shareDevice } from '../notifications/testing/fixtures';
import { runReferralGuardrail } from './guardrail';

let t: TestContext;
let referrer: TestUser;
let traveler: TestUser;

beforeAll(async () => {
  t = await createTestContext();
  referrer = await t.createUser({ kycLevel: 3, displayName: 'Ayu Lestari' });
  traveler = await t.createUser({ kycLevel: 4, mode: 'TRAVELER' });
});
afterAll(async () => {
  await t.close();
});

const codeOf = async (u: TestUser) => (await t.adminSql<{ referral_code: string }[]>`SELECT referral_code FROM users WHERE id = ${u.id}`)[0]!.referral_code;
const apply = (u: TestUser, code: string, program?: string) => t.request('POST', '/v1/referrals/apply', { token: u.accessToken, body: { code, ...(program ? { program } : {}) } });
const referralOf = async (refereeId: string) =>
  (await t.adminSql<{ id: string; status: string; referrer_reward_idr: number; referee_reward_idr: number; fraud_reasons: { code: string }[] }[]>`
    SELECT id, status, referrer_reward_idr, referee_reward_idr, fraud_reasons FROM referrals WHERE referee_id = ${refereeId}`)[0]!;
const creditsOf = (userId: string) => t.adminSql<{ amount_idr: number; reason: string; expires_at: Date | null }[]>`SELECT amount_idr, reason, expires_at FROM credit_entries WHERE user_id = ${userId} ORDER BY id`;

async function payoutAccount(userId: string, hash: Buffer) {
  await t.adminSql`
    INSERT INTO payout_accounts (user_id, bank_code, account_number_enc, account_number_hash, account_mask, holder_name, enc_key_id)
    VALUES (${userId}, 'BCA', ${randomBytes(16)}, ${hash}, '****7890', 'TEST', 'k1')`;
}

describe('GET /v1/referrals/me & POST /v1/referrals/apply', () => {
  it('returns my code, share link and program terms from config', async () => {
    const res = await t.request('GET', '/v1/referrals/me', { token: referrer.accessToken });
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(await codeOf(referrer));
    expect(res.body.shareLink).toBe(`http://web.test/r/${res.body.code}`);
    expect(res.body.programs.buyer).toMatchObject({ referrerCreditIdr: 25000, refereeCreditIdr: 25000, minFirstTransactionIdr: 500000, monthlyCapIdr: 250000, creditExpiryDays: 90, withdrawable: false });
    expect(res.body.programs.traveler).toMatchObject({ referrerCreditIdr: 50000, requiredCompletedTransactions: 2 });
    expect(res.body.referredBy).toBeNull();
  });

  it('rejects self-referral, unknown codes, late or non-new users; applies once', async () => {
    const referee = await t.createUser({ kycLevel: 2 });
    let res = await apply(referrer, await codeOf(referrer));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('SELF_REFERRAL');
    res = await apply(referee, 'ZZZZ9999');
    expect(res.body.error.code).toBe('REFERRAL_CODE_INVALID');
    res = await apply(referee, (await codeOf(referrer)).toLowerCase());
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ program: 'BUYER', status: 'PENDING' });
    const [u] = await t.adminSql<{ referred_by: string }[]>`SELECT referred_by FROM users WHERE id = ${referee.id}`;
    expect(u!.referred_by).toBe(referrer.id);
    res = await apply(referee, await codeOf(referrer));
    expect(res.status).toBe(409);
    expect((await t.request('GET', '/v1/referrals/me', { token: referee.accessToken })).body.referredBy).toMatchObject({ program: 'BUYER', status: 'PENDING' });

    const late = await t.createUser({ kycLevel: 2 });
    await t.adminSql`UPDATE users SET created_at = now() - interval '8 days' WHERE id = ${late.id}`;
    res = await apply(late, await codeOf(referrer));
    expect(res.body.error.code).toBe('REFERRAL_WINDOW_CLOSED');

    const paid = await t.createUser({ kycLevel: 2 });
    await createTransaction(t, { buyerId: paid.id, travelerId: traveler.id, to: 'PAYMENT_SECURED' });
    res = await apply(paid, await codeOf(referrer));
    expect(res.body.error.code).toBe('REFERRAL_NOT_NEW_USER');
  });
});

describe('reward on COMPLETED', () => {
  it('happy path: first transaction ≥ Rp500.000 completes → Rp25.000 credit each, 90-day expiry, notifications', async () => {
    const referee = await t.createUser({ kycLevel: 2 });
    expect((await apply(referee, await codeOf(referrer))).status).toBe(201);
    const tx = await createTransaction(t, { buyerId: referee.id, travelerId: traveler.id, to: 'COMPLETED', itemIdr: 600_000 });
    await t.drain();
    const ref = await referralOf(referee.id);
    expect(ref).toMatchObject({ status: 'REWARDED', referrer_reward_idr: 25000, referee_reward_idr: 25000 });
    const [q] = await t.adminSql<{ qualifying_transaction_id: string }[]>`SELECT qualifying_transaction_id FROM referrals WHERE id = ${ref.id}`;
    expect(q!.qualifying_transaction_id).toBe(tx.id);
    const credits = await creditsOf(referee.id);
    expect(credits).toHaveLength(1);
    expect(credits[0]).toMatchObject({ amount_idr: 25000, reason: 'REFERRAL_REWARD' });
    const days = (credits[0]!.expires_at!.getTime() - Date.now()) / 86400_000;
    expect(Math.round(days)).toBe(90);
    const ev = await t.adminSql`SELECT payload FROM outbox_events WHERE event_type = 'referral.rewarded' AND aggregate_id = ${ref.id}`;
    expect(ev).toHaveLength(2);
    const notes = await t.adminSql<{ user_id: string }[]>`SELECT user_id FROM notifications WHERE event_type = 'referral.rewarded' AND user_id IN (${referrer.id}, ${referee.id})`;
    expect(notes.length).toBeGreaterThanOrEqual(2);
    const aud = await t.adminSql`SELECT 1 FROM audit_logs WHERE action = 'referral.rewarded' AND entity_id = ${ref.id}`;
    expect(aud).toHaveLength(1);

    // replaying the COMPLETED event never double-pays
    await t.adminSql`UPDATE outbox_events SET published_at = NULL, available_at = now() - interval '1 second'
                      WHERE aggregate_id = ${tx.id} AND event_type = 'transaction.status_changed' AND payload->>'to' = 'COMPLETED'`;
    await t.drain();
    expect(await creditsOf(referee.id)).toHaveLength(1);

    const me = await t.request('GET', '/v1/referrals/me', { token: referrer.accessToken });
    expect(me.body.stats.rewarded).toBeGreaterThanOrEqual(1);
    expect(me.body.rewards.find((r: { referralId: string }) => r.referralId === ref.id)).toMatchObject({ status: 'REWARDED', rewardIdr: 25000 });
    const credits2 = await t.request('GET', '/v1/credits', { token: referee.accessToken });
    expect(credits2.body).toMatchObject({ balanceIdr: 25000, withdrawable: false });
  });

  it('a first transaction below Rp500.000 does not qualify', async () => {
    const referee = await t.createUser({ kycLevel: 2 });
    await apply(referee, await codeOf(referrer));
    await createTransaction(t, { buyerId: referee.id, travelerId: traveler.id, to: 'COMPLETED', itemIdr: 150_000 });
    await t.drain();
    const ref = await referralOf(referee.id);
    expect(ref.status).toBe('REJECTED');
    expect(ref.fraud_reasons.map((r) => r.code)).toContain('BELOW_MIN_VALUE');
    expect(await creditsOf(referee.id)).toHaveLength(0);
  });

  it('monthly cap Rp250.000 limits the referrer, never the referee', async () => {
    const capped = await t.createUser({ kycLevel: 3 });
    const anyTx = await createTransaction(t, { buyerId: capped.id, travelerId: traveler.id });
    for (let i = 0; i < 10; i++) {
      const r = await t.createUser();
      await t.adminSql`INSERT INTO referrals (referrer_id, referee_id, program, status, qualifying_transaction_id, referrer_reward_idr, referee_reward_idr, qualified_at, rewarded_at)
                       VALUES (${capped.id}, ${r.id}, 'BUYER', 'REWARDED', ${anyTx.id}, 25000, 25000, now(), now())`;
    }
    const referee = await t.createUser({ kycLevel: 2 });
    await apply(referee, await codeOf(capped));
    await createTransaction(t, { buyerId: referee.id, travelerId: traveler.id, to: 'COMPLETED', itemIdr: 700_000 });
    await t.drain();
    const ref = await referralOf(referee.id);
    expect(ref).toMatchObject({ status: 'REWARDED', referrer_reward_idr: 0, referee_reward_idr: 25000 });
    expect(ref.fraud_reasons.map((r) => r.code)).toContain('MONTHLY_CAP');
    expect(await creditsOf(capped.id)).toHaveLength(0);
    expect((await creditsOf(referee.id))[0]!.amount_idr).toBe(25000);
  });

  it('fraudulent referral: shared device + same bank account → rejected by the fraud gate, no credit', async () => {
    const referee = await t.createUser({ kycLevel: 2 });
    const dev = await addDevice(t, referrer.id);
    await shareDevice(t, dev, referee.id);
    const bank = randomBytes(32);
    await payoutAccount(referrer.id, bank);
    await payoutAccount(referee.id, bank);
    expect((await apply(referee, await codeOf(referrer))).status).toBe(201); // screened again at reward time
    await createTransaction(t, { buyerId: referee.id, travelerId: traveler.id, to: 'COMPLETED', itemIdr: 800_000 });
    await t.drain();
    const ref = await referralOf(referee.id);
    expect(ref.status).toBe('REJECTED');
    const codes = ref.fraud_reasons.map((r) => r.code);
    expect(codes).toEqual(expect.arrayContaining(['FRAUD_GATE', 'REFERRAL_SHARED_PAYMENT', 'REFERRAL_SHARED_DEVICE']));
    expect(await creditsOf(referee.id)).toHaveLength(0);
    const [ra] = await t.adminSql<{ decision: string }[]>`SELECT decision FROM risk_assessments WHERE subject_type = 'REFERRAL' AND subject_id = ${ref.id} ORDER BY created_at DESC LIMIT 1`;
    expect(['HOLD', 'BLOCK']).toContain(ra!.decision);
  });

  it('shared device alone → reward held for RISK review (QUALIFIED), nothing paid yet', async () => {
    const r2 = await t.createUser({ kycLevel: 3 });
    const referee = await t.createUser({ kycLevel: 2 });
    const dev = await addDevice(t, r2.id);
    await shareDevice(t, dev, referee.id);
    await t.adminSql`UPDATE refresh_tokens SET ip_hash = ${Buffer.alloc(32, 7)} WHERE user_id IN (${r2.id}, ${referee.id})`;
    await apply(referee, await codeOf(r2));
    await createTransaction(t, { buyerId: referee.id, travelerId: traveler.id, to: 'COMPLETED', itemIdr: 800_000 });
    await t.drain();
    const ref = await referralOf(referee.id);
    expect(ref).toMatchObject({ status: 'QUALIFIED', referrer_reward_idr: 25000, referee_reward_idr: 25000 });
    expect(ref.fraud_reasons.map((r) => r.code)).toContain('RISK_REVIEW');
    expect(await creditsOf(referee.id)).toHaveLength(0);
    const reviews = await t.adminSql`SELECT 1 FROM risk_reviews WHERE subject_type = 'REFERRAL' AND subject_id = ${ref.id} AND status = 'OPEN'`;
    expect(reviews).toHaveLength(1);
  });

  it('traveler program pays Rp50.000 to the referrer after the referred traveler completes 2 transactions', async () => {
    const newTraveler = await t.createUser({ kycLevel: 4, mode: 'TRAVELER' });
    const res = await apply(newTraveler, await codeOf(referrer));
    expect(res.body.program).toBe('TRAVELER');
    const b = await t.createUser({ kycLevel: 2 });
    await createTransaction(t, { buyerId: b.id, travelerId: newTraveler.id, to: 'COMPLETED' });
    await t.drain();
    expect((await referralOf(newTraveler.id)).status).toBe('PENDING');
    const second = await createTransaction(t, { buyerId: b.id, travelerId: newTraveler.id, to: 'BUYER_CONFIRMED' });
    await advance(t, second.id, 'COMPLETED');
    await t.drain();
    expect(await referralOf(newTraveler.id)).toMatchObject({ status: 'REWARDED', referrer_reward_idr: 50000, referee_reward_idr: 0 });
  });
});

describe('unit-economics guardrail', () => {
  it('computes CAC / LTV / fraud rate and records a security event (once per day) when increases should pause', async () => {
    const r = await runReferralGuardrail(t.deps);
    expect(r).toMatchObject({ windowDays: 90 });
    expect(r.evaluatedReferrals).toBeGreaterThanOrEqual(4);
    expect(Number(r.fraudRate)).toBeGreaterThan(0.05); // 2 of the evaluated referrals were flagged
    expect(r.status).toBe('PAUSE_RECOMMENDED');
    expect(r.reasons).toContain('FRAUD_RATE_TOO_HIGH');
    await runReferralGuardrail(t.deps);
    const ev = await t.adminSql<{ meta: Record<string, unknown> }[]>`SELECT meta FROM security_events WHERE type = 'REFERRAL_GUARDRAIL_TRIPPED'`;
    expect(ev).toHaveLength(1);
    expect(ev[0]!.meta).toMatchObject({ status: 'PAUSE_RECOMMENDED' });
  });
});
