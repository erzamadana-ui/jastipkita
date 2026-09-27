/**
 * Builds a template database (migrations + seeds) once per content hash. Each test file then clones it
 * (CREATE DATABASE … TEMPLATE …) which takes ~100ms instead of re-running migrations.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';

export const ADMIN_URL = process.env.TEST_PG_ADMIN_URL ?? 'postgres://postgres@localhost:5432/postgres';
const DB_DIR = join(import.meta.dirname, '../../../db');

function contentHash(): string {
  const h = createHash('sha256');
  for (const sub of ['migrations', 'seeds']) {
    for (const f of readdirSync(join(DB_DIR, sub)).filter((x) => x.endsWith('.sql')).sort()) {
      h.update(f);
      h.update(readFileSync(join(DB_DIR, sub, f)));
    }
  }
  return h.digest('hex').slice(0, 10);
}

export default async function setup() {
  const tpl = `jk_tpl_${contentHash()}`;
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  try {
    // Serialize template creation across concurrent vitest runs (several agents/CI jobs may start at once).
    await admin`SELECT pg_advisory_lock(727372099)`;
    const exists = await admin`SELECT 1 FROM pg_database WHERE datname = ${tpl}`;
    if (!exists.length) {
      await admin.unsafe(`CREATE DATABASE "${tpl}"`);
      const url = ADMIN_URL.replace(/\/[^/]*$/, `/${tpl}`);
      const env = { ...process.env, DATABASE_URL: url };
      try {
        execFileSync('bash', [join(DB_DIR, 'scripts/migrate.sh')], { env, stdio: 'pipe' });
        execFileSync('bash', [join(DB_DIR, 'scripts/seed.sh')], { env, stdio: 'pipe' });
      } catch (err) {
        await admin.unsafe(`DROP DATABASE IF EXISTS "${tpl}" WITH (FORCE)`);
        const e = err as { stderr?: Buffer; stdout?: Buffer };
        throw new Error(`template build failed:\n${e.stderr?.toString() ?? ''}\n${e.stdout?.toString() ?? ''}`);
      }
      await admin.unsafe(`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jk_api_test') THEN
          CREATE ROLE jk_api_test LOGIN PASSWORD 'jk_api_test' IN ROLE jk_app;
        END IF; END $$`);
      await admin.unsafe(`ALTER DATABASE "${tpl}" IS_TEMPLATE true`);
    }
    await admin`SELECT pg_advisory_unlock(727372099)`;
    process.env.JK_TEST_TEMPLATE = tpl;
  } finally {
    await admin.end();
  }
  return async () => {
    // Clean up per-file databases left behind by crashed runs.
    const a = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
    const dbs = await a<{ datname: string }[]>`SELECT datname FROM pg_database WHERE datname LIKE 'jk_t_%'`;
    for (const d of dbs) await a.unsafe(`DROP DATABASE IF EXISTS "${d.datname}" WITH (FORCE)`).catch(() => {});
    await a.end();
  };
}
