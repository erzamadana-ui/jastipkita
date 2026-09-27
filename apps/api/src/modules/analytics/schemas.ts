import { z } from '@hono/zod-openapi';
import { ANALYTICS_EVENTS } from './sanitize';

export const AnalyticsBatchSchema = z
  .object({
    anonymousId: z.string().regex(/^[A-Za-z0-9._:-]{8,64}$/).optional().openapi({ description: 'Required when not signed in' }),
    sessionId: z.string().max(64).optional(),
    platform: z.enum(['IOS', 'ANDROID', 'WEB']),
    appVersion: z.string().max(32).optional(),
    events: z
      .array(
        z.object({
          name: z.string().max(64).openapi({ description: `Allowlist: ${ANALYTICS_EVENTS.join(', ')}` }),
          occurredAt: z.string().datetime({ offset: true }).optional(),
          eventId: z.string().uuid().optional().openapi({ description: 'Client-generated id → idempotent retries' }),
          properties: z.record(z.string(), z.unknown()).optional(),
        }),
      )
      .min(1)
      .max(50),
  })
  .openapi('AnalyticsBatch');

export const AnalyticsResultSchema = z
  .object({
    accepted: z.number().int(),
    duplicates: z.number().int(),
    rejected: z.array(z.object({ index: z.number().int(), reason: z.string() })),
    droppedProperties: z.array(z.object({ index: z.number().int(), keys: z.array(z.string()) })),
  })
  .openapi('AnalyticsIngestResult');
