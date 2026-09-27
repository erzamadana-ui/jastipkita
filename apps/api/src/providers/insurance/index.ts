// OWNER: money module (protection/insurance). Real insurers plug in here without app changes.
// JastipKita Protection is SANDBOX (mock underwriter) until an insurance partner is contracted.
import type { Env } from '../../env';
import { MockInsuranceProvider } from '../mock';
import type { InsuranceProvider } from '../types';

/** INSURANCE_PROVIDER=none: protection fee is still charged (platform guarantee) but no policy is bound. */
export class DisabledInsuranceProvider implements InsuranceProvider {
  readonly mode = 'MOCK' as const;
  readonly name = 'none';
  async quote(): Promise<never> {
    throw new Error('INSURANCE_DISABLED');
  }
  async bind(): Promise<never> {
    throw new Error('INSURANCE_DISABLED');
  }
  async fileClaim(): Promise<never> {
    throw new Error('INSURANCE_DISABLED');
  }
}

export function createInsuranceProvider(env: Env): InsuranceProvider {
  return env.INSURANCE_PROVIDER === 'none' ? new DisabledInsuranceProvider() : new MockInsuranceProvider();
}
