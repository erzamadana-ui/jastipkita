import { createRoute, z } from '@hono/zod-openapi';
import type { App } from '../../context';
import { bearer, createRouter, errorResponses, jsonBody, jsonContent } from '../../lib/openapi';
import { getAuth, requireAuth } from '../../middleware/auth';
import { requestMeta } from '../auth/common';
import {
  ConsentInputSchema,
  ConsentSchema,
  ConsentsResponse,
  DeviceInputSchema,
  DeviceSchema,
  ModeBody,
  OkSchema,
  PatchMeBody,
  PatchMeResponse,
  ProfileSchema,
} from './schemas';
import * as svc from './service';

const tags = ['Me'];

export function registerMe(app: App) {
  const r = createRouter();

  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/me',
      tags,
      summary: 'Current user profile',
      security: bearer,
      middleware: [requireAuth] as const,
      responses: { 200: jsonContent(ProfileSchema), ...errorResponses },
    }),
    async (c) => c.json(await svc.getMe(c.get('deps'), getAuth(c)), 200),
  );

  r.openapi(
    createRoute({
      method: 'patch',
      path: '/v1/me',
      tags,
      summary: 'Update profile',
      description: 'A new transactionEmail is applied only after e-mail OTP verification (see pendingVerification → POST /v1/auth/otp/verify).',
      security: bearer,
      middleware: [requireAuth] as const,
      request: jsonBody(PatchMeBody),
      responses: { 200: jsonContent(PatchMeResponse), ...errorResponses },
    }),
    async (c) => c.json(await svc.patchMe(c.get('deps'), getAuth(c), c.req.valid('json'), await requestMeta(c)), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/me/mode',
      tags,
      summary: 'Switch active mode (BUYER ↔ TRAVELER)',
      description: 'Always allowed; traveler capabilities (offers, trips) are gated by KYC level on those endpoints.',
      security: bearer,
      middleware: [requireAuth] as const,
      request: jsonBody(ModeBody),
      responses: { 200: jsonContent(ProfileSchema), ...errorResponses },
    }),
    async (c) => c.json(await svc.switchMode(c.get('deps'), getAuth(c), c.req.valid('json').mode), 200),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/me/devices',
      tags,
      summary: 'Devices linked to this account',
      security: bearer,
      middleware: [requireAuth] as const,
      responses: { 200: jsonContent(z.object({ data: z.array(DeviceSchema) })), ...errorResponses },
    }),
    async (c) => c.json({ data: await svc.listDevices(c.get('deps'), getAuth(c)) }, 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/me/devices',
      tags,
      summary: 'Register a device (push token + fingerprint)',
      description: 'The fingerprint is stored only as an HMAC (multi-account fraud signal). A push token is bound to one install.',
      security: bearer,
      middleware: [requireAuth] as const,
      request: jsonBody(DeviceInputSchema),
      responses: { 200: jsonContent(DeviceSchema), ...errorResponses },
    }),
    async (c) => c.json(await svc.registerDevice(c.get('deps'), getAuth(c), c.req.valid('json')), 200),
  );

  r.openapi(
    createRoute({
      method: 'delete',
      path: '/v1/me/devices/{id}',
      tags,
      summary: 'Unlink a device (stops pushes, ends its sessions)',
      security: bearer,
      middleware: [requireAuth] as const,
      request: { params: z.object({ id: z.string().uuid() }) },
      responses: { 200: jsonContent(OkSchema), ...errorResponses },
    }),
    async (c) => {
      await svc.removeDevice(c.get('deps'), getAuth(c), c.req.valid('param').id, await requestMeta(c));
      return c.json({ ok: true as const }, 200);
    },
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/me/consents',
      tags,
      summary: 'Consent state and history',
      security: bearer,
      middleware: [requireAuth] as const,
      responses: { 200: jsonContent(ConsentsResponse), ...errorResponses },
    }),
    async (c) => c.json(await svc.consents(c.get('deps'), getAuth(c)), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/me/consents',
      tags,
      summary: 'Record a consent decision (append-only, versioned)',
      description: 'KYC consent is required before a KYC submission; MARKETING is optional; withdrawal = granted:false.',
      security: bearer,
      middleware: [requireAuth] as const,
      request: jsonBody(ConsentInputSchema),
      responses: { 201: jsonContent(ConsentSchema, 'Recorded'), ...errorResponses },
    }),
    async (c) => c.json(await svc.recordConsent(c.get('deps'), getAuth(c), c.req.valid('json'), await requestMeta(c)), 201),
  );

  app.route('/', r);
}
