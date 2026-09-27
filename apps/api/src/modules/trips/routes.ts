import { createRoute } from '@hono/zod-openapi';
import type { App } from '../../context';
import { bearer, createRouter, errorResponses, jsonBody, jsonContent } from '../../lib/openapi';
import { optionalAuth, requireAuth } from '../../middleware/auth';
import { rateLimit } from '../../middleware/rate-limit';
import { requireAuthContext } from '../catalog/shared';
import {
  CancelBody,
  DiscoveryQuery,
  IdParam,
  MyTripsQuery,
  TripCreateBody,
  TripOwnerSchema,
  TripPageSchema,
  TripPatchBody,
  TripPublicPageSchema,
  TripViewSchema,
  VerificationBody,
} from './schemas';
import * as svc from './service';

export function registerTrips(app: App): void {
  const r = createRouter();

  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/trips',
      tags: ['Trips'],
      summary: 'Public trip discovery (ACTIVE trips; no PII — first name + initial, badge, rating)',
      middleware: [rateLimit({ name: 'trips.discover', limit: 120, windowSec: 60 })] as const,
      request: { query: DiscoveryQuery },
      responses: { 200: jsonContent(TripPublicPageSchema), 400: errorResponses[400], 429: errorResponses[429] },
    }),
    async (c) => {
      const deps = c.get('deps');
      const q = c.req.valid('query');
      const out = await svc.discoverTrips(deps, q);
      c.header('cache-control', 'public, max-age=30');
      return c.json(out, 200);
    },
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/trips',
      tags: ['Trips'],
      summary: 'Create a trip (DRAFT)',
      security: bearer,
      middleware: [requireAuth, rateLimit({ name: 'trips.create', limit: 20, windowSec: 3600, key: 'user' })] as const,
      request: jsonBody(TripCreateBody),
      responses: { 201: jsonContent(TripOwnerSchema, 'Created'), ...errorResponses },
    }),
    async (c) => {
      const deps = c.get('deps');
      const b = c.req.valid('json');
      const trip = await svc.createTrip(deps, requireAuthContext(c), {
        originCountry: b.originCountry,
        originCity: b.originCity,
        destinationCountry: b.destinationCountry,
        destinationCity: b.destinationCity,
        departureDate: b.departureDate,
        arrivalDate: b.arrivalDate,
        returnDate: b.returnDate ?? null,
        capacityKg: b.capacityKg,
        maxItems: b.maxItems ?? null,
        fee: b.fee,
        excludedCategories: b.excludedCategories ?? [],
        notes: b.notes ?? null,
      });
      return c.json(trip, 201);
    },
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/trips/mine',
      tags: ['Trips'],
      summary: "Caller's trips (all statuses)",
      security: bearer,
      middleware: [requireAuth] as const,
      request: { query: MyTripsQuery },
      responses: { 200: jsonContent(TripPageSchema), 400: errorResponses[400], 401: errorResponses[401] },
    }),
    async (c) => c.json(await svc.listMyTrips(c.get('deps'), requireAuthContext(c), c.req.valid('query')), 200),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/trips/{id}',
      tags: ['Trips'],
      summary: 'Trip detail — owner sees everything; others get the public view of listed trips',
      middleware: [optionalAuth] as const,
      request: { params: IdParam },
      responses: { 200: jsonContent(TripViewSchema), 400: errorResponses[400], 404: errorResponses[404] },
    }),
    async (c) => c.json(await svc.getTripView(c.get('deps'), c.get('auth'), c.req.valid('param').id), 200),
  );

  r.openapi(
    createRoute({
      method: 'patch',
      path: '/v1/trips/{id}',
      tags: ['Trips'],
      summary: 'Update a trip (allowed fields depend on status; route/dates locked after documents are submitted)',
      security: bearer,
      middleware: [requireAuth] as const,
      request: { params: IdParam, ...jsonBody(TripPatchBody) },
      responses: { 200: jsonContent(TripOwnerSchema), ...errorResponses },
    }),
    async (c) => {
      const b = c.req.valid('json');
      const patch: svc.TripPatch = {};
      for (const [k, v] of Object.entries(b)) if (v !== undefined) (patch as Record<string, unknown>)[k] = v;
      return c.json(await svc.updateTrip(c.get('deps'), requireAuthContext(c), c.req.valid('param').id, patch), 200);
    },
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/trips/{id}/verification',
      tags: ['Trips'],
      summary: 'Submit a travel document (TRIP_DOC file) → trip VERIFICATION_PENDING',
      security: bearer,
      middleware: [requireAuth] as const,
      request: { params: IdParam, ...jsonBody(VerificationBody) },
      responses: { 200: jsonContent(TripOwnerSchema), ...errorResponses },
    }),
    async (c) => {
      const b = c.req.valid('json');
      return c.json(
        await svc.submitVerification(c.get('deps'), requireAuthContext(c), c.req.valid('param').id, {
          docType: b.docType,
          fileId: b.fileId,
          flightNumber: b.flightNumber ?? null,
          flightDate: b.flightDate ?? null,
        }),
        200,
      );
    },
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/trips/{id}/publish',
      tags: ['Trips'],
      summary: 'Publish (VERIFIED → ACTIVE; DRAFT/VERIFICATION_PENDING → ACTIVE only if trips.allowUnverifiedActive). KYC ≥ 3',
      security: bearer,
      middleware: [requireAuth] as const,
      request: { params: IdParam },
      responses: { 200: jsonContent(TripOwnerSchema), ...errorResponses },
    }),
    async (c) => c.json(await svc.publishTrip(c.get('deps'), requireAuthContext(c), c.req.valid('param').id), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/trips/{id}/depart',
      tags: ['Trips'],
      summary: 'Mark departed (ACTIVE/FULL → TRAVELING); pending offers expire',
      security: bearer,
      middleware: [requireAuth] as const,
      request: { params: IdParam },
      responses: { 200: jsonContent(TripOwnerSchema), ...errorResponses },
    }),
    async (c) => c.json(await svc.departTrip(c.get('deps'), requireAuthContext(c), c.req.valid('param').id), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/trips/{id}/complete',
      tags: ['Trips'],
      summary: 'Complete (TRAVELING → COMPLETED) once every item has been handed over',
      security: bearer,
      middleware: [requireAuth] as const,
      request: { params: IdParam },
      responses: { 200: jsonContent(TripOwnerSchema), ...errorResponses },
    }),
    async (c) => c.json(await svc.completeTrip(c.get('deps'), requireAuthContext(c), c.req.valid('param').id), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/trips/{id}/cancel',
      tags: ['Trips'],
      summary: 'Cancel a trip. Pending offers are withdrawn; open transactions are announced via `trip.cancelled` for the money group',
      security: bearer,
      middleware: [requireAuth] as const,
      request: { params: IdParam, ...jsonBody(CancelBody) },
      responses: { 200: jsonContent(TripOwnerSchema), ...errorResponses },
    }),
    async (c) => c.json(await svc.cancelTrip(c.get('deps'), requireAuthContext(c), c.req.valid('param').id, c.req.valid('json').reason), 200),
  );

  app.route('/', r);
}
