import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../../../test/helpers';
import type { MockKycProvider } from '../../providers/mock';
import { JPEG, phoneLogin, uploadFile } from '../auth/test-support';

let t: TestContext;
beforeAll(async () => {
  t = await createTestContext({ env: { KYC_PROVIDER: 'mock' } });
});
afterAll(async () => {
  await t.close();
});

let nikSeq = 0;
const nik = () => `3171${String(Date.now()).slice(-8)}${String(nikSeq++).padStart(4, '0')}`;

async function readyUser() {
  const u = await phoneLogin(t);
  const token = u.tokens.accessToken as string;
  t.clock.advance(61_000);
  expect((await t.request('POST', '/v1/me/consents', { token, body: { type: 'KYC', version: '0.1-template' } })).status).toBe(201);
  const up = (seed: number) => uploadFile(t, token, 'KYC', 'image/jpeg', JPEG(200, seed));
  return { id: u.user.id as string, token, idFront: await up(3), selfie: await up(5), up };
}

const body = (u: { idFront: string; selfie: string }, documents: Record<string, unknown>) => ({
  idType: 'KTP',
  idNumber: nik(),
  fullName: 'Sari Dewi',
  dateOfBirth: '1992-03-04',
  documents: { idFront: u.idFront, selfie: u.selfie, ...documents },
});

const provider = () => t.deps.providers.kyc as MockKycProvider;

describe('POST /v1/kyc/submissions — livenessFileIds', () => {
  it('accepts 1–5 liveness captures, stores each as a LIVENESS document and passes all to the provider', async () => {
    const u = await readyUser();
    const live = [await u.up(11), await u.up(13), await u.up(17)];
    const res = await t.request('POST', '/v1/kyc/submissions', { token: u.token, body: body(u, { livenessFileIds: live }) });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.submission.status).toBe('APPROVED');
    const docs = await t.adminSql<{ file_id: string }[]>`
      SELECT file_id FROM kyc_documents WHERE submission_id = ${res.body.submission.id} AND type = 'LIVENESS' ORDER BY created_at, file_id`;
    expect(docs.map((d) => d.file_id).sort()).toEqual([...live].sort());
    const call = provider().calls.find((c) => c.submissionId === res.body.submission.id)!;
    const keys = await t.adminSql<{ id: string; storage_key: string }[]>`SELECT id, storage_key FROM files WHERE id = ANY(${live}::uuid[])`;
    expect(call.livenessFileKeys).toEqual(live.map((id) => keys.find((k) => k.id === id)!.storage_key)); // capture order kept
  });

  it('legacy single field still works and may be combined with the array (deduplicated)', async () => {
    const u = await readyUser();
    const a = await u.up(19);
    const b = await u.up(23);
    const res = await t.request('POST', '/v1/kyc/submissions', { token: u.token, body: body(u, { liveness: a, livenessFileIds: [a, b] }) });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(provider().calls.find((c) => c.submissionId === res.body.submission.id)!.livenessFileKeys).toHaveLength(2);
  });

  it('validates count, ownership and scan status of every capture', async () => {
    const u = await readyUser();
    const tooMany = await t.request('POST', '/v1/kyc/submissions', {
      token: u.token,
      body: body(u, { livenessFileIds: Array.from({ length: 6 }, () => crypto.randomUUID()) }),
    });
    expect(tooMany.status).toBe(400);
    expect((await t.request('POST', '/v1/kyc/submissions', { token: u.token, body: body(u, { livenessFileIds: [] }) })).status).toBe(400);
    const five = await Promise.all([29, 31, 37, 41, 43].map((s) => u.up(s)));
    const sixTotal = await t.request('POST', '/v1/kyc/submissions', { token: u.token, body: body(u, { liveness: await u.up(47), livenessFileIds: five }) });
    expect(sixTotal.status).toBe(422);
    expect(sixTotal.body.error.code).toBe('KYC_DOCUMENTS_INVALID');

    const other = await readyUser();
    const foreign = await t.request('POST', '/v1/kyc/submissions', { token: u.token, body: body(u, { livenessFileIds: [five[0], other.selfie] }) });
    expect(foreign.status).toBe(422);
    expect(foreign.body.error.code).toBe('KYC_DOCUMENTS_INVALID');
    expect(foreign.body.error.details.missing).toEqual([other.selfie]);

    const [pending] = await t.adminSql<{ id: string }[]>`
      INSERT INTO files (owner_id, purpose, storage_provider, storage_key, mime, size_bytes, scan_status, encrypted, enc_key_id)
      VALUES (${u.id}, 'KYC', 'MOCK', ${`kyc/${crypto.randomUUID()}`}, 'image/jpeg', 10, 'PENDING', true, 'k1') RETURNING id`;
    const unscanned = await t.request('POST', '/v1/kyc/submissions', { token: u.token, body: body(u, { livenessFileIds: [pending!.id] }) });
    expect(unscanned.status).toBe(422);
    expect(unscanned.body.error.details.missing).toEqual([pending!.id]);
    expect(await t.adminSql`SELECT id FROM kyc_submissions WHERE user_id = ${u.id}`).toHaveLength(0);
  });
});
