// OWNER: money/payments module. Add the Xendit adapter here (./xendit.ts).
import type { Env } from '../../env';
import { MockPaymentProvider } from '../mock';
import type { PaymentProvider } from '../types';

export function createPaymentProvider(env: Env): PaymentProvider {
  switch (env.PAYMENT_PROVIDER) {
    case 'mock':
      return new MockPaymentProvider(env.API_BASE_URL);
    case 'xendit':
      throw new Error('Xendit adapter not wired yet');
  }
}
