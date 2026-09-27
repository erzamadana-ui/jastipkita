import { describe, expect, it } from 'vitest';
import { ResendEmailProvider, ResendError } from './resend';

function fakeFetch(responses: { status: number; body: unknown }[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const r = responses.shift() ?? { status: 500, body: {} };
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fn, calls };
}

describe('ResendEmailProvider', () => {
  const msg = {
    to: 'buyer@example.com',
    subject: 'Pembayaran aman',
    html: '<p>ok</p>',
    text: 'ok',
    tags: { template: 'transaction.payment_secured', category: 'PAYMENT' },
    idempotencyKey: 'notif-123',
  };

  it('POSTs to /emails with bearer auth, idempotency key and sanitized tags', async () => {
    const f = fakeFetch([{ status: 200, body: { id: 'em_1' } }]);
    const p = new ResendEmailProvider({ apiKey: 're_test_key', from: 'JastipKita <no-reply@jastipkita.id>', replyTo: 'help@jastipkita.id', fetch: f.fn });
    const res = await p.send(msg);
    expect(res.providerRef).toBe('em_1');
    expect(f.calls).toHaveLength(1);
    const c = f.calls[0]!;
    expect(c.url).toBe('https://api.resend.com/emails');
    expect(c.init.method).toBe('POST');
    const h = c.init.headers as Record<string, string>;
    expect(h.authorization).toBe('Bearer re_test_key');
    expect(h['idempotency-key']).toBe('notif-123');
    const body = JSON.parse(String(c.init.body));
    expect(body).toMatchObject({ from: 'JastipKita <no-reply@jastipkita.id>', to: ['buyer@example.com'], subject: 'Pembayaran aman', reply_to: 'help@jastipkita.id' });
    expect(body.tags).toEqual([
      { name: 'template', value: 'transaction_payment_secured' },
      { name: 'category', value: 'PAYMENT' },
    ]);
  });

  it('marks 429/5xx as retryable and 4xx validation errors as permanent', async () => {
    const f = fakeFetch([
      { status: 429, body: { name: 'rate_limit_exceeded', message: 'Too many requests' } },
      { status: 422, body: { name: 'validation_error', message: 'Invalid `to`' } },
    ]);
    const p = new ResendEmailProvider({ apiKey: 'k', from: 'x@y.z', fetch: f.fn });
    const e1 = await p.send(msg).catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(ResendError);
    expect((e1 as ResendError).retryable).toBe(true);
    const e2 = await p.send(msg).catch((e: unknown) => e);
    expect((e2 as ResendError).retryable).toBe(false);
    expect((e2 as ResendError).status).toBe(422);
  });

  it('requires an API key', () => {
    expect(() => new ResendEmailProvider({ apiKey: '', from: 'x@y.z' })).toThrow(/RESEND_API_KEY/);
  });
});
