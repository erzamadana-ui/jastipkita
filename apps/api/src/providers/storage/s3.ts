/**
 * S3-compatible object storage (AWS S3, Cloudflare R2, MinIO, …) using SigV4 via aws4fetch.
 * Works on Node and Cloudflare Workers (fetch + WebCrypto only).
 *
 * Addressing:
 *   - path-style (default): {S3_ENDPOINT}/{bucket}/{key} — R2 (https://<account>.r2.cloudflarestorage.com), MinIO
 *   - virtual-hosted: put "{bucket}" in S3_ENDPOINT, e.g. https://{bucket}.s3.ap-southeast-3.amazonaws.com
 * Region: S3_REGION ("auto" for R2).
 *
 * Presigned PUT signs `content-type` AND `content-length` (the declared size), so storage rejects an
 * upload with another type or size. `complete` re-checks everything server-side anyway.
 */
import { AwsClient } from 'aws4fetch';
import type { PresignedUpload, StorageProvider } from '../types';
import { contentDisposition, servedContentType } from './content-safety';

export interface S3StorageOptions {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Injectable for tests. */
  fetch?: typeof fetch;
  now?: () => Date;
}

const encodeKey = (key: string) => key.split('/').map(encodeURIComponent).join('/');

export class S3StorageProvider implements StorageProvider {
  readonly mode = 'LIVE' as const;
  private readonly client: AwsClient;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly opts: S3StorageOptions) {
    this.client = new AwsClient({
      accessKeyId: opts.accessKeyId,
      secretAccessKey: opts.secretAccessKey,
      service: 's3',
      region: opts.region || 'auto',
      retries: 2,
    });
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.now = opts.now ?? (() => new Date());
  }

  objectUrl(key: string): URL {
    const ep = this.opts.endpoint.replace(/\/+$/, '');
    if (ep.includes('{bucket}')) return new URL(`${ep.replace('{bucket}', this.opts.bucket)}/${encodeKey(key)}`);
    return new URL(`${ep}/${encodeURIComponent(this.opts.bucket)}/${encodeKey(key)}`);
  }

  private amzDate(): string {
    return this.now().toISOString().replace(/[:-]|\.\d{3}/g, '');
  }

  private async signed(method: string, key: string, init: { headers?: Record<string, string>; body?: Uint8Array } = {}) {
    const req = await this.client.sign(this.objectUrl(key).toString(), {
      method,
      headers: init.headers ?? {},
      ...(init.body ? { body: init.body as unknown as BodyInit } : {}),
      aws: { datetime: this.amzDate() },
    });
    return this.fetchImpl(req);
  }

  async presignUpload(input: { key: string; contentType: string; maxBytes: number; expiresSec: number }): Promise<PresignedUpload> {
    const url = this.objectUrl(input.key);
    url.searchParams.set('X-Amz-Expires', String(input.expiresSec));
    const headers = { 'content-type': input.contentType, 'content-length': String(input.maxBytes) };
    const signed = await this.client.sign(url.toString(), {
      method: 'PUT',
      headers,
      aws: { signQuery: true, allHeaders: true, datetime: this.amzDate() },
    });
    return {
      url: signed.url,
      method: 'PUT',
      // content-length is set by the HTTP client from the body; it must equal the declared size
      headers: { 'content-type': input.contentType },
      expiresAt: new Date(this.now().getTime() + input.expiresSec * 1000),
    };
  }

  /**
   * SEC-18: the signed query pins `response-content-disposition` (attachment unless a raster image) and, when the type
   * is known, `response-content-type` — the bucket cannot be tricked into serving the object as HTML/PDF inline.
   * (S3/R2 cannot add nosniff/CSP through a presigned URL; see content-safety.ts.)
   */
  async presignDownload(input: { key: string; expiresSec: number; filename?: string; contentType?: string; disposition?: 'inline' | 'attachment' }): Promise<string> {
    const url = this.objectUrl(input.key);
    url.searchParams.set('X-Amz-Expires', String(input.expiresSec));
    url.searchParams.set('response-content-disposition', contentDisposition(input.contentType, input.filename, input.disposition));
    if (input.contentType) url.searchParams.set('response-content-type', servedContentType(input.contentType));
    const signed = await this.client.sign(url.toString(), { method: 'GET', aws: { signQuery: true, datetime: this.amzDate() } });
    return signed.url;
  }

  async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    const res = await this.signed('PUT', key, { headers: { 'content-type': contentType }, body });
    if (!res.ok) throw new Error(`S3 PUT failed: ${res.status} ${await safeText(res)}`);
  }

  async get(key: string): Promise<{ body: Uint8Array; contentType: string } | null> {
    const res = await this.signed('GET', key);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`S3 GET failed: ${res.status} ${await safeText(res)}`);
    return { body: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get('content-type') ?? 'application/octet-stream' };
  }

  async head(key: string): Promise<{ size: number; contentType: string } | null> {
    const res = await this.signed('HEAD', key);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`S3 HEAD failed: ${res.status}`);
    return { size: Number(res.headers.get('content-length') ?? '0'), contentType: res.headers.get('content-type') ?? 'application/octet-stream' };
  }

  async delete(key: string): Promise<void> {
    const res = await this.signed('DELETE', key);
    if (!res.ok && res.status !== 404) throw new Error(`S3 DELETE failed: ${res.status} ${await safeText(res)}`);
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return '';
  }
}
