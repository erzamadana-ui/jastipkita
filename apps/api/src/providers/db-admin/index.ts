// OWNER: admin/infra module. Add the Neon API adapter here (./neon.ts).
import type { Env } from '../../env';
import { GenericDbAdminProvider } from '../mock';
import type { DbAdminProvider } from '../types';

export function createDbAdminProvider(env: Env): DbAdminProvider {
  switch (env.DB_ADMIN_PROVIDER) {
    case 'generic':
      return new GenericDbAdminProvider();
    case 'neon':
      throw new Error('Neon adapter not wired yet');
  }
}
