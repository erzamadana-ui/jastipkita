import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Sql } from './db/sql';
import type { Env } from './env';
import type { Clock } from './lib/clock';
import type { CryptoService } from './lib/crypto';
import type { Logger } from './lib/logger';
import type { Providers } from './providers/types';
import type { ConfigService } from './services/config-service';

/** Everything a request/job needs. Built once per process (Node) or per isolate (Workers). */
export interface AppDeps {
  env: Env;
  sql: Sql;
  clock: Clock;
  logger: Logger;
  crypto: CryptoService;
  providers: Providers;
  config: ConfigService;
}

export type ActorType = 'BUYER' | 'TRAVELER' | 'ADMIN' | 'SYSTEM' | 'USER' | 'WEBHOOK' | 'JOB';

export interface AuthContext {
  userId: string;
  /** refresh-token family (session) id */
  sessionId: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'PENDING_DELETION' | 'DELETED';
  kycLevel: number;
  activeMode: 'BUYER' | 'TRAVELER';
  roles: string[];
  /** epoch seconds of the last MFA verification in this session (admin step-up), if any */
  mfaAt: number | null;
}

export interface AppVariables {
  requestId: string;
  deps: AppDeps;
  auth: AuthContext | undefined;
  /** client IP (best effort, from CF-Connecting-IP / X-Forwarded-For) */
  ip: string | undefined;
}

export interface AppEnv {
  Variables: AppVariables;
}

export type App = OpenAPIHono<AppEnv>;
