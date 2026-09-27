/**
 * Test harness: an isolated database per test file (cloned from the template), deps wired with MOCK
 * providers and a controllable clock, plus fixture helpers. Import in tests:
 *
 *   const t = await createTestContext();
 *   afterAll(() => t.close());
 *   const buyer = await t.createUser({ kycLevel: 2 });
 *   const res = await t.request('GET', '/v1/me', { token: buyer.accessToken });
 */
import postgres from 'postgres';
import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { createApp } from '../src/app';
import type { AppDeps } from '../src/context';
import { createSql, type Sql } from '../src/db/sql';
import { buildDeps } from '../src/deps';
import { loadEnv, type Env } from '../src/env';
import { FixedClock } from '../src/lib/clock';
import { silentLogger } from '../src/lib/logger';
import { resetRateLimits } from '../src/middleware/rate-limit';
import { clearPermissionCache } from '../src/middleware/auth';
import { MemoryStorageProvider, MockPaymentProvider, LogEmailProvider, LogPushProvider, LogSmsProvider } from '../src/providers/mock';
import { issueSession, type IssuedSession } from '../src/services/session';
import type { Providers } from '../src/providers/types';
import { drainWorker } from '../src/jobs/runner';

const ADMIN_URL = process.env.TEST_PG_ADMIN_URL ?? 'postgres://postgres@localhost:5432/postgres';

export const TEST_ENV_BASE: Record<string, string> = {
  APP_ENV: 'test',
  API_BASE_URL: 'http://api.test',
  WEB_BASE_URL: 'http://web.test',
  ADMIN_BASE_URL: 'http://admin.test',
  JWT_SECRET: 'test-secret-test-secret-test-secret-0123456789',
  DATA_ENCRYPTION_KEYS: `k1:${Buffer.from('0123456789abcdef0123456789abcdef').toString('base64')}`,
  HMAC_PEPPER: 'test-pepper-test-pepper-test-pepper-012345',
  OTP_DEV_ECHO: 'true',
  LOG_LEVEL: 'error',
  GOOGLE_CLIENT_IDS: 'test-google-client-id',
  APPLE_CLIENT_IDS: 'id.jastipkita.app',
  WORKER_ID: 'test-worker',
};

export interface TestUser extends IssuedSession {
  id: string;
  email: string;
  phone: string;
}

export interface TestContext {
  deps: AppDeps;
  env: Env;
  clock: FixedClock;
  sql: Sql; // app role (jk_app) — what the API uses
  adminSql: Sql; // superuser on the same database — fixtures only
  app: ReturnType<typeof createApp>;
  payment: MockPaymentProvider;
  email: LogEmailProvider;
  push: LogPushProvider;
  sms: LogSmsProvider;
  storage: MemoryStorageProvider;
  dbName: string;
  request: (method: string, path: string, opts?: { token?: string; body?: unknown; headers?: Record<string, string>; rawBody?: string }) => Promise<{ status: number; body: any; headers: Headers }>;
  createUser: (opts?: { kycLevel?: number; roles?: string[]; mode?: 'BUYER' | 'TRAVELER'; email?: string; phone?: string; displayName?: string; mfa?: boolean }) => Promise<TestUser>;
  drain: () => ReturnType<typeof drainWorker>;
  close: () => Promise<void>;
}

let counter = 0;

export async function createTestContext(opts: { now?: Date; env?: Record<string, string>; providers?: Partial<Providers> } = {}): Promise<TestContext> {
  const tpl = process.env.JK_TEST_TEMPLATE;
  if (!tpl) throw new Error('JK_TEST_TEMPLATE not set — run through vitest (globalSetup)');
  const dbName = `jk_t_${process.pid}_${Date.now().toString(36)}_${counter++}`;
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  await admin.unsafe(`CREATE DATABASE "${dbName}" TEMPLATE "${tpl}"`);
  await admin.end();

  const base = new URL(ADMIN_URL);
  const appUrl = `postgres://jk_api_test:jk_api_test@${base.host}/${dbName}`;
  const adminDbUrl = `${base.protocol}//${base.username}${base.password ? ':' + base.password : ''}@${base.host}/${dbName}`;
  const env = loadEnv({ ...TEST_ENV_BASE, DATABASE_URL: appUrl, ...(opts.env ?? {}) });
  const clock = new FixedClock(opts.now ?? new Date());
  const sql = createSql(appUrl, { max: 5 });
  const adminSql = createSql(adminDbUrl, { max: 2 });
  const payment = new MockPaymentProvider(env.API_BASE_URL);
  const email = new LogEmailProvider();
  const push = new LogPushProvider();
  const sms = new LogSmsProvider();
  const storage = new MemoryStorageProvider(env.API_BASE_URL);
  const deps = await buildDeps(env, { sql, clock, logger: silentLogger, providers: { payment, email, push, sms, storage, ...(opts.providers ?? {}) } });
  const app = createApp(deps);
  resetRateLimits();
  clearPermissionCache();

  const request: TestContext['request'] = async (method, path, o = {}) => {
    const headers = new Headers(o.headers ?? {});
    if (o.token) headers.set('authorization', `Bearer ${o.token}`);
    let body: string | undefined;
    if (o.rawBody !== undefined) body = o.rawBody;
    else if (o.body !== undefined) {
      body = JSON.stringify(o.body);
      headers.set('content-type', 'application/json');
    }
    const res = await app.request(path, { method, headers, ...(body !== undefined ? { body } : {}) });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON */
    }
    return { status: res.status, body: parsed, headers: res.headers };
  };

  let userSeq = 0;
  const createUser: TestContext['createUser'] = async (u = {}) => {
    userSeq++;
    const tag = nodeRandomBytes(4).toString('hex');
    const email = u.email ?? `user${userSeq}-${tag}@example.com`;
    const phone = u.phone ?? `+62812${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
    const kyc = u.kycLevel ?? 1;
    const [row] = await adminSql<{ id: string }[]>`
      INSERT INTO users (email, email_verified_at, phone_e164, phone_verified_at, display_name, kyc_level, active_mode, country_code)
      VALUES (${email}, now(), ${kyc >= 2 ? phone : null}, ${kyc >= 2 ? new Date() : null}, ${u.displayName ?? `User ${userSeq}`}, ${kyc}, ${u.mode ?? 'BUYER'}, 'ID')
      RETURNING id`;
    const id = row!.id;
    for (const role of u.roles ?? []) {
      await adminSql`INSERT INTO user_roles (user_id, role_code, reason) VALUES (${id}, ${role}, 'test fixture')`;
    }
    const session = await issueSession(deps, sql, id, { mfaAt: u.mfa ? Math.floor(clock.now().getTime() / 1000) : null, authMethod: 'OTP' });
    return { id, email, phone, ...session };
  };

  return {
    deps,
    env,
    clock,
    sql,
    adminSql,
    app,
    payment,
    email,
    push,
    sms,
    storage,
    dbName,
    request,
    createUser,
    drain: () => drainWorker(deps),
    close: async () => {
      await sql.end({ timeout: 2 });
      await adminSql.end({ timeout: 2 });
      const a = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
      await a.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await a.end();
    },
  };
}
