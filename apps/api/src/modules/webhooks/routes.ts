import { createRoute, z } from '@hono/zod-openapi';
import type { App } from '../../context';
import { AppError } from '../../lib/errors';
import { createRouter, errorResponses, jsonContent } from '../../lib/openapi';
import { rateLimit } from '../../middleware/rate-limit';
import { MOCK_WEBHOOK_TOKEN, MockPaymentProvider } from '../../providers/mock';
import { handleProviderWebhook } from './service';

const WebhookAck = z
  .object({ status: z.enum(['PROCESSED', 'DUPLICATE', 'IGNORED']), eventId: z.string(), outcome: z.string().optional() })
  .openapi('WebhookAck');

function isDevEnv(env: string) {
  return env === 'development' || env === 'test';
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

export function registerWebhookRoutes(app: App) {
  const r = createRouter();

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/webhooks/payments/{provider}',
      tags: ['Webhooks'],
      summary: 'Payment provider webhook (x-callback-token verified in constant time; deduplicated; idempotent)',
      description:
        'Raw JSON body from the provider (Xendit Payment Sessions / refunds / payouts, or MOCK). Duplicate event ids return 200 without reprocessing. Unverified requests → 401 and are not stored.',
      middleware: [rateLimit({ name: 'money.webhook', limit: 600, windowSec: 60, key: 'ip' })] as const,
      request: { params: z.object({ provider: z.enum(['xendit', 'mock']).openapi({ param: { name: 'provider', in: 'path' } }) }) },
      responses: { 200: jsonContent(WebhookAck), ...errorResponses, 500: { description: 'Processing failed — provider should retry' } },
    }),
    async (c) => {
      const raw = await c.req.text();
      const res = await handleProviderWebhook(c.get('deps'), c.req.valid('param').provider, c.req.raw.headers, raw);
      return c.json(res, 200);
    },
  );

  // ----------------------------------------------------------------- dev-only mock checkout (development/test)
  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/dev/mock-checkout/{ref}',
      tags: ['Dev'],
      summary: 'MOCK checkout page (development/test only)',
      request: { params: z.object({ ref: z.string().min(3).max(100).openapi({ param: { name: 'ref', in: 'path' } }) }) },
      responses: { 200: { description: 'HTML page', content: { 'text/html': { schema: z.string() } } }, 404: errorResponses[404] },
    }),
    async (c) => {
      const deps = c.get('deps');
      const p = deps.providers.payment;
      if (!isDevEnv(deps.env.APP_ENV) || !(p instanceof MockPaymentProvider)) throw new AppError(404, 'NOT_FOUND', 'Endpoint tidak ditemukan');
      const ref = c.req.valid('param').ref;
      const s = p.sessions.get(ref);
      if (!s) throw new AppError(404, 'PAYMENT_NOT_FOUND', 'Sesi pembayaran MOCK tidak ditemukan');
      const safeRef = escapeHtml(ref);
      const html = `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Simulasi Pembayaran — MOCK</title></head><body>
<h1>Simulasi Pembayaran — MOCK</h1>
<p><strong>SANDBOX / MOCK</strong> — tidak ada uang sungguhan yang berpindah.</p>
<p>Referensi: ${safeRef}<br>Nominal: Rp${s.input.amountIdr.toLocaleString('id-ID')}<br>Status: ${escapeHtml(s.status)}</p>
<form method="post" action="/v1/dev/mock-checkout/${safeRef}/pay"><button type="submit">Bayar (simulasi)</button></form>
<form method="post" action="/v1/dev/mock-checkout/${safeRef}/expire"><button type="submit">Kedaluwarsakan</button></form>
</body></html>`;
      return c.html(html, 200);
    },
  );

  for (const action of ['pay', 'expire'] as const) {
    r.openapi(
      createRoute({
        method: 'post',
        path: `/v1/dev/mock-checkout/{ref}/${action}`,
        tags: ['Dev'],
        summary: action === 'pay' ? 'MOCK: pay the checkout (builds the provider webhook and processes it)' : 'MOCK: expire the checkout',
        request: {
          params: z.object({ ref: z.string().min(3).max(100).openapi({ param: { name: 'ref', in: 'path' } }) }),
          query: z.object({ channel: z.enum(['VA', 'QRIS', 'EWALLET', 'CARD']).optional() }),
        },
        responses: { 200: jsonContent(WebhookAck), ...errorResponses },
      }),
      async (c) => {
        const deps = c.get('deps');
        const p = deps.providers.payment;
        if (!isDevEnv(deps.env.APP_ENV) || !(p instanceof MockPaymentProvider)) throw new AppError(404, 'NOT_FOUND', 'Endpoint tidak ditemukan');
        const ref = c.req.valid('param').ref;
        if (!p.sessions.has(ref)) throw new AppError(404, 'PAYMENT_NOT_FOUND', 'Sesi pembayaran MOCK tidak ditemukan');
        const channel = c.req.valid('query').channel;
        const body = p.buildPaymentWebhook(ref, action === 'pay' ? 'SUCCEEDED' : 'EXPIRED', channel ? { channel } : {});
        const headers = new Headers({ 'x-callback-token': MOCK_WEBHOOK_TOKEN, 'content-type': 'application/json' });
        // Same code path as a real provider webhook.
        return c.json(await handleProviderWebhook(deps, 'mock', headers, body), 200);
      },
    );
  }

  app.route('/', r);
}
