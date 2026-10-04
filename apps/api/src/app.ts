import { OpenAPIHono } from '@hono/zod-openapi';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { bodyLimit } from 'hono/body-limit';
import type { AppDeps, AppEnv } from './context';
import { Errors } from './lib/errors';
import { assignOperationIds } from './lib/openapi';
import { errorResponse, requestContext } from './middleware/request';
import { registerModules } from './modules';
import { TOKEN_TRANSPORT_HEADER, toOrigin, webCredentialOrigins } from './modules/auth/cookie-transport';

export function createApp(deps: AppDeps) {
  const app = new OpenAPIHono<AppEnv>({
    defaultHook: (result) => {
      if (!result.success) {
        throw Errors.validation({ issues: result.error.issues.map((i) => ({ path: i.path.join('.'), code: i.code, message: i.message })) });
      }
    },
  });

  // Browser Origin headers never contain a path: compare origins, not full base URLs
  // (e.g. WEB_BASE_URL=https://antarkitaindonesia.com/jastipkita → https://antarkitaindonesia.com).
  // Credentialed CORS (the web's HttpOnly refresh cookie, SEC-14) only for the web origins = WEB_BASE_URL + CORS_ORIGINS;
  // the admin origin keeps non-credentialed CORS (bearer tokens only). Never `*`.
  const credentialOrigins = webCredentialOrigins(deps.env);
  const allowed = new Set([...credentialOrigins, toOrigin(deps.env.ADMIN_BASE_URL)]);
  app.use('*', requestContext(deps));
  const baseSecureHeaders = secureHeaders({
    strictTransportSecurity: 'max-age=63072000; includeSubDomains; preload',
    xFrameOptions: 'DENY',
    referrerPolicy: 'no-referrer',
    crossOriginResourcePolicy: 'same-site',
    contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
  });
  // A route that sets its own (stricter) CSP keeps it — SEC-18 file responses add `sandbox` (providers/storage/content-safety.ts).
  app.use('*', async (c, next) => {
    let routeCsp: string | null = null;
    await baseSecureHeaders(c, async () => {
      await next();
      routeCsp = c.res.headers.get('content-security-policy');
    });
    if (routeCsp) c.res.headers.set('content-security-policy', routeCsp);
  });
  const corsBase = {
    allowHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'X-Request-Id', 'X-Device-Id', 'X-App-Version', TOKEN_TRANSPORT_HEADER],
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    exposeHeaders: ['X-Request-Id', 'Retry-After', 'Idempotent-Replayed'],
    maxAge: 600,
  };
  const corsWeb = cors({ ...corsBase, origin: (origin) => (origin && credentialOrigins.has(origin) ? origin : null), credentials: true });
  const corsOther = cors({ ...corsBase, origin: (origin) => (origin && allowed.has(origin) ? origin : null), credentials: false });
  app.use('*', (c, next) => {
    const origin = c.req.header('origin');
    return origin && credentialOrigins.has(origin) ? corsWeb(c, next) : corsOther(c, next);
  });
  // JSON bodies are small; file uploads go directly to object storage via presigned URLs.
  const jsonLimit = bodyLimit({ maxSize: 1024 * 1024, onError: () => { throw Errors.badRequest('PAYLOAD_TOO_LARGE', 'Ukuran permintaan terlalu besar'); } });
  app.use('/v1/*', async (c, next) => {
    // Dev-only object upload (memory storage) enforces its own per-token size limit.
    if (c.req.path.startsWith('/v1/dev/storage/upload/')) return next();
    return jsonLimit(c, next);
  });

  app.onError((err, c) => errorResponse(c, err));
  app.notFound((c) => c.json({ error: { code: 'NOT_FOUND', message: 'Endpoint tidak ditemukan', details: {}, requestId: c.get('requestId') } }, 404));

  app.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' });
  registerModules(app);
  // Every operation gets a stable, unique operationId (clients generate code from it).
  assignOperationIds(app.openAPIRegistry);

  app.doc31('/v1/openapi.json', {
    openapi: '3.1.0',
    info: {
      title: 'JastipKita API',
      version: deps.env.APP_VERSION,
      description:
        'JastipKita — Titip Mudah, Aman, Terpercaya. P2P shopping & traveler marketplace API. Money = integer IDR; timestamps = ISO-8601 UTC. Financial mutations require Idempotency-Key.',
    },
    servers: [{ url: deps.env.API_BASE_URL }],
  });
  return app;
}
