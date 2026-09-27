// OWNER: admin/infra module. Generic (managed outside the app) or Neon API v2 adapter.
import type { Env } from '../../env';
import { GenericDbAdminProvider } from '../mock';
import type { DbAdminProvider } from '../types';
import { NeonDbAdminProvider } from './neon';

export function createDbAdminProvider(env: Env): DbAdminProvider {
  switch (env.DB_ADMIN_PROVIDER) {
    case 'generic':
      return new GenericDbAdminProvider();
    case 'neon':
      if (!env.NEON_API_KEY || !env.NEON_PROJECT_ID) {
        throw new Error('DB_ADMIN_PROVIDER=neon requires NEON_API_KEY and NEON_PROJECT_ID (server secrets)');
      }
      return new NeonDbAdminProvider({ apiKey: env.NEON_API_KEY, projectId: env.NEON_PROJECT_ID });
  }
}
