// OWNER: identity/auth module. Add the Twilio adapter here (./twilio.ts).
import type { Env } from '../../env';
import { LogSmsProvider } from '../mock';
import type { SmsProvider } from '../types';

export function createSmsProvider(env: Env): SmsProvider {
  switch (env.SMS_PROVIDER) {
    case 'log':
      return new LogSmsProvider();
    case 'twilio':
      throw new Error('Twilio adapter not wired yet');
  }
}
