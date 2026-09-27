import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { identityJobs } from '../../jobs/identity';
import { createTestContext, type TestContext } from '../../../test/helpers';
import { otpRequest, otpVerify, phoneLogin } from '../auth/test-support';
import { purgeExpiredOtpAndIdempotency, retentionPurge } from './retention';
import { finalizeDueDeletions } from './service';

let t: TestContext;
beforeAll(async () => {
  t = await createTestContext();
});
afterAll(async () => {
  await t.close();
});

const DAY = 86400_000;

async function relogin(phone: string) {
  t.clock.advance(61_000);
  const r = await otpRequest(t, { channel: 'SMS', destination: phone, purpose: 'LOGIN' });
  const v = await otpVerify(t, { challengeId: r.body.challengeId, code: r.body.devCode });
  expect(v.status).toBe(200);
  return v.body as { tokens: { accessToken: string }; user: any };
}

describe('privacy: data export', () => {
  it('queues, builds an encrypted export with own data only, emits privacy.export_ready, owner-only download', async () => {
    const me = await phoneLogin(t);
    const token = me.tokens.accessToken;
    const other = await t.createUser({ email: `counterparty-${Date.now()}@example.com`, displayName: 'Rahasia Orang Lain' });
    const [rq] = await t.adminSql<{ id: string }[]>`INSERT INTO requests (buyer_id, source_type, product_name) VALUES (${me.user.id}, 'MANUAL', 'Sepatu lari') RETURNING id`;
    const [cv] = await t.adminSql<{ id: string }[]>`INSERT INTO conversations (request_id, buyer_id, traveler_id) VALUES (${rq!.id}, ${me.user.id}, ${other.id}) RETURNING id`;
    await t.adminSql`INSERT INTO messages (conversation_id, sender_id, type, body) VALUES (${cv!.id}, ${me.user.id}, 'TEXT', 'Halo, pesan saya sendiri')`;
    await t.adminSql`INSERT INTO messages (conversation_id, sender_id, type, body) VALUES (${cv!.id}, ${other.id}, 'TEXT', 'Pesan pribadi lawan bicara')`;

    const req = await t.request('POST', '/v1/privacy/export', { token });
    expect(req.status).toBe(202);
    expect(req.body).toMatchObject({ type: 'EXPORT', status: 'RECEIVED', exportFileId: null });
    const dup = await t.request('POST', '/v1/privacy/export', { token });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('PRIVACY_REQUEST_OPEN');

    await t.drain(); // queue identity.privacy_export
    const list = await t.request('GET', '/v1/privacy/requests', { token });
    const done = list.body.data.find((r: any) => r.id === req.body.id);
    expect(done.status).toBe('COMPLETED');
    expect(done.exportFileId).toBeTruthy();
    const [ev] = await t.adminSql<{ payload: any }[]>`SELECT payload FROM outbox_events WHERE event_type = 'privacy.export_ready' AND aggregate_id = ${req.body.id}`;
    expect(ev!.payload).toEqual({ requestId: req.body.id, userId: me.user.id });

    const [f] = await t.adminSql<{ storage_key: string; encrypted: boolean; retention_until: Date }[]>`SELECT storage_key, encrypted, retention_until FROM files WHERE id = ${done.exportFileId}`;
    expect(f!.encrypted).toBe(true);
    expect(Buffer.from(t.storage.objects.get(f!.storage_key)!.body).toString('latin1')).not.toContain(me.phone);
    const url = await t.request('GET', `/v1/files/${done.exportFileId}/url`, { token });
    expect(url.body.requiresAuth).toBe(true);
    const res = await t.app.request(new URL(url.body.url).pathname, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('attachment');
    const text = await res.text();
    const data = JSON.parse(text);
    expect(data.format).toBe('jastipkita-data-export/v1');
    expect(data.profile.phone).toBe(me.phone);
    expect(data.consents.map((c: any) => c.type).sort()).toEqual(['PRIVACY', 'TOS']);
    expect(data.requests[0].productName).toBe('Sepatu lari');
    expect(data.messagesSent.map((m: any) => m.body)).toEqual(['Halo, pesan saya sendiri']);
    expect(text).not.toContain('Pesan pribadi lawan bicara');
    expect(text).not.toContain(other.email);
    expect(text).not.toContain('Rahasia Orang Lain');
    expect(text).not.toMatch(/_enc|Hash"/);
    // nobody else may download it
    const stranger = await t.createUser({ roles: ['SUPER_ADMIN'] });
    expect((await t.request('GET', `/v1/files/${done.exportFileId}/url`, { token: stranger.accessToken })).status).toBe(403);

    // retention: the export file is purged after 7 days
    t.clock.advance(8 * DAY);
    const purge = await retentionPurge(t.deps);
    expect(purge['files.retention_until']).toBeGreaterThanOrEqual(1);
    expect(t.storage.objects.has(f!.storage_key)).toBe(false);
    expect((await t.request('GET', `/v1/files/${done.exportFileId}/url`, { token: (await relogin(me.phone)).tokens.accessToken })).body.error.code).toBe('FILE_NOT_READY');
  });
});

describe('privacy: account deletion', () => {
  it('blocked while a transaction is open', async () => {
    const u = await phoneLogin(t);
    const [rq] = await t.adminSql<{ id: string }[]>`INSERT INTO requests (buyer_id, source_type, product_name) VALUES (${u.user.id}, 'MANUAL', 'Kamera') RETURNING id`;
    await t.adminSql`INSERT INTO transactions (request_id, buyer_id) VALUES (${rq!.id}, ${u.user.id})`;
    const res = await t.request('POST', '/v1/privacy/delete-account', { token: u.tokens.accessToken, body: { confirm: true } });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DELETION_BLOCKED');
    expect(res.body.error.details).toMatchObject({ activeTransactions: 1, openDisputes: 0, unpaidPayouts: 0, inflightRefunds: 0 });
    expect((await t.request('GET', '/v1/me', { token: u.tokens.accessToken })).body.status).toBe('ACTIVE');
    // confirm flag is required
    expect((await t.request('POST', '/v1/privacy/delete-account', { token: u.tokens.accessToken, body: {} })).status).toBe(400);
  });

  it('schedules with a 14-day grace period, revokes sessions, can be cancelled after logging in again', async () => {
    const u = await phoneLogin(t);
    const res = await t.request('POST', '/v1/privacy/delete-account', { token: u.tokens.accessToken, body: { confirm: true, reason: 'tidak dipakai lagi' } });
    expect(res.status).toBe(202);
    expect(new Date(res.body.effectiveAt).getTime() - t.clock.now().getTime()).toBe(14 * DAY);
    expect(res.body.request).toMatchObject({ type: 'DELETION', status: 'IN_PROGRESS' });
    const [ev] = await t.adminSql<{ payload: any }[]>`SELECT payload FROM outbox_events WHERE event_type = 'account.deletion_scheduled' AND aggregate_id = ${u.user.id}`;
    expect(ev!.payload).toEqual({ requestId: res.body.request.id, userId: u.user.id, effectiveAt: res.body.effectiveAt });
    expect((await t.request('GET', '/v1/me', { token: u.tokens.accessToken })).status).toBe(401); // sessions revoked

    // log in again during the grace period → limited session
    const again = await relogin(u.phone);
    expect(again.user.status).toBe('PENDING_DELETION');
    expect(again.user.deletionScheduledFor).toBe(res.body.effectiveAt);
    const blocked = await t.request('GET', '/v1/me', { token: again.tokens.accessToken });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('ACCOUNT_INACTIVE');
    const reqs = await t.request('GET', '/v1/privacy/requests', { token: again.tokens.accessToken });
    expect(reqs.status).toBe(200);
    expect(reqs.body.data[0].scheduledFor).toBe(res.body.effectiveAt);

    const cancel = await t.request('POST', '/v1/privacy/cancel-deletion', { token: again.tokens.accessToken });
    expect(cancel.status).toBe(200);
    expect(cancel.body.status).toBe('CANCELLED');
    const me = await t.request('GET', '/v1/me', { token: again.tokens.accessToken });
    expect(me.status).toBe(200);
    expect(me.body.status).toBe('ACTIVE');
    expect(me.body.deletionScheduledFor).toBeNull();
    expect((await t.request('POST', '/v1/privacy/cancel-deletion', { token: again.tokens.accessToken })).status).toBe(404);
    // nothing is anonymized later
    t.clock.advance(15 * DAY);
    await finalizeDueDeletions(t.deps);
    const [row] = await t.adminSql<{ status: string }[]>`SELECT status FROM users WHERE id = ${u.user.id}`;
    expect(row!.status).toBe('ACTIVE');
  });

  it('the scheduled job anonymizes after the grace period (anonymize_user)', async () => {
    const u = await phoneLogin(t);
    await t.adminSql`UPDATE users SET email = ${`del-${Date.now()}@example.com`}, email_verified_at = now(), display_name = 'Akan Dihapus' WHERE id = ${u.user.id}`;
    const [row0] = await t.adminSql<{ email: string }[]>`SELECT email FROM users WHERE id = ${u.user.id}`;
    const email = row0!.email;
    const res = await t.request('POST', '/v1/privacy/delete-account', { token: u.tokens.accessToken, body: { confirm: true } });
    expect(res.status).toBe(202);

    t.clock.advance(13 * DAY);
    expect((await finalizeDueDeletions(t.deps)).completed).toBe(0);
    t.clock.advance(2 * DAY);
    const job = identityJobs.scheduled!.find((j) => j.name === 'identity.privacy.finalize_deletions')!;
    const out = (await job.run(t.deps)) as { completed: number };
    expect(out.completed).toBe(1);

    const [row] = await t.adminSql<{ status: string; email: string | null; phone_e164: string | null; display_name: string | null; anonymized_at: Date | null }[]>`
      SELECT status, email, phone_e164, display_name, anonymized_at FROM users WHERE id = ${u.user.id}`;
    expect(row).toMatchObject({ status: 'DELETED', email: null, phone_e164: null, display_name: null });
    expect(row!.anonymized_at).not.toBeNull();
    const [pr] = await t.adminSql<{ status: string }[]>`SELECT status FROM privacy_requests WHERE id = ${res.body.request.id}`;
    expect(pr!.status).toBe('COMPLETED');
    const [sup] = await t.adminSql<{ reason: string }[]>`SELECT reason FROM email_suppressions WHERE email_hash = ${Buffer.from(await t.deps.crypto.hashIdentifier('email', email))}`;
    expect(sup!.reason).toBe('ACCOUNT_DELETED');
    const [anon] = await t.adminSql<{ n: number }[]>`SELECT count(*)::int AS n FROM outbox_events WHERE event_type = 'user.anonymized' AND aggregate_id = ${u.user.id}`;
    expect(anon!.n).toBe(1);
    const [ids] = await t.adminSql<{ n: number }[]>`SELECT count(*)::int AS n FROM auth_identities WHERE user_id = ${u.user.id}`;
    expect(ids!.n).toBe(0);
    // the phone can sign up again as a brand-new account
    const fresh = await phoneLogin(t, u.phone);
    expect(fresh.isNewUser).toBe(true);
    expect(fresh.user.id).not.toBe(u.user.id);
  });
});

describe('privacy: purge jobs', () => {
  it('purges expired OTP challenges and idempotency keys', async () => {
    const u = await t.createUser();
    await otpRequest(t, { channel: 'EMAIL', destination: `purge-${Date.now()}@example.com`, purpose: 'LOGIN' });
    await t.adminSql`INSERT INTO idempotency_keys (user_id, key, method, path, request_hash, status, response_status, expires_at, created_at)
                     VALUES (${u.id}, 'idem-key-expired-1', 'POST', '/v1/x', '\\x00', 'COMPLETED', 200, ${new Date(t.clock.now().getTime() - 1000)}, ${new Date(t.clock.now().getTime() - DAY)})`;
    t.clock.advance(2 * DAY);
    const r = await purgeExpiredOtpAndIdempotency(t.deps);
    expect(r.otpChallenges).toBeGreaterThanOrEqual(1);
    expect(r.idempotencyKeys).toBe(1);
    const retention = await retentionPurge(t.deps);
    expect(retention.security_events).toBe('SKIPPED_APPEND_ONLY_OR_LEGAL_RETENTION');
    expect(typeof retention.otp_challenges).toBe('number');
  });
});
