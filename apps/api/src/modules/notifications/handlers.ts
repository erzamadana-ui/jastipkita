/**
 * Outbox event → notification intents (docs/dev/api-module-guide.md §6). Builders load everything
 * except ids from the DB, skip silently when the referenced entity no longer exists, and never put
 * delivery PINs or other secrets into notifications.
 */
import type { AppDeps } from '../../context';
import type { OutboxEvent } from '../../jobs/types';
import { moderateText } from '../chat/moderation';
import { dispatchNotifications, type NotificationIntent } from './dispatcher';
import { publicName, truncate } from './templates/format';
import { pid, pnum, pstr, type EventPart } from './util';

type Builder = (deps: AppDeps, ev: OutboxEvent) => Promise<NotificationIntent[]>;

const addHoursIso = (d: Date, hours: number) => new Date(d.getTime() + hours * 3600_000).toISOString();

async function parties(deps: AppDeps, txId: string): Promise<{ buyerId: string; travelerId: string | null } | null> {
  const [t] = await deps.sql<{ buyer_id: string; traveler_id: string | null }[]>`SELECT buyer_id, traveler_id FROM transactions WHERE id = ${txId}`;
  return t ? { buyerId: t.buyer_id, travelerId: t.traveler_id } : null;
}

async function buyerOf(deps: AppDeps, p: Record<string, unknown>, txId: string): Promise<string | undefined> {
  return pid(p, 'buyerId') ?? (await parties(deps, txId))?.buyerId;
}

async function travelerOf(deps: AppDeps, p: Record<string, unknown>, txId: string): Promise<string | undefined> {
  return pid(p, 'travelerId') ?? (await parties(deps, txId))?.travelerId ?? undefined;
}

const STATUS_TEMPLATES: Record<string, string> = {
  PURCHASED: 'transaction.purchased',
  TRAVELING: 'transaction.traveling',
  ARRIVED: 'transaction.arrived',
  CUSTOMS_PROCESS: 'transaction.customs',
  READY_FOR_HANDOVER: 'transaction.ready_for_handover',
  OUT_FOR_DELIVERY: 'transaction.out_for_delivery',
};

const transactionStatusChanged: Builder = async (deps, ev) => {
  const p = ev.payload;
  const txId = pid(p, 'transactionId');
  const to = pstr(p, 'to');
  const from = pstr(p, 'from');
  if (!txId || !to) return [];
  const ps = await parties(deps, txId);
  if (!ps) return [];
  const buyer = pid(p, 'buyerId') ?? ps.buyerId;
  const traveler = pid(p, 'travelerId') ?? ps.travelerId ?? undefined;
  const vars = { txStatus: to, from: from ?? null, actorType: pstr(p, 'actorType') ?? null };
  const b = (template: string, extra: Record<string, unknown> = {}): NotificationIntent => ({
    userId: buyer,
    template,
    role: 'BUYER',
    transactionId: txId,
    vars: { ...vars, ...extra },
  });
  const t = (template: string, extra: Record<string, unknown> = {}): NotificationIntent[] =>
    traveler ? [{ userId: traveler, template, role: 'TRAVELER', transactionId: txId, vars: { ...vars, ...extra } }] : [];

  switch (to) {
    case 'MATCHED':
      // AWAITING_PAYMENT → MATCHED = invoice expired (payment.expired notifies)
      return from === 'AWAITING_PAYMENT' ? [] : [b('transaction.matched'), ...t('transaction.matched')];
    case 'PAYMENT_SECURED':
      // PRICE_CHANGE_PENDING → PAYMENT_SECURED is a price revision, not a new payment
      return from === 'AWAITING_PAYMENT' ? [b('transaction.payment_secured'), ...t('transaction.payment_secured')] : [];
    case 'PURCHASE_APPROVED':
      return [...t('transaction.purchase_approved'), ...(from === 'PAYMENT_SECURED' ? [b('transaction.purchase_approved')] : [])];
    case 'OUT_FOR_DELIVERY': {
      const [d] = await deps.sql<{ courier_name: string | null; tracking_number: string | null }[]>`
        SELECT courier_name, tracking_number FROM deliveries WHERE transaction_id = ${txId} AND status NOT IN ('FAILED','CANCELLED')
         ORDER BY created_at DESC LIMIT 1`;
      return [b('transaction.out_for_delivery', { courierName: d?.courier_name ?? null, trackingNumber: d?.tracking_number ?? null })];
    }
    case 'DELIVERED': {
      const sla = await deps.config.get('dispute.sla');
      const delivery = await deps.config.get('delivery');
      const extra = { disputeWindowHours: sla.openWindowHoursAfterDelivery, autoConfirmHours: delivery.autoConfirmHours };
      return [b('transaction.delivered', extra), ...t('transaction.delivered', extra)];
    }
    case 'BUYER_CONFIRMED':
      return from === 'DISPUTED' ? [] : t('transaction.buyer_confirmed');
    case 'COMPLETED':
      return [b('transaction.completed'), ...t('transaction.completed')];
    case 'CANCELLED': {
      // A trip cancelled by the traveler notifies through the dedicated `transaction.trip_cancelled` event.
      const meta = (p.meta ?? {}) as Record<string, unknown>;
      if (meta.cause === 'TRIP_CANCELLED') return [];
      return [b('transaction.cancelled'), ...t('transaction.cancelled')];
    }
    default: {
      const tpl = STATUS_TEMPLATES[to];
      return tpl ? [b(tpl)] : [];
    }
  }
};

const buyerTemplate =
  (template: string, varsOf: (p: Record<string, unknown>) => Record<string, unknown> = () => ({})): Builder =>
  async (deps, ev) => {
    const txId = pid(ev.payload, 'transactionId');
    if (!txId) return [];
    const buyer = await buyerOf(deps, ev.payload, txId);
    return buyer ? [{ userId: buyer, template, role: 'BUYER', transactionId: txId, vars: varsOf(ev.payload) }] : [];
  };

const priceConfirmationResolved: Builder = async (deps, ev) => {
  const p = ev.payload;
  const txId = pid(p, 'transactionId');
  if (!txId) return [];
  const status = pstr(p, 'status') ?? 'APPROVED';
  const vars = { status, actualIdr: pnum(p, 'actualIdr') ?? null, originalIdr: pnum(p, 'originalIdr') ?? null };
  const buyer = await buyerOf(deps, p, txId);
  const traveler = await travelerOf(deps, p, txId);
  const out: NotificationIntent[] = [];
  if (buyer) out.push({ userId: buyer, template: 'price.change_result', role: 'BUYER', transactionId: txId, vars });
  // APPROVED → the traveler gets transaction.purchase_approved (or the supplemental payment flow)
  if (traveler && status !== 'APPROVED') out.push({ userId: traveler, template: 'price.change_result', role: 'TRAVELER', transactionId: txId, vars });
  return out;
};

const refundEvent =
  (template: string): Builder =>
  async (deps, ev) => {
    const p = ev.payload;
    const txId = pid(p, 'transactionId');
    const refundId = pid(p, 'refundId');
    if (!txId) return [];
    const buyer = await buyerOf(deps, p, txId);
    let refundNumber: string | null = null;
    let amountIdr = pnum(p, 'amountIdr') ?? null;
    let method: string | null = null;
    if (refundId) {
      const [r] = await deps.sql<{ number: string; amount_idr: number; method: string | null }[]>`SELECT number, amount_idr, breakdown->>'method' AS method FROM refunds WHERE id = ${refundId}`;
      refundNumber = r?.number ?? null;
      amountIdr = amountIdr ?? (r ? Number(r.amount_idr) : null);
      method = r?.method ?? null;
    }
    const extra: Record<string, unknown> = {};
    if (template === 'refund.destination_updated' && refundId) {
      const [d] = await deps.sql<{ bank_code: string; account_mask: string; validation_status: string }[]>`
        SELECT bank_code, account_mask, validation_status FROM refund_destinations WHERE refund_id = ${refundId}`;
      if (!d) return [];
      Object.assign(extra, { bankCode: d.bank_code, accountMask: d.account_mask, validationStatus: d.validation_status });
    }
    return buyer ? [{ userId: buyer, template, role: 'BUYER', transactionId: txId, vars: { refundNumber, amountIdr, method, ...extra } }] : [];
  };

const priceClarificationRequested: Builder = async (deps, ev) => {
  const p = ev.payload;
  const txId = pid(p, 'transactionId');
  const pcId = pid(p, 'priceConfirmationId');
  if (!txId) return [];
  const traveler = await travelerOf(deps, p, txId);
  if (!traveler) return [];
  let note: string | null = null;
  if (pcId) {
    const [pc] = await deps.sql<{ response_note: string | null }[]>`SELECT response_note FROM price_confirmations WHERE id = ${pcId}`;
    // Free text from the buyer: masked like chat (no contact details / off-platform payment) and truncated.
    if (pc?.response_note) note = truncate(moderateText(pc.response_note).masked, 300);
  }
  return [
    {
      userId: traveler,
      template: 'price.clarification_requested',
      role: 'TRAVELER',
      transactionId: txId,
      vars: { originalIdr: pnum(p, 'originalIdr') ?? null, actualIdr: pnum(p, 'actualIdr') ?? null, expiresAt: pstr(p, 'expiresAt') ?? null, note },
    },
  ];
};

const tripCancelledTransaction: Builder = async (deps, ev) => {
  const p = ev.payload;
  const txId = pid(p, 'transactionId');
  if (!txId) return [];
  const ps = await parties(deps, txId);
  if (!ps) return [];
  const vars = { refundIdr: pnum(p, 'refundIdr') ?? 0, trustPenalty: pnum(p, 'trustPenalty') ?? 0, outcome: pstr(p, 'outcome') ?? null };
  const out: NotificationIntent[] = [{ userId: ps.buyerId, template: 'transaction.trip_cancelled', role: 'BUYER', transactionId: txId, vars }];
  if (ps.travelerId) out.push({ userId: ps.travelerId, template: 'transaction.trip_cancelled', role: 'TRAVELER', transactionId: txId, vars });
  return out;
};

const payoutEvent =
  (template: string): Builder =>
  async (deps, ev) => {
    const p = ev.payload;
    const payoutId = pid(p, 'payoutId');
    let traveler = pid(p, 'travelerId');
    let txId = pid(p, 'transactionId');
    let payoutNumber: string | null = null;
    let accountMask: string | null = null;
    let amountIdr = pnum(p, 'amountIdr') ?? null;
    if (payoutId) {
      const [r] = await deps.sql<{ number: string; traveler_id: string; transaction_id: string | null; amount_idr: number; account_mask: string | null }[]>`
        SELECT po.number, po.traveler_id, po.transaction_id, po.amount_idr, pa.account_mask
          FROM payouts po LEFT JOIN payout_accounts pa ON pa.id = po.payout_account_id WHERE po.id = ${payoutId}`;
      if (r) {
        payoutNumber = r.number;
        accountMask = r.account_mask;
        traveler = traveler ?? r.traveler_id;
        txId = txId ?? r.transaction_id ?? undefined;
        amountIdr = amountIdr ?? Number(r.amount_idr);
      }
    }
    if (!traveler) return [];
    return [{ userId: traveler, template, role: 'TRAVELER', transactionId: txId ?? null, vars: { payoutNumber, accountMask, amountIdr } }];
  };

interface DisputeRow {
  id: string;
  number: string;
  transaction_id: string;
  type: string;
  status: string;
  opened_by: string;
  resolution: string | null;
  resolution_amount_idr: number | null;
  evidence_due_at: Date | null;
  sla_due_at: Date | null;
  resolved_at: Date | null;
  appealed_at: Date | null;
  buyer_id: string;
  traveler_id: string | null;
}

async function loadDispute(deps: AppDeps, disputeId: string): Promise<DisputeRow | null> {
  const [d] = await deps.sql<DisputeRow[]>`
    SELECT d.id, d.number, d.transaction_id, d.type, d.status, d.opened_by, d.resolution, d.resolution_amount_idr,
           d.evidence_due_at, d.sla_due_at, d.resolved_at, d.appealed_at, t.buyer_id, t.traveler_id
      FROM disputes d JOIN transactions t ON t.id = d.transaction_id WHERE d.id = ${disputeId}`;
  return d ?? null;
}

function disputeParties(d: DisputeRow): { userId: string; role: 'BUYER' | 'TRAVELER' }[] {
  const out: { userId: string; role: 'BUYER' | 'TRAVELER' }[] = [{ userId: d.buyer_id, role: 'BUYER' }];
  if (d.traveler_id) out.push({ userId: d.traveler_id, role: 'TRAVELER' });
  return out;
}

const disputeBuilder =
  (template: string, extra: (deps: AppDeps, d: DisputeRow, ev: OutboxEvent) => Promise<Record<string, unknown> | null>): Builder =>
  async (deps, ev) => {
    const disputeId = pid(ev.payload, 'disputeId');
    if (!disputeId) return [];
    const d = await loadDispute(deps, disputeId);
    if (!d) return [];
    const base = await extra(deps, d, ev);
    if (!base) return [];
    return disputeParties(d).map((x) => ({
      userId: x.userId,
      template,
      role: x.role,
      transactionId: d.transaction_id,
      refs: { disputeId: d.id },
      vars: { disputeNumber: d.number, type: d.type, status: d.status, ...base, isOpener: x.userId === d.opened_by },
    }));
  };

const disputeOpened = disputeBuilder('dispute.opened', async (_deps, d) => ({
  evidenceDueAt: d.evidence_due_at?.toISOString() ?? null,
  reviewDueAt: d.sla_due_at?.toISOString() ?? null,
}));

const disputeStatusChanged = disputeBuilder('dispute.updated', async (_deps, d, ev) => {
  const to = pstr(ev.payload, 'to');
  const from = pstr(ev.payload, 'from');
  if (!to) return null;
  if (to === 'RESOLVED' || to === 'APPEALED') return null; // dispute.resolved / dispute.appealed notify
  if (from === 'OPEN' && to === 'EVIDENCE_COLLECTION' && pstr(ev.payload, 'actorType') === 'SYSTEM') return null; // part of opening
  return { status: to };
});

const disputeResolved = disputeBuilder('dispute.resolved', async (deps, d) => {
  const sla = await deps.config.get('dispute.sla');
  return {
    resolution: d.resolution,
    resolutionAmountIdr: d.resolution_amount_idr === null ? null : Number(d.resolution_amount_idr),
    appealDeadline: d.resolved_at && !d.appealed_at ? addHoursIso(d.resolved_at, sla.appealWindowHours) : null,
  };
});

const disputeAppealed = disputeBuilder('dispute.appealed', async () => ({}));

const disputeEvidenceAdded: Builder = async (deps, ev) => {
  const disputeId = pid(ev.payload, 'disputeId');
  const submittedBy = pid(ev.payload, 'submittedBy');
  if (!disputeId) return [];
  const d = await loadDispute(deps, disputeId);
  if (!d) return [];
  return disputeParties(d)
    .filter((x) => x.userId !== submittedBy)
    .map((x) => ({ userId: x.userId, template: 'dispute.evidence_added', role: x.role, transactionId: d.transaction_id, refs: { disputeId: d.id }, vars: { disputeNumber: d.number } }));
};

const chatMessageCreated: Builder = async (deps, ev) => {
  const p = ev.payload;
  const messageId = pid(p, 'messageId');
  const recipientId = pid(p, 'recipientId');
  if (!messageId || !recipientId) return [];
  const [m] = await deps.sql<{ conversation_id: string; type: string; body: string | null; meta: Record<string, unknown>; moderation_status: string; sender_name: string | null; transaction_id: string | null }[]>`
    SELECT m.conversation_id, m.type, m.body, m.meta, m.moderation_status, u.display_name AS sender_name, c.transaction_id
      FROM messages m JOIN conversations c ON c.id = m.conversation_id LEFT JOIN users u ON u.id = m.sender_id
     WHERE m.id = ${messageId} AND m.deleted_at IS NULL`;
  if (!m || m.moderation_status === 'HIDDEN') return [];
  const masked = typeof m.meta?.maskedBody === 'string' ? (m.meta.maskedBody as string) : null;
  const text = m.moderation_status === 'FLAGGED' ? (masked ?? '') : (m.body ?? '');
  const preview =
    m.type === 'IMAGE' ? '📷 Foto' : m.type === 'PRODUCT' ? '🛍️ Info produk' : m.type === 'RECEIPT' ? '🧾 Bukti pembelian' : truncate(text, 120) || 'Pesan baru';
  return [
    {
      userId: recipientId,
      template: 'chat.message',
      refs: { conversationId: m.conversation_id, ...(m.transaction_id ? { transactionId: m.transaction_id } : {}) },
      vars: { senderName: publicName(m.sender_name, 'JastipKita'), preview, messageId },
    },
  ];
};

const userTemplate =
  (template: string, varsOf: (deps: AppDeps, p: Record<string, unknown>) => Promise<Record<string, unknown> | null> = async () => ({})): Builder =>
  async (deps, ev) => {
    const userId = pid(ev.payload, 'userId');
    if (!userId) return [];
    const vars = await varsOf(deps, ev.payload);
    return vars ? [{ userId, template, vars }] : [];
  };

const kycLevelChanged: Builder = async (deps, ev) => {
  const p = ev.payload;
  const userId = pid(p, 'userId');
  const from = pnum(p, 'from');
  const to = pnum(p, 'to');
  if (!userId || (to !== 5 && from !== 5) || to === from) return [];
  const facts = (p.facts ?? {}) as Record<string, unknown>;
  return [
    {
      userId,
      template: 'kyc.trusted_traveler',
      vars: {
        granted: to === 5,
        completedAsTraveler: pnum(facts, 'completedAsTraveler') ?? null,
        trustScore: pnum(facts, 'trustScore') ?? null,
        disputeRatePct: pnum(facts, 'disputeRatePct') ?? null,
      },
    },
  ];
};

const offerEvent =
  (template: string, recipient: 'COUNTERPARTY' | 'INITIATOR'): Builder =>
  async (deps, ev) => {
    const p = ev.payload;
    if (template === 'offer.accepted' && pid(p, 'transactionId')) return []; // transaction.matched notifies
    const offerId = pid(p, 'offerId');
    if (!offerId) return [];
    const [o] = await deps.sql<{ id: string; request_id: string; traveler_id: string; initiated_by: string; traveler_fee_idr: number; buyer_id: string; product_name: string; traveler_name: string | null }[]>`
      SELECT o.id, o.request_id, o.traveler_id, o.initiated_by, o.traveler_fee_idr, r.buyer_id, r.product_name, u.display_name AS traveler_name
        FROM offers o JOIN requests r ON r.id = o.request_id JOIN users u ON u.id = o.traveler_id WHERE o.id = ${offerId}`;
    if (!o) return [];
    const initiatorIsTraveler = o.initiated_by === 'TRAVELER';
    const toTraveler = recipient === 'COUNTERPARTY' ? !initiatorIsTraveler : initiatorIsTraveler;
    return [
      {
        userId: toTraveler ? o.traveler_id : o.buyer_id,
        template,
        role: toTraveler ? 'TRAVELER' : 'BUYER',
        refs: { requestId: o.request_id },
        vars: { productName: o.product_name, travelerFeeIdr: Number(o.traveler_fee_idr), travelerName: publicName(o.traveler_name, 'Traveler') },
      },
    ];
  };

export const NOTIFICATION_BUILDERS: Record<string, Builder> = {
  'transaction.status_changed': transactionStatusChanged,
  'payment.checkout_created': buyerTemplate('payment.checkout_created', (p) => ({ amountIdr: pnum(p, 'amountIdr') ?? null, expiresAt: pstr(p, 'expiresAt') ?? null })),
  'payment.expired': buyerTemplate('payment.expired'),
  'payment.failed': buyerTemplate('payment.failed'),
  'price_confirmation.requested': buyerTemplate('price.change_requested', (p) => ({
    originalIdr: pnum(p, 'originalIdr') ?? null,
    actualIdr: pnum(p, 'actualIdr') ?? null,
    expiresAt: pstr(p, 'expiresAt') ?? null,
  })),
  'price_confirmation.resolved': priceConfirmationResolved,
  'price_confirmation.clarification_requested': priceClarificationRequested,
  'transaction.trip_cancelled': tripCancelledTransaction,
  'purchase.proof_submitted': async (deps, ev) => (ev.payload.flagged === true ? [] : buyerTemplate('purchase.receipt_available')(deps, ev)),
  'delivery.pin_ready': buyerTemplate('delivery.pin_ready'),
  'refund.requested': refundEvent('refund.requested'),
  'refund.succeeded': refundEvent('refund.succeeded'),
  'refund.failed': refundEvent('refund.failed'),
  'refund.destination_required': refundEvent('refund.destination_required'),
  'refund.destination_set': refundEvent('refund.destination_updated'),
  'payout.scheduled': payoutEvent('payout.scheduled'),
  'payout.paid': payoutEvent('payout.paid'),
  'payout.failed': payoutEvent('payout.failed'),
  'payout.on_hold': payoutEvent('payout.on_hold'),
  'receipt.final_available': buyerTemplate('receipt.final'),
  'dispute.opened': disputeOpened,
  'dispute.status_changed': disputeStatusChanged,
  'dispute.resolved': disputeResolved,
  'dispute.appealed': disputeAppealed,
  'dispute.evidence_added': disputeEvidenceAdded,
  'chat.message_created': chatMessageCreated,
  'user.registered': userTemplate('account.welcome'),
  'user.phone_verified': userTemplate('account.phone_verified'),
  'kyc.submitted': userTemplate('kyc.submitted', async (_d, p) => ({ targetLevel: pnum(p, 'targetLevel') ?? null })),
  'kyc.approved': userTemplate('kyc.approved', async (_d, p) => ({ targetLevel: pnum(p, 'targetLevel') ?? null })),
  'kyc.rejected': userTemplate('kyc.rejected', async (_d, p) => ({ targetLevel: pnum(p, 'targetLevel') ?? null, reason: pstr(p, 'reason')?.slice(0, 300) ?? null })),
  'kyc.level_changed': kycLevelChanged,
  'payout_account.verified': userTemplate('payout_account.verified', async (deps, p) => {
    const id = pid(p, 'payoutAccountId');
    if (!id) return {};
    const [a] = await deps.sql<{ bank_code: string; account_mask: string }[]>`SELECT bank_code, account_mask FROM payout_accounts WHERE id = ${id}`;
    return { bankCode: a?.bank_code ?? null, accountMask: a?.account_mask ?? null };
  }),
  'trip.verified': async (deps, ev) => {
    const tripId = pid(ev.payload, 'tripId');
    if (!tripId) return [];
    const [tr] = await deps.sql<{ traveler_id: string; origin_city: string; destination_city: string }[]>`
      SELECT traveler_id, origin_city, destination_city FROM trips WHERE id = ${tripId}`;
    if (!tr) return [];
    return [{ userId: tr.traveler_id, template: 'trip.verified', refs: { tripId }, vars: { route: `${tr.origin_city} → ${tr.destination_city}` } }];
  },
  'request.created': async (deps, ev) => {
    const requestId = pid(ev.payload, 'requestId');
    if (!requestId) return [];
    const [r] = await deps.sql<{ buyer_id: string; product_name: string }[]>`SELECT buyer_id, product_name FROM requests WHERE id = ${requestId}`;
    return r ? [{ userId: r.buyer_id, template: 'request.created', role: 'BUYER', refs: { requestId }, vars: { productName: r.product_name } }] : [];
  },
  'offer.created': offerEvent('offer.created', 'COUNTERPARTY'),
  'offer.accepted': offerEvent('offer.accepted', 'INITIATOR'),
  'offer.declined': offerEvent('offer.declined', 'INITIATOR'),
  'offer.expired': offerEvent('offer.expired', 'INITIATOR'),
  'privacy.export_ready': userTemplate('privacy.export_ready'),
  'account.deletion_scheduled': userTemplate('account.deletion_scheduled', async (_d, p) => ({ effectiveAt: pstr(p, 'effectiveAt') ?? null })),
  'referral.rewarded': userTemplate('referral.rewarded', async (_d, p) => ({ amountIdr: pnum(p, 'amountIdr') ?? null, expiresAt: pstr(p, 'expiresAt') ?? null })),
  'credit.cashback_granted': async (_deps, ev) => {
    const userId = pid(ev.payload, 'userId');
    if (!userId) return [];
    return [
      {
        userId,
        template: 'credit.cashback_granted',
        transactionId: pid(ev.payload, 'transactionId') ?? null,
        vars: { amountIdr: pnum(ev.payload, 'amountIdr') ?? null, expiresAt: pstr(ev.payload, 'expiresAt') ?? null, promotionName: pstr(ev.payload, 'promotionName') ?? null },
      },
    ];
  },
  'support.ticket_updated': async (deps, ev) => {
    const p = ev.payload;
    const ticketId = pid(p, 'ticketId');
    if (!ticketId || pstr(p, 'actorType') === 'USER') return []; // the user did it themself
    const [tk] = await deps.sql<{ user_id: string | null; number: string; status: string }[]>`SELECT user_id, number, status FROM support_tickets WHERE id = ${ticketId}`;
    if (!tk?.user_id) return [];
    return [{ userId: tk.user_id, template: 'support.ticket_updated', refs: { ticketId }, vars: { ticketNumber: tk.number, status: pstr(p, 'status') ?? tk.status } }];
  },
};

/** Event types that produce notifications (used by jobs/engagement.ts and the lifecycle test). */
export const NOTIFIED_EVENT_TYPES = Object.keys(NOTIFICATION_BUILDERS);

export const notifyPart: EventPart = async function notify(deps, ev) {
  const build = NOTIFICATION_BUILDERS[ev.eventType];
  if (!build) return;
  const intents = await build(deps, ev);
  if (intents.length) await dispatchNotifications(deps, { eventId: ev.eventId, eventType: ev.eventType }, intents);
};
