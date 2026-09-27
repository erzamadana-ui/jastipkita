// OWNER: marketplace/fx module.
import type { Env } from '../../env';
import type { Clock } from '../../lib/clock';
import { StaticFxProvider } from '../mock';
import type { FxProvider } from '../types';
import { FrankfurterFxProvider } from './frankfurter';

export { FrankfurterFxProvider, FxProviderError, ecbAsOf } from './frankfurter';

export function createFxProvider(env: Env, clock: Clock): FxProvider {
  switch (env.FX_PROVIDER) {
    case 'static':
      return new StaticFxProvider(() => clock.now());
    case 'frankfurter':
      return new FrankfurterFxProvider({ baseUrl: env.FX_FRANKFURTER_BASE_URL, now: () => clock.now(), timeoutMs: 5000 });
  }
}

/**
 * Pivot currency the rate table is stored against: ECB rates are EUR-based; the static MOCK table is
 * USD-based. Cross rates (e.g. JPY→IDR) are derived with @jastipkita/core `crossRate`.
 */
export function fxPivot(provider: FxProvider): string {
  return provider.source.startsWith('frankfurter') ? 'EUR' : 'USD';
}
