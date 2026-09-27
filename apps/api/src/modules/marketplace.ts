import type { App } from '../context';
import { registerCatalog } from './catalog/routes';
import { registerCustoms } from './customs/routes';
import { registerFx } from './fx/routes';
import { registerMatching } from './matching/routes';
import { registerOffers } from './offers/routes';
import { registerRequests } from './requests/routes';
import { registerRestricted } from './restricted/routes';
import { registerTrips } from './trips/routes';

/**
 * Route registration for the "marketplace" module group. OWNED by the marketplace agent/team — other groups must not edit.
 * Each module lives in src/modules/<module>/ (routes.ts, service.ts, repository.ts, schemas.ts, *.test.ts).
 * Order matters for static vs parameterised paths (/v1/trips/mine before /v1/trips/{id}).
 */
export function registerMarketplace(app: App): void {
  registerCatalog(app);
  registerFx(app);
  registerCustoms(app);
  registerRestricted(app);
  registerTrips(app);
  registerRequests(app);
  registerMatching(app);
  registerOffers(app);
}
