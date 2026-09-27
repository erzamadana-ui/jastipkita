import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../../../test/helpers';
import { JPEG, phoneLogin, scanJson, uploadFile } from '../auth/test-support';
import { computeLevel } from './level';
import { namesMatch } from './service';

let t: TestContext;
beforeAll(async () => {
  t = await createTestContext({ env: { KYC_PROVIDER: 'mock' } });
});
afterAll(async () => {
  await t.close();
});

let nikSeq = 0;
const nik = () => `3174${String(Date.now()).slice(-8)}${String(nikSeq++).padStart(4, '0')}`;

async function kycReadyUser() {
  const u = await phoneLogin(t);
  const token = u.tokens.accessToken;
  t.clock.advance(61_000);
  expect((await t.request('POST', '/v1/me/consents', { token, body: { type: 'KYC', version: '2026-09' } })).status).toBe(201);
  const idFront = await uploadFile(t, token, 'KYC', 'image/jpeg', JPEG(300, 3));
  const selfie = await uploadFile(t, token, 'KYC', 'image/jpeg', JPEG(300, 5));
  return { id: u.user.id as string, token, idFront, selfie };
}

const submission = (u: { idFront: string; selfie: string }, idNumber: string, extra: Record<string, unknown> = {}) => ({
  idType: 'KTP',
  idNumber,
  fullName: 'Budi Santoso',
  dateOfBirth: '1990-05-17',
  documents: { idFront: u.idFront, selfie: u.selfie },
  ...extra,
});

async function verifiedTrip(travelerId: string) {
  const admin = await t.createUser({ roles: ['OPERATIONS'] });
  const [trip] = await t.adminSql<{ id: string }[]>`
    INSERT INTO trips (traveler_id, origin_country, origin_city, destination_country, destination_city, departure_date, arrival_date, capacity_kg, fee_type, fee_value)
    VALUES (${travelerId}, 'JP', 'Tokyo', 'ID', 'Jakarta', '2026-10-10', '2026-10-11', 5, 'FIXED', 150000) RETURNING id`;
  await t.adminSql`SELECT transition_trip(${trip!.id}::uuid, 1, 'VERIFICATION_PENDING', 'TRAVELER', ${travelerId}::uuid)`;
  await t.adminSql`SELECT transition_trip(${trip!.id}::uuid, 2, 'VERIFIED', 'ADMIN', ${admin.id}::uuid)`;
  await t.adminSql`SELECT jk_outbox('trip', ${trip!.id}, 'trip.verified', ${t.adminSql.json({ tripId: trip!.id, travelerId } as never)}::jsonb)`;
  return trip!.id;
}

describe('KYC level rules', () => {
  it('computeLevel only raises and follows §2', () => {
    const none = { phoneVerified: false, identityApproved: false, payoutVerified: false, tripVerified: false };
    expect(computeLevel(1, none)).toBe(1);
    expect(computeLevel(1, { ...none, phoneVerified: true })).toBe(2);
    expect(computeLevel(1, { ...none, identityApproved: true })).toBe(1); // needs level 2 first
    expect(computeLevel(2, { ...none, phoneVerified: true, identityApproved: true })).toBe(3);
    expect(computeLevel(3, { ...none, payoutVerified: true })).toBe(3);
    expect(computeLevel(3, { ...none, payoutVerified: true, tripVerified: true })).toBe(4);
    expect(computeLevel(5, none)).toBe(5); // L5 is the trust job's; never lowered here
  });

  it('bank name matching tolerates truncation/abbreviation', () => {
    expect(namesMatch('BUDI SANTOSO', 'Budi Santoso')).toBe(true);
    expect(namesMatch('MUH RIZKY PRATAMA', 'Muhammad Rizky Pratama')).toBe(true);
    expect(namesMatch('SITI RAHMA', 'Budi Santoso')).toBe(false);
  });
});

describe('KYC status & submission', () => {
  it('status shows the next level requirements; level 1 cannot submit; consent is required', async () => {
    const l1 = await t.createUser({ kycLevel: 1 });
    const s1 = await t.request('GET', '/v1/kyc/status', { token: l1.accessToken });
    expect(s1.status).toBe(200);
    expect(s1.body).toMatchObject({ level: 1, levelCode: 'REGISTERED', next: { level: 2, requirements: [{ code: 'PHONE_VERIFIED', met: false }] } });
    const denied = await t.request('POST', '/v1/kyc/submissions', { token: l1.accessToken, body: submission({ idFront: crypto.randomUUID(), selfie: crypto.randomUUID() }, nik()) });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('KYC_LEVEL_REQUIRED');

    const l2 = await phoneLogin(t);
    const s2 = await t.request('GET', '/v1/kyc/status', { token: l2.tokens.accessToken });
    expect(s2.body.next.level).toBe(3);
    expect(s2.body.next.requirements.map((r: any) => r.code)).toEqual(['KYC_CONSENT', 'IDENTITY_SUBMITTED', 'IDENTITY_APPROVED']);
    const noConsent = await t.request('POST', '/v1/kyc/submissions', { token: l2.tokens.accessToken, body: submission({ idFront: crypto.randomUUID(), selfie: crypto.randomUUID() }, nik()) });
    expect(noConsent.status).toBe(422);
    expect(noConsent.body.error.code).toBe('CONSENT_REQUIRED');
    expect(noConsent.body.error.details.required).toEqual(['KYC']);
  });

  it('mock provider approves → level 3; identity stored encrypted + hashed; events emitted', async () => {
    const u = await kycReadyUser();
    const idNumber = nik();
    const res = await t.request('POST', '/v1/kyc/submissions', { token: u.token, body: submission(u, idNumber) });
    expect(res.status).toBe(201);
    expect(res.body.submission.status).toBe('APPROVED');
    expect(res.body.submission.provider).toBe('MOCK');
    expect(res.body.submission.providerEnv).toBe('TEST');
    expect(res.body.kycLevel).toBe(3);

    const [ir] = await t.adminSql<{ id: string; id_number_enc: Buffer; id_number_hash: Buffer; full_name_enc: Buffer; verified_at: Date | null }[]>`
      SELECT id, id_number_enc, id_number_hash, full_name_enc, verified_at FROM identity_records WHERE user_id = ${u.id}`;
    expect(ir!.verified_at).not.toBeNull();
    expect(ir!.id_number_enc.toString('latin1')).not.toContain(idNumber);
    expect(ir!.full_name_enc.toString('latin1')).not.toContain('Budi');
    expect(ir!.id_number_hash.length).toBe(32);
    expect(await t.deps.crypto.decryptString(new Uint8Array(ir!.id_number_enc), `identity_records.id_number:${ir!.id}`)).toBe(idNumber);
    const docs = await t.adminSql<{ type: string; status: string }[]>`SELECT type, status FROM kyc_documents WHERE user_id = ${u.id} ORDER BY type`;
    expect(docs).toEqual([{ type: 'KTP', status: 'ACCEPTED' }, { type: 'SELFIE', status: 'ACCEPTED' }]);
    const events = await t.adminSql<{ event_type: string; payload: any }[]>`
      SELECT event_type, payload FROM outbox_events WHERE event_type LIKE 'kyc.%' AND payload->>'userId' = ${u.id} ORDER BY id`;
    expect(events.map((e) => e.event_type)).toEqual(['kyc.level_changed', 'kyc.submitted', 'kyc.approved', 'kyc.level_changed']);
    expect(events[3]!.payload).toEqual({ userId: u.id, from: 2, to: 3 });
    expect(events[2]!.payload).toEqual({ userId: u.id, submissionId: res.body.submission.id, targetLevel: 3 });
    const audits = await t.adminSql<{ action: string }[]>`SELECT action FROM audit_logs WHERE entity_id = ${res.body.submission.id} ORDER BY id`;
    expect(audits.map((a) => a.action)).toEqual(['kyc.submitted', 'kyc.approved']);

    const again = await t.request('POST', '/v1/kyc/submissions', { token: u.token, body: submission(u, nik()) });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('KYC_ALREADY_VERIFIED');

    // duplicate identity on another account → rejected + risk assessment
    const v = await kycReadyUser();
    const dup = await t.request('POST', '/v1/kyc/submissions', { token: v.token, body: submission(v, idNumber.replace(/(\d{4})/, '$1 ')) });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('IDENTITY_ALREADY_REGISTERED');
    const [risk] = await t.adminSql<{ decision: string; signals: any }[]>`SELECT decision, signals FROM risk_assessments WHERE subject_id = ${v.id} AND signals->>'stage' = 'KYC_SUBMISSION'`;
    expect(risk!.decision).toBe('REVIEW');
    const [sec] = await t.adminSql<{ severity: string }[]>`SELECT severity FROM security_events WHERE user_id = ${v.id} AND type = 'KYC_DUPLICATE_IDENTITY'`;
    expect(sec!.severity).toBe('HIGH');
    const [none] = await t.adminSql<{ n: number }[]>`SELECT count(*)::int AS n FROM kyc_submissions WHERE user_id = ${v.id}`;
    expect(none!.n).toBe(0);
  });

  it('validation: NIK format, age, document ownership & purpose', async () => {
    const u = await kycReadyUser();
    expect((await t.request('POST', '/v1/kyc/submissions', { token: u.token, body: submission(u, '12345') })).body.error.code).toBe('ID_NUMBER_INVALID');
    expect((await t.request('POST', '/v1/kyc/submissions', { token: u.token, body: submission(u, nik(), { dateOfBirth: '2015-01-01' }) })).body.error.code).toBe('KYC_AGE_REQUIREMENT');
    expect((await t.request('POST', '/v1/kyc/submissions', { token: u.token, body: submission(u, nik(), { idType: 'PASSPORT', idNumber: 'X1234567' }) })).body.error.code).toBe('NATIONALITY_REQUIRED');
    const other = await kycReadyUser();
    const stolen = await t.request('POST', '/v1/kyc/submissions', { token: u.token, body: submission({ idFront: other.idFront, selfie: u.selfie }, nik()) });
    expect(stolen.body.error.code).toBe('KYC_DOCUMENTS_INVALID');
    const avatar = await uploadFile(t, u.token, 'AVATAR', 'image/jpeg', JPEG());
    const wrongPurpose = await t.request('POST', '/v1/kyc/submissions', { token: u.token, body: submission({ idFront: avatar, selfie: u.selfie }, nik()) });
    expect(wrongPurpose.body.error.code).toBe('KYC_DOCUMENTS_INVALID');
  });

  it('provider rejection → REJECTED + kyc.rejected; manual review stays IN_REVIEW and blocks a second submission', async () => {
    const kyc = t.deps.providers.kyc;
    const original = kyc.verify.bind(kyc);
    try {
      (kyc as { verify: typeof kyc.verify }).verify = async () => ({ status: 'FAILED', livenessScore: 0.2, faceMatchScore: 0.3, reasons: ['LIVENESS_FAILED'], providerRef: 'mock_x' });
      const u = await kycReadyUser();
      const res = await t.request('POST', '/v1/kyc/submissions', { token: u.token, body: submission(u, nik()) });
      expect(res.status).toBe(201);
      expect(res.body.submission).toMatchObject({ status: 'REJECTED', rejectionCode: 'LIVENESS_FAILED' });
      expect(res.body.kycLevel).toBe(2);
      const [ev] = await t.adminSql<{ payload: any }[]>`SELECT payload FROM outbox_events WHERE event_type = 'kyc.rejected' AND payload->>'userId' = ${u.id}`;
      expect(ev!.payload.reason).toBe('LIVENESS_FAILED');

      (kyc as { verify: typeof kyc.verify }).verify = async () => ({ status: 'MANUAL_REVIEW', reasons: ['MANUAL_REVIEW_REQUIRED'] });
      t.clock.advance(1000);
      const retry = await t.request('POST', '/v1/kyc/submissions', { token: u.token, body: submission(u, nik()) });
      expect(retry.body.submission.status).toBe('IN_REVIEW');
      const open = await t.request('POST', '/v1/kyc/submissions', { token: u.token, body: submission(u, nik()) });
      expect(open.status).toBe(409);
      expect(open.body.error.code).toBe('KYC_SUBMISSION_OPEN');
      const st = await t.request('GET', '/v1/kyc/status', { token: u.token });
      expect(st.body.submissions.map((s: any) => s.status)).toEqual(['IN_REVIEW', 'REJECTED']);
      expect(st.body.next.requirements.find((r: any) => r.code === 'IDENTITY_SUBMITTED').met).toBe(true);
    } finally {
      (kyc as { verify: typeof kyc.verify }).verify = original;
    }
  });
});

describe('payout accounts & level 4', () => {
  it('K3+ only; masked; name inquiry; default handling; level 4 via outbox (trip verified)', async () => {
    const l2 = await phoneLogin(t);
    expect((await t.request('GET', '/v1/kyc/payout-accounts', { token: l2.tokens.accessToken })).status).toBe(403);

    const u = await kycReadyUser();
    await t.request('POST', '/v1/kyc/submissions', { token: u.token, body: submission(u, nik()) });
    const payment = t.payment;
    const original = payment.validateBankAccount.bind(payment);
    try {
      payment.validateBankAccount = (async (i: { bankCode: string; accountNumber: string }) => ({ valid: /^\d{6,20}$/.test(i.accountNumber) && !i.accountNumber.startsWith('000'), holderName: i.accountNumber.startsWith('9') ? 'SITI RAHMA' : 'BUDI SANTOSO' })) as typeof payment.validateBankAccount;
      const invalid = await t.request('POST', '/v1/kyc/payout-accounts', { token: u.token, body: { bankCode: 'BCA', accountNumber: '0001112223', holderName: 'Budi Santoso' } });
      expect(invalid.status).toBe(422);
      expect(invalid.body.error.code).toBe('BANK_ACCOUNT_INVALID');
      const mismatch = await t.request('POST', '/v1/kyc/payout-accounts', { token: u.token, body: { bankCode: 'BCA', accountNumber: '9876543210', holderName: 'Budi Santoso' } });
      expect(mismatch.status).toBe(422);
      expect(mismatch.body.error.code).toBe('BANK_ACCOUNT_NAME_MISMATCH');

      const accountNumber = '1234560961';
      const add = await t.request('POST', '/v1/kyc/payout-accounts', { token: u.token, body: { bankCode: 'bca', accountNumber, holderName: 'Budi Santoso' } });
      expect(add.status).toBe(201);
      expect(add.body).toMatchObject({ bankCode: 'BCA', accountMask: '****0961', verificationStatus: 'VERIFIED', isDefault: true, holderName: 'BUDI SANTOSO' });
      expect(JSON.stringify(add.body)).not.toContain(accountNumber);
      const [row] = await t.adminSql<{ id: string; account_number_enc: Buffer }[]>`SELECT id, account_number_enc FROM payout_accounts WHERE id = ${add.body.id}`;
      expect(row!.account_number_enc.toString('latin1')).not.toContain(accountNumber);
      expect(await t.deps.crypto.decryptString(new Uint8Array(row!.account_number_enc), `payout_accounts.account_number:${row!.id}`)).toBe(accountNumber);
      const dupe = await t.request('POST', '/v1/kyc/payout-accounts', { token: u.token, body: { bankCode: 'BCA', accountNumber, holderName: 'Budi Santoso' } });
      expect(dupe.body.error.code).toBe('PAYOUT_ACCOUNT_EXISTS');

      const second = await t.request('POST', '/v1/kyc/payout-accounts', { token: u.token, body: { bankCode: 'MANDIRI', accountNumber: '5550001234', holderName: 'Budi Santoso' } });
      expect(second.body.isDefault).toBe(false);
      const def = await t.request('POST', `/v1/kyc/payout-accounts/${second.body.id}/default`, { token: u.token });
      expect(def.body.isDefault).toBe(true);
      const list = await t.request('GET', '/v1/kyc/payout-accounts', { token: u.token });
      expect(list.body.data.map((a: any) => [a.accountMask, a.isDefault])).toEqual([['****1234', true], ['****0961', false]]);
      expect((await t.request('DELETE', `/v1/kyc/payout-accounts/${second.body.id}`, { token: u.token })).status).toBe(200);
      const after = await t.request('GET', '/v1/kyc/payout-accounts', { token: u.token });
      expect(after.body.data).toHaveLength(1);
      expect(after.body.data[0].isDefault).toBe(true); // promoted

      const [ev] = await t.adminSql<{ n: number }[]>`SELECT count(*)::int AS n FROM outbox_events WHERE event_type = 'payout_account.verified' AND payload->>'userId' = ${u.id}`;
      expect(ev!.n).toBe(2);
      // level stays 3 until a trip reached VERIFIED
      expect((await t.request('GET', '/v1/me', { token: u.token })).body.kycLevel).toBe(3);

      await verifiedTrip(u.id);
      await t.drain();
      expect((await t.request('GET', '/v1/me', { token: u.token })).body.kycLevel).toBe(4);
      const changes = await t.adminSql<{ payload: any }[]>`SELECT payload FROM outbox_events WHERE event_type = 'kyc.level_changed' AND payload->>'userId' = ${u.id} ORDER BY id`;
      expect(changes.map((c) => `${c.payload.from}->${c.payload.to}`)).toEqual(['1->2', '2->3', '3->4']);
      const st = await t.request('GET', '/v1/kyc/status', { token: u.token });
      expect(st.body.next).toMatchObject({ level: 5, evaluatedBy: 'SYSTEM' });

      // a fixture-level traveler (L3 set directly) also reaches L4 through payout_account.verified
      const fx = await t.createUser({ kycLevel: 3 });
      await verifiedTrip(fx.id);
      await t.drain();
      expect((await t.request('GET', '/v1/me', { token: fx.accessToken })).body.kycLevel).toBe(3);
      const addFx = await t.request('POST', '/v1/kyc/payout-accounts', { token: fx.accessToken, body: { bankCode: 'BNI', accountNumber: '4440001111', holderName: 'Budi Santoso' } });
      expect(addFx.status).toBe(201);
      await t.drain();
      expect((await t.request('GET', '/v1/me', { token: fx.accessToken })).body.kycLevel).toBe(4);
    } finally {
      payment.validateBankAccount = original;
    }
  });

  it('no endpoint response leaks *_enc, hashes or raw ID / account numbers', async () => {
    const u = await kycReadyUser();
    const idNumber = nik();
    const bodies: unknown[] = [];
    bodies.push((await t.request('POST', '/v1/kyc/submissions', { token: u.token, body: submission(u, idNumber) })).body);
    const payment = t.payment;
    const original = payment.validateBankAccount.bind(payment);
    payment.validateBankAccount = (async () => ({ valid: true, holderName: 'BUDI SANTOSO' })) as typeof payment.validateBankAccount;
    const accountNumber = '7778889990';
    try {
      bodies.push((await t.request('POST', '/v1/kyc/payout-accounts', { token: u.token, body: { bankCode: 'BRI', accountNumber, holderName: 'Budi Santoso' } })).body);
    } finally {
      payment.validateBankAccount = original;
    }
    for (const path of ['/v1/me', '/v1/kyc/status', '/v1/kyc/payout-accounts', '/v1/me/consents', '/v1/me/devices', '/v1/auth/sessions', `/v1/files/${u.idFront}`, '/v1/privacy/requests']) {
      const r = await t.request('GET', path, { token: u.token });
      expect(r.status).toBe(200);
      bodies.push(r.body);
    }
    const { keys, strings } = scanJson(bodies);
    for (const k of keys) expect(k).not.toMatch(/(_enc|Enc|hash|Hash|secret|Secret|storageKey|storage_key|sha256)$/);
    for (const s of strings) {
      expect(s).not.toContain(idNumber);
      expect(s).not.toContain(accountNumber);
    }
  });
});
