/** Writes the OpenAPI 3.1 document to docs/api/openapi.json (no DB needed). */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from '../src/app';
import { buildDeps } from '../src/deps';
import { loadEnv } from '../src/env';
import { createSql } from '../src/db/sql';
import { silentLogger } from '../src/lib/logger';

const env = loadEnv({
  APP_ENV: 'development',
  DATABASE_URL: 'postgres://unused@localhost:1/unused',
  JWT_SECRET: 'x'.repeat(40),
  DATA_ENCRYPTION_KEYS: `k1:${Buffer.alloc(32).toString('base64')}`,
  HMAC_PEPPER: 'p'.repeat(40),
  API_BASE_URL: process.env.API_BASE_URL ?? 'https://api.example.com',
});
const deps = await buildDeps(env, { sql: createSql(env.DATABASE_URL, { max: 1 }), logger: silentLogger });
const app = createApp(deps);
const res = await app.request('/v1/openapi.json');
const doc = await res.json();
const out = join(import.meta.dirname, '../../../docs/api');
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'openapi.json'), JSON.stringify(doc, null, 2) + '\n');
const paths = Object.keys((doc as { paths: object }).paths ?? {}).length;
console.log(`wrote docs/api/openapi.json (${paths} paths)`);
await deps.sql.end({ timeout: 1 });
