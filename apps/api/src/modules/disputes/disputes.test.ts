import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext, type TestUser } from '../../../test/helpers';
import { createTransaction } from '../notifications/testing/fixtures';
import { runDisputeSla } from './sla-job';

let t: TestContext;
let buyer: TestUser;
let traveler: TestUser;
let stranger: TestUser;

beforeAll(async () => {
  t = await createTestContext();
  buyer = await t.createUser({ kycLevel: 2 });
  traveler = await t.createUser({ kycLevel: 4, mode: 'TRAVELER' });
  stranger = await t.createUser({ kycLevel: 2 });
});
afterAll(async () => {
  await t.close();
});

const open = (u: TestUser, txId: string, body: Record<string, unknown> = { type: 'DAMAGED_ITEM', description: 'Layar retak saat barang diterima', requestedResolution: 'REFUND_PARTIAL' }) =>
  t.request('POST', `/v1/transactions/${txId}/disputes`, { token: u.accessToken, body });

async function insertFile(ownerId: string, purpose: string) {
  const [f] = await t.adminSql<{ id: string }[]>`
    INSERT INTO files (owner_id, purpose, storage_provider, storage_key, mime, size_bytes, scan_status)
    VALUES (${ownerId}, ${purpose}, 'MOCK', ${`ev/${randomUUID()}`}, 'image/jpeg', 2048, 'CLEAN') RETURNING id`;
  return f!.id;
}

async function adminResolve(disputeId: string, resolution = 'NO_REFUND') {
  await t.adminSql`UPDATE disputes SET resolution = ${resolution}, resolution_note = 'Bukti tidak cukup' WHERE id = ${disputeId}`;
  for (const to of ['UNDER_REVIEW', 'RESOLVED']) {
    const [d] = await t.adminSql<{ version: number; status: string }[]>`SELECT version, status FROM disputes WHERE id = ${disputeId}`;
    if (d!.status === to) continue;
    await t.adminSql`SELECT transition_dispute(${disputeId}, ${d!.version}, ${to}, 'ADMIN', NULL, 'admin decision', '{}'::jsonb)`;
  }
}

describe('open dispute', () => {
  it('is not allowed before PURCHASED', async () => {
    const tx = await createTransaction(t, { buyerId: buyer.id, travelerId: traveler.id, to: 'PAYMENT_SECURED' });
    const res = await open(buyer, tx.id);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('STATUS_NOT_DISPUTABLE');
  });

  it('opens within the window: transaction → DISPUTED, evidence window + SLA deadlines, events and audit', async () => {
    const tx = await createTransaction(t, { buyerId: buyer.id, travelerId: traveler.id, to: 'DELIVERED' });
    const res = await open(buyer, tx.id);
    expect(res.status).toBe(201);
    const d = res.body;
    expect(d.number).toMatch(/^DSP-\d{6}-[0-9A-Z]{6}$/);
    expect(d).toMatchObject({ status: 'EVIDENCE_COLLECTION', transactionStatus: 'DISPUTED', openedByRole: 'BUYER', openedByMe: true, myRole: 'BUYER', requestedResolution: 'REFUND_PARTIAL' });
    expect(d.allowedActions).toEqual(['ADD_EVIDENCE', 'WITHDRAW']);
    const hours = (iso: string) => (new Date(iso).getTime() - t.clock.now().getTime()) / 3600_000;
    expect(Math.round(hours(d.evidenceDueAt))).toBe(72);
    expect(Math.round(hours(d.slaDueAt))).toBe(72 + 120);
    expect(d.timeline.map((e: { to: string }) => e.to)).toEqual(['OPEN', 'EVIDENCE_COLLECTION']);

    const [txRow] = await t.adminSql<{ status: string; disputed_at: Date | null }[]>`SELECT status, disputed_at FROM transactions WHERE id = ${tx.id}`;
    expect(txRow!.status).toBe('DISPUTED');
    const ev = await t.adminSql`SELECT event_type FROM outbox_events WHERE aggregate_id = ${d.id} ORDER BY id`;
    expect(ev.map((e) => e.event_type)).toEqual(['dispute.status_changed', 'dispute.opened']);
    const aud = await t.adminSql`SELECT 1 FROM audit_logs WHERE action = 'dispute.opened' AND entity_id = ${d.id}`;
    expect(aud).toHaveLength(1);

    // both parties are notified; the counterparty gets the evidence deadline (critical e-mail)
    await t.drain();
    const notes = await t.adminSql<{ user_id: string; event_type: string }[]>`SELECT user_id, event_type FROM notifications WHERE event_type = 'dispute.opened' AND data->>'disputeId' = ${d.id}`;
    expect(notes.map((n) => n.user_id).sort()).toEqual([buyer.id, traveler.id].sort());
    expect(t.email.outbox.some((m) => m.to === traveler.email && m.subject === `Dispute ${d.number} pada transaksi ${tx.number}`)).toBe(true);
    // the SYSTEM OPEN→EVIDENCE_COLLECTION hop is not a separate "updated" notification
    const upd = await t.adminSql`SELECT 1 FROM notifications WHERE event_type = 'dispute.updated' AND data->>'disputeId' = ${d.id}`;
    expect(upd).toHaveLength(0);

    const again = await open(traveler, tx.id);
    expect(again.status).toBe(422); // tx is DISPUTED now → not disputable
  });

  it('enforces the window after delivery, participants only and one active dispute', async () => {
    const late = await createTransaction(t, { buyerId: buyer.id, travelerId: traveler.id, to: 'DELIVERED' });
    await t.adminSql`UPDATE transactions SET delivered_at = now() - interval '73 hours' WHERE id = ${late.id}`;
    let res = await open(buyer, late.id);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('DISPUTE_WINDOW_CLOSED');

    const tx = await createTransaction(t, { buyerId: buyer.id, travelerId: traveler.id, to: 'TRAVELING' });
    res = await open(stranger, tx.id);
    expect(res.status).toBe(404);
    res = await open(buyer, tx.id, { type: 'NOPE', description: 'x' });
    expect(res.status).toBe(400);
    // an active dispute already exists (e.g. created by an admin tool) → 409
    await t.adminSql`INSERT INTO disputes (transaction_id, opened_by, opened_by_role, type, description) VALUES (${tx.id}, ${traveler.id}, 'TRAVELER', 'OTHER', 'Dibuka oleh admin untuk tes')`;
    res = await open(buyer, tx.id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DISPUTE_ALREADY_OPEN');
  });
});

describe('evidence, detail & list', () => {
  let disputeId: string;
  let txId: string;
  let chatMessageId: string;

  beforeAll(async () => {
    const tx = await createTransaction(t, { buyerId: buyer.id, travelerId: traveler.id, to: 'DELIVERED' });
    txId = tx.id;
    await t.drain(); // conversation exists
    const [conv] = await t.adminSql<{ id: string }[]>`SELECT id FROM conversations WHERE transaction_id = ${tx.id}`;
    const msg = await t.request('POST', `/v1/conversations/${conv!.id}/messages`, { token: traveler.accessToken, body: { type: 'TEXT', body: 'Barang sudah aku cek sebelum diserahkan.' } });
    chatMessageId = msg.body.id;
    disputeId = (await open(buyer, tx.id)).body.id;
  });

  it('accepts own files, transaction files and chat messages; rejects foreign references', async () => {
    const photo = await insertFile(buyer.id, 'EVIDENCE');
    let res = await t.request('POST', `/v1/disputes/${disputeId}/evidence`, { token: buyer.accessToken, body: { type: 'PHOTO', fileId: photo, note: 'Foto layar retak' } });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ party: 'BUYER', type: 'PHOTO', fileId: photo, mine: true });
    const evidenceId = res.body.id;

    res = await t.request('POST', `/v1/disputes/${disputeId}/evidence`, { token: traveler.accessToken, body: { type: 'CHAT', messageId: chatMessageId } });
    expect(res.status).toBe(201);
    expect(res.body.party).toBe('TRAVELER');

    const foreign = await insertFile(stranger.id, 'EVIDENCE');
    res = await t.request('POST', `/v1/disputes/${disputeId}/evidence`, { token: buyer.accessToken, body: { type: 'PHOTO', fileId: foreign } });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('EVIDENCE_FILE_NOT_ALLOWED');
    res = await t.request('POST', `/v1/disputes/${disputeId}/evidence`, { token: buyer.accessToken, body: { type: 'CHAT', messageId: randomUUID() } });
    expect(res.body.error.code).toBe('EVIDENCE_MESSAGE_NOT_ALLOWED');
    res = await t.request('POST', `/v1/disputes/${disputeId}/evidence`, { token: buyer.accessToken, body: { type: 'PHOTO', note: 'lupa file' } });
    expect(res.status).toBe(400);
    res = await t.request('POST', `/v1/disputes/${disputeId}/evidence`, { token: stranger.accessToken, body: { type: 'OTHER', note: 'hai' } });
    expect(res.status).toBe(404);

    // traveler (counterparty) sees evidence metadata of both sides
    const detail = await t.request('GET', `/v1/disputes/${disputeId}`, { token: traveler.accessToken });
    expect(detail.status).toBe(200);
    expect(detail.body.evidence.map((e: { party: string; mine: boolean }) => [e.party, e.mine])).toEqual([
      ['BUYER', false],
      ['TRAVELER', true],
    ]);
    expect(detail.body.openedByMe).toBe(false);
    expect(detail.body.allowedActions).toEqual(['ADD_EVIDENCE']);
    // files through participant-checked short-lived URLs
    const url = await t.request('GET', `/v1/disputes/${disputeId}/evidence/${evidenceId}/file-url`, { token: traveler.accessToken });
    expect(url.status).toBe(200);
    expect(url.body.url).toContain('/v1/dev/storage/download/');
    expect((await t.request('GET', `/v1/disputes/${disputeId}/evidence/${evidenceId}/file-url`, { token: stranger.accessToken })).status).toBe(404);
    expect((await t.request('GET', `/v1/disputes/${disputeId}`, { token: stranger.accessToken })).status).toBe(404);

    // counterpart is notified about new evidence
    await t.drain();
    const n = await t.adminSql`SELECT 1 FROM notifications WHERE user_id = ${traveler.id} AND event_type = 'dispute.evidence_added'`;
    expect(n.length).toBeGreaterThanOrEqual(1);
  });

  it('lists my disputes for both parties with a status filter', async () => {
    const mineB = await t.request('GET', '/v1/disputes/mine?limit=50', { token: buyer.accessToken });
    expect(mineB.body.data.some((d: { id: string }) => d.id === disputeId)).toBe(true);
    const mineT = await t.request('GET', '/v1/disputes/mine?status=EVIDENCE_COLLECTION&limit=50', { token: traveler.accessToken });
    expect(mineT.body.data.every((d: { status: string }) => d.status === 'EVIDENCE_COLLECTION')).toBe(true);
    expect((await t.request('GET', '/v1/disputes/mine', { token: stranger.accessToken })).body.data).toHaveLength(0);
    const p1 = await t.request('GET', '/v1/disputes/mine?limit=1', { token: buyer.accessToken });
    expect(p1.body.nextCursor).toBeTruthy();
    const p2 = await t.request('GET', `/v1/disputes/mine?limit=1&cursor=${encodeURIComponent(p1.body.nextCursor)}`, { token: buyer.accessToken });
    expect(p2.body.data[0].id).not.toBe(p1.body.data[0].id);
  });

  it('SLA job: evidence window closes → UNDER_REVIEW; review overdue → breach flag; evidence then rejected', async () => {
    await t.adminSql`UPDATE disputes SET evidence_due_at = now() - interval '1 minute' WHERE id = ${disputeId}`;
    let r = await runDisputeSla(t.deps);
    expect(r.toReview).toBeGreaterThanOrEqual(1);
    let [d] = await t.adminSql<{ status: string; sla_breach: string | null }[]>`SELECT status, sla_breach FROM disputes WHERE id = ${disputeId}`;
    expect(d!.status).toBe('UNDER_REVIEW');
    const res = await t.request('POST', `/v1/disputes/${disputeId}/evidence`, { token: buyer.accessToken, body: { type: 'OTHER', note: 'tambahan' } });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('EVIDENCE_WINDOW_CLOSED');

    await t.adminSql`UPDATE disputes SET sla_due_at = now() - interval '1 minute' WHERE id = ${disputeId}`;
    r = await runDisputeSla(t.deps);
    expect(r.breached).toBeGreaterThanOrEqual(1);
    [d] = await t.adminSql<{ status: string; sla_breach: string | null }[]>`SELECT status, sla_breach FROM disputes WHERE id = ${disputeId}`;
    expect(d!.sla_breach).toBe('REVIEW_OVERDUE');
    const ev = await t.adminSql`SELECT 1 FROM outbox_events WHERE event_type = 'dispute.sla_breached' AND aggregate_id = ${disputeId}`;
    expect(ev).toHaveLength(1);
    // flagged once only
    await runDisputeSla(t.deps);
    expect(await t.adminSql`SELECT 1 FROM outbox_events WHERE event_type = 'dispute.sla_breached' AND aggregate_id = ${disputeId}`).toHaveLength(1);
    void txId;
  });

  it('appeal: once, within the window, after RESOLVED; resets the review SLA', async () => {
    let res = await t.request('POST', `/v1/disputes/${disputeId}/appeal`, { token: buyer.accessToken, body: { reason: 'Keputusan belum mempertimbangkan foto saya' } });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('DISPUTE_NOT_RESOLVED');
    await adminResolve(disputeId);
    const detail = await t.request('GET', `/v1/disputes/${disputeId}`, { token: buyer.accessToken });
    expect(detail.body.allowedActions).toEqual(['APPEAL']);
    expect(detail.body.appealDeadline).toBeTruthy();
    res = await t.request('POST', `/v1/disputes/${disputeId}/appeal`, { token: buyer.accessToken, body: { reason: 'pendek' } });
    expect(res.status).toBe(400);
    res = await t.request('POST', `/v1/disputes/${disputeId}/appeal`, { token: buyer.accessToken, body: { reason: 'Keputusan belum mempertimbangkan foto saya' } });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('APPEALED');
    const [d] = await t.adminSql<{ sla_breach: string | null; sla_due_at: Date }[]>`SELECT sla_breach, sla_due_at FROM disputes WHERE id = ${disputeId}`;
    expect(d!.sla_breach).toBeNull();
    expect(d!.sla_due_at.getTime()).toBeGreaterThan(Date.now());
    expect(await t.adminSql`SELECT 1 FROM outbox_events WHERE event_type = 'dispute.appealed' AND aggregate_id = ${disputeId}`).toHaveLength(1);

    // decided again → a second appeal is refused
    await adminResolve(disputeId);
    res = await t.request('POST', `/v1/disputes/${disputeId}/appeal`, { token: traveler.accessToken, body: { reason: 'Saya juga ingin banding lagi' } });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('APPEAL_ALREADY_USED');
  });

  it('appeal window: refused after it closes, and the SLA job then closes the dispute', async () => {
    const tx = await createTransaction(t, { buyerId: buyer.id, travelerId: traveler.id, to: 'DELIVERED' });
    const id = (await open(buyer, tx.id)).body.id;
    await adminResolve(id);
    await t.adminSql`UPDATE disputes SET resolved_at = now() - interval '73 hours' WHERE id = ${id}`;
    const res = await t.request('POST', `/v1/disputes/${id}/appeal`, { token: buyer.accessToken, body: { reason: 'Saya tidak setuju dengan keputusan ini' } });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('APPEAL_WINDOW_CLOSED');
    const r = await runDisputeSla(t.deps);
    expect(r.closed).toBeGreaterThanOrEqual(1);
    const [d] = await t.adminSql<{ status: string; closed_at: Date | null }[]>`SELECT status, closed_at FROM disputes WHERE id = ${id}`;
    expect(d!.status).toBe('CLOSED');
    expect(d!.closed_at).not.toBeNull();
  });
});

describe('withdraw', () => {
  it('opener only; a buyer withdrawing on a delivered item resumes the transaction (BUYER_CONFIRMED)', async () => {
    const tx = await createTransaction(t, { buyerId: buyer.id, travelerId: traveler.id, to: 'DELIVERED' });
    const id = (await open(buyer, tx.id)).body.id;
    let res = await t.request('POST', `/v1/disputes/${id}/withdraw`, { token: traveler.accessToken, body: {} });
    expect(res.status).toBe(403);
    res = await t.request('POST', `/v1/disputes/${id}/withdraw`, { token: buyer.accessToken, body: { reason: 'Sudah diselesaikan baik-baik' } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'CLOSED', transactionFollowUp: 'BUYER_CONFIRMED' });
    const [row] = await t.adminSql<{ status: string }[]>`SELECT status FROM transactions WHERE id = ${tx.id}`;
    expect(row!.status).toBe('BUYER_CONFIRMED');
    res = await t.request('POST', `/v1/disputes/${id}/withdraw`, { token: buyer.accessToken });
    expect(res.status).toBe(422);
  });

  it('a pre-delivery withdrawal leaves the transaction DISPUTED for ops (no §4 edge back)', async () => {
    const tx = await createTransaction(t, { buyerId: buyer.id, travelerId: traveler.id, to: 'TRAVELING' });
    const id = (await open(traveler, tx.id, { type: 'DELIVERY_DISPUTE', description: 'Penitip tidak bisa dihubungi untuk serah terima' })).body.id;
    const res = await t.request('POST', `/v1/disputes/${id}/withdraw`, { token: traveler.accessToken });
    expect(res.status).toBe(200);
    expect(res.body.transactionFollowUp).toBe('ADMIN_REQUIRED');
    const [row] = await t.adminSql<{ status: string }[]>`SELECT status FROM transactions WHERE id = ${tx.id}`;
    expect(row!.status).toBe('DISPUTED');
  });
});
