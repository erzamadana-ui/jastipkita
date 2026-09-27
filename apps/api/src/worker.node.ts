/** Standalone worker process (Node): runs background jobs without serving HTTP. */
import { buildDeps } from './deps';
import { loadEnv } from './env';
import { runWorkerTick } from './jobs/runner';

const env = loadEnv(process.env);
const deps = await buildDeps(env);
deps.logger.info('worker.started', { id: env.WORKER_ID });
for (;;) {
  try {
    const r = await runWorkerTick(deps);
    if (r.outboxProcessed + r.jobsRun === 0) await new Promise((res) => setTimeout(res, 3000));
  } catch (err) {
    deps.logger.error('worker.tick_failed', { error: err instanceof Error ? err.message : String(err) });
    await new Promise((res) => setTimeout(res, 5000));
  }
}
