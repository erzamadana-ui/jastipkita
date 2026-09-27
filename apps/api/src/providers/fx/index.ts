// OWNER: marketplace/catalog module. Add the Frankfurter adapter here (./frankfurter.ts).
import type { Env } from '../../env';
import type { Clock } from '../../lib/clock';
import { StaticFxProvider } from '../mock';
import type { FxProvider } from '../types';

export function createFxProvider(env: Env, clock: Clock): FxProvider {
  switch (env.FX_PROVIDER) {
    case 'static':
      return new StaticFxProvider(() => clock.now());
    case 'frankfurter':
      throw new Error('Frankfurter adapter not wired yet');
  }
}
