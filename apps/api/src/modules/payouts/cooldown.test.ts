/**
 * New payout account cooldown (anti account-takeover, CEO decision 2026-10-04; money.md §5.7):
 * a payout account added / verified / made default less than money.policy.newPayoutAccountCooldownHours (24) ago
 * receives no payout — the payout is scheduled at max(normal schedule, account ready time) and re-checked at processing.
 */
import { DEFAULT_BUSINESS_CONFIG } from '@jastipkita/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../../../test/helpers';
import { sensitiveStepUp } from '../auth/test-support';
import { loadTx, moneyPolicy } from '../transactions/common';
import { call, createMatchedTx, createPayoutAccount, seedFx, setupParties, type Parties } from '../transactions/test-fixtures';
import { payoutAccountReadyAt, processPayouts, schedulePayout } from './service';

const H = 3600_000;
let t: TestContext;

beforeAll(async () => {
  t = await createTestContext();
  await seedFx(t);
});
afterAll(async () => {
  await t.close();
});

async function travelerWithoutAccount(): Promise<Parties> {
  return setupParties(t, { payoutAccount: false });
}

async function schedule(p: Parties, amountIdr = 150_000) {
  const mt = await createMatchedTx(t, p);
  const payout = await t.sql.begin(async (db) => {
    const tx = (await loadTx(db as never, mt.id, { forUpdate: true }))!;
    return schedulePayout(t.deps, db as never, tx, { amountIdr, kind: 'EARNING' });
  });
  return { txId: mt.id, payout: payout! };
}

const payoutRow = async (id: string) =>
  (await t.adminSql<{ status: string; scheduled_for: Date; payout_account_id: string }[]>`SELECT status, scheduled_for, payout_account_id FROM payouts WHERE id = ${id}`)[0]!;
const scheduledEvents = (payoutId: string) =>
  t.adminSql<{ payload: Record<string, unknown> }[]>`SELECT payload FROM outbox_events WHERE aggregate_id = ${payoutId} AND event_type = 'payout.scheduled' ORDER BY created_at, id`;

async function setPolicy(value: Record<string, unknown>) {
  await t.adminSql`UPDATE business_configs SET status = 'SUPERSEDED', superseded_at = now() WHERE key = 'money.policy' AND status = 'ACTIVE'`;
  await t.adminSql`
    INSERT INTO business_configs (key, version, value, status, change_reason, approved_at)
    SELECT 'money.policy', coalesce(max(version), 0) + 1, ${t.adminSql.json(value as never)}, 'ACTIVE', 'test: payout cooldown', now()
      FROM business_configs WHERE key = 'money.policy'`;
  t.deps.config.invalidate();
}
const defaults = DEFAULT_BUSINESS_CONFIG['money.policy'];

describe('payoutAccountReadyAt (pure)', () => {
  it('latest of created / verified / became default + cooldown hours; 0 disables', () => {
    const base = new Date('2026-10-04T00:00:00Z');
    const a = { createdAt: base, verifiedAt: new Date(base.getTime() + 2 * H), defaultSince: new Date(base.getTime() + 5 * H) };
    expect(payoutAccountReadyAt(a, 24).toISOString()).toBe('2026-10-05T05:00:00.000Z');
    expect(payoutAccountReadyAt({ ...a, defaultSince: null }, 24).toISOString()).toBe('2026-10-05T02:00:00.000Z');
    expect(payoutAccountReadyAt({ createdAt: base, verifiedAt: null, defaultSince: null }, 0).toISOString()).toBe(base.toISOString());
  });
});

describe('new payout account cooldown', () => {
  it('fresh account → payout scheduled at its ready time, not paid before, paid after; surfaced to traveler and admin', async () => {
    const p = await travelerWithoutAccount();
    const accountId = await createPayoutAccount(t, p.traveler.id, { ageHours: 2 });
    const now = t.clock.now();
    const { payout } = await schedule(p);
    const readyAt = new Date(now.getTime() + 22 * H);
    expect(payout.status).toBe('SCHEDULED');
    expect(Math.abs(new Date(payout.scheduledFor).getTime() - readyAt.getTime())).toBeLessThan(1000);
    const [ev] = await scheduledEvents(payout.id);
    expect(ev!.payload.cooldownUntil).toBe(new Date(payout.scheduledFor).toISOString());

    expect(await processPayouts(t.deps, { transactionId: payout.transactionId! })).toMatchObject({ paid: 0 });
    expect((await payoutRow(payout.id)).status).toBe('SCHEDULED');

    // traveler: earnings list + payout account show the cooldown
    const mine = await call(t, p.traveler, 'GET', '/v1/payouts/mine');
    const item = mine.body.data.find((x: { id: string }) => x.id === payout.id);
    expect(item.cooldownUntil).toBe(new Date(payout.scheduledFor).toISOString());
    expect(item.scheduledFor).toBe(item.cooldownUntil);
    const accounts = await call(t, p.traveler, 'GET', '/v1/kyc/payout-accounts');
    expect(accounts.body.data.find((a: { id: string }) => a.id === accountId).payoutsFrom).toBe(item.cooldownUntil);
    // admin finance list
    const fin = await t.createUser({ kycLevel: 2, roles: ['FINANCE'], mfa: true });
    const adm = await t.request('GET', `/v1/admin/payouts?status=SCHEDULED&travelerId=${p.traveler.id}`, { token: fin.accessToken });
    expect(adm.status).toBe(200);
    expect(adm.body.data[0].cooldownUntil).toBe(item.cooldownUntil);

    // the traveler notification explains the delay
    await t.drain();
    const [n] = await t.adminSql<{ title: string; body: string }[]>`
      SELECT title, body FROM notifications WHERE user_id = ${p.traveler.id} AND event_type = 'payout.scheduled' ORDER BY created_at DESC LIMIT 1`;
    expect(n!.title).toBe('Pencairan dijadwalkan — rekening baru');
    expect(n!.body).toMatch(/cair mulai .* WIB karena rekening payout baru/);

    t.clock.advance(22 * H + 60_000);
    expect(await processPayouts(t.deps, { transactionId: payout.transactionId! })).toMatchObject({ paid: 1, deferred: 0 });
    expect((await payoutRow(payout.id)).status).toBe('PAID');
    const adm2 = await t.request('GET', `/v1/admin/payouts?status=PAID&travelerId=${p.traveler.id}`, { token: (await t.createUser({ kycLevel: 2, roles: ['FINANCE'], mfa: true })).accessToken });
    expect(adm2.body.data[0].cooldownUntil).toBeNull();
  });

  it('established account → normal schedule (payoutDelayHours = 0) and paid right away', async () => {
    const p = await travelerWithoutAccount();
    await createPayoutAccount(t, p.traveler.id, { ageHours: 72 });
    const now = t.clock.now();
    const { payout } = await schedule(p);
    expect(Math.abs(new Date(payout.scheduledFor).getTime() - now.getTime())).toBeLessThan(1000);
    const [ev] = await scheduledEvents(payout.id);
    expect(ev!.payload.cooldownUntil).toBeNull();
    expect(await processPayouts(t.deps, { transactionId: payout.transactionId! })).toMatchObject({ paid: 1, deferred: 0 });
    const mine = await call(t, p.traveler, 'GET', '/v1/payouts/mine');
    expect(mine.body.data.find((x: { id: string }) => x.id === payout.id).cooldownUntil).toBeNull();
  });

  it('config change is respected: 0 disables, a longer cooldown applies at scheduling and re-checks at processing; missing key → default 24', async () => {
    try {
      await setPolicy({ ...defaults, newPayoutAccountCooldownHours: 0 });
      const p0 = await travelerWithoutAccount();
      await createPayoutAccount(t, p0.traveler.id, { ageHours: 0 });
      const s0 = await schedule(p0);
      expect(await processPayouts(t.deps, { transactionId: s0.txId })).toMatchObject({ paid: 1 });

      await setPolicy({ ...defaults, newPayoutAccountCooldownHours: 48 });
      const p1 = await travelerWithoutAccount();
      await createPayoutAccount(t, p1.traveler.id, { ageHours: 30 });
      const now = t.clock.now();
      const s1 = await schedule(p1);
      expect(Math.abs(new Date(s1.payout.scheduledFor).getTime() - (now.getTime() + 18 * H))).toBeLessThan(1000);

      // scheduled under 24 h (account 30 h old → due now), cooldown raised to 48 h before the run → deferred
      await setPolicy({ ...defaults, newPayoutAccountCooldownHours: 24 });
      const p2 = await travelerWithoutAccount();
      const acc2 = await createPayoutAccount(t, p2.traveler.id, { ageHours: 30 });
      const s2 = await schedule(p2);
      await setPolicy({ ...defaults, newPayoutAccountCooldownHours: 48 });
      expect(await processPayouts(t.deps, { transactionId: s2.txId })).toMatchObject({ paid: 0, deferred: 1 });
      const row = await payoutRow(s2.payout.id);
      expect(row.status).toBe('SCHEDULED');
      expect(Math.abs(row.scheduled_for.getTime() - (t.clock.now().getTime() + 18 * H))).toBeLessThan(1000);
      const evs = await scheduledEvents(s2.payout.id);
      expect(evs.at(-1)!.payload).toMatchObject({ kind: 'ACCOUNT_COOLDOWN', cooldownUntil: row.scheduled_for.toISOString() });
      const [a] = await t.adminSql<{ meta: Record<string, unknown> }[]>`SELECT meta FROM audit_logs WHERE action = 'payout.cooldown_deferred' AND entity_id = ${s2.payout.id}`;
      expect(a!.meta).toMatchObject({ payoutAccountId: acc2, cooldownHours: 48 });

      // a stored version written before 2026-10-04 (no key) falls back to the default 24 h
      const { newPayoutAccountCooldownHours: _drop, ...legacy } = defaults;
      await setPolicy(legacy);
      expect((await moneyPolicy(t.sql)).newPayoutAccountCooldownHours).toBe(24);
    } finally {
      await setPolicy({ ...defaults });
    }
  });

  it('default switched after scheduling (outside the API) → processor re-points to the new default and waits for its cooldown', async () => {
    const p = await travelerWithoutAccount();
    const oldAcc = await createPayoutAccount(t, p.traveler.id, { ageHours: 72, accountNumber: '7000000001' });
    const newAcc = await createPayoutAccount(t, p.traveler.id, { ageHours: 72, accountNumber: '7000000002', isDefault: false });
    const { payout } = await schedule(p);
    expect((await payoutRow(payout.id)).payout_account_id).toBe(oldAcc);
    // e.g. admin verification override / support tool: the trigger stamps default_since with the DB clock unless given
    await t.adminSql`UPDATE payout_accounts SET is_default = false WHERE id = ${oldAcc}`;
    await t.adminSql`UPDATE payout_accounts SET is_default = true, default_since = ${t.clock.now()} WHERE id = ${newAcc}`;

    expect(await processPayouts(t.deps, { transactionId: payout.transactionId! })).toMatchObject({ paid: 0, deferred: 1 });
    const row = await payoutRow(payout.id);
    expect(row.payout_account_id).toBe(newAcc);
    expect(Math.abs(row.scheduled_for.getTime() - (t.clock.now().getTime() + 24 * H))).toBeLessThan(1000);
    const actions = await t.adminSql<{ action: string }[]>`SELECT action FROM audit_logs WHERE entity_id = ${payout.id} ORDER BY id`;
    expect(actions.map((x) => x.action)).toEqual(expect.arrayContaining(['payout.destination_changed', 'payout.cooldown_deferred']));

    t.clock.advance(24 * H + 60_000);
    expect(await processPayouts(t.deps, { transactionId: payout.transactionId! })).toMatchObject({ paid: 1 });
    expect(t.payment.payouts.at(-1)!.accountNumber).toBe('7000000002');
  });

  it('traveler makes another account default (API, step-up) → pending payout follows it, waits 24 h; old account becomes removable', async () => {
    const p = await travelerWithoutAccount();
    const oldAcc = await createPayoutAccount(t, p.traveler.id, { ageHours: 72, accountNumber: '7100000001' });
    const newAcc = await createPayoutAccount(t, p.traveler.id, { ageHours: 72, accountNumber: '7100000002', isDefault: false });
    const { payout } = await schedule(p);
    // busy: the old account still has a pending payout
    expect((await call(t, p.traveler, 'DELETE', `/v1/kyc/payout-accounts/${oldAcc}`)).body.error.code).toBe('PAYOUT_ACCOUNT_IN_USE');

    const stepUp = await sensitiveStepUp(t, p.traveler, 'PAYOUT_ACCOUNT_SET_DEFAULT', newAcc);
    const def = await call(t, p.traveler, 'POST', `/v1/kyc/payout-accounts/${newAcc}/default`, { stepUp });
    expect(def.status).toBe(200);
    expect(def.body.isDefault).toBe(true);
    const expected = new Date(t.clock.now().getTime() + 24 * H).toISOString();
    expect(def.body.payoutsFrom).toBe(expected);

    const row = await payoutRow(payout.id);
    expect(row.payout_account_id).toBe(newAcc);
    expect(row.scheduled_for.toISOString()).toBe(expected);
    const evs = await scheduledEvents(payout.id);
    expect(evs.at(-1)!.payload).toMatchObject({ kind: 'DESTINATION_CHANGED', cooldownUntil: expected });
    const mine = await call(t, p.traveler, 'GET', '/v1/payouts/mine');
    const item = mine.body.data.find((x: { id: string }) => x.id === payout.id);
    expect(item).toMatchObject({ cooldownUntil: expected, destination: { accountMask: '****0002' } });
    expect(await processPayouts(t.deps, { transactionId: payout.transactionId! })).toMatchObject({ paid: 0 });

    // traveler is warned (destination changed + cooldown)
    await t.drain();
    const ns = await t.adminSql<{ body: string }[]>`SELECT body FROM notifications WHERE user_id = ${p.traveler.id} AND event_type = 'payout.scheduled'`;
    expect(ns.map((n) => n.body)).toEqual(expect.arrayContaining([expect.stringMatching(/rekening payout baru/)]));

    // nothing pending on the old account any more → it can be removed
    expect((await call(t, p.traveler, 'DELETE', `/v1/kyc/payout-accounts/${oldAcc}`)).status).toBe(200);

    t.clock.advance(24 * H + 60_000);
    expect(await processPayouts(t.deps, { transactionId: payout.transactionId! })).toMatchObject({ paid: 1 });
    expect(t.payment.payouts.at(-1)!.accountNumber).toBe('7100000002');
  });
});
