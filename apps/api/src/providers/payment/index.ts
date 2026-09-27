// OWNER: money/payments module. Provider factory: MOCK (dev/test) or Xendit (SANDBOX `test` / LIVE `live`).
import type { Env } from '../../env';
import { MockPaymentProvider } from '../mock';
import type { PaymentProvider } from '../types';
import { XenditPaymentProvider } from './xendit';

export { XenditPaymentProvider } from './xendit';
export * from './channels';

export function createPaymentProvider(env: Env): PaymentProvider {
  switch (env.PAYMENT_PROVIDER) {
    case 'mock':
      return new MockPaymentProvider(env.API_BASE_URL);
    case 'xendit':
      // env.ts already refuses xendit without keys and `live` without ALLOW_LIVE_PAYMENTS.
      return new XenditPaymentProvider({
        secretKey: env.XENDIT_SECRET_KEY ?? '',
        webhookToken: env.XENDIT_WEBHOOK_TOKEN ?? '',
        env: env.XENDIT_ENV,
        baseUrl: env.XENDIT_BASE_URL,
        successReturnUrl: `${env.WEB_BASE_URL}/checkout/success`,
        cancelReturnUrl: `${env.WEB_BASE_URL}/checkout/cancelled`,
      });
  }
}

/** `payments.provider_env` / `payouts.provider_env` for a provider: only a LIVE-mode provider is LIVE. */
export function providerEnv(p: Pick<PaymentProvider, 'mode'>): 'TEST' | 'LIVE' {
  return p.mode === 'LIVE' ? 'LIVE' : 'TEST';
}
