/**
 * Cloudflare Workers entry. Requires `compatibility_flags = ["nodejs_compat"]` (postgres.js TCP sockets).
 *
 * CPU budget: building the Hono/OpenAPI app is the expensive part, so it happens ONCE per isolate.
 * Only the database client is per request (Workers cannot share sockets across requests); it is
 * injected through the fetch `env` argument (`__deps`) and read by requestContext().
 * For pooled providers (Neon/Supabase pooler) prepared statements are disabled.
 * Cron Triggers call `scheduled` → one worker tick (jobs + outbox).
 */
import { createApp } from './app';
import type { AppDeps } from './context';
import { createSql } from './db/sql';
import { buildDeps } from './deps';
import { loadEnv } from './env';
import { runWorkerTick } from './jobs/runner';
import { ConfigService, type ConfigCacheHolder } from './services/config-service';

interface ExecutionContextLike {
  waitUntil(p: Promise<unknown>): void;
}

interface IsolateState {
  base: AppDeps;
  app: ReturnType<typeof createApp>;
  configCache: ConfigCacheHolder;
}

let state: Promise<IsolateState> | null = null;

async function isolate(bindings: Record<string, unknown>): Promise<IsolateState> {
  if (!state) {
    state = (async () => {
      const env = loadEnv(bindings);
      // A placeholder client: never queried (per-request clients replace it).
      const base = await buildDeps(env, { sql: createSql(env.DATABASE_URL, { max: 1, prepare: false }) });
      return { base, app: createApp(base), configCache: { cache: null } };
    })().catch((err) => {
      state = null;
      throw err;
    });
  }
  return state;
}

function requestDeps(s: IsolateState): AppDeps {
  const sql = createSql(s.base.env.DATABASE_URL, { max: 1, prepare: false });
  return { ...s.base, sql, config: new ConfigService(sql, s.base.clock, s.base.logger, 30_000, s.configCache) };
}

export default {
  async fetch(request: Request, bindings: Record<string, unknown>, ctx: ExecutionContextLike): Promise<Response> {
    const s = await isolate(bindings);
    const deps = requestDeps(s);
    try {
      return await s.app.fetch(request, { ...bindings, __deps: deps }, ctx as never);
    } finally {
      ctx.waitUntil(deps.sql.end({ timeout: 5 }));
    }
  },
  async scheduled(_event: unknown, bindings: Record<string, unknown>, ctx: ExecutionContextLike): Promise<void> {
    const s = await isolate(bindings);
    const deps = requestDeps(s);
    ctx.waitUntil(
      runWorkerTick(deps)
        .catch((err) => deps.logger.error('worker.tick_failed', { error: err instanceof Error ? err.message : String(err) }))
        .finally(() => deps.sql.end({ timeout: 5 })),
    );
  },
};
