import { createRoute, z } from '@hono/zod-openapi';
import type { App } from '../../context';
import { bearer, createRouter, errorResponses, jsonBody, jsonContent } from '../../lib/openapi';
import { getAuth, requireAuth } from '../../middleware/auth';
import { rateLimit } from '../../middleware/rate-limit';
import {
  AddEvidenceSchema,
  AppealSchema,
  DisputeListQuery,
  DisputePage,
  DisputeSchema,
  EvidenceSchema,
  FileUrlSchema,
  OpenDisputeSchema,
  WithdrawResultSchema,
  WithdrawSchema,
} from './schemas';
import * as svc from './service';

const tags = ['Disputes'];
const IdParam = z.object({ id: z.string().uuid().openapi({ param: { name: 'id', in: 'path' } }) });
const EvidenceParam = IdParam.extend({ evidenceId: z.string().uuid().openapi({ param: { name: 'evidenceId', in: 'path' } }) });

export function registerDisputes(app: App): void {
  const r = createRouter();

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/transactions/{id}/disputes',
      tags,
      summary: 'Open a dispute (buyer or traveler; PURCHASED…DELIVERED, within dispute.sla.openWindowHoursAfterDelivery after delivery)',
      description: 'Moves the transaction to DISPUTED, creates the dispute (DSP-…) and starts the evidence window (EVIDENCE_COLLECTION) with SLA deadlines from dispute.sla.',
      security: bearer,
      middleware: [requireAuth, rateLimit({ name: 'disputes.open', limit: 20, windowSec: 3600, key: 'user' })] as const,
      request: { params: IdParam, ...jsonBody(OpenDisputeSchema) },
      responses: { 201: jsonContent(DisputeSchema, 'Created'), ...errorResponses },
    }),
    async (c) => c.json(await svc.openDispute(c.get('deps'), getAuth(c), c.req.valid('param').id, c.req.valid('json')), 201),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/disputes/mine',
      tags,
      summary: 'Disputes on my transactions (as buyer or traveler)',
      security: bearer,
      middleware: [requireAuth] as const,
      request: { query: DisputeListQuery },
      responses: { 200: jsonContent(DisputePage), ...errorResponses },
    }),
    async (c) => c.json(await svc.listMine(c.get('deps'), getAuth(c), c.req.valid('query')), 200),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/disputes/{id}',
      tags,
      summary: 'Dispute detail: both parties see status, deadlines, evidence metadata and timeline',
      security: bearer,
      middleware: [requireAuth] as const,
      request: { params: IdParam },
      responses: { 200: jsonContent(DisputeSchema), ...errorResponses },
    }),
    async (c) => c.json(await svc.getDetail(c.get('deps'), getAuth(c), c.req.valid('param').id), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/disputes/{id}/evidence',
      tags,
      summary: 'Add evidence (PHOTO/VIDEO/RECEIPT/CHAT/TRACKING/DELIVERY_PROOF/OTHER) referencing own files, transaction files or chat messages',
      security: bearer,
      middleware: [requireAuth, rateLimit({ name: 'disputes.evidence', limit: 30, windowSec: 3600, key: 'user' })] as const,
      request: { params: IdParam, ...jsonBody(AddEvidenceSchema) },
      responses: { 201: jsonContent(EvidenceSchema, 'Created'), ...errorResponses },
    }),
    async (c) => c.json(await svc.addEvidence(c.get('deps'), getAuth(c), c.req.valid('param').id, c.req.valid('json')), 201),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/disputes/{id}/evidence/{evidenceId}/file-url',
      tags,
      summary: 'Short-lived download URL for an evidence file (dispute participants only)',
      security: bearer,
      middleware: [requireAuth] as const,
      request: { params: EvidenceParam },
      responses: { 200: jsonContent(FileUrlSchema), ...errorResponses },
    }),
    async (c) => {
      const p = c.req.valid('param');
      return c.json(await svc.evidenceFileUrl(c.get('deps'), getAuth(c), p.id, p.evidenceId), 200);
    },
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/disputes/{id}/appeal',
      tags,
      summary: 'Appeal a RESOLVED dispute (once, within dispute.sla.appealWindowHours)',
      security: bearer,
      middleware: [requireAuth] as const,
      request: { params: IdParam, ...jsonBody(AppealSchema) },
      responses: { 200: jsonContent(DisputeSchema), ...errorResponses },
    }),
    async (c) => c.json(await svc.appeal(c.get('deps'), getAuth(c), c.req.valid('param').id, c.req.valid('json').reason), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/disputes/{id}/withdraw',
      tags,
      summary: 'Withdraw my dispute (opener only; OPEN or EVIDENCE_COLLECTION)',
      security: bearer,
      middleware: [requireAuth] as const,
      request: { params: IdParam, body: { content: { 'application/json': { schema: WithdrawSchema } }, required: false } },
      responses: { 200: jsonContent(WithdrawResultSchema), ...errorResponses },
    }),
    async (c) => {
      const body = (c.req.valid('json') as { reason?: string } | undefined) ?? {};
      return c.json(await svc.withdraw(c.get('deps'), getAuth(c), c.req.valid('param').id, body.reason), 200);
    },
  );

  app.route('/', r);
}
