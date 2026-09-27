import { OpenAPIHono } from '@hono/zod-openapi';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { bodyLimit } from 'hono/body-limit';
import type { AppDeps, AppEnv } from './context';
import { Errors } from './lib/errors';
import { assignOperationIds } from './lib/openapi';
import { errorResponse, requestContext } from './middleware/request';
import { registerModules } from './modules';

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
  const toOrigin = (u: string) => {
    try {
      return new URL(u).origin;
    } catch {
      return u;
    }
  };
  const allowed = new Set([deps.env.WEB_BASE_URL, deps.env.ADMIN_BASE_URL, ...deps.env.CORS_ORIGINS].map(toOrigin));
  app.use('*', requestContext(deps));
  app.use(
    '*',
    secureHeaders({
      strictTransportSecurity: 'max-age=63072000; includeSubDomains; preload',
      xFrameOptions: 'DENY',
      referrerPolicy: 'no-referrer',
      crossOriginResourcePolicy: 'same-site',
      contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
    }),
  );
  app.use(
    '*',
    cors({
      origin: (origin) => (origin && allowed.has(origin) ? origin : null),
      allowHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'X-Request-Id', 'X-Device-Id', 'X-App-Version'],
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      exposeHeaders: ['X-Request-Id', 'Retry-After', 'Idempotent-Replayed'],
      credentials: false,
      maxAge: 600,
    }),
  );
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
