import { createRoute, z } from '@hono/zod-openapi';
import type { App } from '../../../context';
import { bearer, createRouter, errorResponses, IdempotencyHeader, jsonBody, jsonContent } from '../../../lib/openapi';
import { AdminLoose, AdminPage, adminCtx, adminGuard, IdParam } from '../common';
import * as svc from './service';

const tags = ['Admin · Settlement accounts'];

const ChangeBody = z
  .object({
    changeType: z.enum(['CREATE', 'UPDATE', 'DISABLE', 'SET_PRIMARY']),
    settlementAccountId: z.string().uuid().optional(),
    label: z.string().trim().min(3).max(100).optional(),
    purpose: z.enum(['PLATFORM_REVENUE', 'TAX', 'OPERATIONS']).optional(),
    bankCode: z.string().regex(/^[A-Z0-9_]{2,20}$/).optional(),
    secretRef: z.string().max(80).optional().openapi({ description: 'NAME of the entry in the server secret store (SETTLEMENT_SECRETS_JSON), e.g. SETTLEMENT_MAIN. Never the account number.', example: 'SETTLEMENT_MAIN' }),
    accountMask: z.string().regex(/^\*{4}\d{2,4}$/).optional().openapi({ example: '****0961', description: 'Must match the last digits of the account number in the secret store' }),
    holderNameMask: z.string().trim().min(2).max(100).optional().openapi({ example: 'PT J*** K*** I***' }),
    currency: z.string().regex(/^[A-Z]{3}$/).optional(),
    isPrimary: z.boolean().optional(),
    reason: z.string().trim().min(10).max(1000),
  })
  .openapi('AdminSettlementChangeRequest');

export function registerAdminSettlement(app: App) {
  const r = createRouter();
  r.openapi(
    createRoute({
      method: 'get', path: '/v1/admin/settlement-accounts', tags, security: bearer,
      summary: 'Settlement accounts — masked only (****0961); secretConfigured shows whether the secret store holds the number',
      middleware: adminGuard(['finance.settlement.read_masked']),
      responses: { 200: jsonContent(AdminPage), ...errorResponses },
    }),
    async (c) => c.json(await svc.listAccounts(await adminCtx(c)), 200),
  );
  r.openapi(
    createRoute({
      method: 'get', path: '/v1/admin/settlement-accounts/changes', tags, security: bearer,
      summary: 'Change history (maker-checker requests)',
      middleware: adminGuard(['finance.settlement.read_masked']),
      request: { query: z.object({ status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'APPLIED', 'EXPIRED']).optional() }) },
      responses: { 200: jsonContent(AdminPage), ...errorResponses },
    }),
    async (c) => c.json(await svc.listChanges(await adminCtx(c), c.req.valid('query').status), 200),
  );
  r.openapi(
    createRoute({
      method: 'post', path: '/v1/admin/settlement-accounts/changes', tags, security: bearer,
      summary: 'Request a change (CREATE/UPDATE/DISABLE/SET_PRIMARY) — secret name + mask only; validated against the secret store',
      middleware: adminGuard(['finance.settlement.request_change'], { mfa: true, idempotent: true }),
      request: { headers: IdempotencyHeader, ...jsonBody(ChangeBody) },
      responses: { 201: jsonContent(AdminLoose, 'Requested'), ...errorResponses },
    }),
    async (c) => c.json(await svc.requestChange(await adminCtx(c), c.req.valid('json')), 201),
  );
  r.openapi(
    createRoute({
      method: 'post', path: '/v1/admin/settlement-accounts/changes/{id}/approve', tags, security: bearer,
      summary: 'Approve & apply (FINANCE_SUPER_ADMIN ≠ requester, MFA ≤ 15 min)',
      middleware: adminGuard(['finance.settlement.approve_change'], { mfa: true, idempotent: true }),
      request: { params: IdParam, headers: IdempotencyHeader, ...jsonBody(z.object({ note: z.string().trim().max(1000).optional() })) },
      responses: { 200: jsonContent(AdminLoose), ...errorResponses },
    }),
    async (c) => c.json(await svc.approveChange(await adminCtx(c), c.req.valid('param').id, c.req.valid('json').note), 200),
  );
  r.openapi(
    createRoute({
      method: 'post', path: '/v1/admin/settlement-accounts/changes/{id}/reject', tags, security: bearer,
      summary: 'Reject a pending change',
      middleware: adminGuard(['finance.settlement.approve_change'], { mfa: true, idempotent: true }),
      request: { params: IdParam, headers: IdempotencyHeader, ...jsonBody(z.object({ note: z.string().trim().min(5).max(1000) })) },
      responses: { 200: jsonContent(AdminLoose), ...errorResponses },
    }),
    async (c) => c.json(await svc.rejectChange(await adminCtx(c), c.req.valid('param').id, c.req.valid('json').note), 200),
  );
  app.route('/', r);
}
