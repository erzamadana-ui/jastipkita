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
/**
 * `Idempotency-Key` request header. Every route whose middleware chain contains `requireIdempotency` MUST declare
 * it as `request: { headers: IdempotencyHeader }` (enforced by test/openapi-contract.test.ts).
 */
export const IdempotencyHeader = z.object({
  'idempotency-key': z.string().min(8).max(255).openapi({ description: 'Unique per logical operation (UUID). Replays return the original response.', example: '6f1f3b0e-0a0b-4c55-9d8b-2a2f7e5d1c11' }),
});

// ------------------------------------------------------------------ operationId

function pascal(segment: string): string {
  return segment
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
}

/**
 * Stable operationId derived from the HTTP method and the OpenAPI path (the `/v1` prefix is dropped, path params
 * become `By<Param>`): `GET /v1/transactions/{id}/cancel/preview` → `getTransactionsByIdCancelPreview`.
 * It only changes when the path changes, so generated client method names stay stable across releases.
 */
export function deriveOperationId(method: string, path: string): string {
  const parts = path.split('/').filter(Boolean);
  if (parts[0] === 'v1') parts.shift();
  let id = method.toLowerCase();
  for (const seg of parts) {
    const param = /^\{(.+)\}$/.exec(seg);
    id += param ? `By${pascal(param[1]!)}` : pascal(seg);
  }
  return id;
}

interface RegistryLike {
  definitions: readonly { type: string; route?: { method: string; path: string; operationId?: string } }[];
}

/**
 * Gives every registered route an operationId (explicit ones are kept) and fails fast on duplicates, so client
 * code generators (Flutter / admin) never see a missing or ambiguous operation name. Call after all routes are
 * registered and before the document is generated.
 */
export function assignOperationIds(registry: RegistryLike): void {
  const seen = new Map<string, string>();
  for (const def of registry.definitions) {
    if (def.type !== 'route' || !def.route) continue;
    const r = def.route;
    r.operationId ??= deriveOperationId(r.method, r.path);
    const where = `${r.method.toUpperCase()} ${r.path}`;
    const prev = seen.get(r.operationId);
    if (prev && prev !== where) throw new Error(`Duplicate OpenAPI operationId "${r.operationId}" (${prev} / ${where})`);
    seen.set(r.operationId, where);
  }
}

/** Absolute, authenticated URL that streams a file through the API (`GET /v1/files/{id}/content`). */
export function fileContentUrl(apiBaseUrl: string, fileId: string): string {
  return `${apiBaseUrl.replace(/\/+$/, '')}/v1/files/${fileId}/content`;
}
