import type { App } from '../context';
import { registerCancellationRoutes } from './cancellation/routes';
import { registerCheckoutRoutes } from './checkout/routes';
import { registerDeliveryRoutes } from './delivery/routes';
import { registerPayoutRoutes } from './payouts/routes';
import { registerPriceConfirmationRoutes } from './price-confirmation/routes';
import { registerPurchaseRoutes } from './purchase/routes';
import { registerRefundRoutes } from './refunds/routes';
import { registerTransactionRoutes } from './transactions/routes';
import { registerWebhookRoutes } from './webhooks/routes';

/**
 * Route registration for the "money" module group. OWNED by the money agent/team — other groups must not edit.
 * Each module lives in src/modules/<module>/ (routes.ts, service.ts, repository.ts, schemas.ts, *.test.ts).
 * SafePay integrations are SANDBOX/MOCK until the Xendit contract + legal review (docs/04-payments-ledger.md).
 */
export function registerMoney(app: App): void {
  registerTransactionRoutes(app);
  registerCheckoutRoutes(app);
  registerWebhookRoutes(app);
  registerPriceConfirmationRoutes(app);
  registerPurchaseRoutes(app);
  registerDeliveryRoutes(app);
  registerCancellationRoutes(app);
  registerRefundRoutes(app);
  registerPayoutRoutes(app);
}
