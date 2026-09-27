import { createRoute } from '@hono/zod-openapi';
import type { App } from '../../context';
import { bearer, createRouter, errorResponses, jsonBody, jsonContent } from '../../lib/openapi';
import { requireAuth } from '../../middleware/auth';
import { rateLimit } from '../../middleware/rate-limit';
import { requireAuthContext, unavailableResponse } from '../catalog/shared';
import {
  CancelBody,
  ExtractBody,
  ExtractResponse,
  IdParam,
  ListingPageSchema,
  MineQuery,
  OpenQuery,
  PublishBody,
  RequestCreateBody,
  RequestOwnerSchema,
  RequestPageSchema,
  RequestPatchBody,
  RequestViewSchema,
} from './schemas';
import * as svc from './service';

export function registerRequests(app: App): void {
  const r = createRouter();

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/requests/extract',
      tags: ['Requests'],
      summary: 'Draft a request from a product URL (heuristic JSON-LD/OpenGraph, SSRF-guarded), a photo, or a search query',
      security: bearer,
      middleware: [requireAuth, rateLimit({ name: 'requests.extract', limit: 20, windowSec: 60, key: 'user' })] as const,
      request: jsonBody(ExtractBody),
      responses: { 200: jsonContent(ExtractResponse), ...errorResponses },
    }),
    async (c) => {
      const b = c.req.valid('json');
      return c.json(await svc.extract(c.get('deps'), requireAuthContext(c), b), 200);
    },
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/requests',
      tags: ['Requests'],
      summary: 'Create a request (DRAFT, or OPEN with publish=true). Restriction class computed; PROHIBITED cannot be published',
      security: bearer,
      middleware: [requireAuth, rateLimit({ name: 'requests.create', limit: 30, windowSec: 3600, key: 'user' })] as const,
      request: jsonBody(RequestCreateBody),
      responses: { 201: jsonContent(RequestOwnerSchema, 'Created'), ...errorResponses, 503: unavailableResponse },
    }),
    async (c) => {
      const b = c.req.valid('json');
      const out = await svc.createRequest(c.get('deps'), requireAuthContext(c), {
        sourceType: b.sourceType,
        productUrl: b.productUrl ?? null,
        productName: b.productName,
        merchantName: b.merchantName ?? null,
        merchantCountry: b.merchantCountry,
        categoryCode: b.categoryCode,
        hsCode: b.hsCode ?? null,
        quantity: b.quantity,
        variant: b.variant ?? null,
        unitPriceMinor: b.unitPriceMinor,
        priceCurrency: b.priceCurrency,
        estWeightKg: b.estWeightKg ?? null,
        notes: b.notes ?? null,
        maxBudgetIdr: b.maxBudgetIdr ?? null,
        neededBy: b.neededBy ?? null,
        destinationCountry: b.destinationCountry,
        destinationCity: b.destinationCity ?? null,
        deliveryPreference: b.deliveryPreference ?? null,
        imageUrls: b.imageUrls ?? [],
        imageFileIds: b.imageFileIds ?? [],
        extraction: b.extraction ?? {},
        acknowledgeRestriction: b.acknowledgeRestriction ?? false,
        publish: b.publish ?? false,
      });
      return c.json(out, 201);
    },
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/requests/mine',
      tags: ['Requests'],
      summary: "Caller's requests",
      security: bearer,
      middleware: [requireAuth] as const,
      request: { query: MineQuery },
      responses: { 200: jsonContent(RequestPageSchema), 400: errorResponses[400], 401: errorResponses[401] },
    }),
    async (c) => c.json(await svc.listMine(c.get('deps'), requireAuthContext(c), c.req.valid('query')), 200),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/requests/open',
      tags: ['Requests'],
      summary: "Open requests matching the caller's ACTIVE trips (traveler view, no buyer PII)",
      security: bearer,
      middleware: [requireAuth] as const,
      request: { query: OpenQuery },
      responses: { 200: jsonContent(ListingPageSchema), 400: errorResponses[400], 401: errorResponses[401] },
    }),
    async (c) => c.json(await svc.listOpenForTraveler(c.get('deps'), requireAuthContext(c), c.req.valid('query')), 200),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/requests/{id}',
      tags: ['Requests'],
      summary: 'Request detail — buyer sees everything; travelers get the listing view (OPEN requests / own offers)',
      security: bearer,
      middleware: [requireAuth] as const,
      request: { params: IdParam },
      responses: { 200: jsonContent(RequestViewSchema), 401: errorResponses[401], 404: errorResponses[404] },
    }),
    async (c) => c.json(await svc.getRequestView(c.get('deps'), requireAuthContext(c), c.req.valid('param').id), 200),
  );

  r.openapi(
    createRoute({
      method: 'patch',
      path: '/v1/requests/{id}',
      tags: ['Requests'],
      summary: 'Update a DRAFT/OPEN request (item details locked while offers are pending); restriction re-evaluated',
      security: bearer,
      middleware: [requireAuth] as const,
      request: { params: IdParam, ...jsonBody(RequestPatchBody) },
      responses: { 200: jsonContent(RequestOwnerSchema), ...errorResponses, 503: unavailableResponse },
    }),
    async (c) => {
      const b = c.req.valid('json');
      const patch: svc.RequestPatch = {};
      for (const [k, v] of Object.entries(b)) if (v !== undefined) (patch as Record<string, unknown>)[k] = v;
      return c.json(await svc.updateRequestById(c.get('deps'), requireAuthContext(c), c.req.valid('param').id, patch), 200);
    },
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/requests/{id}/publish',
      tags: ['Requests'],
      summary: 'Publish a DRAFT (→ OPEN). Non-ALLOWED items need acknowledgeRestriction; PROHIBITED is refused',
      security: bearer,
      middleware: [requireAuth] as const,
      request: { params: IdParam, body: { content: { 'application/json': { schema: PublishBody } }, required: false } },
      responses: { 200: jsonContent(RequestOwnerSchema), ...errorResponses, 503: unavailableResponse },
    }),
    async (c) => {
      let ack = false;
      try {
        const body = (await c.req.json()) as { acknowledgeRestriction?: unknown };
        ack = body?.acknowledgeRestriction === true;
      } catch {
        ack = false;
      }
      return c.json(await svc.publishRequest(c.get('deps'), requireAuthContext(c), c.req.valid('param').id, ack), 200);
    },
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/requests/{id}/cancel',
      tags: ['Requests'],
      summary: 'Cancel a DRAFT/OPEN request; pending offers are declined',
      security: bearer,
      middleware: [requireAuth] as const,
      request: { params: IdParam, body: { content: { 'application/json': { schema: CancelBody } }, required: false } },
      responses: { 200: jsonContent(RequestOwnerSchema), ...errorResponses },
    }),
    async (c) => {
      let reason: string | null = null;
      try {
        const body = (await c.req.json()) as { reason?: unknown };
        reason = typeof body?.reason === 'string' ? body.reason.slice(0, 500) : null;
      } catch {
        reason = null;
      }
      return c.json(await svc.cancelRequest(c.get('deps'), requireAuthContext(c), c.req.valid('param').id, reason), 200);
    },
  );

  app.route('/', r);
}
