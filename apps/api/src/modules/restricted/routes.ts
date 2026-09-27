import { createRoute } from '@hono/zod-openapi';
import type { App } from '../../context';
import { createRouter, errorResponses, jsonBody, jsonContent } from '../../lib/openapi';
import { rateLimit } from '../../middleware/rate-limit';
import { RestrictedCheckBody, RestrictedCheckResponse } from './schemas';
import * as svc from './service';

export function localeFrom(explicit: 'id' | 'en' | undefined, acceptLanguage: string | undefined): svc.Locale {
  if (explicit) return explicit;
  return acceptLanguage && /^\s*en\b/i.test(acceptLanguage) ? 'en' : 'id';
}

export function registerRestricted(app: App): void {
  const r = createRouter();
  r.openapi(
    createRoute({
      method: 'post',
      path: '/v1/restricted/check',
      tags: ['Restricted items'],
      summary: 'Classify an item (ALLOWED … PROHIBITED) with ID/EN messages',
      middleware: [rateLimit({ name: 'restricted.check', limit: 60, windowSec: 60 })] as const,
      request: jsonBody(RestrictedCheckBody),
      responses: { 200: jsonContent(RestrictedCheckResponse), 400: errorResponses[400], 422: errorResponses[422], 429: errorResponses[429] },
    }),
    async (c) => {
      const deps = c.get('deps');
      const b = c.req.valid('json');
      const locale = localeFrom(b.locale, c.req.header('accept-language'));
      const out = await svc.publicCheck(
        deps.sql,
        deps,
        {
          originCountry: b.originCountry,
          destinationCountry: b.destinationCountry,
          categoryCode: b.categoryCode,
          hsCode: b.hsCode ?? null,
          productName: b.productName,
          quantity: b.quantity,
          valueUsd: b.valueUsd ?? null,
          unitPriceMinor: b.unitPriceMinor ?? null,
          currency: b.currency ?? null,
        },
        locale,
      );
      return c.json(out, 200);
    },
  );
  app.route('/', r);
}
