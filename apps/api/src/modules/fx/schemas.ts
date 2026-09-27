import { z } from '@hono/zod-openapi';

const Ccy = z
  .string()
  .regex(/^[A-Za-z]{3}$/)
  .transform((s) => s.toUpperCase());

export const FxRatesQuery = z.object({
  base: Ccy.optional().openapi({ description: 'Source currency (omit for every active currency)', example: 'JPY' }),
  quote: Ccy.default('IDR').openapi({ description: 'Target currency (default IDR)', example: 'IDR' }),
});

export const FxRateSchema = z
  .object({
    base: z.string().openapi({ example: 'JPY' }),
    quote: z.string().openapi({ example: 'IDR' }),
    spotRate: z.string().openapi({ description: 'Mid/reference rate: quote per 1 base (decimal string, ≤ 10 dp)', example: '113.6734442391' }),
    markupBps: z.number().int().openapi({ description: 'pricing.fx_markup applied for this currency', example: 150 }),
    rate: z.string().openapi({ description: 'Markup-applied rate used for quotes/locks', example: '115.3785459027' }),
    asOf: z.string().openapi({ description: 'Provider publication time (ISO-8601 UTC); ECB = reference day ~16:00 CET', example: '2026-09-25T14:00:00.000Z' }),
    ageMinutes: z.number().int(),
    maxRateAgeMinutes: z.number().int().openapi({ description: 'fx.lock.maxRateAgeMinutes — older rates are refused (FX_RATE_STALE)' }),
    source: z.string().openapi({ example: 'frankfurter-ecb' }),
    pivot: z.string().openapi({ description: 'Currency the provider table is based on; cross rates derived via @jastipkita/core', example: 'EUR' }),
  })
  .openapi('FxRate');

export const FxRatesResponse = z
  .object({
    data: z.array(FxRateSchema),
    unavailable: z.array(z.object({ currency: z.string(), code: z.string() })),
    mode: z.enum(['MOCK', 'SANDBOX', 'LIVE']).openapi({ description: 'MOCK = static illustrative rates (never market data)' }),
  })
  .openapi('FxRates');

export const FxLockBody = z
  .object({
    base: Ccy.openapi({ example: 'JPY' }),
    quote: Ccy.default('IDR').openapi({ example: 'IDR' }),
  })
  .openapi('FxLockRequest');

export const FxLockSchema = z
  .object({
    id: z.string().uuid(),
    base: z.string(),
    quote: z.string(),
    spotRate: z.string(),
    markupBps: z.number().int(),
    lockedRate: z.string(),
    lockedAt: z.string(),
    expiresAt: z.string(),
    status: z.enum(['ACTIVE', 'CONSUMED', 'EXPIRED']),
    rateAsOf: z.string(),
    source: z.string(),
    sourceRateId: z.string().uuid().nullable(),
  })
  .openapi('FxLock');
