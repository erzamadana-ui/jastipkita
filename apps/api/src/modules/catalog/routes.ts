import { createRoute } from '@hono/zod-openapi';
import type { App } from '../../context';
import { createRouter, errorResponses, jsonContent } from '../../lib/openapi';
import { CategoryListSchema, CountryListSchema, CountryQuery, CurrencyListSchema } from './schemas';
import * as svc from './service';

/** Reference data changes rarely (seed/admin); let CDNs and apps cache it. */
export const CATALOG_CACHE_CONTROL = 'public, max-age=300, stale-while-revalidate=3600';

export function registerCatalog(app: App): void {
  const r = createRouter();

  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/catalog/countries',
      tags: ['Catalog'],
      summary: 'Supported countries (origins: SOFT_LAUNCH/ACTIVE; destinations: ACTIVE)',
      request: { query: CountryQuery },
      responses: { 200: jsonContent(CountryListSchema), 400: errorResponses[400] },
    }),
    async (c) => {
      const { role } = c.req.valid('query');
      const data = await svc.listCountries(c.get('deps').sql, role);
      c.header('cache-control', CATALOG_CACHE_CONTROL);
      return c.json({ data }, 200);
    },
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/catalog/categories',
      tags: ['Catalog'],
      summary: 'Active product categories (risk level, serial/video requirements, default weight & HS code)',
      responses: { 200: jsonContent(CategoryListSchema) },
    }),
    async (c) => {
      const data = await svc.listCategories(c.get('deps').sql);
      c.header('cache-control', CATALOG_CACHE_CONTROL);
      return c.json({ data }, 200);
    },
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/v1/catalog/currencies',
      tags: ['Catalog'],
      summary: 'Active currencies with minor units and FX-provider coverage',
      responses: { 200: jsonContent(CurrencyListSchema) },
    }),
    async (c) => {
      const data = await svc.listCurrencies(c.get('deps').sql);
      c.header('cache-control', CATALOG_CACHE_CONTROL);
      return c.json({ data }, 200);
    },
  );

  app.route('/', r);
}
