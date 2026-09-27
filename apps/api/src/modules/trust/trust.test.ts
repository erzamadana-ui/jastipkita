import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext, type TestUser } from '../../../test/helpers';
import { createTransaction, createTrip } from '../notifications/testing/fixtures';
import { recomputeTrustScore, runTrustSweep } from './service';

let t: TestContext;
beforeAll(async () => {
  t = await createTestContext();
});
afterAll(async () => {
  await t.close();
});

const scoreOf = async (userId: string) =>
  (await t.adminSql<{ score: number; override_id: string | null; components: Record<string, unknown> }[]>`SELECT score, override_id, components FROM trust_scores WHERE user_id = ${userId}`)[0];
const userOf = async (userId: string) => (await t.adminSql<{ trust_score: number; kyc_level: number }[]>`SELECT trust_score, kyc_level FROM users WHERE id = ${userId}`)[0]!;

describe('trust score recompute', () => {
  it('recomputes both parties from DB signals when a transaction COMPLETES (history + users.trust_score synced)', async () => {
    const b = await t.createUser({ kycLevel: 2 });
    const tr = await t.createUser({ kycLevel: 4, mode: 'TRAVELER' });
    await createTransaction(t, { buyerId: b.id, travelerId: tr.id, to: 'COMPLETED' });
    await t.drain();
    const s = await scoreOf(tr.id);
    expect(s).toBeTruthy();
    expect(s!.components).toMatchObject({ engine: 'trust-v1', computedScore: s!.score });
    const items = s!.components.items as { key: string; applicable: boolean }[];
    expect(items.find((i) => i.key === 'onTimeDelivery')!.applicable).toBe(true);
    expect(items.find((i) => i.key === 'tripVerification')!.applicable).toBe(true);
    expect((await userOf(tr.id)).trust_score).toBe(s!.score);
    const buyerScore = await scoreOf(b.id);
    const bItems = buyerScore!.components.items as { key: string; applicable: boolean }[];
    expect(bItems.find((i) => i.key === 'onTimeDelivery')!.applicable).toBe(false); // buyers are not penalised
    const hist = await t.adminSql<{ source: string }[]>`SELECT source FROM trust_score_history WHERE user_id = ${tr.id} ORDER BY id`;
    expect(hist[0]!.source).toBe('INITIAL');
    // same facts → no new history row
    await recomputeTrustScore(t.deps, tr.id, 'test');
    expect(await t.adminSql`SELECT 1 FROM trust_score_history WHERE user_id = ${tr.id}`).toHaveLength(hist.length);
  });

  it('penalises cancellations by the user but not a buyer rejecting a price change (§5)', async () => {
    const b = await t.createUser({ kycLevel: 2 });
    const tr = await t.createUser({ kycLevel: 4, mode: 'TRAVELER' });
    await createTransaction(t, { buyerId: b.id, travelerId: tr.id, to: 'CANCELLED' });
    const r = await recomputeTrustScore(t.deps, b.id, 'test');
    const s = await scoreOf(b.id);
    const cancel = (s!.components.items as { key: string; contribution: number }[]).find((i) => i.key === 'cancellationPenalty')!;
    expect(cancel.contribution).toBeLessThan(0);
    expect(r!.score).toBe(s!.score);
  });
});

describe('KYC level 5 (TRUSTED_TRAVELER)', () => {
  let traveler: TestUser;

  it('is granted automatically after ≥ 10 completed trips with trust ≥ 80 and dispute rate < 3 %', async () => {
    traveler = await t.createUser({ kycLevel: 4, mode: 'TRAVELER' });
    await t.adminSql`UPDATE users SET created_at = now() - interval '730 days' WHERE id = ${traveler.id}`;
    const b = await t.createUser({ kycLevel: 2 });
    for (let i = 0; i < 10; i++) {
      const tripId = await createTrip(t, traveler.id, { verified: true });
      await createTransaction(t, { buyerId: b.id, travelerId: traveler.id, tripId, to: 'COMPLETED' });
    }
    await t.drain();
    await t.drain();
    const u = await userOf(traveler.id);
    expect(u.trust_score).toBeGreaterThanOrEqual(80);
    expect(u.kyc_level).toBe(5);
    const [ev] = await t.adminSql<{ payload: Record<string, unknown> }[]>`
      SELECT payload FROM outbox_events WHERE event_type = 'kyc.level_changed' AND aggregate_id = ${traveler.id} ORDER BY id DESC LIMIT 1`;
    expect(ev!.payload).toMatchObject({ userId: traveler.id, from: 4, to: 5, reason: 'TRUSTED_TRAVELER_GRANTED' });
    expect(await t.adminSql`SELECT 1 FROM audit_logs WHERE action = 'kyc.level_changed' AND entity_id = ${traveler.id}`).toHaveLength(1);
    const n = await t.adminSql<{ title: string }[]>`SELECT title FROM notifications WHERE user_id = ${traveler.id} AND event_type = 'kyc.trusted_traveler'`;
    expect(n[0]!.title).toBe('Kamu sekarang Trusted Traveler');
  });

  it('is revoked when the dispute rate reaches 3 %', async () => {
    const [tx] = await t.adminSql<{ id: string; buyer_id: string }[]>`SELECT id, buyer_id FROM transactions WHERE traveler_id = ${traveler.id} LIMIT 1`;
    await t.adminSql`INSERT INTO disputes (transaction_id, opened_by, opened_by_role, type, description) VALUES (${tx!.id}, ${tx!.buyer_id}, 'BUYER', 'DAMAGED_ITEM', 'Kemasan rusak parah saat diterima')`;
    const r = await recomputeTrustScore(t.deps, traveler.id, 'test');
    expect(r!.levelChange).toEqual({ from: 5, to: 4 });
    expect((await userOf(traveler.id)).kyc_level).toBe(4);
    const [ev] = await t.adminSql<{ payload: Record<string, unknown> }[]>`
      SELECT payload FROM outbox_events WHERE event_type = 'kyc.level_changed' AND aggregate_id = ${traveler.id} ORDER BY id DESC LIMIT 1`;
    expect(ev!.payload).toMatchObject({ from: 5, to: 4, reason: 'TRUSTED_TRAVELER_REVOKED' });
    expect((ev!.payload.facts as { disputeRatePct: number }).disputeRatePct).toBe(10);
  });
});

describe('admin overrides (maker-checker) are respected', () => {
  it('keeps an active override score, refreshes the computed breakdown, and releases it after valid_until', async () => {
    const maker = await t.createUser({ roles: ['RISK'] });
    const checker = await t.createUser({ roles: ['SUPER_ADMIN'] });
    const u = await t.createUser({ kycLevel: 3 });
    await recomputeTrustScore(t.deps, u.id, 'test');
    const computed = (await scoreOf(u.id))!.score;
    const mk = async (validUntil: string | null) => {
      const [o] = await t.adminSql<{ id: string }[]>`
        INSERT INTO trust_score_overrides (user_id, previous_score, new_score, reason, valid_until, requested_by)
        VALUES (${u.id}, ${computed}, 95, 'Mitra korporat terverifikasi manual', ${validUntil === null ? null : t.adminSql`${validUntil}::timestamptz`}, ${maker.id}) RETURNING id`;
      await t.adminSql`UPDATE trust_score_overrides SET status = 'APPROVED', approved_by = ${checker.id}, decided_at = now() WHERE id = ${o!.id}`;
      await t.adminSql`SELECT apply_trust_score_override(${o!.id}, ${checker.id})`;
      return o!.id;
    };
    const o1 = await mk(null);
    const r = await recomputeTrustScore(t.deps, u.id, 'test');
    expect(r).toMatchObject({ score: 95, overridden: true, computedScore: computed });
    const s = await scoreOf(u.id);
    expect(s).toMatchObject({ score: 95, override_id: o1 });
    expect(s!.components.override).toMatchObject({ id: o1 });

    // an override whose valid_until passed is released by the hourly sweep
    await mk(new Date(Date.now() - 60_000).toISOString());
    const sweep = await runTrustSweep(t.deps);
    expect(sweep.users).toBeGreaterThanOrEqual(1);
    const after = await scoreOf(u.id);
    expect(after).toMatchObject({ score: computed, override_id: null });
    expect((await userOf(u.id)).trust_score).toBe(computed);
  });
});
