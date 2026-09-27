import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../../../test/helpers';
import { decryptObject } from './envelope';
import { sniffContentType } from './policy';
import { JPEG } from '../auth/test-support';

let t: TestContext;
beforeAll(async () => {
  t = await createTestContext();
});
afterAll(async () => {
  await t.close();
});

const PNG = () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 1, 2, 3]);
const PDF = () => new TextEncoder().encode('%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\ntrailer\n%%EOF');
const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

async function putBytes(url: string, headers: Record<string, string>, bytes: Uint8Array) {
  const u = new URL(url);
  return t.app.request(u.pathname + u.search, { method: 'PUT', headers, body: new Uint8Array(bytes) });
}

async function upload(token: string, purpose: string, contentType: string, bytes: Uint8Array, extra: Record<string, unknown> = {}) {
  const c = await t.request('POST', '/v1/files/uploads', { token, body: { purpose, contentType, sizeBytes: bytes.length, ...extra } });
  expect(c.status).toBe(201);
  const put = await putBytes(c.body.upload.url, c.body.upload.headers, bytes);
  expect(put.status).toBe(200);
  const done = await t.request('POST', `/v1/files/${c.body.fileId}/complete`, { token });
  return { fileId: c.body.fileId as string, done };
}

describe('files: upload → complete', () => {
  it('sniffs magic bytes', () => {
    expect(sniffContentType(JPEG())).toBe('image/jpeg');
    expect(sniffContentType(PNG())).toBe('image/png');
    expect(sniffContentType(PDF())).toBe('application/pdf');
    expect(sniffContentType(new Uint8Array([0, 0, 0, 0x18, ...new TextEncoder().encode('ftypheic'), 0, 0, 0, 0]))).toBe('image/heic');
    expect(sniffContentType(new Uint8Array([0, 0, 0, 0x18, ...new TextEncoder().encode('ftypisom'), 0, 0, 2, 0]))).toBe('video/mp4');
    expect(sniffContentType(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(sniffContentType(new TextEncoder().encode('<html>'))).toBeNull();
  });

  it('happy path: avatar JPEG becomes READY and is downloadable through a short-lived URL', async () => {
    const u = await t.createUser();
    const bytes = JPEG(200);
    const hex = Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
    const { fileId, done } = await upload(u.accessToken, 'AVATAR', 'image/jpeg', bytes, { sha256: hex });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ id: fileId, status: 'READY', purpose: 'AVATAR', contentType: 'image/jpeg', sizeBytes: bytes.length, encrypted: false });
    const [row] = await t.adminSql<{ sha256: Buffer; scan_status: string }[]>`SELECT sha256, scan_status FROM files WHERE id = ${fileId}`;
    expect(row!.sha256.toString('hex')).toBe(hex);
    expect(row!.scan_status).toBe('CLEAN');
    // complete is idempotent
    expect((await t.request('POST', `/v1/files/${fileId}/complete`, { token: u.accessToken })).body.status).toBe('READY');

    const dl = await t.request('GET', `/v1/files/${fileId}/url`, { token: u.accessToken });
    expect(dl.status).toBe(200);
    expect(dl.body.requiresAuth).toBe(false);
    expect(dl.body.expiresAt).toBeTruthy();
    const got = await t.app.request(new URL(dl.body.url).pathname);
    expect(got.status).toBe(200);
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(bytes);

    // set as avatar
    const patch = await t.request('PATCH', '/v1/me', { token: u.accessToken, body: { avatarFileId: fileId } });
    expect(patch.body.user.avatarFileId).toBe(fileId);
  });

  it('allowlist and size limits per purpose', async () => {
    const u = await t.createUser();
    const pdfAvatar = await t.request('POST', '/v1/files/uploads', { token: u.accessToken, body: { purpose: 'AVATAR', contentType: 'application/pdf', sizeBytes: 100 } });
    expect(pdfAvatar.status).toBe(422);
    expect(pdfAvatar.body.error.code).toBe('FILE_TYPE_NOT_ALLOWED');
    const big = await t.request('POST', '/v1/files/uploads', { token: u.accessToken, body: { purpose: 'RECEIPT', contentType: 'image/jpeg', sizeBytes: 10 * 1024 * 1024 + 1 } });
    expect(big.body.error.code).toBe('FILE_TOO_LARGE');
    const video = await t.request('POST', '/v1/files/uploads', { token: u.accessToken, body: { purpose: 'EVIDENCE', contentType: 'video/mp4', sizeBytes: 40 * 1024 * 1024 } });
    expect(video.status).toBe(201);
    const videoReceipt = await t.request('POST', '/v1/files/uploads', { token: u.accessToken, body: { purpose: 'RECEIPT', contentType: 'video/mp4', sizeBytes: 1000 } });
    expect(videoReceipt.body.error.code).toBe('FILE_TYPE_NOT_ALLOWED');
    const pdfReceipt = await upload(u.accessToken, 'RECEIPT', 'application/pdf', PDF());
    expect(pdfReceipt.done.body.status).toBe('READY');
    // storage enforces the declared size & type
    const c = await t.request('POST', '/v1/files/uploads', { token: u.accessToken, body: { purpose: 'CHAT', contentType: 'image/png', sizeBytes: 10 } });
    expect((await putBytes(c.body.upload.url, c.body.upload.headers, PNG())).status).toBe(400);
  });

  it('magic-byte mismatch is rejected and the object deleted', async () => {
    const u = await t.createUser();
    const { fileId, done } = await upload(u.accessToken, 'PRODUCT_PHOTO', 'image/png', JPEG());
    expect(done.status).toBe(422);
    expect(done.body.error.code).toBe('FILE_TYPE_MISMATCH');
    expect(done.body.error.details).toEqual({ declared: 'image/png', detected: 'image/jpeg' });
    const [row] = await t.adminSql<{ storage_key: string; deleted_at: Date | null; scan_status: string }[]>`SELECT storage_key, deleted_at, scan_status FROM files WHERE id = ${fileId}`;
    expect(row!.deleted_at).not.toBeNull();
    expect(row!.scan_status).toBe('FAILED');
    expect(t.storage.objects.has(row!.storage_key)).toBe(false);
    const meta = await t.request('GET', `/v1/files/${fileId}`, { token: u.accessToken });
    expect(meta.body.status).toBe('REJECTED');
    // an HTML file declared as a JPEG
    const html = await upload(u.accessToken, 'CHAT', 'image/jpeg', new TextEncoder().encode('<html><script>alert(1)</script></html>'));
    expect(html.done.body.error.code).toBe('FILE_TYPE_MISMATCH');
  });

  it('checksum mismatch is rejected', async () => {
    const u = await t.createUser();
    const r = await upload(u.accessToken, 'CHAT', 'image/jpeg', JPEG(), { sha256: '0'.repeat(64) });
    expect(r.done.status).toBe(422);
    expect(r.done.body.error.code).toBe('FILE_CHECKSUM_MISMATCH');
  });

  it('EICAR → INFECTED: deleted + HIGH security event', async () => {
    const u = await t.createUser();
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, ...new TextEncoder().encode(EICAR)]);
    const { fileId, done } = await upload(u.accessToken, 'EVIDENCE', 'image/jpeg', bytes);
    expect(done.status).toBe(422);
    expect(done.body.error.code).toBe('FILE_INFECTED');
    const [row] = await t.adminSql<{ storage_key: string; scan_status: string; scan_signature: string; deleted_at: Date | null }[]>`
      SELECT storage_key, scan_status, scan_signature, deleted_at FROM files WHERE id = ${fileId}`;
    expect(row!.scan_status).toBe('INFECTED');
    expect(row!.scan_signature).toBe('EICAR-Test-File');
    expect(row!.deleted_at).not.toBeNull();
    expect(t.storage.objects.has(row!.storage_key)).toBe(false);
    const [ev] = await t.adminSql<{ severity: string; meta: any }[]>`SELECT severity, meta FROM security_events WHERE user_id = ${u.id} AND type = 'MALWARE_UPLOAD'`;
    expect(ev!.severity).toBe('HIGH');
    expect(ev!.meta.fileId).toBe(fileId);
    expect((await t.request('GET', `/v1/files/${fileId}/url`, { token: u.accessToken })).body.error.code).toBe('FILE_NOT_READY');
  });

  it('KYC file is stored envelope-encrypted: raw object ≠ plaintext, decrypts correctly, staging copy removed', async () => {
    const u = await t.createUser({ kycLevel: 2 });
    const plain = JPEG(500);
    const c = await t.request('POST', '/v1/files/uploads', { token: u.accessToken, body: { purpose: 'KYC', contentType: 'image/jpeg', sizeBytes: plain.length } });
    const [staging] = await t.adminSql<{ storage_key: string }[]>`SELECT storage_key FROM files WHERE id = ${c.body.fileId}`;
    await putBytes(c.body.upload.url, c.body.upload.headers, plain);
    expect(t.storage.objects.has(staging!.storage_key)).toBe(true);
    const done = await t.request('POST', `/v1/files/${c.body.fileId}/complete`, { token: u.accessToken });
    expect(done.status).toBe(200);
    expect(done.body.encrypted).toBe(true);
    const [row] = await t.adminSql<{ storage_key: string; encrypted: boolean; enc_key_id: string }[]>`SELECT storage_key, encrypted, enc_key_id FROM files WHERE id = ${c.body.fileId}`;
    expect(row!.storage_key).not.toBe(staging!.storage_key);
    expect(t.storage.objects.has(staging!.storage_key)).toBe(false);
    expect(row!.enc_key_id).toBe('k1');
    const raw = t.storage.objects.get(row!.storage_key)!.body;
    expect(Buffer.from(raw).equals(Buffer.from(plain))).toBe(false);
    expect(Buffer.from(raw).includes(Buffer.from(plain.subarray(10, 60)))).toBe(false);
    expect(await decryptObject(t.deps, c.body.fileId, raw)).toEqual(plain);
    // bound to its file id (AAD)
    await expect(decryptObject(t.deps, crypto.randomUUID(), raw)).rejects.toThrow();

    // owner cannot fetch the KYC document; only reviewers with kyc.review, via the authenticated stream
    const own = await t.request('GET', `/v1/files/${c.body.fileId}/url`, { token: u.accessToken });
    expect(own.status).toBe(403);
    const support = await t.createUser({ roles: ['SUPPORT'] });
    expect((await t.request('GET', `/v1/files/${c.body.fileId}/content`, { token: support.accessToken })).status).toBe(403);
    const reviewer = await t.createUser({ roles: ['OPERATIONS'] });
    const url = await t.request('GET', `/v1/files/${c.body.fileId}/url`, { token: reviewer.accessToken });
    expect(url.body).toMatchObject({ requiresAuth: true, expiresAt: null });
    const stream = await t.app.request(new URL(url.body.url).pathname, { headers: { authorization: `Bearer ${reviewer.accessToken}` } });
    expect(stream.status).toBe(200);
    expect(stream.headers.get('cache-control')).toContain('no-store');
    expect(new Uint8Array(await stream.arrayBuffer())).toEqual(plain);
    const [a] = await t.adminSql<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'kyc.document_viewed' AND entity_id = ${c.body.fileId} AND actor_id = ${reviewer.id}`;
    expect(a!.n).toBe(1);
  });

  it('download authorization: owner ok, counterparty ok, stranger 403', async () => {
    const buyer = await t.createUser();
    const traveler = await t.createUser({ kycLevel: 3, mode: 'TRAVELER' });
    const stranger = await t.createUser();
    const { fileId } = await upload(traveler.accessToken, 'CHAT', 'image/jpeg', JPEG());
    const [rq] = await t.adminSql<{ id: string }[]>`INSERT INTO requests (buyer_id, source_type, product_name) VALUES (${buyer.id}, 'MANUAL', 'Tas kulit') RETURNING id`;
    const [cv] = await t.adminSql<{ id: string }[]>`INSERT INTO conversations (request_id, buyer_id, traveler_id) VALUES (${rq!.id}, ${buyer.id}, ${traveler.id}) RETURNING id`;
    await t.adminSql`INSERT INTO messages (conversation_id, sender_id, type, attachments) VALUES (${cv!.id}, ${traveler.id}, 'IMAGE', ${t.adminSql.json([{ fileId, mime: 'image/jpeg' }] as never)})`;

    expect((await t.request('GET', `/v1/files/${fileId}/url`, { token: traveler.accessToken })).status).toBe(200);
    expect((await t.request('GET', `/v1/files/${fileId}/url`, { token: buyer.accessToken })).status).toBe(200);
    const denied = await t.request('GET', `/v1/files/${fileId}/url`, { token: stranger.accessToken });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('FILE_ACCESS_DENIED');
    expect((await t.request('GET', `/v1/files/${fileId}/content`, { token: stranger.accessToken })).status).toBe(403);

    // request photos: buyer's DRAFT request is private; once OPEN any signed-in user may see them
    const photo = await upload(buyer.accessToken, 'PRODUCT_PHOTO', 'image/jpeg', JPEG());
    await t.adminSql`INSERT INTO request_images (request_id, file_id) VALUES (${rq!.id}, ${photo.fileId})`;
    expect((await t.request('GET', `/v1/files/${photo.fileId}/url`, { token: stranger.accessToken })).status).toBe(403);
    await t.adminSql`UPDATE requests SET status = 'OPEN', published_at = now() WHERE id = ${rq!.id}`;
    expect((await t.request('GET', `/v1/files/${photo.fileId}/url`, { token: stranger.accessToken })).status).toBe(200);

    // someone else cannot complete my upload
    const c = await t.request('POST', '/v1/files/uploads', { token: buyer.accessToken, body: { purpose: 'CHAT', contentType: 'image/jpeg', sizeBytes: 10 } });
    expect((await t.request('POST', `/v1/files/${c.body.fileId}/complete`, { token: stranger.accessToken })).status).toBe(404);
    // not uploaded yet
    expect((await t.request('POST', `/v1/files/${c.body.fileId}/complete`, { token: buyer.accessToken })).body.error.code).toBe('UPLOAD_MISSING');
  });

  it('dev storage routes reject unknown tokens', async () => {
    const put = await t.app.request('/v1/dev/storage/upload/not-a-real-token-123', { method: 'PUT', headers: { 'content-type': 'image/jpeg' }, body: JPEG() });
    expect(put.status).toBe(400);
    expect((await t.app.request('/v1/dev/storage/download/not-a-real-token-123')).status).toBe(404);
  });
});
