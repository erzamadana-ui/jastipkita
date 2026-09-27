// OWNER: money module (protection/insurance). Real insurers plug in here without app changes.
import type { Env } from '../../env';
import { MockInsuranceProvider } from '../mock';
import type { InsuranceProvider } from '../types';

export function createInsuranceProvider(_env: Env): InsuranceProvider {
  return new MockInsuranceProvider();
}
