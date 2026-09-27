/**
 * J7 — referral: a new buyer applies a code, the first transaction ≥ Rp500.000 completes → Rp25.000 JastipKita Credit for
 * referrer and referee; the credit is used at the next checkout (restored when the invoice expires); a referral from an
 * account on the referrer's device (shared device) is held by the fraud gate — no credit is paid.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../helpers';
import {
  type Actor,
  adminWithMfa,
  api,
  buyerL2,
  emailTemplates,
  extraTrip,
  idem,
  line,
  meetupHandover,
  ok,
  providerPays,
  purchase,
  securedDeal,
  matchedDeal,
  tag,
  tick,
  travelToHandover,
  txLedger,
  txStatus,
  world,
  type World,
} from './support';

let t: TestContext;
let w: World;
let referrer: Actor;
let referee: Actor;
let code: string;
const REFERRER_DEVICE = `fp-referrer-${Date.now()}`;
const REFERRER_IP = '198.51.100.201';

beforeAll(async () => {
  t = await createTestContext();
  w = await world(t);
  referrer = await buyerL2(t, { label: 'referrer', fingerprint: REFERRER_DEVICE, ip: REFERRER_IP });
});
afterAll(async () => {
  await t.close();
});

async function completeDeal(buyer: Actor, tripId: string) {
  const d = await securedDeal(t, w, { buyer, tripId });
  await purchase(t, w.traveler, d.tx.id, 6000);
  await travelToHandover(t, w.traveler, d.tx.id, tripId);
  await meetupHandover(t, buyer, w.traveler, d.tx.id);
  const c = await ok(api(t, buyer, 'POST', `/v1/transactions/${d.tx.id}/confirm-receipt`, undefined, idem()));
  expect(c.transactionStatus).toBe('COMPLETED');
  return d;
}

const credits = (userId: string) =>
  t.adminSql<{ amount_idr: number; reason: string }[]>`SELECT amount_idr, reason FROM credit_entries WHERE user_id = ${userId} ORDER BY id`;

describe('J7 referral & JastipKita Credit', () => {
  it('referrer gets a code + share link; a brand-new buyer applies it (self-referral refused)', async () => {
    const me = await ok(api(t, referrer, 'GET', '/v1/referrals/me'));
    code = me.code;
    expect(me.shareLink).toBe(`http://web.test/r/${code}`);
    expect(me.programs.buyer).toMatchObject({ referrerCreditIdr: 25000, refereeCreditIdr: 25000, minFirstTransactionIdr: 500000, withdrawable: false });
    const self = await api(t, referrer, 'POST', '/v1/referrals/apply', { code });
    expect(self.body.error.code).toBe('SELF_REFERRAL');
    referee = await buyerL2(t, { label: 'referee' });
    const applied = await ok(api(t, referee, 'POST', '/v1/referrals/apply', { code: code.toLowerCase() }), 201);
    expect(applied).toMatchObject({ program: 'BUYER', status: 'PENDING' });
  });

  it('first transaction ≥ Rp500.000 COMPLETED → Rp25.000 credit for both, non-withdrawable, notified', async () => {
    const d = await completeDeal(referee, w.trip.id);
    expect(d.quote.totalIdr).toBeGreaterThanOrEqual(500_000);
    await t.drain();
    const [ref] = await t.adminSql<{ status: string; qualifying_transaction_id: string }[]>`SELECT status, qualifying_transaction_id FROM referrals WHERE referee_id = ${referee.id}`;
    expect(ref).toMatchObject({ status: 'REWARDED', qualifying_transaction_id: d.tx.id });
    for (const u of [referrer, referee]) {
      const c = await ok(api(t, u, 'GET', '/v1/credits'));
      expect(c).toMatchObject({ balanceIdr: 25000, withdrawable: false });
      expect(emailTemplates(t, u.email)).toContain(tag('referral.rewarded'));
    }
    expect(await credits(referee.id)).toEqual([{ amount_idr: 25000, reason: 'REFERRAL_REWARD' }]);
  });

  it('credit is applied at the next checkout (REFERRAL_CREDIT line), restored when the invoice expires, consumed on payment', async () => {
    const trip2 = await extraTrip(t, w);
    const d = await matchedDeal(t, w, { buyer: referee, tripId: trip2.id });
    const q1 = await ok(api(t, referee, 'POST', `/v1/transactions/${d.tx.id}/quote`, { channel: 'QRIS', useCredit: true }), 201);
    expect(line(q1, 'REFERRAL_CREDIT')).toBe(-25000);
    expect(q1.credit).toMatchObject({ appliedIdr: 25000, withdrawable: false });
    await ok(api(t, referee, 'POST', `/v1/transactions/${d.tx.id}/checkout`, { quoteId: q1.quoteId }, idem()), 201);
    expect((await ok(api(t, referee, 'GET', '/v1/credits'))).balanceIdr).toBe(0);
    // the buyer never pays: invoice expires → MATCHED, credit restored
    await tick(t, 31);
    expect(await txStatus(t, d.tx.id)).toBe('MATCHED');
    expect((await ok(api(t, referee, 'GET', '/v1/credits'))).balanceIdr).toBe(25000);
    // re-quote and pay this time
    const q2 = await ok(api(t, referee, 'POST', `/v1/transactions/${d.tx.id}/quote`, { channel: 'QRIS', useCredit: true }), 201);
    expect(line(q2, 'REFERRAL_CREDIT')).toBe(-25000);
    const co = await ok(api(t, referee, 'POST', `/v1/transactions/${d.tx.id}/checkout`, { quoteId: q2.quoteId }, idem()), 201);
    expect(co.amountIdr).toBe(q2.totalIdr);
    const { res } = await providerPays(t, co.paymentId);
    expect(res.body.outcome).toBe('SECURED');
    expect((await ok(api(t, referee, 'GET', '/v1/credits'))).balanceIdr).toBe(0);
    const l = await txLedger(t, d.tx.id);
    expect(l.PROMOTION_CREDIT).toBe(-25000); // platform-funded credit debited at capture
    expect(-(l.PROVIDER_CASH ?? 0)).toBe(q2.totalIdr);
  });

  it('mandatory scenario — fraudulent referral: an account on the referrer\'s device (shared device + IP) gets no credit; held for RISK', async () => {
    const fraud = await buyerL2(t, { label: 'fraud', fingerprint: REFERRER_DEVICE, ip: REFERRER_IP });
    // weak signals are only noted at apply time (§6.2); the gate decides at reward time
    const applied = await ok(api(t, fraud, 'POST', '/v1/referrals/apply', { code }), 201);
    expect(applied.status).toBe('PENDING');
    const trip3 = await extraTrip(t, w);
    await completeDeal(fraud, trip3.id);
    await t.drain();
    const [ref] = await t.adminSql<{ id: string; status: string; fraud_reasons: { code: string }[] }[]>`SELECT id, status, fraud_reasons FROM referrals WHERE referee_id = ${fraud.id}`;
    expect(ref!.status).toBe('QUALIFIED'); // REVIEW → reward computed but held (not paid)
    expect(ref!.fraud_reasons.map((r) => r.code)).toEqual(expect.arrayContaining(['REFERRAL_SHARED_DEVICE']));
    expect(await credits(fraud.id)).toEqual([]);
    expect((await ok(api(t, referrer, 'GET', '/v1/credits'))).balanceIdr).toBe(25000); // only the legitimate reward
    {
      const reviews = await t.adminSql`SELECT 1 FROM risk_reviews WHERE subject_type = 'REFERRAL' AND subject_id = ${ref!.id} AND status = 'OPEN'`;
      expect(reviews).toHaveLength(1);
      // Marketing sees it in the back office, flagged
      const mkt = await adminWithMfa(t, ['MARKETING']);
      const list = await ok(api(t, mkt, 'GET', '/v1/admin/referrals?status=QUALIFIED'));
      expect(list.data.map((x: any) => x.id)).toContain(ref!.id);
      const release = await api(t, mkt, 'POST', `/v1/admin/referrals/${ref!.id}/release`, { note: 'Cek referral perangkat sama' }, idem());
      expect(release.status).toBe(422); // open risk review blocks the release
    }
  });
});
