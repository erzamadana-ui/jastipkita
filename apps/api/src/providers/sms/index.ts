// OWNER: identity/auth module.
import type { Env } from '../../env';
import { LogSmsProvider } from '../mock';
import type { SmsProvider } from '../types';
import { TwilioSmsProvider } from './twilio';

export function createSmsProvider(env: Env): SmsProvider {
  switch (env.SMS_PROVIDER) {
    case 'log':
      return new LogSmsProvider();
    case 'twilio':
      if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_FROM) {
        throw new Error('SMS_PROVIDER=twilio requires TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM');
      }
      return new TwilioSmsProvider({ accountSid: env.TWILIO_ACCOUNT_SID, authToken: env.TWILIO_AUTH_TOKEN, from: env.TWILIO_FROM });
  }
}
