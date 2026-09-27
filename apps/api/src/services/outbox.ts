import type { Db } from '../db/sql';

/**
 * Transactional outbox: write in the SAME DB transaction as the state change. The notification
 * dispatcher (jobs/) publishes at-least-once, so consumers must be idempotent (event_id).
 */
export async function emitEvent(db: Db, aggregateType: string, aggregateId: string, eventType: string, payload: Record<string, unknown>): Promise<void> {
  await db`SELECT jk_outbox(${aggregateType}, ${aggregateId}, ${eventType}, ${db.json(payload as never)}::jsonb)`;
}
