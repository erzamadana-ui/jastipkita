// OWNER: notifications module. Add the FCM HTTP v1 adapter here (./fcm.ts).
import type { Env } from '../../env';
import { LogPushProvider } from '../mock';
import type { PushProvider } from '../types';

export function createPushProvider(env: Env): PushProvider {
  switch (env.PUSH_PROVIDER) {
    case 'log':
      return new LogPushProvider();
    case 'fcm':
      throw new Error('FCM adapter not wired yet');
  }
}
