import type { AppDeps, AuthContext } from '../../context';
import { Errors } from '../../lib/errors';
import { isAllowedEvent, sanitizeProperties } from './sanitize';

/** Client clocks drift: accept events up to 30 days old and 10 minutes in the future. */
export const MAX_EVENT_AGE_MS = 30 * 86400_000;
export const MAX_EVENT_SKEW_MS = 10 * 60_000;

export interface IngestInput {
  anonymousId?: string | undefined;
  sessionId?: string | undefined;
  platform: 'IOS' | 'ANDROID' | 'WEB';
  appVersion?: string | undefined;
  events: { name: string; occurredAt?: string | undefined; eventId?: string | undefined; properties?: Record<string, unknown> | undefined }[];
}

export async function ingest(deps: AppDeps, auth: AuthContext | undefined, input: IngestInput) {
  const userId = auth?.userId ?? null;
  if (!userId && !input.anonymousId) throw Errors.validation({ issues: [{ path: 'anonymousId', message: 'anonymousId wajib untuk event tanpa login' }] });
  const now = deps.clock.now();
  const rejected: { index: number; reason: string }[] = [];
  const dropped: { index: number; keys: string[] }[] = [];
  const rows: Record<string, unknown>[] = [];
  const identity = userId ?? `anon:${input.anonymousId}`;
  input.events.forEach((e, index) => {
    if (!isAllowedEvent(e.name)) return rejected.push({ index, reason: 'EVENT_NOT_ALLOWED' });
    const at = e.occurredAt ? new Date(e.occurredAt) : now;
    if (Number.isNaN(at.getTime()) || at.getTime() < now.getTime() - MAX_EVENT_AGE_MS || at.getTime() > now.getTime() + MAX_EVENT_SKEW_MS) {
      return rejected.push({ index, reason: 'OCCURRED_AT_OUT_OF_RANGE' });
    }
    const s = sanitizeProperties(e.properties ?? {});
    if (s.dropped.length) dropped.push({ index, keys: s.dropped });
    rows.push({
      event_name: e.name,
      user_id: userId,
      anonymous_id: input.anonymousId ?? null,
      session_id: input.sessionId ?? null,
      platform: input.platform,
      app_version: input.appVersion ?? null,
      properties: s.properties,
      occurred_at: at,
      received_at: now,
      dedupe_key: e.eventId ? `c:${identity}:${e.eventId}`.slice(0, 200) : null,
    });
    return undefined;
  });
  let inserted = 0;
  if (rows.length) {
    const { sql } = deps;
    const res = await sql`
      INSERT INTO analytics_events (event_name, user_id, anonymous_id, session_id, platform, app_version, properties, occurred_at, received_at, dedupe_key)
      SELECT x.event_name, x.user_id::uuid, x.anonymous_id, x.session_id, x.platform, x.app_version, x.properties, x.occurred_at::timestamptz, x.received_at::timestamptz, x.dedupe_key
        FROM jsonb_to_recordset(${sql.json(rows.map((r) => ({ ...r, occurred_at: (r.occurred_at as Date).toISOString(), received_at: (r.received_at as Date).toISOString() })) as never)}::jsonb)
          AS x(event_name text, user_id text, anonymous_id text, session_id text, platform text, app_version text, properties jsonb, occurred_at text, received_at text, dedupe_key text)
      ON CONFLICT DO NOTHING`;
    inserted = res.count;
  }
  return { accepted: inserted, duplicates: rows.length - inserted, rejected, droppedProperties: dropped };
}
