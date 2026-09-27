import type { App } from '../context';

/**
 * Route registration for the "money" module group. OWNED by the money agent/team — other groups must not edit.
 * Each module lives in src/modules/<module>/ (routes.ts, service.ts, repository.ts, schemas.ts, *.test.ts).
 */
export function registerMoney(_app: App): void {
  // e.g. registerAuth(app);
}
