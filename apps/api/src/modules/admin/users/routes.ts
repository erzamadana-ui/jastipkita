import { createRoute, z } from '@hono/zod-openapi';
import type { App } from '../../../context';
import { bearer, createRouter, errorResponses, jsonBody, jsonContent } from '../../../lib/openapi';
import { AdminLoose, AdminPage, adminCtx, adminGuard, IdParam, PageQuery, ReasonBody } from '../common';
import * as svc from './service';

const tags = ['Admin · Users'];
const rbacTags = ['Admin · RBAC'];

const UserSearchQuery = PageQuery.extend({
  q: z.string().max(200).optional().openapi({ description: 'id (uuid), e-mail prefix, phone prefix, name fragment or referral code' }),
  status: z.enum(['ACTIVE', 'SUSPENDED', 'PENDING_DELETION', 'DELETED']).optional(),
  role: z.string().regex(/^[A-Z][A-Z_]*$/).optional(),
  kycLevel: z.coerce.number().int().min(1).max(5).optional(),
});

const MaskedUser = z
  .looseObject({
    id: z.string().uuid(),
    email: z.string().nullable().openapi({ example: 'r***@example.com' }),
    phone: z.string().nullable().openapi({ example: '+6281****567' }),
    displayName: z.string().nullable().openapi({ example: 'Budi S.' }),
    status: z.string(),
    kycLevel: z.number().int(),
    roles: z.array(z.string()),
    piiMasked: z.literal(true),
  })
  .openapi('AdminMaskedUser');

const GrantBody = z.object({ roleCode: z.string().regex(/^[A-Z][A-Z_]*$/), reason: z.string().trim().min(10).max(1000) }).openapi('AdminRoleGrantRequest');
const RoleParam = IdParam.extend({ roleCode: z.string().regex(/^[A-Z][A-Z_]*$/).openapi({ param: { name: 'roleCode', in: 'path' } }) });
const NoteBody = z.object({ note: z.string().trim().max(1000).optional() });
const RejectBody = z.object({ note: z.string().trim().min(5).max(1000) });

export function registerAdminUsers(app: App) {
  const r = createRouter();

  r.openapi(
    createRoute({
      method: 'get', path: '/v1/admin/users', tags, security: bearer,
      summary: 'Search users (PII masked)',
      middleware: adminGuard(['users.read']),
      request: { query: UserSearchQuery },
      responses: { 200: jsonContent(z.object({ data: z.array(MaskedUser), nextCursor: z.string().nullable() })), ...errorResponses },
    }),
    async (c) => c.json(await svc.searchUsers(await adminCtx(c), c.req.valid('query')), 200),
  );
  r.openapi(
    createRoute({
      method: 'get', path: '/v1/admin/users/{id}', tags, security: bearer,
      summary: 'User detail: KYC level, trust score + components, risk, transactions summary, devices, sessions (PII masked)',
      middleware: adminGuard(['users.read']),
      request: { params: IdParam },
      responses: { 200: jsonContent(MaskedUser), ...errorResponses },
    }),
    async (c) => c.json(await svc.userDetail(await adminCtx(c), c.req.valid('param').id), 200),
  );
  r.openapi(
    createRoute({
      method: 'post', path: '/v1/admin/users/{id}/reveal-contact', tags, security: bearer,
      summary: 'Reveal full e-mail / phone / name (users.read + MFA; audited users.pii_revealed + security event)',
      middleware: adminGuard(['users.read'], { mfa: true }),
      request: { params: IdParam, ...jsonBody(ReasonBody) },
      responses: { 200: jsonContent(z.object({ id: z.string(), email: z.string().nullable(), phone: z.string().nullable(), displayName: z.string().nullable(), revealedAt: z.string() })), ...errorResponses },
    }),
    async (c) => c.json(await svc.revealContact(await adminCtx(c), c.req.valid('param').id, c.req.valid('json').reason), 200),
  );
  r.openapi(
    createRoute({
      method: 'post', path: '/v1/admin/users/{id}/suspend', tags, security: bearer,
      summary: 'Suspend (reason required; revokes every session)',
      middleware: adminGuard(['users.suspend'], { mfa: true }),
      request: { params: IdParam, ...jsonBody(ReasonBody) },
      responses: { 200: jsonContent(AdminLoose), ...errorResponses },
    }),
    async (c) => c.json(await svc.suspendUser(await adminCtx(c), c.req.valid('param').id, c.req.valid('json').reason), 200),
  );
  r.openapi(
    createRoute({
      method: 'post', path: '/v1/admin/users/{id}/reactivate', tags, security: bearer,
      summary: 'Reactivate a suspended account (reason required)',
      middleware: adminGuard(['users.suspend'], { mfa: true }),
      request: { params: IdParam, ...jsonBody(ReasonBody) },
      responses: { 200: jsonContent(AdminLoose), ...errorResponses },
    }),
    async (c) => c.json(await svc.reactivateUser(await adminCtx(c), c.req.valid('param').id, c.req.valid('json').reason), 200),
  );
  r.openapi(
    createRoute({
      method: 'post', path: '/v1/admin/users/{id}/force-logout', tags, security: bearer,
      summary: 'Revoke all sessions of the user',
      middleware: adminGuard(['users.suspend']),
      request: { params: IdParam, ...jsonBody(ReasonBody) },
      responses: { 200: jsonContent(AdminLoose), ...errorResponses },
    }),
    async (c) => c.json(await svc.forceLogout(await adminCtx(c), c.req.valid('param').id, c.req.valid('json').reason), 200),
  );

  // ---------------------------------------------------------------- RBAC
  r.openapi(
    createRoute({
      method: 'get', path: '/v1/admin/rbac/roles', tags: rbacTags, security: bearer,
      summary: 'Roles, their permissions (least-privilege matrix) and holder counts',
      middleware: adminGuard(['rbac.manage']),
      responses: { 200: jsonContent(AdminLoose), ...errorResponses },
    }),
    async (c) => c.json(await svc.listRoles(await adminCtx(c)), 200),
  );
  r.openapi(
    createRoute({
      method: 'post', path: '/v1/admin/users/{id}/roles', tags: rbacTags, security: bearer,
      summary: 'Grant a role. SUPER_ADMIN / FINANCE_SUPER_ADMIN → 202 maker-checker request (another SUPER_ADMIN approves)',
      middleware: adminGuard(['rbac.manage'], { mfa: true }),
      request: { params: IdParam, ...jsonBody(GrantBody) },
      responses: { 200: jsonContent(AdminLoose, 'Granted'), 202: jsonContent(AdminLoose, 'Pending approval'), ...errorResponses },
    }),
    async (c) => {
      const b = c.req.valid('json');
      const out = await svc.grantRole(await adminCtx(c), c.req.valid('param').id, b.roleCode, b.reason);
      return out.status === 'PENDING_APPROVAL' ? c.json(out, 202) : c.json(out, 200);
    },
  );
  r.openapi(
    createRoute({
      method: 'delete', path: '/v1/admin/users/{id}/roles/{roleCode}', tags: rbacTags, security: bearer,
      summary: 'Revoke a role (never the last SUPER_ADMIN, never your own SUPER_ADMIN)',
      middleware: adminGuard(['rbac.manage'], { mfa: true }),
      request: { params: RoleParam, ...jsonBody(ReasonBody) },
      responses: { 200: jsonContent(AdminLoose), ...errorResponses },
    }),
    async (c) => {
      const p = c.req.valid('param');
      return c.json(await svc.revokeRole(await adminCtx(c), p.id, p.roleCode, c.req.valid('json').reason), 200);
    },
  );
  r.openapi(
    createRoute({
      method: 'get', path: '/v1/admin/rbac/role-requests', tags: rbacTags, security: bearer,
      summary: 'Privileged role grant requests (maker-checker)',
      middleware: adminGuard(['rbac.manage']),
      request: { query: z.object({ status: z.enum(['PENDING', 'APPLIED', 'REJECTED', 'EXPIRED', 'CANCELLED']).optional() }) },
      responses: { 200: jsonContent(AdminPage), ...errorResponses },
    }),
    async (c) => c.json({ ...(await svc.listRoleRequests(await adminCtx(c), c.req.valid('query').status)), nextCursor: null }, 200),
  );
  r.openapi(
    createRoute({
      method: 'post', path: '/v1/admin/rbac/role-requests/{id}/approve', tags: rbacTags, security: bearer,
      summary: 'Approve a privileged role grant (SUPER_ADMIN ≠ requester ≠ subject, fresh MFA)',
      middleware: adminGuard(['rbac.manage'], { mfa: true }),
      request: { params: IdParam, ...jsonBody(NoteBody) },
      responses: { 200: jsonContent(AdminLoose), ...errorResponses },
    }),
    async (c) => c.json(await svc.approveRoleRequest(await adminCtx(c), c.req.valid('param').id, c.req.valid('json').note), 200),
  );
  r.openapi(
    createRoute({
      method: 'post', path: '/v1/admin/rbac/role-requests/{id}/reject', tags: rbacTags, security: bearer,
      summary: 'Reject (or, by the requester, cancel) a privileged role grant request',
      middleware: adminGuard(['rbac.manage'], { mfa: true }),
      request: { params: IdParam, ...jsonBody(RejectBody) },
      responses: { 200: jsonContent(AdminLoose), ...errorResponses },
    }),
    async (c) => c.json(await svc.rejectRoleRequest(await adminCtx(c), c.req.valid('param').id, c.req.valid('json').note), 200),
  );

  app.route('/', r);
}
