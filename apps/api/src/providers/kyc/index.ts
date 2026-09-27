// OWNER: identity/kyc module.
import type { Env } from '../../env';
import { ManualKycProvider, MockKycProvider } from '../mock';
import type { KycProvider } from '../types';

export function createKycProvider(env: Env): KycProvider {
  return env.KYC_PROVIDER === 'mock' ? new MockKycProvider() : new ManualKycProvider();
}
