import type { Db, TxSql } from '../../db/sql';
import type { Cursor } from '../../lib/pagination';

export interface NotificationRow {
  id: string;
  event_type: string;
  category: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  read_at: Date | null;
  created_at: Date;
}

export function listInbox(db: Db, userId: string, opts: { now: Date; unreadOnly: boolean; cursor: Cursor | null; limit: number }) {
  return db<NotificationRow[]>`
    SELECT id, event_type, category, title, body, data, read_at, created_at FROM notifications
     WHERE user_id = ${userId} AND in_app
       AND (expires_at IS NULL OR expires_at > ${opts.now})
       ${opts.unreadOnly ? db`AND read_at IS NULL` : db``}
       ${opts.cursor ? db`AND (created_at, id) < (${new Date(opts.cursor.t)}, ${opts.cursor.id}::uuid)` : db``}
     ORDER BY created_at DESC, id DESC
     LIMIT ${opts.limit}`;
}

export async function countUnread(db: Db, userId: string, now: Date): Promise<number> {
  const [r] = await db<{ n: number }[]>`
    SELECT count(*)::int AS n FROM notifications
     WHERE user_id = ${userId} AND in_app AND read_at IS NULL AND (expires_at IS NULL OR expires_at > ${now})`;
  return r?.n ?? 0;
}

export async function markRead(db: Db, userId: string, id: string, now: Date) {
  const [r] = await db<{ id: string; read_at: Date }[]>`
    UPDATE notifications SET read_at = coalesce(read_at, ${now}) WHERE id = ${id} AND user_id = ${userId} RETURNING id, read_at`;
  return r ?? null;
}

export async function markAllRead(db: Db, userId: string, now: Date): Promise<number> {
  const r = await db`UPDATE notifications SET read_at = ${now} WHERE user_id = ${userId} AND in_app AND read_at IS NULL`;
  return r.count;
}

export function preferenceRows(db: Db, userId: string) {
  return db<{ category: string; channel: string; enabled: boolean }[]>`
    SELECT category, channel, enabled FROM notification_preferences WHERE user_id = ${userId}`;
}

export async function upsertPreference(tx: TxSql, userId: string, group: string, channel: string, enabled: boolean) {
  await tx`
    INSERT INTO notification_preferences (user_id, category, channel, enabled)
    VALUES (${userId}, ${group}, ${channel}, ${enabled})
    ON CONFLICT (user_id, category, channel) DO UPDATE SET enabled = EXCLUDED.enabled`;
}

export async function userLocale(db: Db, userId: string): Promise<'id' | 'en'> {
  const [u] = await db<{ locale: string }[]>`SELECT locale FROM users WHERE id = ${userId}`;
  return u?.locale === 'en' ? 'en' : 'id';
}
