import type { App } from '../context';
import { registerAuth } from './auth/routes';
import { registerFiles } from './files/routes';
import { registerKyc } from './kyc/routes';
import { registerMe } from './me/routes';
import { registerPrivacy } from './privacy/routes';

/**
 * Route registration for the "identity" module group. OWNED by the identity agent/team — other groups must not edit.
 * Each module lives in src/modules/<module>/ (routes.ts, service.ts, repository.ts, schemas.ts, *.test.ts).
 */
export function registerIdentity(app: App): void {
  registerAuth(app);
  registerMe(app);
  registerFiles(app);
  registerKyc(app);
  registerPrivacy(app);
}
