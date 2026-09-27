import { createRoute, z } from '@hono/zod-openapi';
import type { App } from '../../../context';
import { bearer, createRouter, errorResponses, jsonContent } from '../../../lib/openapi';
import { adminGuard } from '../common';
import { funnel, kpis, SERIES, type SeriesKey, timeseries } from './service';

const tags = ['Admin · Dashboard'];
const RangeQuery = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().openapi({ description: 'WIB date (inclusive); default today − 29 days', example: '2026-09-01' }),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().openapi({ description: 'WIB date (inclusive); default today', example: '2026-09-27' }),
});

export const MetricSchema = z
  .object({
    key: z.string(),
    label: z.string(),
    value: z.number().nullable(),
    unit: z.enum(['IDR', 'COUNT', 'RATIO', 'HOURS']),
    definition: z.string(),
    sampleSize: z.number().int().nullable(),
    dataQuality: z.string().nullable().openapi({ description: 'Set when the sample is small (< 30) or empty' }),
  })
  .openapi('AdminMetric');

const KpiResponse = z
  .object({
    range: z.object({ from: z.string(), to: z.string(), days: z.number().int(), timezone: z.string() }),
    generatedAt: z.string(),
    metrics: z.array(MetricSchema),
    breakdowns: z.object({
      transactionsByStatus: z.array(z.object({ status: z.string(), count: z.number().int() })),
      paymentsByChannel: z.array(z.object({ channel: z.string(), count: z.number().int(), amountIdr: z.number().int() })),
      fraudReviewsBySubject: z.array(z.object({ subjectType: z.string(), count: z.number().int() })),
      supportBacklogByPriority: z.array(z.object({ priority: z.string(), open: z.number().int(), slaBreached: z.number().int() })),
    }),
    systemHealth: z.looseObject({ status: z.string() }),
    definitions: z.record(z.string(), z.string()),
    notes: z.array(z.string()),
  })
  .openapi('AdminKpis');

const SeriesResponse = z
  .object({
    metric: z.string(),
    interval: z.enum(['day', 'week']),
    unit: z.string(),
    definition: z.string(),
    range: z.object({ from: z.string(), to: z.string(), timezone: z.string() }),
    points: z.array(z.object({ bucket: z.string(), value: z.number(), sampleSize: z.number().int() })),
    sampleSize: z.number().int(),
    dataQuality: z.string().nullable(),
  })
  .openapi('AdminTimeSeries');

const FunnelResponse = z
  .object({
    range: z.object({ from: z.string(), to: z.string(), timezone: z.string() }),
    method: z.string(),
    note: z.string(),
    steps: z.array(z.object({ step: z.string(), count: z.number().int(), conversionFromPrevious: z.number().nullable(), definition: z.string(), dataQuality: z.string().nullable() })),
    dataQuality: z.string().nullable(),
  })
  .openapi('AdminFunnel');

export function registerAdminDashboard(app: App) {
  const r = createRouter();
  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/admin/dashboard/kpis',
      tags,
      summary: 'KPIs (GMV, revenue/take rate, statuses, users, dispute/refund rate, fraud, referral spend, channels, customs, support, health) — each with definition',
      security: bearer,
      middleware: adminGuard(['analytics.read']),
      request: { query: RangeQuery },
      responses: { 200: jsonContent(KpiResponse), ...errorResponses },
    }),
    async (c) => c.json(await kpis(c.get('deps'), c.req.valid('query')), 200),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/admin/dashboard/timeseries',
      tags,
      summary: 'Daily/weekly time series of one metric (zero-filled WIB buckets)',
      security: bearer,
      middleware: adminGuard(['analytics.read']),
      request: {
        query: RangeQuery.extend({
          metric: z.enum(Object.keys(SERIES) as [SeriesKey, ...SeriesKey[]]),
          interval: z.enum(['day', 'week']).default('day'),
        }),
      },
      responses: { 200: jsonContent(SeriesResponse), ...errorResponses },
    }),
    async (c) => c.json(await timeseries(c.get('deps'), c.req.valid('query')), 200),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/admin/dashboard/funnel',
      tags,
      summary: 'Funnel install → signup → KYC → request → match → checkout → payment → purchase → delivery → repeat',
      security: bearer,
      middleware: adminGuard(['analytics.read']),
      request: { query: RangeQuery },
      responses: { 200: jsonContent(FunnelResponse), ...errorResponses },
    }),
    async (c) => c.json(await funnel(c.get('deps'), c.req.valid('query')), 200),
  );
  app.route('/', r);
}
