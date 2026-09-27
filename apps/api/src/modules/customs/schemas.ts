import { z } from '@hono/zod-openapi';

const Country = z
  .string()
  .regex(/^[A-Za-z]{2}$/)
  .transform((s) => s.toUpperCase());
const Ccy = z
  .string()
  .regex(/^[A-Za-z]{3}$/)
  .transform((s) => s.toUpperCase());

export const CustomsEstimateBody = z
  .object({
    originCountry: Country.openapi({ example: 'JP' }),
    destinationCountry: Country.default('ID').openapi({ example: 'ID' }),
    categoryCode: z.string().regex(/^[A-Z][A-Z0-9_]*$/).openapi({ example: 'TOYS_HOBBIES' }),
    hsCode: z.string().regex(/^[0-9.]{2,14}$/).nullable().optional().openapi({ example: '9503.00' }),
    unitPriceMinor: z.number().int().min(0).max(1e13).openapi({ description: 'Unit price in minor units of `currency`', example: 50000 }),
    currency: Ccy.openapi({ example: 'JPY' }),
    quantity: z.number().int().min(1).max(999).default(1),
    treatment: z.enum(['PERSONAL', 'NON_PERSONAL']).optional().openapi({ description: 'Default NON_PERSONAL (jastip)' }),
    hasNpwp: z.boolean().optional().openapi({ description: 'Traveler (importer) has an NPWP; default false' }),
  })
  .openapi('CustomsEstimateRequest');

const Step = z.object({ label: z.string(), formula: z.string(), amount: z.number().int() });
const Warning = z.object({ code: z.string(), message: z.string() });

export const CustomsEstimateSchema = z
  .object({
    ruleId: z.string().nullable(),
    ruleCode: z.string().nullable(),
    ruleVersion: z.number().int().nullable(),
    ruleRef: z.string().nullable(),
    formulaCode: z.string().nullable(),
    treatment: z.enum(['PERSONAL', 'NON_PERSONAL']),
    hsCodeUsed: z.string().nullable(),
    customsValueIdr: z.number().int(),
    exemptionAppliedIdr: z.number().int(),
    taxableValueIdr: z.number().int(),
    dutyIdr: z.number().int(),
    vatIdr: z.number().int(),
    luxuryTaxIdr: z.number().int(),
    incomeTaxIdr: z.number().int(),
    importTaxIdr: z.number().int(),
    totalIdr: z.number().int(),
    isEstimate: z.literal(true),
    breakdownSteps: z.array(Step),
    sourceReference: z.string().nullable(),
    sourceUrl: z.string().nullable(),
    lastVerifiedAt: z.string().nullable().openapi({ description: 'YYYY-MM-DD' }),
    warnings: z.array(Warning),
  })
  .openapi('CustomsEstimate');

export const CustomsEstimateResponse = z
  .object({
    isEstimate: z.literal(true),
    treatment: z.enum(['PERSONAL', 'NON_PERSONAL']),
    treatmentExplanation: z.string(),
    estimate: CustomsEstimateSchema,
    personalComparison: CustomsEstimateSchema.extend({ note: z.string() }).nullable(),
    fx: z.object({
      itemToIdr: z.string().nullable(),
      usdToIdr: z.string().nullable(),
      asOf: z.string().nullable(),
      source: z.string().nullable(),
      note: z.string(),
    }),
    disclaimer: z.string(),
  })
  .openapi('CustomsEstimateResult');
