import type { App } from '../context';

/**
 * Route registration for the "admin" module group. OWNED by the admin agent/team — other groups must not edit.
 * Each module lives in src/modules/<module>/ (routes.ts, service.ts, repository.ts, schemas.ts, *.test.ts).
 */
export function registerAdmin(_app: App): void {
  // e.g. registerAuth(app);
}
