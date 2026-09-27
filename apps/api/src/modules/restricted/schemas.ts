import { z } from '@hono/zod-openapi';

const Country = z
  .string()
  .regex(/^[A-Za-z]{2}$/)
  .transform((s) => s.toUpperCase());

export const Classification = z.enum(['ALLOWED', 'RESTRICTED', 'DECLARATION_REQUIRED', 'PERMIT_REQUIRED', 'PROHIBITED']);

export const RestrictedCheckBody = z
  .object({
    originCountry: Country.openapi({ example: 'JP' }),
    destinationCountry: Country.default('ID'),
    categoryCode: z.string().regex(/^[A-Z][A-Z0-9_]*$/).openapi({ example: 'BATTERIES_POWERBANK' }),
    hsCode: z.string().regex(/^[0-9.]{2,14}$/).nullable().optional(),
    productName: z.string().trim().min(2).max(300).openapi({ example: 'Anker Power Bank 20000mAh' }),
    quantity: z.number().int().min(1).max(999).default(1),
    unitPriceMinor: z.number().int().min(0).max(1e13).optional().openapi({ description: 'Enables value-based limits (converted to USD at spot)' }),
    currency: z
      .string()
      .regex(/^[A-Za-z]{3}$/)
      .transform((s) => s.toUpperCase())
      .optional(),
    valueUsd: z.string().regex(/^\d{1,10}(\.\d{1,2})?$/).optional().openapi({ description: 'Total value in USD (overrides unitPriceMinor)' }),
    locale: z.enum(['id', 'en']).optional(),
  })
  .openapi('RestrictedCheckRequest');

export const RestrictedCheckResponse = z
  .object({
    classification: Classification,
    blocksCheckout: z.boolean().openapi({ description: 'PROHIBITED blocks checkout (§7)' }),
    requiresAcknowledgement: z.boolean().openapi({ description: 'Non-ALLOWED, non-PROHIBITED items need buyer acknowledgement before payment' }),
    locale: z.enum(['id', 'en']),
    messages: z.array(z.string()),
    permitAuthorities: z.array(z.string()),
    airlineDg: z.boolean(),
    matches: z.array(
      z.object({
        code: z.string(),
        version: z.number().int(),
        classification: Classification,
        ruleClassification: Classification,
        matchedOn: z.array(z.string()),
        matchedKeyword: z.string().nullable(),
        limitExceeded: z.object({ kind: z.enum(['QUANTITY', 'VALUE_USD']), limit: z.string(), actual: z.string() }).nullable(),
        valueCheckSkipped: z.boolean(),
        message: z.string(),
        permitAuthority: z.string().nullable(),
        airlineDg: z.boolean(),
        sourceReference: z.string(),
      }),
    ),
    ruleRef: z.string().nullable(),
    valueUsd: z.string().nullable(),
    disclaimer: z.string(),
  })
  .openapi('RestrictedCheckResult');
