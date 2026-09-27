// OWNER: notifications module (engagement group).
import type { Env } from '../../env';
import { LogPushProvider } from '../mock';
import type { PushProvider } from '../types';
import { FcmPushProvider, parseServiceAccount } from './fcm';

export { FcmPushProvider, parseServiceAccount } from './fcm';

export function createPushProvider(env: Env): PushProvider {
  switch (env.PUSH_PROVIDER) {
    case 'log':
      return new LogPushProvider();
    case 'fcm':
      if (!env.FCM_SERVICE_ACCOUNT_JSON) throw new Error('PUSH_PROVIDER=fcm requires FCM_SERVICE_ACCOUNT_JSON');
      return new FcmPushProvider({ projectId: env.FCM_PROJECT_ID, serviceAccount: parseServiceAccount(env.FCM_SERVICE_ACCOUNT_JSON) });
  }
}
