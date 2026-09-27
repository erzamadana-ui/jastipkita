// OWNER: marketplace/requests module.
import type { Env } from '../../env';
import { MockExtractionProvider } from '../mock';
import type { ExtractionProvider } from '../types';
import { HeuristicExtractionProvider } from './heuristic';

export { HeuristicExtractionProvider, UrlNotAllowedError } from './heuristic';

/**
 * `heuristic` (default): real HTTP fetch + JSON-LD/OpenGraph parsing behind the SSRF guard.
 * `mock`, and always under APP_ENV=test: MockExtractionProvider — tests inject a
 * HeuristicExtractionProvider with a fake fetch/resolver so they never touch the network.
 */
export function createExtractionProvider(env: Env): ExtractionProvider {
  if (env.EXTRACTION_PROVIDER === 'mock' || env.APP_ENV === 'test') return new MockExtractionProvider();
  return new HeuristicExtractionProvider();
}
