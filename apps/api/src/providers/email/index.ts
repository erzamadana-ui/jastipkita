// OWNER: notifications module (engagement group).
import type { Env } from '../../env';
import type { Logger } from '../../lib/logger';
import { LogEmailProvider } from '../mock';
import type { EmailProvider } from '../types';
import { ResendEmailProvider } from './resend';

export { ResendEmailProvider, ResendError } from './resend';

export function createEmailProvider(env: Env, logger: Logger): EmailProvider {
  switch (env.EMAIL_PROVIDER) {
    case 'log':
      return new LogEmailProvider(logger);
    case 'resend':
      if (!env.RESEND_API_KEY) throw new Error('EMAIL_PROVIDER=resend requires RESEND_API_KEY');
      return new ResendEmailProvider({ apiKey: env.RESEND_API_KEY, from: env.EMAIL_FROM, replyTo: env.EMAIL_REPLY_TO });
  }
}
