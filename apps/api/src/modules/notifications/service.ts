import type { AppDeps, AuthContext } from '../../context';
import type { TxSql } from '../../db/sql';
import { Errors } from '../../lib/errors';
import { decodeCursor, encodeCursor } from '../../lib/pagination';
import { isLocked, preferenceMatrix } from './preferences';
import * as repo from './repository';
import type { Channel, PrefGroup } from './templates/types';

const toDto = (r: repo.NotificationRow) => ({
  id: r.id,
  type: r.event_type,
  category: r.category,
  title: r.title,
  body: r.body,
  data: r.data ?? {},
  readAt: r.read_at?.toISOString() ?? null,
  createdAt: r.created_at.toISOString(),
});

export async function listNotifications(deps: AppDeps, auth: AuthContext, q: { limit: number; cursor?: string | undefined; unreadOnly?: string | undefined }) {
  const cursor = decodeCursor(q.cursor);
  if (q.cursor && (!cursor || Number.isNaN(Date.parse(cursor.t)) || !/^[0-9a-f-]{36}$/i.test(cursor.id))) {
    throw Errors.badRequest('CURSOR_INVALID', 'Cursor tidak valid');
  }
  const rows = await repo.listInbox(deps.sql, auth.userId, { now: deps.clock.now(), unreadOnly: q.unreadOnly === 'true', cursor, limit: q.limit + 1 });
  const has = rows.length > q.limit;
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return { data: page.map(toDto), nextCursor: has && last ? encodeCursor({ t: last.created_at.toISOString(), id: last.id }) : null };
}

export async function unreadCount(deps: AppDeps, auth: AuthContext) {
  return { count: await repo.countUnread(deps.sql, auth.userId, deps.clock.now()) };
}

export async function markRead(deps: AppDeps, auth: AuthContext, id: string) {
  const r = await repo.markRead(deps.sql, auth.userId, id, deps.clock.now());
  if (!r) throw Errors.notFound('Notifikasi', 'NOTIFICATION_NOT_FOUND');
  return { id: r.id, readAt: r.read_at.toISOString() };
}

export async function markAllRead(deps: AppDeps, auth: AuthContext) {
  return { updated: await repo.markAllRead(deps.sql, auth.userId, deps.clock.now()) };
}

const CRITICAL_NOTICE = {
  id: 'E-mail & notifikasi penting (pembayaran aman, refund, pencairan, dispute, perubahan harga) tetap dikirim demi keamanan dana kamu.',
  en: 'Critical e-mails & notifications (payment secured, refunds, payouts, disputes, price changes) are always sent to protect your money.',
};

export async function getPreferences(deps: AppDeps, auth: AuthContext) {
  const rows = await repo.preferenceRows(deps.sql, auth.userId);
  const loc = await repo.userLocale(deps.sql, auth.userId);
  return { groups: preferenceMatrix(rows, loc), criticalNotice: CRITICAL_NOTICE[loc] };
}

export async function updatePreferences(deps: AppDeps, auth: AuthContext, prefs: { group: PrefGroup; channel: Channel; enabled: boolean }[]) {
  const locked = prefs.filter((p) => !p.enabled && isLocked(p.group, p.channel));
  if (locked.length) {
    throw Errors.unprocessable('PREFERENCE_LOCKED', 'Notifikasi penting ini tidak bisa dimatikan', {
      locked: locked.map((p) => ({ group: p.group, channel: p.channel })),
    });
  }
  await deps.sql.begin(async (t) => {
    for (const p of prefs) await repo.upsertPreference(t as unknown as TxSql, auth.userId, p.group, p.channel, p.enabled);
  });
  return getPreferences(deps, auth);
}
