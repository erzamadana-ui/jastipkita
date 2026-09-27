import type { App } from '../context';

/**
 * Route registration for the "marketplace" module group. OWNED by the marketplace agent/team — other groups must not edit.
 * Each module lives in src/modules/<module>/ (routes.ts, service.ts, repository.ts, schemas.ts, *.test.ts).
 */
export function registerMarketplace(_app: App): void {
  // e.g. registerAuth(app);
}
