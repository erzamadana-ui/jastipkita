/**
 * Server-side funnel events derived from the outbox so business metrics never depend on clients
 * (ad blockers, old app versions). Idempotent via analytics_events.dedupe_key
 * `srv:<outboxEventId>:<event>:<userId>`; platform = SERVER.
 */
import type { AppDeps } from '../../context';
import type { OutboxEvent } from '../../jobs/types';
import { pid, pnum, pstr, type EventPart } from '../notifications/util';
import type { AnalyticsEventName } from './sanitize';

type Derived = { name: AnalyticsEventName; userId: string; properties: Record<string, unknown> };

async function derive(deps: AppDeps, ev: OutboxEvent): Promise<Derived[]> {
  const p = ev.payload;
  switch (ev.eventType) {
    case 'user.registered': {
      const u = pid(p, 'userId');
      return u ? [{ name: 'signup_completed', userId: u, properties: { method: pstr(p, 'method') ?? null } }] : [];
    }
    case 'kyc.submitted': {
      const u = pid(p, 'userId');
      return u ? [{ name: 'kyc_submitted', userId: u, properties: { targetLevel: pnum(p, 'targetLevel') ?? null } }] : [];
    }
    case 'request.created': {
      const u = pid(p, 'buyerId');
      return u ? [{ name: 'request_created', userId: u, properties: { requestId: pid(p, 'requestId') ?? null } }] : [];
    }
    case 'offer.created': {
      const by = pstr(p, 'initiatedBy');
      const u = by === 'BUYER' ? pid(p, 'buyerId') : pid(p, 'travelerId');
      return u ? [{ name: 'offer_sent', userId: u, properties: { offerId: pid(p, 'offerId') ?? null, initiatedBy: by ?? null } }] : [];
    }
    case 'offer.accepted': {
      const by = pstr(p, 'initiatedBy');
      const u = by === 'BUYER' ? pid(p, 'travelerId') : pid(p, 'buyerId');
      return u ? [{ name: 'offer_accepted', userId: u, properties: { offerId: pid(p, 'offerId') ?? null } }] : [];
    }
    case 'payment.checkout_created': {
      const u = pid(p, 'buyerId');
      return u ? [{ name: 'payment_initiated', userId: u, properties: { transactionId: pid(p, 'transactionId') ?? null, amountIdr: pnum(p, 'amountIdr') ?? null } }] : [];
    }
    case 'transaction.status_changed': {
      const to = pstr(p, 'to');
      const txId = pid(p, 'transactionId');
      const buyer = pid(p, 'buyerId');
      const traveler = pid(p, 'travelerId');
      if (!txId || !buyer) return [];
      const props = { transactionId: txId };
      if (to === 'PAYMENT_SECURED' && pstr(p, 'from') === 'AWAITING_PAYMENT') return [{ name: 'payment_secured', userId: buyer, properties: props }];
      if (to === 'PURCHASED' && traveler) return [{ name: 'purchase_completed', userId: traveler, properties: props }];
      if (to === 'BUYER_CONFIRMED' && pstr(p, 'from') === 'DELIVERED') return [{ name: 'delivery_confirmed', userId: buyer, properties: { ...props, auto: pstr(p, 'actorType') === 'SYSTEM' } }];
      if (to === 'COMPLETED') {
        const [c] = await deps.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM transactions WHERE buyer_id = ${buyer} AND status = 'COMPLETED'`;
        const out: Derived[] = [{ name: 'transaction_completed', userId: buyer, properties: props }];
        if ((c?.n ?? 0) >= 2) out.push({ name: 'repeat_transaction', userId: buyer, properties: { ...props, completedCount: c!.n } });
        return out;
      }
      return [];
    }
    default:
      return [];
  }
}

export const SERVER_ANALYTICS_EVENT_TYPES = [
  'user.registered',
  'kyc.submitted',
  'request.created',
  'offer.created',
  'offer.accepted',
  'payment.checkout_created',
  'transaction.status_changed',
];

export const analyticsPart: EventPart = async function serverAnalytics(deps, ev) {
  const derived = await derive(deps, ev);
  for (const d of derived) {
    await deps.sql`
      INSERT INTO analytics_events (event_name, user_id, platform, properties, occurred_at, dedupe_key)
      VALUES (${d.name}, ${d.userId}, 'SERVER', ${deps.sql.json({ ...d.properties, source: 'server' } as never)}, ${ev.createdAt}, ${`srv:${ev.eventId}:${d.name}:${d.userId}`})
      ON CONFLICT DO NOTHING`;
  }
};
