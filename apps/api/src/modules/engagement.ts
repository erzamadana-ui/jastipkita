import type { App } from '../context';
import { registerAnalytics } from './analytics/routes';
import { registerChat } from './chat/routes';
import { registerCredits } from './credits/routes';
import { registerDisputes } from './disputes/routes';
import { registerNotifications } from './notifications/routes';
import { registerPromotions } from './promotions/routes';
import { registerRatings } from './ratings/routes';
import { registerReferrals } from './referrals/routes';
import { registerSupport } from './support/routes';

/**
 * Route registration for the "engagement" module group. OWNED by the engagement agent/team — other groups must not edit.
 * Each module lives in src/modules/<module>/ (routes.ts, service.ts, repository.ts, schemas.ts, *.test.ts).
 * Trust Score has no public routes (jobs only; admin overrides live in the admin group).
 */
export function registerEngagement(app: App): void {
  registerNotifications(app);
  registerChat(app);
  registerRatings(app);
  registerDisputes(app);
  registerReferrals(app);
  registerCredits(app);
  registerPromotions(app);
  registerSupport(app);
  registerAnalytics(app);
}
