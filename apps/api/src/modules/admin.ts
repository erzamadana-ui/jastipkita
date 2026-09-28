import type { App } from '../context';
import { registerAdminAudit } from './admin/audit/routes';
import { registerAdminConfig } from './admin/config/routes';
import { registerAdminContent } from './admin/content/routes';
import { registerAdminDashboard } from './admin/dashboard/routes';
import { registerAdminDisputes } from './admin/disputes/routes';
import { registerAdminFinance } from './admin/finance/routes';
import { registerAdminGrowth } from './admin/growth/routes';
import { registerAdminKyc } from './admin/kyc/routes';
import { registerAdminReconciliation } from './admin/reconciliation/routes';
import { registerAdminRisk } from './admin/risk/routes';
import { registerAdminRules } from './admin/rules/routes';
import { registerAdminSettlement } from './admin/settlement/routes';
import { registerAdminSupport } from './admin/support/routes';
import { registerAdminTransactions } from './admin/transactions/routes';
import { registerAdminTrips } from './admin/trips/routes';
import { registerAdminUsers } from './admin/users/routes';
import { registerInfra } from './infra/routes';

/**
 * Route registration for the "admin" module group. OWNED by the admin agent/team — other groups must not edit.
 * Every /v1/admin/* route: requireAuth + requireAdmin + requirePermission(<least privilege>) (+ requireRecentMfa for
 * sensitive writes, + requireIdempotency for financial writes). Catalogue: docs/api/admin.md.
 */
export function registerAdmin(app: App): void {
  registerAdminDashboard(app);
  registerAdminUsers(app);
  registerAdminKyc(app);
  registerAdminTrips(app);
  registerAdminTransactions(app);
  registerAdminDisputes(app);
  registerAdminFinance(app);
  registerAdminReconciliation(app);
  registerAdminConfig(app);
  registerAdminRules(app);
  registerAdminSettlement(app);
  registerAdminGrowth(app);
  registerAdminRisk(app);
  registerAdminSupport(app);
  registerAdminContent(app);
  registerAdminAudit(app);
  registerInfra(app);
}
