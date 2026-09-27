/**
 * Provider webhook intake: verify (constant-time token) → dedupe in `payment_webhook_events`
 * (unique provider+event_id) → process idempotently. Unverified requests are never stored (an attacker
 * must not be able to pre-occupy an event id) and never change state.
 */
import type { AppDeps } from '../../context';
import { AppError } from '../../lib/errors';
import { providerEnv } from '../../providers/payment';
import { processPayoutEvent } from '../payouts/service';
import { processPaymentEvent } from '../payments/service';
import { processRefundEvent } from '../refunds/service';

export type WebhookResult = { status: 'PROCESSED' | 'DUPLICATE' | 'IGNORED'; eventId: string; outcome?: string };

const SAFE_HEADERS = ['webhook-id', 'content-type', 'user-agent', 'x-request-id'];

export async function handleProviderWebhook(deps: AppDeps, providerParam: string, headers: Headers, rawBody: string): Promise<WebhookResult> {
  const provider = deps.providers.payment;
  const expected = providerParam.toUpperCase();
  if (expected !== provider.name) throw new AppError(404, 'PROVIDER_NOT_CONFIGURED', 'Provider pembayaran tidak aktif');
  const valid = await provider.verifyWebhook(headers, rawBody);
  if (!valid) {
    deps.logger.warn('webhook.invalid_token', { provider: provider.name });
    throw new AppError(401, 'WEBHOOK_UNAUTHORIZED', 'Webhook tidak terverifikasi');
  }
  let parsed;
  try {
    parsed = provider.parseWebhook(rawBody);
  } catch {
    throw new AppError(400, 'WEBHOOK_MALFORMED', 'Payload webhook tidak valid');
  }
  const eventId = (headers.get('webhook-id') ?? parsed.eventId).slice(0, 200);
  const env = providerEnv(provider);
  const safeHeaders: Record<string, string> = {};
  for (const h of SAFE_HEADERS) {
    const v = headers.get(h);
    if (v) safeHeaders[h] = v.slice(0, 200);
  }
  const now = deps.clock.now();
  const inserted = await deps.sql<{ id: number }[]>`
    INSERT INTO payment_webhook_events (provider, provider_env, event_id, event_type, signature_valid, payload, headers, received_at, attempts)
    VALUES (${provider.name}, ${env}, ${eventId}, ${parsed.eventType}, true, ${deps.sql.json(JSON.parse(rawBody) as never)},
            ${deps.sql.json(safeHeaders as never)}, ${now}, 1)
    ON CONFLICT (provider, event_id) DO NOTHING RETURNING id`;
  let inboxId: number;
  if (inserted[0]) {
    inboxId = Number(inserted[0].id);
  } else {
    const [row] = await deps.sql<{ id: number; processed_at: Date | null }[]>`
      SELECT id, processed_at FROM payment_webhook_events WHERE provider = ${provider.name} AND event_id = ${eventId}`;
    if (row?.processed_at) return { status: 'DUPLICATE', eventId };
    inboxId = Number(row!.id);
    await deps.sql`UPDATE payment_webhook_events SET attempts = attempts + 1 WHERE id = ${inboxId}`;
  }
  try {
    let outcome: string;
    if (parsed.kind === 'PAYMENT') {
      const r = await processPaymentEvent(deps, {
        provider: provider.name,
        providerRef: parsed.providerRef,
        referenceId: parsed.referenceId,
        status: parsed.status,
        amountIdr: parsed.amountIdr,
        currency: parsed.currency,
        channel: parsed.channel,
        source: 'WEBHOOK',
        inboxId,
        signatureValid: true,
      });
      outcome = r.outcome;
    } else if (parsed.kind === 'REFUND') {
      outcome = await processRefundEvent(deps, { providerRef: parsed.providerRef, referenceId: parsed.referenceId, status: parsed.status });
      await deps.sql`UPDATE payment_webhook_events SET processed_at = ${now} WHERE id = ${inboxId}`;
    } else if (parsed.kind === 'PAYOUT') {
      outcome = await processPayoutEvent(deps, { providerRef: parsed.providerRef, referenceId: parsed.referenceId, status: parsed.status });
      await deps.sql`UPDATE payment_webhook_events SET processed_at = ${now} WHERE id = ${inboxId}`;
    } else {
      outcome = 'IGNORED';
      await deps.sql`UPDATE payment_webhook_events SET processed_at = ${now}, processing_error = 'UNHANDLED_EVENT_TYPE' WHERE id = ${inboxId}`;
    }
    return { status: outcome === 'IGNORED' ? 'IGNORED' : 'PROCESSED', eventId, outcome };
  } catch (err) {
    const msg = err instanceof Error ? err.message.slice(0, 1000) : String(err);
    await deps.sql`UPDATE payment_webhook_events SET processing_error = ${msg} WHERE id = ${inboxId}`;
    deps.logger.error('webhook.processing_failed', { provider: provider.name, eventId, error: msg });
    // 5xx → the provider retries (Xendit: up to 6 times); processing is idempotent.
    throw new AppError(500, 'WEBHOOK_PROCESSING_FAILED', 'Webhook gagal diproses; akan dicoba ulang');
  }
}
