/**
 * OpenAPI contract hygiene (clients generate code from /v1/openapi.json):
 *  - every operation has a unique, stable camelCase operationId and at least one tag
 *  - no emoji in operation summaries / descriptions
 *  - every route whose handler chain contains requireIdempotency declares the Idempotency-Key header
 *    (found by introspecting the Hono route table; cross-checked against a grep of the route files)
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deriveOperationId } from '../src/lib/openapi';
import { requireIdempotency } from '../src/middleware/idempotency';
import { createTestContext, type TestContext } from './helpers';

type Op = { operationId?: string; tags?: string[]; summary?: string; description?: string; parameters?: { in: string; name: string; required?: boolean }[] };

let t: TestContext;
let doc: { paths: Record<string, Record<string, Op>> };
beforeAll(async () => {
  t = await createTestContext();
  doc = (await t.request('GET', '/v1/openapi.json')).body;
});
afterAll(async () => {
  await t.close();
});

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
function operations() {
  const out: { method: string; path: string; op: Op }[] = [];
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(item)) if (METHODS.includes(method)) out.push({ method, path, op });
  }
  return out;
}

/** Route files that mention requireIdempotency / idempotent:true, counted per createRoute occurrence. */
function grepIdempotentRoutes(): number {
  const root = join(import.meta.dirname, '../src/modules');
  let n = 0;
  const walk = (dir: string) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (f === 'routes.ts') {
        const src = readFileSync(p, 'utf8');
        n += (src.match(/middleware:\s*\[[^\]]*\brequireIdempotency\b[^\]]*\]/g) ?? []).length;
        n += (src.match(/idempotent:\s*true/g) ?? []).length;
      }
    }
  };
  walk(root);
  return n;
}

describe('OpenAPI contract hygiene', () => {
  it('every operation has a unique camelCase operationId and tags', () => {
    const ops = operations();
    expect(ops.length).toBeGreaterThan(250);
    const ids = new Map<string, string>();
    for (const { method, path, op } of ops) {
      const where = `${method.toUpperCase()} ${path}`;
      expect(op.operationId, where).toMatch(/^[a-z][A-Za-z0-9]*$/);
      expect(ids.get(op.operationId!), `duplicate operationId ${op.operationId}`).toBeUndefined();
      ids.set(op.operationId!, where);
      expect(op.tags?.length ?? 0, `${where} has no tags`).toBeGreaterThan(0);
    }
    // stable: derived from method + path unless set explicitly
    expect(doc.paths['/v1/transactions/{id}']!.get!.operationId).toBe('getTransactionsById');
    expect(doc.paths['/v1/transactions/{id}/cancel/preview']!.get!.operationId).toBe('getTransactionsByIdCancelPreview');
    expect(deriveOperationId('post', '/v1/transactions/{id}/price-confirmations/{pcId}/respond')).toBe('postTransactionsByIdPriceConfirmationsByPcIdRespond');
  });

  it('no emoji in operation summaries or descriptions', () => {
    const emoji = /\p{Extended_Pictographic}/u;
    const offenders = operations()
      .filter(({ op }) => emoji.test(`${op.summary ?? ''} ${op.description ?? ''}`))
      .map(({ method, path, op }) => `${method.toUpperCase()} ${path}: ${op.summary}`);
    expect(offenders).toEqual([]);
  });

  it('every route using requireIdempotency declares the Idempotency-Key header', () => {
    const toOpenApi = (p: string) => p.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
    const composed = '__COMPOSED_HANDLER'; // hono/utils/constants COMPOSED_HANDLER (sub-apps with their own onError)
    const idempotent = new Set(
      t.app.routes
        .filter((r) => r.handler === requireIdempotency || (r.handler as unknown as Record<string, unknown>)[composed] === requireIdempotency)
        .map((r) => `${r.method.toLowerCase()} ${toOpenApi(r.path)}`),
    );
    // introspection must see exactly the routes the source declares (grep of every routes.ts)
    expect(idempotent.size).toBe(grepIdempotentRoutes());
    for (const known of [
      'post /v1/transactions/{id}/checkout',
      'post /v1/transactions/{id}/cancel',
      'post /v1/transactions/{id}/confirm-receipt',
      'post /v1/transactions/{id}/price-confirmations/{pcId}/respond',
      'post /v1/admin/refunds/{id}/approve',
    ]) {
      expect([...idempotent], known).toContain(known);
    }
    for (const key of idempotent) {
      const [method, path] = key.split(' ') as [string, string];
      const op = doc.paths[path]?.[method];
      expect(op, `${key} missing from OpenAPI`).toBeTruthy();
      const header = op!.parameters?.find((p) => p.in === 'header' && p.name.toLowerCase() === 'idempotency-key');
      expect(header, `${key} does not declare the Idempotency-Key header`).toBeTruthy();
      expect(header!.required, key).toBe(true);
    }
  });
});
