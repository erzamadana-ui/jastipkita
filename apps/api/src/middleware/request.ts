import type { Context, MiddlewareHandler } from 'hono';
import type { AppDeps, AppEnv } from '../context';
import { AppError, fromPgError } from '../lib/errors';
import { randomToken } from '../lib/crypto';

/** Injects deps, request id, client IP; logs one line per request. */
export function requestContext(deps: AppDeps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const incoming = c.req.header('x-request-id');
    const requestId = incoming && /^[A-Za-z0-9._-]{8,64}$/.test(incoming) ? incoming : randomToken(12);
    c.set('requestId', requestId);
    // Cloudflare Workers: the app is built once per isolate; per-request deps (fresh DB client)
    // arrive through the fetch "env" argument as `__deps`. Node passes nothing → static deps.
    const perRequest = (c.env as { __deps?: AppDeps } | undefined)?.__deps;
    c.set('deps', perRequest ?? deps);
    c.set('auth', undefined);
    c.set('ip', clientIp(c.req.header('cf-connecting-ip'), c.req.header('x-forwarded-for'), c.req.header('x-real-ip')));
    const started = Date.now();
    await next();
    c.header('x-request-id', requestId);
    (perRequest ?? deps).logger.info('http.request', {
      requestId,
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      ms: Date.now() - started,
      userId: c.get('auth')?.userId,
    });
  };
}

/**
 * Client IP for rate limits, OTP quotas, signup risk and security events.
 * Cloudflare (Workers, or a Node origin behind Cloudflare) sets CF-Connecting-IP and strips client-supplied copies.
 * Without it, X-Forwarded-For is appended to by every proxy: its LEFT-most entry is whatever the client sent, so
 * only the RIGHT-most entry (written by our own reverse proxy) is trustworthy (SEC-06 — rotating a fake
 * X-Forwarded-For used to bypass every per-IP limit on Node deployments).
 */
export function clientIp(cfConnectingIp: string | undefined, xForwardedFor: string | undefined, xRealIp: string | undefined): string | undefined {
  const clean = (v: string | undefined) => {
    const s = v?.trim();
    return s && s.length <= 64 && /^[0-9A-Fa-f:.]+$/.test(s) ? s : undefined;
  };
  const cf = clean(cfConnectingIp);
  if (cf) return cf;
  const hops = (xForwardedFor ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  return clean(hops[hops.length - 1]) ?? clean(xRealIp);
}

export function errorResponse(c: Context<AppEnv>, err: unknown) {
  const requestId = c.get('requestId');
  const deps = c.get('deps');
  let appErr: AppError;
  if (err instanceof AppError) appErr = err;
  else {
    const mapped = fromPgError(err);
    if (mapped) {
      appErr = mapped;
      // SEC-20: the client gets fixed text; the raw DB rule message is kept for operators only.
      if (/^JK/.test(String((err as { code?: string }).code ?? ''))) {
        const log = mapped.status >= 500 ? deps?.logger.error : deps?.logger.warn;
        log?.call(deps?.logger, 'http.db_rule', { requestId, code: mapped.code, dbMessage: err instanceof Error ? err.message : String(err) });
      }
    } else {
      deps?.logger.error('http.unhandled_error', {
        requestId,
        error: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : String(err),
      });
      appErr = new AppError(500, 'INTERNAL_ERROR', 'Terjadi kesalahan pada server');
    }
  }
  if (appErr.status >= 500 && !(err instanceof AppError)) {
    // already logged
  } else if (appErr.status >= 500) {
    deps?.logger.error('http.app_error', { requestId, code: appErr.code, message: appErr.message });
  }
  return c.json({ error: { code: appErr.code, message: appErr.message, details: appErr.details ?? {}, requestId } }, appErr.status);
}
