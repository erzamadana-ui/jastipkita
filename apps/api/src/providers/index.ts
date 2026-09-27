import type { Env } from '../env';
import type { Clock } from '../lib/clock';
import type { Logger } from '../lib/logger';
import { createDbAdminProvider } from './db-admin';
import { createEmailProvider } from './email';
import { createExtractionProvider } from './extraction';
import { createFxProvider } from './fx';
import { createInsuranceProvider } from './insurance';
import { createKycProvider } from './kyc';
import { createMalwareScanner } from './malware';
import { createPaymentProvider } from './payment';
import { createPushProvider } from './push';
import { createSmsProvider } from './sms';
import { createStorageProvider } from './storage';
import type { Providers } from './types';

export * from './types';

export function buildProviders(env: Env, logger: Logger, clock: Clock): Providers {
  return {
    payment: createPaymentProvider(env),
    email: createEmailProvider(env, logger),
    push: createPushProvider(env),
    sms: createSmsProvider(env),
    storage: createStorageProvider(env),
    fx: createFxProvider(env, clock),
    kyc: createKycProvider(env),
    insurance: createInsuranceProvider(env),
    extraction: createExtractionProvider(env),
    malware: createMalwareScanner(env),
    dbAdmin: createDbAdminProvider(env),
  };
}
