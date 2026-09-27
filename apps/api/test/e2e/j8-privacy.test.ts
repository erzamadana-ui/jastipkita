/**
 * J8 — privacy (UU PDP): data export (own data only, encrypted, owner-only download) and account deletion — blocked
 * while a transaction is open, allowed once it is terminal, 14-day grace period, then anonymized by the worker.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../helpers';
import { type Actor, api, buyerL2, emailTemplates, idem, matchedDeal, ok, tag, tick, txStatus, world, type World } from './support';

let t: TestContext;
let w: World;
let buyer: Actor;
let deal: Awaited<ReturnType<typeof matchedDeal>>;

beforeAll(async () => {
  t = await createTestContext();
  w = await world(t);
  buyer = await buyerL2(t, { label: 'privacy' });
  deal = await matchedDeal(t, w, { buyer });
  const conv = await ok(api(t, buyer, 'GET', `/v1/transactions/${deal.tx.id}/conversation`));
  await ok(api(t, buyer, 'POST', `/v1/conversations/${conv.conversationId}/messages`, { type: 'TEXT', body: 'Halo kak, ukuran M ya' }), 201);
  await ok(api(t, w.traveler, 'POST', `/v1/conversations/${conv.conversationId}/messages`, { type: 'TEXT', body: 'Siap kak, pesan rahasia traveler' }), 201);
});
afterAll(async () => {
  await t.close();
});

describe('J8 privacy: export & delete account', () => {
  it('export: queued → worker builds an encrypted JSON of my data only → owner-only download', async () => {
    const req = await ok(api(t, buyer, 'POST', '/v1/privacy/export'), 202);
    expect(req).toMatchObject({ type: 'EXPORT', status: 'RECEIVED' });
    await t.drain();
    const list = await ok(api(t, buyer, 'GET', '/v1/privacy/requests'));
    const done = list.data.find((r: any) => r.id === req.id);
    expect(done.status).toBe('COMPLETED');
    const url = await ok(api(t, buyer, 'GET', `/v1/files/${done.exportFileId}/url`));
    expect(url.requiresAuth).toBe(true);
    const res = await t.app.request(new URL(url.url).pathname, { headers: { authorization: `Bearer ${buyer.accessToken}` } });
    expect(res.status).toBe(200);
    const text = await res.text();
    const data = JSON.parse(text);
    expect(data.format).toBe('jastipkita-data-export/v1');
    expect(data.profile.email).toBe(buyer.email);
    expect(data.requests.map((r: any) => r.productName)).toContain(deal.request.productName);
    expect(data.messagesSent.map((m: any) => m.body)).toEqual(['Halo kak, ukuran M ya']);
    expect(text).not.toContain('pesan rahasia traveler');
    expect(text).not.toContain(w.traveler.email);
    expect(text).not.toMatch(/_enc|Hash"/);
    // counterparty / admin cannot download it
    expect((await api(t, w.traveler, 'GET', `/v1/files/${done.exportFileId}/url`)).status).toBe(403);
    expect((await api(t, w.admin, 'GET', `/v1/files/${done.exportFileId}/url`)).status).toBe(403);
    await t.drain();
    expect(emailTemplates(t, buyer.email)).toContain(tag('privacy.export_ready'));
  });

  it('deletion is blocked while the transaction is open (409 DELETION_BLOCKED)', async () => {
    const r = await api(t, buyer, 'POST', '/v1/privacy/delete-account', { confirm: true, reason: 'tidak dipakai' });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({ code: 'DELETION_BLOCKED', details: { activeTransactions: 1 } });
    expect((await ok(api(t, buyer, 'GET', '/v1/me'))).status).toBe('ACTIVE');
  });

  it('after the transaction is terminal: scheduled (14 days), sessions revoked, limited re-login, then anonymized by the worker', async () => {
    const c = await ok(api(t, buyer, 'POST', `/v1/transactions/${deal.tx.id}/cancel`, { reason: 'Tidak jadi beli' }, idem()));
    expect(c.status).toBe('CANCELLED');
    expect(await txStatus(t, deal.tx.id)).toBe('CANCELLED');
    const del = await ok(api(t, buyer, 'POST', '/v1/privacy/delete-account', { confirm: true, reason: 'tidak dipakai lagi' }), 202);
    expect(new Date(del.effectiveAt).getTime() - t.clock.now().getTime()).toBe(14 * 86400_000);
    expect((await t.request('GET', '/v1/me', { token: buyer.accessToken })).status).toBe(401); // all sessions revoked
    expect((await t.request('POST', '/v1/auth/refresh', { body: { refreshToken: buyer.refreshToken } })).status).toBe(401);

    // logging in again during the grace period gives a limited session
    t.clock.advance(61_000);
    const rq = await t.request('POST', '/v1/auth/otp/request', { body: { channel: 'EMAIL', destination: buyer.email, purpose: 'LOGIN' }, headers: { 'x-forwarded-for': buyer.ip } });
    const v = await t.request('POST', '/v1/auth/otp/verify', { body: { challengeId: rq.body.challengeId, code: rq.body.devCode }, headers: { 'x-forwarded-for': buyer.ip } });
    expect(v.status).toBe(200);
    expect(v.body.user).toMatchObject({ id: buyer.id, status: 'PENDING_DELETION', deletionScheduledFor: del.effectiveAt });
    const limited = v.body.tokens.accessToken;
    expect((await t.request('GET', '/v1/me', { token: limited })).body.error.code).toBe('ACCOUNT_INACTIVE');
    expect((await t.request('GET', '/v1/privacy/requests', { token: limited })).status).toBe(200);
    await t.drain();
    expect(emailTemplates(t, buyer.email)).toContain(tag('account.deletion_scheduled'));

    // grace period over → hourly worker job anonymizes
    await tick(t, 14 * 24 * 60 + 61);
    const [u] = await t.adminSql<{ status: string; email: string | null; phone_e164: string | null; display_name: string | null; anonymized_at: Date | null }[]>`
      SELECT status, email, phone_e164, display_name, anonymized_at FROM users WHERE id = ${buyer.id}`;
    expect(u).toMatchObject({ status: 'DELETED', email: null, phone_e164: null, display_name: null });
    expect(u!.anonymized_at).not.toBeNull();
    // the counterparty's history keeps the transaction without the buyer's PII
    const tv = await ok(api(t, w.traveler, 'GET', `/v1/transactions/${deal.tx.id}`));
    expect(JSON.stringify(tv)).not.toContain(buyer.email);
    expect(JSON.stringify(tv)).not.toContain(buyer.phone!);
    // the e-mail can register again as a brand-new account (suppression is for marketing/re-registration risk only)
    t.clock.advance(61_000);
    const again = await t.request('POST', '/v1/auth/otp/request', { body: { channel: 'EMAIL', destination: buyer.email, purpose: 'LOGIN' }, headers: { 'x-forwarded-for': '203.0.113.99' } });
    expect(again.status).toBe(200);
  });
});
