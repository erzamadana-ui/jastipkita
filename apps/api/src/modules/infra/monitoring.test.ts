/**
 * Alerting as code (infra/monitoring/alerts.yaml) must not drift from the code it watches:
 *  - every in-app alert code of ALERT_THRESHOLDS is listed with the same thresholds (and nothing else is),
 *  - every log-based alert names a log `msg` that the API really emits,
 *  - ids are unique, severities/types/statuses are known, runbook files exist,
 *  - the in-app alert job emits the "ALERT ops.alert_opened" line the log-based IN_APP_ALERT_OPENED alert relies on.
 * The YAML is parsed with a small line-based reader (no YAML dependency): one key per line inside each alert block.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../../../test/helpers';
import type { Logger } from '../../lib/logger';
import { ALERT_THRESHOLDS, evaluateAndPersistAlerts } from '../admin/system/service';

const ROOT = join(import.meta.dirname, '../../../../..');
const SRC = join(ROOT, 'apps/api/src');
const yaml = readFileSync(join(ROOT, 'infra/monitoring/alerts.yaml'), 'utf8');

interface Block {
  id: string;
  text: string;
  field: (k: string) => string | null;
}
const blocks: Block[] = yaml
  .split(/\n(?= {2}- id: )/)
  .slice(1)
  .map((text) => {
    const id = /^ {2}- id: (\S+)/.exec(text)![1]!;
    const field = (k: string) => {
      const m = new RegExp(`^\\s+${k}: (.+)$`, 'm').exec(text);
      return m ? m[1]!.trim().replace(/^"(.*)"$/, '$1') : null;
    };
    return { id, text, field };
  });

/** GitHub-style heading anchors of a markdown file. */
function headingSlugs(md: string): string[] {
  return [...md.matchAll(/^#{1,6} (.+)$/gm)].map((m) => m[1]!.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s/g, '-'));
}

/** A ```sql block of docs/runbooks/secret-rotation.md that starts with `-- <tag>`. */
function runbookSql(tag: string): string {
  const md = readFileSync(join(ROOT, 'docs/runbooks/secret-rotation.md'), 'utf8');
  const block = [...md.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]!).find((x) => x.startsWith(`-- ${tag}`));
  if (!block) throw new Error(`no sql block -- ${tag}`);
  return block;
}

const sourceFiles = (readdirSync(SRC, { recursive: true }) as string[]).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
const sourceText = sourceFiles.map((f) => readFileSync(join(SRC, f), 'utf8')).join('\n');

describe('infra/monitoring/alerts.yaml', () => {
  it('parses into uniquely named alerts with known severity, source type, status and an existing runbook', () => {
    expect(blocks.length).toBeGreaterThan(30);
    const ids = blocks.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const b of blocks) {
      expect(b.id, b.id).toMatch(/^[A-Z][A-Z0-9_]+$/);
      expect(['CRITICAL', 'HIGH', 'MEDIUM', 'from_tier'], b.id).toContain(b.field('severity'));
      expect(['http_check', 'log', 'in_app_alert'], b.id).toContain(b.field('type'));
      expect(['NOT_WIRED', 'IN_APP', 'WIRED'], b.id).toContain(b.field('status'));
      const runbook = b.field('runbook');
      expect(runbook, `${b.id} runbook`).toBeTruthy();
      const [file, anchor] = runbook!.split('#') as [string, string | undefined];
      expect(existsSync(join(ROOT, file)), `${b.id}: ${runbook}`).toBe(true);
      if (anchor) expect(headingSlugs(readFileSync(join(ROOT, file), 'utf8')), `${b.id}: #${anchor}`).toContain(anchor);
      // a fixed severity everywhere except where the in-app tier decides (in-app alerts and their log forwarder)
      if (b.field('type') !== 'in_app_alert' && b.id !== 'IN_APP_ALERT_OPENED') expect(b.field('severity'), b.id).not.toBe('from_tier');
    }
  });

  it('nothing external is marked WIRED (no paging service is connected yet)', () => {
    expect(blocks.filter((b) => b.field('status') === 'WIRED').map((b) => b.id)).toEqual([]);
  });

  it('in-app alerts mirror ALERT_THRESHOLDS exactly (codes and every tier)', () => {
    const inApp = blocks.filter((b) => b.field('type') === 'in_app_alert');
    expect(inApp.map((b) => b.field('code')).sort()).toEqual(Object.keys(ALERT_THRESHOLDS).sort());
    for (const b of inApp) {
      const code = b.field('code') as keyof typeof ALERT_THRESHOLDS;
      const t = ALERT_THRESHOLDS[code] as { medium?: number; high?: number; critical?: number; minSample?: number };
      const line = b.field('thresholds') ?? '';
      const got = Object.fromEntries([...line.matchAll(/(\w+):\s*([\d.]+)/g)].map((m) => [m[1], Number(m[2])]));
      const want: Record<string, number> = {};
      if (t.medium !== undefined) want.medium = t.medium;
      if (t.high !== undefined) want.high = t.high;
      if (t.critical !== undefined) want.critical = t.critical;
      if (t.minSample !== undefined) want.min_sample = t.minSample;
      expect(got, code).toEqual(want);
      expect(b.field('severity'), code).toBe('from_tier');
    }
  });

  it('every log-based alert watches a log message the API actually emits', () => {
    const logAlerts = blocks.filter((b) => b.field('type') === 'log');
    expect(logAlerts.length).toBeGreaterThan(10);
    for (const b of logAlerts) {
      const event = b.field('event')!;
      expect(event, b.id).toBeTruthy();
      expect(sourceText.includes(`'${event}'`), `${b.id}: no logger call emits '${event}'`).toBe(true);
    }
  });

  it('http checks target the public health endpoints only', () => {
    for (const b of blocks.filter((x) => x.field('type') === 'http_check')) {
      expect(['/v1/health', '/v1/health/worker'], b.id).toContain(b.field('path'));
    }
  });
});

describe('ALERT ops.alert_opened log line (hook for external paging)', () => {
  let t: TestContext;
  beforeAll(async () => {
    t = await createTestContext();
  });
  afterAll(async () => {
    await t.close();
  });

  it('is logged once per opening, after COMMIT, with code/severity/value/threshold and at error level for HIGH', async () => {
    const lines: { level: string; msg: string; fields: Record<string, unknown> }[] = [];
    const capture: Logger = {
      debug: () => {},
      info: (msg, fields) => lines.push({ level: 'info', msg, fields: fields ?? {} }),
      warn: (msg, fields) => lines.push({ level: 'warn', msg, fields: fields ?? {} }),
      error: (msg, fields) => lines.push({ level: 'error', msg, fields: fields ?? {} }),
      child: () => capture,
    };
    await t.adminSql`INSERT INTO jobs (queue, name, status, attempts, max_attempts, finished_at, last_error)
                     VALUES ('scheduled', 'test.dead', 'DEAD', 3, 3, now(), 'boom')`;
    const deps = { ...t.deps, logger: capture };
    await evaluateAndPersistAlerts(deps);
    const opened = lines.filter((l) => l.msg === 'ALERT ops.alert_opened');
    const dead = opened.find((l) => l.fields.code === 'JOBS_DEAD');
    expect(dead).toMatchObject({ level: 'error', fields: { code: 'JOBS_DEAD', severity: 'HIGH', value: 1, threshold: 1 } });
    const [row] = await t.adminSql<{ status: string }[]>`SELECT status FROM admin_ops_alerts WHERE code = 'JOBS_DEAD'`;
    expect(row!.status).toBe('OPEN');

    lines.length = 0;
    await evaluateAndPersistAlerts(deps); // still open → not logged again
    expect(lines.filter((l) => l.msg === 'ALERT ops.alert_opened' && l.fields.code === 'JOBS_DEAD')).toHaveLength(0);
  });
});

describe('docs/runbooks/secret-rotation.md SQL blocks run against the real schema', () => {
  let t: TestContext;
  beforeAll(async () => {
    t = await createTestContext();
  });
  afterAll(async () => {
    await t.close();
  });

  it('kid-inventory lists every *_enc column of the schema and reports rows per key id', async () => {
    const encCols = await t.adminSql<{ c: string }[]>`
      SELECT table_name || '.' || column_name AS c FROM information_schema.columns
       WHERE table_schema = 'public' AND data_type = 'bytea' AND column_name LIKE '%\_enc' ORDER BY 1`;
    const sql = runbookSql('kid-inventory');
    for (const { c } of encCols) expect(sql, `kid-inventory misses ${c}`).toContain(`'${c}'`);

    const otp = await t.request('POST', '/v1/auth/otp/request', { body: { channel: 'EMAIL', destination: 'rotasi@example.com', purpose: 'LOGIN', locale: 'id' } });
    expect(otp.status, JSON.stringify(otp.body)).toBeLessThan(300);
    const rows = (await t.adminSql.unsafe(sql)) as unknown as { col: string; kid: string; rows: string }[];
    expect(rows).toContainEqual(expect.objectContaining({ col: 'otp_challenges.destination_enc', kid: t.deps.crypto.activeKeyId }));
  });

  it('revoke-all-sessions logs everybody out (refresh → 401) but keeps the rows (reuse detection)', async () => {
    const u = await t.createUser({ kycLevel: 1 });
    expect((await t.request('POST', '/v1/auth/refresh', { body: { refreshToken: u.refreshToken } })).status).toBe(200);
    const u2 = await t.createUser({ kycLevel: 1 });
    await t.adminSql.unsafe(runbookSql('revoke-all-sessions'));
    expect((await t.request('POST', '/v1/auth/refresh', { body: { refreshToken: u2.refreshToken } })).status).toBe(401);
    const [n] = await t.adminSql<{ n: string }[]>`SELECT count(*) AS n FROM refresh_tokens WHERE user_id = ${u2.id} AND revoked_reason = 'ADMIN'`;
    expect(Number(n!.n)).toBe(1);
  });
});
