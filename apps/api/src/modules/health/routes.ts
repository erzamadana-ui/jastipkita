import { createRoute, z } from '@hono/zod-openapi';
import type { App } from '../../context';
import { sandboxFlags } from '../../env';
import { createRouter, jsonContent } from '../../lib/openapi';

const HealthSchema = z
  .object({
    status: z.enum(['ok', 'degraded']),
    version: z.string(),
    env: z.string(),
    time: z.string(),
    database: z.object({ ok: z.boolean(), latencyMs: z.number().nullable(), schemaVersion: z.string().nullable() }),
    integrations: z.record(z.string(), z.string()).openapi({ description: 'MOCK | SANDBOX | LIVE per integration — never claim LIVE when sandboxed' }),
  })
  .openapi('Health');

export function registerHealth(app: App) {
  const r = createRouter();
  r.get('/health', (c) => c.json({ status: 'ok' }));
  r.openapi(
    createRoute({ method: 'get', path: '/v1/health', tags: ['System'], summary: 'Service health, schema version and integration modes', responses: { 200: jsonContent(HealthSchema) } }),
    async (c) => {
      const { sql, env, clock } = c.get('deps');
      let ok = false;
      let latencyMs: number | null = null;
      let schemaVersion: string | null = null;
      const t0 = Date.now();
      try {
        const [row] = await sql<{ v: string | null }[]>`SELECT max(version) AS v FROM schema_migrations`;
        schemaVersion = row?.v ?? null;
        ok = true;
        latencyMs = Date.now() - t0;
      } catch {
        ok = false;
      }
      return c.json(
        {
          status: ok ? ('ok' as const) : ('degraded' as const),
          version: env.APP_VERSION,
          env: env.APP_ENV,
          time: clock.now().toISOString(),
          database: { ok, latencyMs, schemaVersion },
          integrations: sandboxFlags(env),
        },
        200,
      );
    },
  );
  app.route('/', r);
}
