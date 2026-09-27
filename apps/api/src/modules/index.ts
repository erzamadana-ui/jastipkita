import type { App } from '../context';
import { registerHealth } from './health/routes';
import { registerIdentity } from './identity';
import { registerMarketplace } from './marketplace';
import { registerMoney } from './money';
import { registerEngagement } from './engagement';
import { registerAdmin } from './admin';

export function registerModules(app: App): void {
  registerHealth(app);
  registerIdentity(app);
  registerMarketplace(app);
  registerMoney(app);
  registerEngagement(app);
  registerAdmin(app);
}
