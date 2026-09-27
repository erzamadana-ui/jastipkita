import { z } from '@hono/zod-openapi';

export const RiskLevel = z.enum(['LOW', 'MEDIUM', 'HIGH']);

export const CountrySchema = z
  .object({
    code: z.string().openapi({ example: 'JP' }),
    nameId: z.string().openapi({ example: 'Jepang' }),
    nameEn: z.string().openapi({ example: 'Japan' }),
    currencyCode: z.string().openapi({ example: 'JPY' }),
    isOrigin: z.boolean(),
    isDestination: z.boolean(),
    activation: z.enum(['ACTIVE', 'SOFT_LAUNCH', 'INACTIVE']),
    riskLevel: RiskLevel,
    slug: z.string(),
    sortOrder: z.number().int(),
  })
  .openapi('Country');

export const CountryListSchema = z.object({ data: z.array(CountrySchema) }).openapi('CountryList');

export const CountryQuery = z.object({
  role: z.enum(['origin', 'destination']).optional().openapi({ description: 'Filter: origin (merchant/trip departure) or destination' }),
});

export const CategorySchema = z
  .object({
    code: z.string().openapi({ example: 'COSMETICS_SKINCARE' }),
    parentCode: z.string().nullable(),
    nameId: z.string(),
    nameEn: z.string(),
    riskLevel: RiskLevel,
    requiresSerial: z.boolean(),
    requiresVideo: z.boolean(),
    defaultWeightKg: z.number().nullable(),
    defaultHsCode: z.string().nullable(),
    sortOrder: z.number().int(),
  })
  .openapi('ProductCategory');

export const CategoryListSchema = z.object({ data: z.array(CategorySchema) }).openapi('ProductCategoryList');

export const CurrencySchema = z
  .object({
    code: z.string().openapi({ example: 'JPY' }),
    minorUnits: z.number().int().openapi({ example: 0 }),
    name: z.string(),
    symbol: z.string(),
    ecbReference: z.boolean().openapi({ description: 'Quotable by the ECB/Frankfurter FX provider' }),
  })
  .openapi('Currency');

export const CurrencyListSchema = z.object({ data: z.array(CurrencySchema) }).openapi('CurrencyList');
