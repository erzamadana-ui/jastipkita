/** Node entry: HTTP server + in-process background worker loop (disable with WORKER_ENABLED=false). */
import { serve } from '@hono/node-server';
import { createApp } from './app';
import { buildDeps } from './deps';
import { loadEnv } from './env';
import { runWorkerTick } from './jobs/runner';

const env = loadEnv(process.env);
const deps = await buildDeps(env);
const app = createApp(deps);

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  deps.logger.info('server.started', { port: info.port, env: env.APP_ENV, integrations: 'see /v1/health' });
});

if (env.WORKER_ENABLED) {
  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await runWorkerTick(deps);
    } catch (err) {
      deps.logger.error('worker.tick_failed', { error: err instanceof Error ? err.message : String(err) });
    } finally {
      running = false;
    }
  }, 5_000);
}

const shutdown = async () => {
  deps.logger.info('server.stopping');
  await deps.sql.end({ timeout: 5 });
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
