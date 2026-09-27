import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../env';
import { createDbAdminProvider } from './index';
import { NeonApiError, NeonDbAdminProvider } from './neon';

const KEY = 'neon_api_key_SECRET_123';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeFetch(routes: Record<string, (c: Call) => { status?: number; json: unknown }>) {
  const calls: Call[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    const call: Call = { url, method, headers, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const key = `${method} ${new URL(url).pathname}`;
    const h = routes[key];
    if (!h) return new Response(JSON.stringify({ code: 'NOT_FOUND', message: `no route ${key}` }), { status: 404 });
    const out = h(call);
    return new Response(JSON.stringify(out.json), { status: out.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { f, calls };
}

const P = '/api/v2/projects/proj-123';

describe('Neon DB admin adapter (fake fetch)', () => {
  it('info(): region, plan, PITR window from history_retention_seconds; bearer auth only in the header', async () => {
    const { f, calls } = fakeFetch({ [`GET ${P}`]: () => ({ json: { project: { id: 'proj-123', region_id: 'aws-ap-southeast-1', pg_version: 16, history_retention_seconds: 604800, owner: { subscription_type: 'launch' } } } }) });
    const neon = new NeonDbAdminProvider({ apiKey: KEY, projectId: 'proj-123', fetch: f });
    const info = await neon.info();
    expect(info).toMatchObject({ provider: 'neon', region: 'aws-ap-southeast-1', plan: 'launch', pitrWindowHours: 168 });
    expect(info.notes).toContain('PostgreSQL 16');
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(calls[0]!.url).toBe(`https://console.neon.tech${P}`);
    expect(JSON.stringify(info)).not.toContain(KEY);
    expect(neon.capabilities).toEqual({ backups: true, pitr: true, branching: true, replicationInfo: false });
  });

  it('listBackups(): non-default branches, newest first', async () => {
    const { f } = fakeFetch({
      [`GET ${P}/branches`]: () => ({
        json: {
          branches: [
            { id: 'br-main', name: 'main', default: true, created_at: '2026-01-01T00:00:00Z', current_state: 'ready' },
            { id: 'br-a', name: 'backup-a', created_at: '2026-09-01T00:00:00Z', current_state: 'ready', logical_size: 1024 },
            { id: 'br-b', name: 'backup-b', created_at: '2026-09-20T00:00:00Z', current_state: 'init' },
          ],
        },
      }),
    });
    const neon = new NeonDbAdminProvider({ apiKey: KEY, projectId: 'proj-123', fetch: f });
    const list = await neon.listBackups();
    expect(list.map((b) => [b.id, b.status, b.kind])).toEqual([['br-b', 'INIT', 'BRANCH'], ['br-a', 'READY', 'BRANCH']]);
    expect(list[1]!.sizeBytes).toBe(1024);
  });

  it('createBackup() and restoreToNew() create NEW branches (parent_id / parent_timestamp), never in place', async () => {
    const { f, calls } = fakeFetch({
      [`POST ${P}/branches`]: (c) => ({ status: 201, json: { branch: { id: 'br-new', name: (c.body as any).branch.name, created_at: '2026-09-27T01:00:00Z', current_state: 'init' } } }),
    });
    const neon = new NeonDbAdminProvider({ apiKey: KEY, projectId: 'proj-123', fetch: f });
    const b = await neon.createBackup('Pre Launch!!');
    expect(b).toMatchObject({ id: 'br-new', kind: 'BRANCH', status: 'INIT' });
    expect((calls[0]!.body as any).branch.name).toMatch(/^backup-pre-launch-[a-z0-9]+$/);
    const pit = new Date('2026-09-26T10:00:00Z');
    const r = await neon.restoreToNew({ backupId: 'br-a', pointInTime: pit, label: 'restore test' });
    expect(r).toEqual({ targetId: 'br-new', status: 'INIT' });
    expect((calls[1]!.body as any).branch).toMatchObject({ parent_id: 'br-a', parent_timestamp: pit.toISOString() });
    expect((calls[1]!.body as any).branch.name).toMatch(/^restore-restore-test-/);
    await expect(neon.restoreToNew({ label: 'x' })).rejects.toThrow(/backupId/);
  });

  it('API errors carry status + sanitized code only (no key, no raw message)', async () => {
    const { f } = fakeFetch({ [`GET ${P}`]: () => ({ status: 401, json: { code: 'UNAUTHORIZED<script>', message: `bad key ${KEY}` } }) });
    const neon = new NeonDbAdminProvider({ apiKey: KEY, projectId: 'proj-123', fetch: f });
    const err = await neon.info().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NeonApiError);
    expect((err as NeonApiError).status).toBe(401);
    expect((err as NeonApiError).code).toBe('UNAUTHORIZEDscript');
    expect(String((err as Error).message)).not.toContain(KEY);
  });

  it('factory: neon requires NEON_API_KEY and NEON_PROJECT_ID; generic has no backups', () => {
    const base = {
      APP_ENV: 'development',
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      JWT_SECRET: 'x'.repeat(40),
      DATA_ENCRYPTION_KEYS: `k1:${Buffer.alloc(32).toString('base64')}`,
      HMAC_PEPPER: 'p'.repeat(40),
    };
    expect(createDbAdminProvider(loadEnv({ ...base, DB_ADMIN_PROVIDER: 'generic' })).capabilities.backups).toBe(false);
    expect(() => createDbAdminProvider(loadEnv({ ...base, DB_ADMIN_PROVIDER: 'neon' }))).toThrow(/NEON_API_KEY/);
    const neon = createDbAdminProvider(loadEnv({ ...base, DB_ADMIN_PROVIDER: 'neon', NEON_API_KEY: KEY, NEON_PROJECT_ID: 'p' }));
    expect(neon.name).toBe('neon');
  });
});
