/**
 * Multi-channel notification dispatcher (outbox-driven).
 *
 * Idempotency per (outbox eventId, user, channel):
 *   notifications UNIQUE (user_id, outbox_event_id)  → one in-app row per event & user
 *   notification_deliveries UNIQUE (notification_id, channel) → one PUSH / EMAIL delivery each
 * A delivery is claimed with SELECT … FOR UPDATE SKIP LOCKED, so redelivered outbox events, the retry
 * queue and concurrent workers never send twice; e-mails also carry a provider idempotency key.
 * Provider failures never fail the outbox event: the delivery is marked FAILED and retried through the
 * `engagement.notifications` job queue (exponential backoff, 5 attempts).
 */
import type { AppDeps } from '../../context';
import type { Db, TxSql } from '../../db/sql';
import { emailDestination, loadRecipient, loadTxView, type Recipient } from './context';
import { effectivePrefs, resolveChannels } from './preferences';
import { getTemplate } from './templates/catalog';
import { renderNotification, type NotificationRefs } from './templates/render';
import type { RenderedNotification, Role, TxView } from './templates/types';

export const NOTIFICATION_QUEUE = 'engagement.notifications';
export const MAX_DELIVERY_ATTEMPTS = 5;
const IN_APP_TTL_DAYS = 180;

export interface NotificationIntent {
  userId: string;
  template: string;
  role?: Role;
  transactionId?: string | null;
  refs?: NotificationRefs;
  vars?: Record<string, unknown>;
}

export interface SourceEvent {
  eventId: string;
  eventType: string;
}

const ANDROID_CHANNEL: Record<string, string> = {
  TRANSACTION: 'transactions',
  PAYMENT: 'payments',
  CHAT: 'chat',
  PROMOTION: 'promotions',
  ACCOUNT: 'account',
};

function jsonSafe(v: Record<string, unknown> | undefined): Record<string, unknown> {
  return v ? (JSON.parse(JSON.stringify(v)) as Record<string, unknown>) : {};
}

async function hasMarketingConsent(db: Db, userId: string): Promise<boolean> {
  const [r] = await db<{ granted: boolean }[]>`
    SELECT granted FROM consents WHERE user_id = ${userId} AND type = 'MARKETING' ORDER BY created_at DESC, id DESC LIMIT 1`;
  return r?.granted === true;
}

export async function dispatchNotifications(deps: AppDeps, source: SourceEvent, intents: NotificationIntent[]): Promise<void> {
  const txCache = new Map<string, TxView | null>();
  const seen = new Set<string>();
  for (const intent of intents) {
    // one notification per (event, user) — the DB unique key enforces it too
    if (seen.has(intent.userId)) continue;
    seen.add(intent.userId);
    await dispatchOne(deps, source, intent, txCache);
  }
}

async function dispatchOne(deps: AppDeps, source: SourceEvent, intent: NotificationIntent, txCache: Map<string, TxView | null>): Promise<void> {
  const { sql } = deps;
  const def = getTemplate(intent.template);
  const recipient = await loadRecipient(sql, intent.userId);
  if (!recipient || recipient.anonymized || recipient.status === 'DELETED') return;

  let tx: TxView | undefined;
  if (intent.transactionId) {
    if (!txCache.has(intent.transactionId)) txCache.set(intent.transactionId, await loadTxView(sql, intent.transactionId));
    tx = txCache.get(intent.transactionId) ?? undefined;
    if (!tx) {
      deps.logger.warn('notifications.transaction_missing', { transactionId: intent.transactionId, template: def.key });
      return;
    }
  }

  const prefRows = await sql<{ category: string; channel: string; enabled: boolean }[]>`
    SELECT category, channel, enabled FROM notification_preferences WHERE user_id = ${recipient.id}`;
  const consent = def.marketing ? await hasMarketingConsent(sql, recipient.id) : true;
  const decisions = resolveChannels(def, effectivePrefs(prefRows), consent);
  const vars = jsonSafe(intent.vars);
  const refs: NotificationRefs = { ...(intent.refs ?? {}), ...(intent.transactionId ? { transactionId: intent.transactionId } : {}) };
  const rendered = renderNotification({
    key: def.key,
    locale: recipient.locale,
    role: intent.role,
    recipientDisplayName: recipient.displayName,
    tx,
    vars,
    refs,
    webBaseUrl: deps.env.WEB_BASE_URL,
  });
  const data = { ...rendered.push.data, ...(intent.role ? { role: intent.role } : {}), vars };
  const now = deps.clock.now();

  const pending = await sql.begin(async (t) => {
    const txq = t as unknown as TxSql;
    const [ins] = await txq<{ id: string }[]>`
      INSERT INTO notifications (user_id, event_type, category, title, body, data, outbox_event_id, in_app, expires_at, created_at)
      VALUES (${recipient.id}, ${def.key}, ${def.category}, ${rendered.title}, ${rendered.body}, ${txq.json(data as never)},
              ${source.eventId}, ${decisions.IN_APP.send}, ${new Date(now.getTime() + IN_APP_TTL_DAYS * 86400_000)}, ${now})
      ON CONFLICT (user_id, outbox_event_id) DO NOTHING
      RETURNING id`;
    let notificationId = ins?.id;
    if (!notificationId) {
      const [ex] = await txq<{ id: string }[]>`SELECT id FROM notifications WHERE user_id = ${recipient.id} AND outbox_event_id = ${source.eventId}`;
      notificationId = ex!.id;
    }
    for (const ch of ['PUSH', 'EMAIL'] as const) {
      const d = decisions[ch];
      if (!d.send && d.reason === 'NOT_USED') continue;
      await txq`
        INSERT INTO notification_deliveries (notification_id, channel, status, skip_reason)
        VALUES (${notificationId}, ${ch}, ${d.send ? 'QUEUED' : 'SKIPPED'}, ${d.send ? null : d.reason})
        ON CONFLICT (notification_id, channel) DO NOTHING`;
    }
    return txq<{ id: string }[]>`
      SELECT id FROM notification_deliveries
       WHERE notification_id = ${notificationId} AND status IN ('QUEUED','FAILED') AND attempts < ${MAX_DELIVERY_ATTEMPTS}`;
  });

  for (const d of pending) {
    await attemptDelivery(deps, d.id, { rendered, recipient, enqueueRetryOnFailure: true });
  }
}

export type DeliveryOutcome = 'SENT' | 'SKIPPED' | 'FAILED' | 'NOT_CLAIMED';

/**
 * Sends one delivery. The row is locked for the duration of the provider call (SKIP LOCKED claim),
 * so concurrent attempts are impossible; the outcome is written in the same DB transaction.
 */
export async function attemptDelivery(
  deps: AppDeps,
  deliveryId: string,
  ctx: { rendered: RenderedNotification; recipient: Recipient; enqueueRetryOnFailure: boolean },
): Promise<DeliveryOutcome> {
  const { sql, providers, env, logger } = deps;
  let outcome: DeliveryOutcome = 'NOT_CLAIMED';
  let retry = false;
  await sql.begin(async (t) => {
    const tx = t as unknown as TxSql;
    const [d] = await tx<{ id: string; channel: 'PUSH' | 'EMAIL' | 'SMS'; attempts: number }[]>`
      SELECT id, channel, attempts FROM notification_deliveries
       WHERE id = ${deliveryId} AND status IN ('QUEUED','FAILED') AND attempts < ${MAX_DELIVERY_ATTEMPTS}
       FOR UPDATE SKIP LOCKED`;
    if (!d) return;
    const attempts = d.attempts + 1;
    const skip = async (reason: string) => {
      outcome = 'SKIPPED';
      await tx`UPDATE notification_deliveries SET status = 'SKIPPED', skip_reason = ${reason}, attempts = ${attempts} WHERE id = ${d.id}`;
    };
    try {
      if (d.channel === 'EMAIL') {
        const to = emailDestination(ctx.recipient);
        if (!to) return await skip('NO_EMAIL');
        const hash = Buffer.from(await deps.crypto.hashIdentifier('email', to.trim().toLowerCase()));
        const def = getTemplate(ctx.rendered.key);
        const [sup] = await tx<{ scope: string }[]>`SELECT scope FROM email_suppressions WHERE email_hash = ${hash}`;
        if (sup && (sup.scope === 'ALL' || def.marketing)) return await skip('SUPPRESSED');
        const res = await providers.email.send({
          to,
          subject: ctx.rendered.email.subject,
          html: ctx.rendered.email.html,
          text: ctx.rendered.email.text,
          tags: { template: ctx.rendered.key.replace(/[^A-Za-z0-9_-]/g, '_'), category: ctx.rendered.category },
          idempotencyKey: `notif-${d.id}`,
          ...(env.EMAIL_REPLY_TO ? { replyTo: env.EMAIL_REPLY_TO } : {}),
        });
        outcome = 'SENT';
        await tx`UPDATE notification_deliveries
                    SET status = 'SENT', sent_at = now(), attempts = ${attempts}, error = NULL,
                        provider = ${env.EMAIL_PROVIDER.toUpperCase()}, provider_env = ${providers.email.mode === 'LIVE' ? 'LIVE' : 'TEST'},
                        provider_ref = ${res.providerRef}
                  WHERE id = ${d.id}`;
        return;
      }
      if (d.channel === 'PUSH') {
        const rows = await tx<{ push_token: string }[]>`
          SELECT DISTINCT dv.push_token FROM user_devices ud JOIN devices dv ON dv.id = ud.device_id
           WHERE ud.user_id = ${ctx.recipient.id} AND ud.revoked_at IS NULL AND dv.push_token IS NOT NULL`;
        const tokens = rows.map((r) => r.push_token);
        if (tokens.length === 0) return await skip('NO_DEVICE');
        const res = await providers.push.send({
          tokens,
          title: ctx.rendered.push.title,
          body: ctx.rendered.push.body,
          data: ctx.rendered.push.data,
          channelId: ANDROID_CHANNEL[ctx.rendered.group] ?? 'default',
        });
        if (res.invalidTokens.length) {
          await tx`UPDATE devices SET push_token = NULL, push_token_updated_at = now() WHERE push_token = ANY(${tx.array(res.invalidTokens)}::text[])`;
        }
        // some providers (the MOCK) count invalid tokens as sent → never trust more than the valid ones
        const delivered = Math.min(res.sent, tokens.length - new Set(res.invalidTokens).size);
        if (delivered <= 0) return await skip('NO_VALID_DEVICE');
        outcome = 'SENT';
        await tx`UPDATE notification_deliveries
                    SET status = 'SENT', sent_at = now(), attempts = ${attempts}, error = NULL,
                        provider = ${env.PUSH_PROVIDER.toUpperCase()}, provider_env = ${providers.push.mode === 'LIVE' ? 'LIVE' : 'TEST'},
                        provider_ref = ${`sent:${delivered}/${tokens.length}`}
                  WHERE id = ${d.id}`;
        return;
      }
      return await skip('CHANNEL_UNSUPPORTED');
    } catch (err) {
      outcome = 'FAILED';
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('notifications.delivery_failed', { deliveryId: d.id, channel: d.channel, attempts, error: msg.slice(0, 300) });
      await tx`UPDATE notification_deliveries SET status = 'FAILED', attempts = ${attempts}, error = ${msg.slice(0, 1000)} WHERE id = ${d.id}`;
      retry = ctx.enqueueRetryOnFailure && attempts < MAX_DELIVERY_ATTEMPTS;
    }
  });
  if (retry) {
    // same shape as jobs/runner enqueueJob (not imported: runner → jobs/engagement → here would be a cycle)
    await sql`
      INSERT INTO jobs (queue, name, payload, run_at, dedupe_key, max_attempts)
      VALUES (${NOTIFICATION_QUEUE}, 'retry_delivery', ${sql.json({ deliveryId } as never)},
              ${new Date(deps.clock.now().getTime() + 60_000)}, ${`delivery:${deliveryId}`}, ${MAX_DELIVERY_ATTEMPTS})
      ON CONFLICT DO NOTHING`;
  }
  return outcome;
}

/** Queue handler: re-renders from the stored notification (fresh DB facts) and retries the delivery. */
export async function retryDeliveryJob(deps: AppDeps, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const deliveryId = typeof payload.deliveryId === 'string' ? payload.deliveryId : null;
  if (!deliveryId) return { skipped: 'NO_DELIVERY_ID' };
  const [row] = await deps.sql<{ user_id: string; event_type: string; data: Record<string, unknown> }[]>`
    SELECT n.user_id, n.event_type, n.data FROM notification_deliveries d JOIN notifications n ON n.id = d.notification_id WHERE d.id = ${deliveryId}`;
  if (!row) return { skipped: 'NOT_FOUND' };
  const recipient = await loadRecipient(deps.sql, row.user_id);
  if (!recipient || recipient.anonymized) return { skipped: 'RECIPIENT_GONE' };
  const data = row.data ?? {};
  const str = (k: string) => (typeof data[k] === 'string' ? (data[k] as string) : null);
  const tx = str('transactionId') ? ((await loadTxView(deps.sql, str('transactionId')!)) ?? undefined) : undefined;
  const role = str('role');
  const rendered = renderNotification({
    key: row.event_type,
    locale: recipient.locale,
    role: role === 'BUYER' || role === 'TRAVELER' ? role : undefined,
    recipientDisplayName: recipient.displayName,
    tx,
    vars: (data.vars as Record<string, unknown>) ?? {},
    refs: {
      transactionId: str('transactionId'),
      disputeId: str('disputeId'),
      conversationId: str('conversationId'),
      ticketId: str('ticketId'),
      tripId: str('tripId'),
      requestId: str('requestId'),
    },
    webBaseUrl: deps.env.WEB_BASE_URL,
  });
  const outcome = await attemptDelivery(deps, deliveryId, { rendered, recipient, enqueueRetryOnFailure: false });
  if (outcome === 'FAILED') throw new Error(`delivery ${deliveryId} failed again`);
  return { outcome };
}
