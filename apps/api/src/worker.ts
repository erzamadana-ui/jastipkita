/**
 * Cloudflare Workers entry. Requires `compatibility_flags = ["nodejs_compat"]` (postgres.js TCP sockets).
 * Secrets/vars are bound on `env`. A fresh postgres client is created per request (Workers cannot share
 * sockets across requests); for pooled providers (Neon/Supabase pooler) set prepare=false.
 * Cron Triggers call `scheduled` → one worker tick (jobs + outbox).
 */
import { createApp } from './app';
import { buildDeps } from './deps';
import { loadEnv } from './env';
import { runWorkerTick } from './jobs/runner';

interface ExecutionContextLike {
  waitUntil(p: Promise<unknown>): void;
}

export default {
  async fetch(request: Request, bindings: Record<string, unknown>, ctx: ExecutionContextLike): Promise<Response> {
    const env = loadEnv(bindings);
    const deps = await buildDeps(env, { sqlOptions: { prepare: false, max: 1 } });
    const app = createApp(deps);
    const res = await app.fetch(request);
    ctx.waitUntil(deps.sql.end({ timeout: 5 }));
    return res;
  },
  async scheduled(_event: unknown, bindings: Record<string, unknown>, ctx: ExecutionContextLike): Promise<void> {
    const env = loadEnv(bindings);
    const deps = await buildDeps(env, { sqlOptions: { prepare: false, max: 1 } });
    ctx.waitUntil(
      runWorkerTick(deps)
        .catch((err) => deps.logger.error('worker.tick_failed', { error: err instanceof Error ? err.message : String(err) }))
        .finally(() => deps.sql.end({ timeout: 5 })),
    );
  },
};
