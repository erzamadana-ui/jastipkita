import { autoConfirmDeliveries } from '../modules/delivery/service';
import { bindProtectionPolicy, expireDuePayments, expireQuotesAndLocks } from '../modules/payments/service';
import { processPayouts, scheduleOwedPayouts } from '../modules/payouts/service';
import { expirePriceConfirmations } from '../modules/price-confirmation/service';
import { pollPendingPayments, runDailyReconciliation } from '../modules/reconciliation/service';
import { processRefunds } from '../modules/refunds/service';
import { completeConfirmedTransactions } from '../modules/transactions/completion';
import type { JobGroup } from './types';

/**
 * Background jobs for the "money" module group. OWNED by the money agent/team.
 * Every job is idempotent and safe to run concurrently (row locks / FSM checks / journal idempotency keys).
 */
export const moneyJobs: JobGroup = {
  outbox: {
    // JastipKita Protection: bind the (SANDBOX) policy once the checkout payment is secured.
    'payment.secured': [
      async (deps, e) => {
        await bindProtectionPolicy(deps, e.payload as { transactionId: string; purpose?: string });
      },
    ],
  },
  scheduled: [
    { name: 'money.expire_quotes_fx_locks', everySec: 60, run: async (deps) => ({ ...(await expireQuotesAndLocks(deps)) }) },
    { name: 'money.expire_payments', everySec: 60, run: async (deps) => ({ ...(await expireDuePayments(deps)) }) },
    { name: 'money.expire_price_confirmations', everySec: 60, run: async (deps) => ({ ...(await expirePriceConfirmations(deps)) }) },
    { name: 'money.auto_confirm', everySec: 300, run: async (deps) => ({ ...(await autoConfirmDeliveries(deps)) }) },
    { name: 'money.complete_confirmed', everySec: 300, run: async (deps) => ({ ...(await completeConfirmedTransactions(deps)) }) },
    { name: 'money.process_refunds', everySec: 120, run: async (deps) => ({ ...(await processRefunds(deps)) }) },
    { name: 'money.process_payouts', everySec: 300, run: async (deps) => ({ ...(await scheduleOwedPayouts(deps)), ...(await processPayouts(deps)) }) },
    { name: 'money.reconcile_pending_payments', everySec: 600, run: async (deps) => ({ ...(await pollPendingPayments(deps)) }) },
    { name: 'money.daily_reconciliation', everySec: 86_400, run: async (deps) => ({ ...(await runDailyReconciliation(deps)) }) },
  ],
  queues: {},
};
