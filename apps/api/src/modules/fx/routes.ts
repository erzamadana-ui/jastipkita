import { createRoute } from '@hono/zod-openapi';
import type { App } from '../../context';
import { bearer, createRouter, errorResponses, jsonBody, jsonContent } from '../../lib/openapi';
import { requireAuth } from '../../middleware/auth';
import { rateLimit } from '../../middleware/rate-limit';
import { requireAuthContext, unavailableResponse } from '../catalog/shared';
import { FxLockBody, FxLockSchema, FxRatesQuery, FxRatesResponse } from './schemas';
import * as svc from './service';

export function registerFx(app: App): void {
  const r = createRouter();

  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/fx/rates',
      tags: ['FX'],
      summary: 'Spot + markup-applied rates with timestamp and source (cross rates via core)',
      description:
        'Rates come from fx_rates (refreshed hourly). ECB/Frankfurter does not publish on weekends/TARGET holidays: `asOf` is the ECB reference time, and rates older than `fx.lock.maxRateAgeMinutes` are refused with FX_RATE_STALE.',
      middleware: [rateLimit({ name: 'fx.rates', limit: 120, windowSec: 60 })] as const,
      request: { query: FxRatesQuery },
      responses: { 200: jsonContent(FxRatesResponse), 400: errorResponses[400], 422: errorResponses[422], 429: errorResponses[429], 503: unavailableResponse },
    }),
    async (c) => {
      const deps = c.get('deps');
      const { base, quote } = c.req.valid('query');
      const out = base
        ? { data: [await svc.quoteFxRate(deps.sql, deps, base, quote)], unavailable: [] }
        : await svc.listFxRates(deps.sql, deps, quote);
      c.header('cache-control', 'public, max-age=60');
      return c.json({ ...out, mode: deps.providers.fx.mode }, 200);
    },
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/fx/locks',
      tags: ['FX'],
      summary: 'Lock a markup-applied rate for fx.lock.lockMinutes (used by quotes)',
      security: bearer,
      middleware: [requireAuth, rateLimit({ name: 'fx.locks', limit: 30, windowSec: 60, key: 'user' })] as const,
      request: jsonBody(FxLockBody),
      responses: { 201: jsonContent(FxLockSchema, 'Created'), ...errorResponses, 503: unavailableResponse },
    }),
    async (c) => {
      const deps = c.get('deps');
      const auth = requireAuthContext(c);
      const body = c.req.valid('json');
      const lock = await svc.createFxLock(deps.sql, deps, { base: body.base, quote: body.quote, userId: auth.userId });
      return c.json(lock, 201);
    },
  );

  app.route('/', r);
}
