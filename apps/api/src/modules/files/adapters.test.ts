import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClamAvHttpScanner, parseClamAvResponse } from '../../providers/malware/clamav-http';
import { TwilioSmsProvider } from '../../providers/sms/twilio';
import { S3StorageProvider } from '../../providers/storage/s3';

// ------------------------------------------------------------------ minimal fake S3 (path-style)
const objects = new Map<string, { body: Buffer; type: string }>();
const seen: { method: string; url: string; auth: string | null }[] = [];
let server: Server;
let endpoint: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url!, 'http://x');
      seen.push({ method: req.method!, url: req.url!, auth: (req.headers.authorization as string) ?? null });
      const signed = !!req.headers.authorization?.startsWith('AWS4-HMAC-SHA256') || url.searchParams.has('X-Amz-Signature');
      if (!signed) {
        res.writeHead(403).end('unsigned');
        return;
      }
      const key = decodeURIComponent(url.pathname);
      if (req.method === 'PUT') {
        objects.set(key, { body: Buffer.concat(chunks), type: String(req.headers['content-type'] ?? '') });
        res.writeHead(200).end();
      } else if (req.method === 'GET' || req.method === 'HEAD') {
        const o = objects.get(key);
        if (!o) return void res.writeHead(404).end();
        res.writeHead(200, { 'content-type': o.type, 'content-length': o.body.length });
        res.end(req.method === 'GET' ? o.body : undefined);
      } else if (req.method === 'DELETE') {
        objects.delete(key);
        res.writeHead(204).end();
      } else res.writeHead(405).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('S3StorageProvider (aws4fetch SigV4)', () => {
  const s3 = () =>
    new S3StorageProvider({ endpoint, bucket: 'jk-files', region: 'auto', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' });

  it('put / head / get / delete with signed requests (path-style)', async () => {
    const p = s3();
    await p.put('kyc/enc/2026/09/a b.jke', new Uint8Array([1, 2, 3]), 'application/octet-stream');
    expect(objects.get('/jk-files/kyc/enc/2026/09/a b.jke')!.body).toEqual(Buffer.from([1, 2, 3]));
    expect(seen.at(-1)!.auth).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/auto\/s3\/aws4_request/);
    expect(await p.head('kyc/enc/2026/09/a b.jke')).toEqual({ size: 3, contentType: 'application/octet-stream' });
    expect((await p.get('kyc/enc/2026/09/a b.jke'))!.body).toEqual(new Uint8Array([1, 2, 3]));
    await p.delete('kyc/enc/2026/09/a b.jke');
    expect(await p.get('kyc/enc/2026/09/a b.jke')).toBeNull();
    await p.delete('missing'); // 404 is fine
  });

  it('presigned PUT signs content-type and content-length; the URL works', async () => {
    const p = s3();
    const up = await p.presignUpload({ key: 'receipt/x.jpg', contentType: 'image/jpeg', maxBytes: 4, expiresSec: 900 });
    const u = new URL(up.url);
    expect(u.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(u.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(u.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;content-type;host');
    expect(u.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(up.headers).toEqual({ 'content-type': 'image/jpeg' });
    const res = await fetch(up.url, { method: 'PUT', headers: up.headers, body: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]) });
    expect(res.status).toBe(200);
    const dl = await p.presignDownload({ key: 'receipt/x.jpg', expiresSec: 300, filename: 'receipt.jpg' });
    const d = new URL(dl);
    expect(d.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(d.searchParams.get('response-content-disposition')).toBe('inline; filename="receipt.jpg"');
    const got = await fetch(dl);
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]));
  });

  it('virtual-hosted endpoints via {bucket}', () => {
    const p = new S3StorageProvider({ endpoint: 'https://{bucket}.s3.ap-southeast-3.amazonaws.com', bucket: 'jk', region: 'ap-southeast-3', accessKeyId: 'a', secretAccessKey: 'b' });
    expect(p.objectUrl('a/b c.png').toString()).toBe('https://jk.s3.ap-southeast-3.amazonaws.com/a/b%20c.png');
  });
});

describe('ClamAvHttpScanner', () => {
  it('parses the documented contract and common clamav-rest shapes', () => {
    expect(parseClamAvResponse({ status: 'CLEAN' }).status).toBe('CLEAN');
    expect(parseClamAvResponse({ status: 'INFECTED', signature: 'Eicar-Signature' })).toEqual({ status: 'INFECTED', engine: 'clamav-http', signature: 'Eicar-Signature' });
    expect(parseClamAvResponse({ status: 'ERROR', error: 'x' }).status).toBe('FAILED');
    expect(parseClamAvResponse({ infected: true, viruses: ['Win.Test.EICAR_HDB-1'] }).signature).toBe('Win.Test.EICAR_HDB-1');
    expect(parseClamAvResponse({ infected: false, viruses: [] }).status).toBe('CLEAN');
    expect(parseClamAvResponse({ data: { result: [{ is_infected: true, viruses: ['X'] }] } }).status).toBe('INFECTED');
    expect(parseClamAvResponse('nope').status).toBe('FAILED');
  });

  it('posts raw bytes and fails closed on errors/timeouts', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const ok = new ClamAvHttpScanner({
      url: 'http://clamav.local/',
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ status: 'INFECTED', signature: 'Eicar' }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    const r = await ok.scan({ key: 'k', body: new Uint8Array([1, 2]), contentType: 'image/jpeg' });
    expect(r).toEqual({ status: 'INFECTED', engine: 'clamav-http', signature: 'Eicar' });
    expect(calls[0]!.url).toBe('http://clamav.local/scan');
    expect((calls[0]!.init.headers as Record<string, string>)['content-type']).toBe('application/octet-stream');
    const down = new ClamAvHttpScanner({ url: 'http://clamav.local', fetch: (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch });
    expect((await down.scan({ key: 'k', body: new Uint8Array([1]), contentType: 'x' })).status).toBe('FAILED');
    const unreachable = new ClamAvHttpScanner({ url: 'http://clamav.local', fetch: (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch });
    expect((await unreachable.scan({ key: 'k', body: new Uint8Array([1]), contentType: 'x' })).status).toBe('FAILED');
  });
});

describe('TwilioSmsProvider', () => {
  it('sends SMS and WhatsApp through the Messages API with Basic auth', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const tw = new TwilioSmsProvider({
      accountSid: 'AC123',
      authToken: 'secret-token',
      from: '+15005550006',
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ sid: `SM${calls.length}`, status: 'queued' }), { status: 201 });
      }) as unknown as typeof fetch,
    });
    expect(await tw.send({ to: '+6281234567890', body: 'kode 123456', channel: 'SMS' })).toEqual({ providerRef: 'SM1' });
    expect(calls[0]!.url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json');
    const h = calls[0]!.init.headers as Record<string, string>;
    expect(h.authorization).toBe(`Basic ${Buffer.from('AC123:secret-token').toString('base64')}`);
    const form = new URLSearchParams(calls[0]!.init.body as string);
    expect(form.get('To')).toBe('+6281234567890');
    expect(form.get('From')).toBe('+15005550006');
    await tw.send({ to: '+6281234567890', body: 'kode 654321', channel: 'WHATSAPP' });
    const wa = new URLSearchParams(calls[1]!.init.body as string);
    expect(wa.get('To')).toBe('whatsapp:+6281234567890');
    expect(wa.get('From')).toBe('whatsapp:+15005550006');
  });

  it('throws without leaking the destination or body', async () => {
    const tw = new TwilioSmsProvider({
      accountSid: 'AC123',
      authToken: 't',
      from: '+15005550006',
      fetch: (async () => new Response(JSON.stringify({ code: 21211, message: "The 'To' number is not a valid phone number." }), { status: 400 })) as unknown as typeof fetch,
    });
    const err = await tw.send({ to: '+6281299999999', body: 'kode 111222' }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('21211');
    expect((err as Error).message).not.toContain('+6281299999999');
    expect((err as Error).message).not.toContain('111222');
  });
});
