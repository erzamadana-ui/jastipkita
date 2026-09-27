/**
 * Admin · Audit log viewer (audit.read): filter by actor / entity / action / date (keyset on the gapless id), and
 * `verify` running verify_audit_chain() (hash chain + head check; detects tampered, deleted and truncated rows).
 */
import { Errors } from '../../../lib/errors';
import { type AdminCtx, iso } from '../common';

export interface AuditQuery {
  actorId?: string | undefined;
  actorType?: string | undefined;
  entityType?: string | undefined;
  entityId?: string | undefined;
  action?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  limit: number;
  cursor?: string | undefined;
}

export async function listAudit(ctx: AdminCtx, q: AuditQuery) {
  const db = ctx.deps.sql;
  const before = q.cursor ? Number(q.cursor) : null;
  if (q.cursor && (!Number.isSafeInteger(before) || before! <= 0)) throw Errors.badRequest('CURSOR_INVALID', 'Cursor tidak valid');
  const action = q.action?.trim();
  const r = await db<{ id: number; occurred_at: Date; actor_type: string; actor_id: string | null; actor_role: string | null; action: string; entity_type: string; entity_id: string | null; request_id: string | null; before: unknown; after: unknown; meta: unknown; hash: Buffer }[]>`
    SELECT id, occurred_at, actor_type, actor_id, actor_role, action, entity_type, entity_id, request_id, before, after, meta, hash FROM audit_logs
     WHERE true
       ${q.actorId ? db`AND actor_id = ${q.actorId}` : db``}
       ${q.actorType ? db`AND actor_type = ${q.actorType}` : db``}
       ${q.entityType ? db`AND entity_type = ${q.entityType}` : db``}
       ${q.entityId ? db`AND entity_id = ${q.entityId}` : db``}
       ${action ? (action.endsWith('*') ? db`AND action LIKE ${action.slice(0, -1).replace(/[%_]/g, '') + '%'}` : db`AND action = ${action}`) : db``}
       ${q.from ? db`AND occurred_at >= ${new Date(`${q.from}T00:00:00+07:00`)}` : db``}
       ${q.to ? db`AND occurred_at < ${new Date(new Date(`${q.to}T00:00:00+07:00`).getTime() + 86400_000)}` : db``}
       ${before ? db`AND id < ${before}` : db``}
     ORDER BY id DESC LIMIT ${q.limit + 1}`;
  const more = r.length > q.limit;
  const data = r.slice(0, q.limit).map((a) => ({
    id: Number(a.id),
    occurredAt: iso(a.occurred_at)!,
    actorType: a.actor_type,
    actorId: a.actor_id,
    actorRole: a.actor_role,
    action: a.action,
    entityType: a.entity_type,
    entityId: a.entity_id,
    requestId: a.request_id,
    before: a.before,
    after: a.after,
    meta: a.meta,
    hash: Buffer.from(a.hash).toString('hex'),
  }));
  const last = data[data.length - 1];
  return { data, nextCursor: more && last ? String(last.id) : null };
}

export async function verifyAudit(ctx: AdminCtx, q: { fromId?: number | undefined; toId?: number | undefined }) {
  const t0 = Date.now();
  const [r] = await ctx.deps.sql<{ broken: number | null }[]>`SELECT verify_audit_chain(${q.fromId ?? null}::bigint, ${q.toId ?? null}::bigint) AS broken`;
  const [head] = await ctx.deps.sql<{ last_id: number; last_hash: Buffer; updated_at: Date }[]>`SELECT last_id, last_hash, updated_at FROM audit_chain_head WHERE singleton`;
  const [cp] = await ctx.deps.sql<{ last_id: number; created_at: Date; anchored_to: string | null }[]>`
    SELECT last_id, created_at, anchored_to FROM audit_chain_checkpoints ORDER BY id DESC LIMIT 1`;
  const broken = r?.broken === null || r?.broken === undefined ? null : Number(r.broken);
  return {
    status: broken === null ? 'OK' : 'BROKEN',
    brokenAtId: broken,
    range: { fromId: q.fromId ?? null, toId: q.toId ?? null },
    head: head ? { lastId: Number(head.last_id), lastHash: Buffer.from(head.last_hash).toString('hex'), updatedAt: iso(head.updated_at)! } : null,
    lastCheckpoint: cp ? { lastId: Number(cp.last_id), createdAt: iso(cp.created_at)!, anchoredTo: cp.anchored_to } : null,
    checkedAt: ctx.deps.clock.now().toISOString(),
    durationMs: Date.now() - t0,
    note: 'Verifikasi penuh (tanpa rentang) juga mendeteksi ekor yang terpotong lewat audit_chain_head. Checkpoint eksternal (WORM) mendeteksi penulisan ulang seluruh rantai.',
  };
}
