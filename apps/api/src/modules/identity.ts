import type { App } from '../context';

/**
 * Route registration for the "identity" module group. OWNED by the identity agent/team — other groups must not edit.
 * Each module lives in src/modules/<module>/ (routes.ts, service.ts, repository.ts, schemas.ts, *.test.ts).
 */
export function registerIdentity(_app: App): void {
  // e.g. registerAuth(app);
}
