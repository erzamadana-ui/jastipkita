import type { AppDeps } from './context';
import { createSql, type Sql } from './db/sql';
import type { Env } from './env';
import { systemClock, type Clock } from './lib/clock';
import { CryptoService } from './lib/crypto';
import { createLogger, type Logger } from './lib/logger';
import { buildProviders } from './providers';
import type { Providers } from './providers/types';
import { ConfigService } from './services/config-service';

export interface BuildDepsOptions {
  sql?: Sql;
  clock?: Clock;
  logger?: Logger;
  providers?: Partial<Providers>;
  sqlOptions?: { prepare?: boolean; max?: number };
}

export async function buildDeps(env: Env, opts: BuildDepsOptions = {}): Promise<AppDeps> {
  const clock = opts.clock ?? systemClock;
  const logger = opts.logger ?? createLogger(env.LOG_LEVEL, { app: 'jastipkita-api', env: env.APP_ENV });
  const sql = opts.sql ?? createSql(env.DATABASE_URL, { max: opts.sqlOptions?.max ?? env.DB_POOL_MAX, ...(opts.sqlOptions?.prepare !== undefined ? { prepare: opts.sqlOptions.prepare } : {}) });
  const crypto = await CryptoService.create(env.DATA_ENCRYPTION_KEYS, env.HMAC_PEPPER);
  const providers = { ...buildProviders(env, logger, clock), ...(opts.providers ?? {}) } as Providers;
  const config = new ConfigService(sql, clock, logger);
  return { env, sql, clock, logger, crypto, providers, config };
}
