// OWNER: notifications module. Add the Resend adapter here (./resend.ts).
import type { Env } from '../../env';
import type { Logger } from '../../lib/logger';
import { LogEmailProvider } from '../mock';
import type { EmailProvider } from '../types';

export function createEmailProvider(env: Env, logger: Logger): EmailProvider {
  switch (env.EMAIL_PROVIDER) {
    case 'log':
      return new LogEmailProvider(logger);
    case 'resend':
      throw new Error('Resend adapter not wired yet');
  }
}
