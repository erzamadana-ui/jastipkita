/**
 * Admin RBAC matrix (security review 2026-09, scope item 2): enumerates EVERY /v1/admin/* operation from the
 * OpenAPI document and the permissions each route actually declares (requirePermission marker), then asserts:
 *   - no bearer token            → 401
 *   - signed-in non-admin        → 403 ADMIN_ONLY
 *   - admin role, no permissions → 403 PERMISSION_DENIED (every admin route declares ≥ 1 permission)
 *   - admin holding every permission EXCEPT one the route requires → 403 PERMISSION_DENIED naming it
 * Guards run before validation, idempotency and services, so no bodies or real ids are needed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REQUIRED_PERMISSIONS } from '../../src/middleware/auth';
import { issueSession } from '../../src/services/session';
import { createTestContext, type TestContext } from '../helpers';

let t: TestContext;
beforeAll(async () => {
  t = await createTestContext();
});
afterAll(() => t?.close());

interface Op {
  method: string;
  path: string; // OpenAPI form (/v1/admin/users/{id})
  honoPath: string; // router form (/v1/admin/users/:id)
  concrete: string; // request path with sample parameter values
}

function samplePath(p: string): string {
  return p.replace(/\{([^}]+)\}/g, (_m, name: string) =>
    name === 'roleCode' ? 'SUPPORT' : name === 'key' ? 'money.policy' : name === 'type' ? 'TOS' : '00000000-0000-4000-8000-000000000001',
  );
}

async function adminOps(): Promise<Op[]> {
  const doc = await t.request('GET', '/v1/openapi.json');
  expect(doc.status).toBe(200);
  const ops: Op[] = [];
  for (const [path, item] of Object.entries(doc.body.paths as Record<string, Record<string, unknown>>)) {
    if (!path.startsWith('/v1/admin')) continue;
    for (const method of Object.keys(item)) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
      ops.push({ method: method.toUpperCase(), path, honoPath: path.replace(/\{([^}]+)\}/g, ':$1'), concrete: samplePath(path) });
    }
  }
  return ops;
}

/** Declared permissions per METHOD path (union of every requirePermission middleware on the route). */
function declaredPermissions(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const r of t.app.routes as { method: string; path: string; handler: unknown }[]) {
    const perms = (r.handler as Record<symbol, readonly string[] | undefined>)[REQUIRED_PERMISSIONS];
    if (!perms) continue;
    const k = `${r.method} ${r.path}`;
    const set = out.get(k) ?? new Set<string>();
    for (const p of perms) set.add(p);
    out.set(k, set);
  }
  return out;
}

async function userWithRole(role: string, permissions: string[]) {
  await t.adminSql`INSERT INTO roles (code, name, description, is_system) VALUES (${role}, ${role}, 'security test role', false) ON CONFLICT DO NOTHING`;
  for (const p of permissions) await t.adminSql`INSERT INTO role_permissions (role_code, permission_code) VALUES (${role}, ${p}) ON CONFLICT DO NOTHING`;
  const u = await t.createUser({ kycLevel: 2, roles: [role] });
  // MFA-verified session: permission is the only thing missing
  const s = await issueSession(t.deps, t.sql, u.id, { mfaAt: Math.floor(t.clock.now().getTime() / 1000) });
  return s.accessToken;
}

describe('admin RBAC matrix (all /v1/admin/* operations)', () => {
  it('every admin operation declares at least one permission and rejects anonymous, non-admin and permission-less callers', async () => {
    const ops = await adminOps();
    expect(ops.length).toBeGreaterThan(100);
    const declared = declaredPermissions();
    const undeclared = ops.filter((o) => !declared.get(`${o.method} ${o.honoPath}`)?.size).map((o) => `${o.method} ${o.path}`);
    expect(undeclared, 'admin routes without requirePermission').toEqual([]);

    const buyer = await t.createUser({ kycLevel: 3, mfa: true });
    const noPerm = await userWithRole('SEC_NO_PERMISSIONS', []);
    const problems: string[] = [];
    for (const o of ops) {
      const anon = await t.request(o.method, o.concrete);
      if (anon.status !== 401) problems.push(`${o.method} ${o.path} anonymous → ${anon.status}`);
      const nonAdmin = await t.request(o.method, o.concrete, { token: buyer.accessToken });
      if (nonAdmin.status !== 403 || nonAdmin.body?.error?.code !== 'ADMIN_ONLY') problems.push(`${o.method} ${o.path} non-admin → ${nonAdmin.status} ${nonAdmin.body?.error?.code}`);
      const bare = await t.request(o.method, o.concrete, { token: noPerm });
      if (bare.status !== 403 || bare.body?.error?.code !== 'PERMISSION_DENIED') problems.push(`${o.method} ${o.path} no-permission admin → ${bare.status} ${bare.body?.error?.code}`);
    }
    expect(problems).toEqual([]);
  });

  it('an admin lacking exactly one required permission is denied (and told which one)', async () => {
    const ops = await adminOps();
    const declared = declaredPermissions();
    const all = (await t.adminSql<{ code: string }[]>`SELECT code FROM permissions ORDER BY code`).map((r) => r.code);
    const tokenWithout = new Map<string, string>();
    let n = 0;
    const problems: string[] = [];
    for (const o of ops) {
      for (const p of declared.get(`${o.method} ${o.honoPath}`) ?? []) {
        if (!tokenWithout.has(p)) tokenWithout.set(p, await userWithRole(`SEC_ALL_BUT_${String.fromCharCode(65 + Math.floor(n / 26), 65 + (n++ % 26))}`, all.filter((x) => x !== p)));
        const r = await t.request(o.method, o.concrete, { token: tokenWithout.get(p)! });
        if (r.status !== 403 || r.body?.error?.code !== 'PERMISSION_DENIED' || !(r.body.error.details.missing as string[]).includes(p)) {
          problems.push(`${o.method} ${o.path} without ${p} → ${r.status} ${r.body?.error?.code}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});
