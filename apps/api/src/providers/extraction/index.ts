// OWNER: marketplace/requests module. Add the heuristic URL/OpenGraph extractor here (./heuristic.ts).
import type { Env } from '../../env';
import { MockExtractionProvider } from '../mock';
import type { ExtractionProvider } from '../types';

export function createExtractionProvider(_env: Env): ExtractionProvider {
  return new MockExtractionProvider();
}
