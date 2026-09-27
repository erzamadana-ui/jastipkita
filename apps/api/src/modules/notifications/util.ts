/** Small helpers shared by the engagement modules (payload parsing, handler composition). */
import type { AppDeps } from '../../context';
import type { OutboxEvent, OutboxHandler } from '../../jobs/types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

/** uuid field from an outbox payload (undefined when absent/invalid). */
export function pid(p: Record<string, unknown>, key: string): string | undefined {
  const v = p[key];
  return isUuid(v) ? v : undefined;
}

export function pstr(p: Record<string, unknown>, key: string): string | undefined {
  const v = p[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export function pnum(p: Record<string, unknown>, key: string): number | undefined {
  const v = p[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

export type EventPart = (deps: AppDeps, event: OutboxEvent) => Promise<void>;

/**
 * Runs every part even when one fails, then rethrows (the runner retries the event; all parts are
 * idempotent). Keeps one failing concern (e.g. a provider outage) from starving the others.
 */
export function composeHandler(name: string, parts: EventPart[]): OutboxHandler {
  return async (deps, event) => {
    const errors: string[] = [];
    for (const part of parts) {
      try {
        await part(deps, event);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${part.name || 'part'}: ${msg}`);
        deps.logger.error('engagement.handler_failed', { handler: name, eventType: event.eventType, eventId: event.eventId, error: msg.slice(0, 500) });
      }
    }
    if (errors.length) throw new Error(`[${name}] ${errors.join(' | ').slice(0, 1800)}`);
  };
}
