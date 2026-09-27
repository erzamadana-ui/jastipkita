/**
 * Admin · Business configuration (versioned, maker-checker):
 *   list keys with the ACTIVE version, history per key, JSON diff between versions, propose (validated with core
 *   validateBusinessConfig; stored PENDING_APPROVAL with change_reason + is_assumption), approve by a DIFFERENT admin
 *   with fresh MFA (DB activate_business_config: previous ACTIVE → SUPERSEDED, audit, outbox config.activated) and
 *   deps.config.invalidate(); reject.
 */
import { BUSINESS_CONFIG_KEYS, BUSINESS_CONFIG_META, type BusinessConfigKey, isBusinessConfigKey, validateBusinessConfig } from '@jastipkita/core';
import { Errors } from '../../../lib/errors';
import { type AdminCtx, adminAudit, inAdminTx, iso, makerChecker } from '../common';

interface ConfigRow {
  id: string;
  key: string;
  version: number;
  value: unknown;
  status: string;
  effective_from: Date;
  change_reason: string;
  is_assumption: boolean;
  notes: string | null;
  created_by: string | null;
  approved_by: string | null;
  approved_at: Date | null;
  rejected_reason: string | null;
  superseded_at: Date | null;
  created_at: Date;
}

function versionDto(r: ConfigRow) {
  return {
    id: r.id,
    key: r.key,
    version: r.version,
    value: r.value,
    status: r.status,
    effectiveFrom: iso(r.effective_from)!,
    changeReason: r.change_reason,
    isAssumption: r.is_assumption,
    notes: r.notes,
    createdBy: r.created_by,
    approvedBy: r.approved_by,
    approvedAt: iso(r.approved_at),
    rejectedReason: r.rejected_reason,
    supersededAt: iso(r.superseded_at),
    createdAt: iso(r.created_at)!,
  };
}

function assertKey(key: string): BusinessConfigKey {
  if (!isBusinessConfigKey(key)) throw Errors.notFound('Config key', 'CONFIG_KEY_UNKNOWN');
  return key;
}

export async function listConfigs(ctx: AdminCtx) {
  const rowsRaw = await ctx.deps.sql<(ConfigRow & { pending: number; latest: number })[]>`
    SELECT c.*, (SELECT count(*) FROM business_configs p WHERE p.key = c.key AND p.status = 'PENDING_APPROVAL')::int AS pending,
           (SELECT max(version) FROM business_configs p WHERE p.key = c.key)::int AS latest
      FROM business_configs c WHERE c.status = 'ACTIVE' ORDER BY c.key`;
  const byKey = new Map(rowsRaw.map((r) => [r.key, r]));
  const pendingOnly = await ctx.deps.sql<{ key: string; n: number }[]>`
    SELECT key, count(*)::int AS n FROM business_configs WHERE status = 'PENDING_APPROVAL' GROUP BY key`;
  return {
    data: BUSINESS_CONFIG_KEYS.map((key) => {
      const a = byKey.get(key);
      return {
        key,
        active: a ? versionDto(a) : null,
        latestVersion: a?.latest ?? null,
        pendingApprovals: a?.pending ?? pendingOnly.find((p) => p.key === key)?.n ?? 0,
        isAssumption: a?.is_assumption ?? false,
      };
    }),
    assumptions: [...BUSINESS_CONFIG_META.assumptions],
  };
}

export async function configDetail(ctx: AdminCtx, keyRaw: string) {
  const key = assertKey(keyRaw);
  const history = await ctx.deps.sql<ConfigRow[]>`SELECT * FROM business_configs WHERE key = ${key} ORDER BY version DESC`;
  const active = history.find((h) => h.status === 'ACTIVE') ?? null;
  return {
    key,
    active: active ? versionDto(active) : null,
    history: history.map((h) => ({ ...versionDto(h), diffFromActive: active && h.id !== active.id ? jsonDiff(active.value, h.value) : [] })),
  };
}

export interface DiffEntry {
  path: string;
  op: 'added' | 'removed' | 'changed';
  before?: unknown;
  after?: unknown;
}

/** Structural JSON diff (objects by key, arrays by index). */
export function jsonDiff(before: unknown, after: unknown, path = ''): DiffEntry[] {
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  if (Array.isArray(before) && Array.isArray(after)) {
    const out: DiffEntry[] = [];
    const n = Math.max(before.length, after.length);
    for (let i = 0; i < n; i++) {
      const p = `${path}[${i}]`;
      if (i >= before.length) out.push({ path: p, op: 'added', after: after[i] });
      else if (i >= after.length) out.push({ path: p, op: 'removed', before: before[i] });
      else out.push(...jsonDiff(before[i], after[i], p));
    }
    return out;
  }
  if (isObj(before) && isObj(after)) {
    const out: DiffEntry[] = [];
    for (const k of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
      const p = path ? `${path}.${k}` : k;
      if (!(k in before)) out.push({ path: p, op: 'added', after: after[k] });
      else if (!(k in after)) out.push({ path: p, op: 'removed', before: before[k] });
      else out.push(...jsonDiff(before[k], after[k], p));
    }
    return out;
  }
  return JSON.stringify(before) === JSON.stringify(after) ? [] : [{ path: path || '$', op: 'changed', before, after }];
}

export async function configDiff(ctx: AdminCtx, keyRaw: string, version: number, against?: number) {
  const key = assertKey(keyRaw);
  const rowsRaw = await ctx.deps.sql<ConfigRow[]>`SELECT * FROM business_configs WHERE key = ${key}`;
  const target = rowsRaw.find((r) => r.version === version);
  if (!target) throw Errors.notFound('Versi config', 'CONFIG_VERSION_NOT_FOUND');
  const base = against !== undefined ? rowsRaw.find((r) => r.version === against) : rowsRaw.find((r) => r.status === 'ACTIVE');
  if (!base) throw Errors.notFound('Versi pembanding', 'CONFIG_VERSION_NOT_FOUND');
  return { key, from: { version: base.version, status: base.status }, to: { version: target.version, status: target.status }, changes: jsonDiff(base.value, target.value) };
}

export async function proposeConfig(ctx: AdminCtx, keyRaw: string, input: { value: unknown; changeReason: string; isAssumption: boolean; notes?: string | undefined }) {
  const key = assertKey(keyRaw);
  const v = validateBusinessConfig(key, input.value);
  if (!v.ok) throw Errors.unprocessable('CONFIG_INVALID', 'Nilai konfigurasi tidak valid', { errors: v.errors });
  const out = await inAdminTx(ctx, async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'business_configs:' + key}, 0))`;
    const [pending] = await tx<{ id: string; version: number }[]>`SELECT id, version FROM business_configs WHERE key = ${key} AND status = 'PENDING_APPROVAL'`;
    if (pending) throw Errors.conflict('CONFIG_PROPOSAL_PENDING', `Versi ${pending.version} masih menunggu persetujuan`, { id: pending.id });
    const [active] = await tx<ConfigRow[]>`SELECT * FROM business_configs WHERE key = ${key} AND status = 'ACTIVE'`;
    const changes = active ? jsonDiff(active.value, input.value) : [];
    if (active && changes.length === 0) throw Errors.unprocessable('CONFIG_NO_CHANGE', 'Nilai sama dengan versi ACTIVE');
    const [mx] = await tx<{ v: number }[]>`SELECT coalesce(max(version), 0)::int AS v FROM business_configs WHERE key = ${key}`;
    const [row] = await tx<ConfigRow[]>`
      INSERT INTO business_configs (key, version, value, status, change_reason, is_assumption, notes, created_by, effective_from)
      VALUES (${key}, ${(mx?.v ?? 0) + 1}, ${tx.json(input.value as never)}, 'PENDING_APPROVAL', ${input.changeReason}, ${input.isAssumption},
              ${input.notes ?? null}, ${ctx.auth.userId}, ${ctx.deps.clock.now()})
      RETURNING *`;
    await adminAudit(tx, ctx, {
      action: 'config.proposed',
      entityType: 'business_config',
      entityId: key,
      before: active ? { version: active.version } : null,
      after: { version: row!.version, status: 'PENDING_APPROVAL' },
      meta: { configId: row!.id, changes, changeReason: input.changeReason, isAssumption: input.isAssumption },
    });
    return { row: row!, changes };
  });
  return { ...versionDto(out.row), diffFromActive: out.changes };
}

export async function approveConfig(ctx: AdminCtx, id: string) {
  const out = await inAdminTx(ctx, async (tx) => {
    const [row] = await tx<ConfigRow[]>`SELECT * FROM business_configs WHERE id = ${id} FOR UPDATE`;
    if (!row) throw Errors.notFound('Versi config', 'CONFIG_VERSION_NOT_FOUND');
    makerChecker(row.created_by, ctx.auth.userId, 'Konfigurasi harus disetujui oleh admin yang berbeda dari pengusul (maker-checker)');
    if (row.status !== 'PENDING_APPROVAL') throw Errors.unprocessable('CONFIG_NOT_PENDING', 'Versi ini tidak menunggu persetujuan', { status: row.status });
    const v = validateBusinessConfig(assertKey(row.key), row.value);
    if (!v.ok) throw Errors.unprocessable('CONFIG_INVALID', 'Nilai konfigurasi tidak valid (validator berubah?)', { errors: v.errors });
    const [act] = await tx<ConfigRow[]>`SELECT * FROM activate_business_config(${id}, ${ctx.auth.userId})`;
    await adminAudit(tx, ctx, { action: 'config.approved', entityType: 'business_config', entityId: row.key, after: { version: row.version, status: 'ACTIVE' }, meta: { configId: id, makerId: row.created_by } });
    return act!;
  });
  ctx.deps.config.invalidate();
  return versionDto(out);
}

export async function rejectConfig(ctx: AdminCtx, id: string, reason: string) {
  const out = await inAdminTx(ctx, async (tx) => {
    const [row] = await tx<ConfigRow[]>`SELECT * FROM business_configs WHERE id = ${id} FOR UPDATE`;
    if (!row) throw Errors.notFound('Versi config', 'CONFIG_VERSION_NOT_FOUND');
    if (row.status !== 'PENDING_APPROVAL') throw Errors.unprocessable('CONFIG_NOT_PENDING', 'Versi ini tidak menunggu persetujuan', { status: row.status });
    const [r] = await tx<ConfigRow[]>`UPDATE business_configs SET status = 'REJECTED', rejected_reason = ${reason} WHERE id = ${id} RETURNING *`;
    await adminAudit(tx, ctx, { action: 'config.rejected', entityType: 'business_config', entityId: row.key, before: { version: row.version, status: 'PENDING_APPROVAL' }, after: { status: 'REJECTED' }, meta: { configId: id, reason } });
    return r!;
  });
  return versionDto(out);
}
