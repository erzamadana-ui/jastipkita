import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext, type TestUser } from '../../../../test/helpers';
import { createTransaction } from '../../notifications/testing/fixtures';
import { type Admin, as, auditRows, createAdmin } from '../test-support';

let t: TestContext;
let agent: Admin;
let agentB: Admin;
let marketing: Admin;
let buyer: TestUser;
let traveler: TestUser;
let txId: string;
let convId: string;
let ticketId: string;
let flaggedId: string;

beforeAll(async () => {
  t = await createTestContext();
  agent = await createAdmin(t, ['SUPPORT']);
  agentB = await createAdmin(t, ['SUPPORT']);
  marketing = await createAdmin(t, ['MARKETING']);
  buyer = await t.createUser({ kycLevel: 2 });
  traveler = await t.createUser({ kycLevel: 4, mode: 'TRAVELER' });
  txId = (await createTransaction(t, { buyerId: buyer.id, travelerId: traveler.id, to: 'DELIVERED' })).id;
  await t.drain();
  const [c] = await t.adminSql<{ id: string }[]>`SELECT id FROM conversations WHERE transaction_id = ${txId}`;
  convId = c!.id;
  const msg = await t.request('POST', `/v1/conversations/${convId}/messages`, {
    token: traveler.accessToken,
    body: { type: 'TEXT', body: 'Biar cepat transfer langsung aja ke BCA 1234567890 ya, atau WA 0812-3456-7890' },
  });
  flaggedId = msg.body.id;
  const tk = await t.request('POST', '/v1/support/tickets', {
    token: buyer.accessToken,
    body: { category: 'TRANSACTION', subject: 'Traveler minta transfer di luar aplikasi', message: 'Traveler minta saya transfer langsung ke rekeningnya.', transactionId: txId },
  });
  ticketId = tk.body.id;
});
afterAll(async () => {
  await t.close();
});

describe('support tickets', () => {
  it('queue (SUPPORT only), detail, assign → IN_PROGRESS', async () => {
    expect((await as(t, marketing, 'GET', '/v1/admin/support/tickets')).status).toBe(403);
    const q = await as(t, agent, 'GET', '/v1/admin/support/tickets?assignee=none');
    expect(q.status, JSON.stringify(q.body)).toBe(200);
    expect(q.body.data.find((x: any) => x.id === ticketId)).toMatchObject({ status: 'OPEN', category: 'TRANSACTION' });
    const d = await as(t, agent, 'GET', `/v1/admin/support/tickets/${ticketId}`);
    expect(d.body).toMatchObject({ transaction: { id: txId }, conversationId: convId });
    expect(d.body.messages).toHaveLength(1);
    const bad = await as(t, agent, 'POST', `/v1/admin/support/tickets/${ticketId}/assign`, { assigneeId: marketing.id });
    expect(bad.body.error.code).toBe('ASSIGNEE_NOT_ALLOWED');
    const a = await as(t, agent, 'POST', `/v1/admin/support/tickets/${ticketId}/assign`, {});
    expect(a.body.assigneeId).toBe(agent.id);
  });

  it('internal note stays hidden from the user; public reply → PENDING_USER, first response, event', async () => {
    const note = await as(t, agent, 'POST', `/v1/admin/support/tickets/${ticketId}/reply`, { body: 'Cek riwayat chat — indikasi off-platform', internal: true });
    expect(note.status).toBe(200);
    const reply = await as(t, agent, 'POST', `/v1/admin/support/tickets/${ticketId}/reply`, { body: 'Terima kasih, jangan transfer di luar aplikasi. Kami tindak lanjuti.' });
    expect(reply.body.status).toBe('PENDING_USER');
    const mine = await t.request('GET', `/v1/support/tickets/${ticketId}`, { token: buyer.accessToken });
    const bodies = mine.body.messages.map((m: any) => m.body);
    expect(bodies).toContain('Terima kasih, jangan transfer di luar aplikasi. Kami tindak lanjuti.');
    expect(bodies).not.toContain('Cek riwayat chat — indikasi off-platform');
    const [row] = await t.adminSql<{ first_response_at: Date | null }[]>`SELECT first_response_at FROM support_tickets WHERE id = ${ticketId}`;
    expect(row!.first_response_at).not.toBeNull();
    const ev = await t.adminSql<{ payload: any }[]>`SELECT payload FROM outbox_events WHERE event_type = 'support.ticket_updated' AND aggregate_id = ${ticketId}`;
    expect(ev.at(-1)!.payload).toMatchObject({ ticketId, userId: buyer.id, status: 'PENDING_USER', actorType: 'AGENT', action: 'REPLIED' });
    expect(await auditRows(t, 'support.ticket_note_added', ticketId)).toHaveLength(1);
  });

  it('priority change + SLA view with definition', async () => {
    const p = await as(t, agentB, 'PATCH', `/v1/admin/support/tickets/${ticketId}`, { priority: 'URGENT', note: 'Indikasi penipuan' });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body.priority).toBe('URGENT');
    const sla = await as(t, agent, 'GET', '/v1/admin/support/sla');
    expect(sla.body.definition).toMatch(/SLA/);
    expect(sla.body.byPriority.map((x: any) => x.priority)).toEqual(['LOW', 'NORMAL', 'HIGH', 'URGENT']);
    expect(sla.body.byPriority.find((x: any) => x.priority === 'URGENT').open).toBe(1);
    expect(sla.body.hoursByPriority.URGENT).toBe(4);
  });
});

describe('chat moderation', () => {
  it('flagged queue shows masked text only; reveal is audited', async () => {
    const q = await as(t, agent, 'GET', '/v1/admin/chat/flagged');
    expect(q.status, JSON.stringify(q.body)).toBe(200);
    const m = q.body.data.find((x: any) => x.id === flaggedId);
    expect(m).toMatchObject({ moderationStatus: 'FLAGGED', reasons: ['BANK_ACCOUNT', 'CONTACT_PHONE', 'OFF_PLATFORM_PAYMENT'] });
    expect(JSON.stringify(q.body)).not.toContain('1234567890');
    const r = await as(t, agent, 'POST', `/v1/admin/chat/messages/${flaggedId}/reveal`, { reason: 'Investigasi tiket off-platform' });
    expect(r.body.body).toContain('1234567890');
    expect(await auditRows(t, 'chat.message_revealed', flaggedId)).toHaveLength(1);
    expect((await as(t, marketing, 'GET', '/v1/admin/chat/flagged')).status).toBe(403);
  });

  it('hide → HIDDEN (both parties see it hidden) → unhide restores FLAGGED', async () => {
    const h = await as(t, agent, 'POST', `/v1/admin/chat/messages/${flaggedId}/hide`, { reason: 'Ajakan transaksi di luar aplikasi' });
    expect(h.body.moderationStatus).toBe('HIDDEN');
    expect((await as(t, agent, 'POST', `/v1/admin/chat/messages/${flaggedId}/hide`, { reason: 'dua kali' })).status).toBe(409);
    const u = await as(t, agentB, 'POST', `/v1/admin/chat/messages/${flaggedId}/unhide`, { reason: 'Salah sembunyikan' });
    expect(u.body.moderationStatus).toBe('FLAGGED');
  });

  it('conversation access needs an OPEN ticket/dispute on the same transaction (audited)', async () => {
    const none = await as(t, agent, 'GET', `/v1/admin/chat/conversations/${convId}/messages?reason=cek`);
    expect(none.status).toBe(400); // reason too short (min 5)
    const noScope = await as(t, agent, 'GET', `/v1/admin/chat/conversations/${convId}/messages?reason=Investigasi%20tiket`);
    expect(noScope.body.error.code).toBe('CHAT_ACCESS_SCOPE_REQUIRED');
    const ok = await as(t, agent, 'GET', `/v1/admin/chat/conversations/${convId}/messages?ticketId=${ticketId}&reason=Investigasi%20tiket`);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.basis).toEqual({ type: 'TICKET', id: ticketId });
    expect(ok.body.data.length).toBeGreaterThan(0);
    expect(await auditRows(t, 'chat.conversation_viewed', convId)).toHaveLength(1);
    await as(t, agent, 'PATCH', `/v1/admin/support/tickets/${ticketId}`, { status: 'CLOSED' });
    const closed = await as(t, agent, 'GET', `/v1/admin/chat/conversations/${convId}/messages?ticketId=${ticketId}&reason=Investigasi%20tiket`);
    expect(closed.status).toBe(403);
    expect(closed.body.error.code).toBe('CHAT_ACCESS_OUT_OF_SCOPE');
  });
});
