import { SERVER_ANALYTICS_EVENT_TYPES, analyticsPart } from '../modules/analytics/server-events';
import { chatOnTransactionStatus } from '../modules/chat/handlers';
import { runCreditExpiry } from '../modules/credits/service';
import { runDisputeSla } from '../modules/disputes/sla-job';
import { NOTIFICATION_QUEUE, retryDeliveryJob } from '../modules/notifications/dispatcher';
import { NOTIFIED_EVENT_TYPES, notifyPart } from '../modules/notifications/handlers';
import { composeHandler, pid, pstr, type EventPart } from '../modules/notifications/util';
import { cashbackOnCompleted } from '../modules/promotions/service';
import { runReferralGuardrail } from '../modules/referrals/guardrail';
import { rewardOnCompleted, runReferralExpiry } from '../modules/referrals/service';
import { TRUST_EVENT_TYPES, trustPart } from '../modules/trust/handlers';
import { runTrustSweep } from '../modules/trust/service';
import type { JobGroup, OutboxHandler } from './types';

/** event type → ordered parts. Every part is idempotent; composeHandler runs all of them and rethrows. */
const PARTS: Record<string, EventPart[]> = {};
function on(eventType: string, ...parts: EventPart[]) {
  PARTS[eventType] = [...(PARTS[eventType] ?? []), ...parts];
}

const referralPart: EventPart = async function referralReward(deps, ev) {
  const txId = pid(ev.payload, 'transactionId');
  if (txId && pstr(ev.payload, 'to') === 'COMPLETED') await rewardOnCompleted(deps, txId);
};

const cashbackPart: EventPart = async function promoCashback(deps, ev) {
  const txId = pid(ev.payload, 'transactionId');
  if (txId && pstr(ev.payload, 'to') === 'COMPLETED') await cashbackOnCompleted(deps, txId);
};

const configPart: EventPart = async function configCache(deps) {
  deps.config.invalidate();
};

// 1. chat first: the conversation must exist before notifications deep-link into it
on('transaction.status_changed', chatOnTransactionStatus);
// 2. notifications (in-app / push / e-mail) for every lifecycle event
for (const type of NOTIFIED_EVENT_TYPES) on(type, notifyPart);
// 3. money-like side effects on COMPLETED (credit ledger, idempotency keys)
on('transaction.status_changed', referralPart, cashbackPart);
// 4. trust score & level 5
for (const type of TRUST_EVENT_TYPES) on(type, trustPart);
// 5. server-side funnel analytics
for (const type of SERVER_ANALYTICS_EVENT_TYPES) on(type, analyticsPart);
// config changes apply within this worker immediately (API isolates refresh within 30 s)
on('config.activated', configPart);

const outbox: Record<string, OutboxHandler[]> = Object.fromEntries(
  Object.entries(PARTS).map(([type, parts]) => [type, [composeHandler(`engagement:${type}`, parts)]]),
);

/** Background jobs for the "engagement" module group. OWNED by the engagement agent/team. */
export const engagementJobs: JobGroup = {
  outbox,
  scheduled: [
    { name: 'engagement.dispute_sla', everySec: 300, run: runDisputeSla },
    { name: 'engagement.credit_expiry', everySec: 3600, run: runCreditExpiry },
    { name: 'engagement.referral_expiry', everySec: 3600, run: runReferralExpiry },
    { name: 'engagement.trust_sweep', everySec: 3600, run: runTrustSweep },
    { name: 'engagement.referral_guardrail', everySec: 86400, run: runReferralGuardrail },
  ],
  queues: {
    [NOTIFICATION_QUEUE]: retryDeliveryJob,
  },
};
