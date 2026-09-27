import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../context';
import { Errors } from '../lib/errors';

/**
 * Fixed-window in-memory limiter (per process / per Worker isolate). It is a first line of defence;
 * abuse-sensitive flows (OTP, login, payment creation) ALSO enforce DB-backed limits in their services
 * so limits hold across isolates. For production at scale, front with Cloudflare Rate Limiting rules.
 */
const buckets = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(opts: { name: string; limit: number; windowSec: number; key?: 'ip' | 'user' | 'ip+user' }): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const now = c.get('deps').clock.now().getTime();
    const ip = c.get('ip') ?? 'unknown';
    const user = c.get('auth')?.userId ?? 'anon';
    const who = opts.key === 'user' ? user : opts.key === 'ip+user' ? `${ip}|${user}` : ip;
    const k = `${opts.name}:${who}`;
    let b = buckets.get(k);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + opts.windowSec * 1000 };
      buckets.set(k, b);
    }
    b.count += 1;
    c.header('x-ratelimit-limit', String(opts.limit));
    c.header('x-ratelimit-remaining', String(Math.max(0, opts.limit - b.count)));
    if (b.count > opts.limit) {
      c.header('retry-after', String(Math.ceil((b.resetAt - now) / 1000)));
      throw Errors.tooMany(undefined, { retryAfterSec: Math.ceil((b.resetAt - now) / 1000) });
    }
    if (buckets.size > 50_000) {
      for (const [key, v] of buckets) if (v.resetAt <= now) buckets.delete(key);
    }
    await next();
  };
}

export function resetRateLimits() {
  buckets.clear();
}
