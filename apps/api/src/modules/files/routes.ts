import { createRoute, z } from '@hono/zod-openapi';
import type { App } from '../../context';
import { bearer, createRouter, errorResponses, jsonBody, jsonContent } from '../../lib/openapi';
import { getAuth, requireAuth } from '../../middleware/auth';
import { rateLimit } from '../../middleware/rate-limit';
import { MemoryStorageProvider } from '../../providers/mock';
import { requestMeta } from '../auth/common';
import { CreateUploadBody, CreateUploadResponse, DownloadResponse, FileSchema } from './schemas';
import * as svc from './service';

const tags = ['Files'];
const IdParam = z.object({ id: z.string().uuid() });

export function registerFiles(app: App) {
  const r = createRouter();

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/files/uploads',
      tags,
      summary: 'Create a presigned direct upload',
      description:
        'Allowlist: images (jpeg/png/webp/heic) ≤ 10 MB for every purpose; application/pdf also for RECEIPT and TRIP_DOC; video/mp4 ≤ 50 MB for EVIDENCE. ' +
        'PUT the bytes to `upload.url` with `upload.headers`, then call POST /v1/files/{id}/complete.',
      security: bearer,
      middleware: [requireAuth, rateLimit({ name: 'files.upload', limit: 60, windowSec: 60, key: 'user' })] as const,
      request: jsonBody(CreateUploadBody),
      responses: { 201: jsonContent(CreateUploadResponse, 'Upload ticket'), ...errorResponses },
    }),
    async (c) => c.json(await svc.createUpload(c.get('deps'), getAuth(c), c.req.valid('json')), 201),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/files/{id}/complete',
      tags,
      summary: 'Finish an upload (magic-byte check, SHA-256, malware scan, encryption)',
      description: 'KYC and TRIP_DOC files are re-encrypted with an AES-256-GCM envelope and the plaintext upload is deleted. Infected files are deleted.',
      security: bearer,
      middleware: [requireAuth, rateLimit({ name: 'files.complete', limit: 60, windowSec: 60, key: 'user' })] as const,
      request: { params: IdParam },
      responses: { 200: jsonContent(FileSchema), ...errorResponses },
    }),
    async (c) => c.json(await svc.completeUpload(c.get('deps'), getAuth(c), c.req.valid('param').id, await requestMeta(c)), 200),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/files/{id}',
      tags,
      summary: 'File metadata',
      security: bearer,
      middleware: [requireAuth] as const,
      request: { params: IdParam },
      responses: { 200: jsonContent(FileSchema), ...errorResponses },
    }),
    async (c) => c.json(await svc.getFileMeta(c.get('deps'), getAuth(c), c.req.valid('param').id), 200),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/files/{id}/url',
      tags,
      summary: 'Short-lived download URL',
      description: 'Owner and authorized parties only (transaction counterparties for RECEIPT/PRODUCT_PHOTO/DELIVERY_PROOF/CHAT/EVIDENCE). Encrypted files return the authenticated streaming URL.',
      security: bearer,
      middleware: [requireAuth] as const,
      request: { params: IdParam },
      responses: { 200: jsonContent(DownloadResponse), ...errorResponses },
    }),
    async (c) => c.json(await svc.downloadUrl(c.get('deps'), getAuth(c), c.req.valid('param').id), 200),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/files/{id}/content',
      tags,
      summary: 'Stream a file through the API (decrypts encrypted files)',
      description: 'KYC documents require permission kyc.review; access is audited.',
      security: bearer,
      middleware: [requireAuth] as const,
      request: { params: IdParam },
      responses: {
        200: { description: 'File bytes', content: { 'application/octet-stream': { schema: z.string().openapi({ format: 'binary' }) } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const f = await svc.streamContent(c.get('deps'), getAuth(c), c.req.valid('param').id, await requestMeta(c));
      return c.body(new Uint8Array(f.body), 200, {
        'content-type': f.contentType,
        'cache-control': 'no-store, private',
        'x-content-type-options': 'nosniff',
        'content-disposition': `${f.attachment ? 'attachment' : 'inline'}; filename="${f.filename}"`,
      }) as never;
    },
  );

  // ---------------------------------------------------------------- dev-only storage endpoints (memory provider)
  const devEnabled = (c: { get: (k: 'deps') => { env: { APP_ENV: string } } }) => ['development', 'test'].includes(c.get('deps').env.APP_ENV);

  r.openapi(
    createRoute({
      method: 'put',
      path: '/v1/dev/storage/upload/{token}',
      tags: ['Dev'],
      summary: 'DEV ONLY: receive a direct upload for the in-memory storage provider',
      hide: true,
      request: { params: z.object({ token: z.string().min(10).max(100) }) },
      responses: { 200: jsonContent(z.object({ ok: z.literal(true) })), ...errorResponses },
    }),
    async (c) => {
      const storage = c.get('deps').providers.storage;
      if (!devEnabled(c) || !(storage instanceof MemoryStorageProvider)) return c.json({ error: { code: 'NOT_FOUND', message: 'Endpoint tidak ditemukan', details: {}, requestId: c.get('requestId') } }, 404) as never;
      const body = new Uint8Array(await c.req.arrayBuffer());
      const res = storage.acceptUpload(c.req.valid('param').token, body, c.req.header('content-type') ?? '');
      if (!res.ok) return c.json({ error: { code: res.reason ?? 'UPLOAD_REJECTED', message: 'Unggahan ditolak', details: {}, requestId: c.get('requestId') } }, 400) as never;
      return c.json({ ok: true as const }, 200);
    },
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/dev/storage/download/{token}',
      tags: ['Dev'],
      summary: 'DEV ONLY: serve a presigned download from the in-memory storage provider',
      hide: true,
      request: { params: z.object({ token: z.string().min(10).max(100) }) },
      responses: { 200: { description: 'Object bytes' }, ...errorResponses },
    }),
    async (c) => {
      const storage = c.get('deps').providers.storage;
      if (!devEnabled(c) || !(storage instanceof MemoryStorageProvider)) return c.json({ error: { code: 'NOT_FOUND', message: 'Endpoint tidak ditemukan', details: {}, requestId: c.get('requestId') } }, 404) as never;
      const d = storage.resolveDownload(c.req.valid('param').token);
      const obj = d ? await storage.get(d.key) : null;
      if (!d || !obj) return c.json({ error: { code: 'DOWNLOAD_TOKEN_INVALID', message: 'Tautan unduhan tidak valid atau kedaluwarsa', details: {}, requestId: c.get('requestId') } }, 404) as never;
      return c.body(new Uint8Array(obj.body), 200, {
        'content-type': obj.contentType,
        'cache-control': 'no-store',
        ...(d.filename ? { 'content-disposition': `inline; filename="${d.filename}"` } : {}),
      }) as never;
    },
  );

  app.route('/', r);
}
