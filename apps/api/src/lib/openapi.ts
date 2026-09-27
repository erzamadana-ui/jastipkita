import { OpenAPIHono, z } from '@hono/zod-openapi';
import type { AppEnv } from '../context';
import { Errors } from './errors';

/** Creates a router whose request validation failures produce our standard VALIDATION_ERROR shape. */
export function createRouter() {
  return new OpenAPIHono<AppEnv>({
    defaultHook: (result) => {
      if (!result.success) {
        throw Errors.validation({
          issues: result.error.issues.map((i) => ({ path: i.path.join('.'), code: i.code, message: i.message })),
        });
      }
    },
  });
}

export const ErrorSchema = z
  .object({
    error: z.object({
      code: z.string().openapi({ example: 'PAYMENT_NOT_SECURED' }),
      message: z.string(),
      details: z.record(z.string(), z.unknown()),
      requestId: z.string(),
    }),
  })
  .openapi('Error');

/** Standard error responses to spread into createRoute({ responses }). */
export const errorResponses = {
  400: { description: 'Validation error', content: { 'application/json': { schema: ErrorSchema } } },
  401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorSchema } } },
  403: { description: 'Forbidden', content: { 'application/json': { schema: ErrorSchema } } },
  404: { description: 'Not found', content: { 'application/json': { schema: ErrorSchema } } },
  409: { description: 'Conflict', content: { 'application/json': { schema: ErrorSchema } } },
  422: { description: 'Business rule violation', content: { 'application/json': { schema: ErrorSchema } } },
  429: { description: 'Rate limited', content: { 'application/json': { schema: ErrorSchema } } },
} as const;

export const jsonContent = <T extends z.ZodTypeAny>(schema: T, description = 'OK') => ({
  description,
  content: { 'application/json': { schema } },
});

export const jsonBody = <T extends z.ZodTypeAny>(schema: T) => ({
  body: { content: { 'application/json': { schema } }, required: true },
});

export const bearer = [{ bearerAuth: [] }];

/** Common schema fragments */
export const Uuid = z.string().uuid();
export const IsoDate = z.string().datetime({ offset: true });
export const Idr = z.number().int().openapi({ description: 'Rupiah (integer, no decimals)', example: 1250000 });
export const IdempotencyHeader = z.object({
  'idempotency-key': z.string().min(8).max(255).openapi({ param: { name: 'Idempotency-Key', in: 'header' }, example: '6f1f3b0e-0a0b-4c55-9d8b-2a2f7e5d1c11' }),
});
