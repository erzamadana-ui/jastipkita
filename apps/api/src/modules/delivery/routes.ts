import { createRoute, z } from '@hono/zod-openapi';
import type { App } from '../../context';
import { bearer, createRouter, errorResponses, jsonBody, jsonContent } from '../../lib/openapi';
import { getAuth, requireAuth } from '../../middleware/auth';
import { requireIdempotency } from '../../middleware/idempotency';
import { rateLimit } from '../../middleware/rate-limit';
import { LooseResult, TxIdParam, IdemHeader } from '../transactions/schemas';
import { confirmReceipt, markDelivered, markShipped, revealPin, setDelivery, verifyHandover } from './service';

const DeliveryBody = z
  .object({
    method: z.enum(['MEETUP', 'COURIER', 'PARTNER_LOGISTICS']),
    courierName: z.string().max(100).optional(),
    trackingNumber: z.string().max(100).optional(),
    meetupPoint: z.string().max(300).optional(),
    scheduledAt: z.string().datetime({ offset: true }).optional(),
    address: z.string().max(1000).optional().openapi({ description: 'Encrypted at rest (AES-256-GCM)' }),
    addressCity: z.string().max(100).optional(),
  })
  .openapi('DeliveryRequest');

const VerifyBody = z
  .object({ pin: z.string().regex(/^\d{4,12}$/).optional(), qrToken: z.string().min(16).max(200).optional() })
  .openapi('HandoverVerification');

const PinResult = z
  .object({ pin: z.string(), qrToken: z.string(), qrPayload: z.string(), qrExpiresAt: z.string(), attemptsRemaining: z.number().int(), note: z.string() })
  .openapi('HandoverPin');

export function registerDeliveryRoutes(app: App) {
  const r = createRouter();

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/transactions/{id}/delivery',
      tags: ['Delivery'],
      summary: 'Traveler sets the delivery method (MEETUP issues PIN/QR; only hashes are stored)',
      security: bearer,
      middleware: [requireAuth] as const,
      request: { params: TxIdParam, ...jsonBody(DeliveryBody) },
      responses: { 200: jsonContent(LooseResult), ...errorResponses },
    }),
    async (c) => c.json(await setDelivery(c.get('deps'), getAuth(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/transactions/{id}/delivery/pin',
      tags: ['Delivery'],
      summary: 'Buyer only: reveal the handover PIN + QR token (rotated on every reveal)',
      security: bearer,
      middleware: [requireAuth, rateLimit({ name: 'money.pin_reveal', limit: 20, windowSec: 3600, key: 'user' })] as const,
      request: { params: TxIdParam },
      responses: { 200: jsonContent(PinResult), ...errorResponses, 423: { description: 'PIN locked' } },
    }),
    async (c) => {
      c.header('cache-control', 'no-store');
      return c.json(await revealPin(c.get('deps'), getAuth(c), c.req.valid('param').id), 200);
    },
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/transactions/{id}/delivery/verify',
      tags: ['Delivery'],
      summary: 'Traveler verifies the buyer PIN/QR (max attempts, then lock + risk flag; idempotent once delivered)',
      security: bearer,
      middleware: [requireAuth, rateLimit({ name: 'money.pin_verify', limit: 20, windowSec: 600, key: 'user' })] as const,
      request: { params: TxIdParam, ...jsonBody(VerifyBody) },
      responses: { 200: jsonContent(LooseResult), ...errorResponses, 423: { description: 'PIN locked' } },
    }),
    async (c) => c.json(await verifyHandover(c.get('deps'), getAuth(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/transactions/{id}/delivery/shipped',
      tags: ['Delivery'],
      summary: 'Traveler hands the parcel to a courier (tracking number) → OUT_FOR_DELIVERY',
      security: bearer,
      middleware: [requireAuth] as const,
      request: { params: TxIdParam, ...jsonBody(z.object({ trackingNumber: z.string().min(3).max(100), courierName: z.string().max(100).optional() })) },
      responses: { 200: jsonContent(LooseResult), ...errorResponses },
    }),
    async (c) => c.json(await markShipped(c.get('deps'), getAuth(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/transactions/{id}/delivery/delivered',
      tags: ['Delivery'],
      summary: 'Traveler reports courier delivery with proof files → DELIVERED (idempotent)',
      security: bearer,
      middleware: [requireAuth] as const,
      request: { params: TxIdParam, ...jsonBody(z.object({ proofFileIds: z.array(z.string().uuid()).min(1).max(10) })) },
      responses: { 200: jsonContent(LooseResult), ...errorResponses },
    }),
    async (c) => c.json(await markDelivered(c.get('deps'), getAuth(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/transactions/{id}/confirm-receipt',
      tags: ['Delivery'],
      summary: 'Buyer confirms receipt (💰) → BUYER_CONFIRMED → COMPLETED (release + payout scheduled)',
      security: bearer,
      middleware: [requireAuth, requireIdempotency] as const,
      request: { params: TxIdParam, headers: IdemHeader },
      responses: { 200: jsonContent(LooseResult), ...errorResponses },
    }),
    async (c) => c.json(await confirmReceipt(c.get('deps'), getAuth(c), c.req.valid('param').id), 200),
  );

  app.route('/', r);
}
