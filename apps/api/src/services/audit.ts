import type { Db } from '../db/sql';
import type { ActorType } from '../context';

export interface AuditEntry {
  actorType: ActorType;
  actorId: string | null;
  action: string; // dotted lower-case, e.g. "finance.settlement.change_requested"
  entityType: string;
  entityId: string | null;
  before?: unknown;
  after?: unknown;
  meta?: Record<string, unknown>;
}

/**
 * Appends to the hash-chained audit log. Call it as the LAST statement of a DB transaction
 * (the chain head row is locked until commit). Never pass raw PII in before/after/meta.
 */
export async function audit(db: Db, e: AuditEntry): Promise<void> {
  await db`SELECT jk_audit(${e.actorType}, ${e.actorId}, ${e.action}, ${e.entityType}, ${e.entityId},
    ${e.before === undefined ? null : db.json(e.before as never)}::jsonb,
    ${e.after === undefined ? null : db.json(e.after as never)}::jsonb,
    ${db.json((e.meta ?? {}) as never)}::jsonb)`;
}
