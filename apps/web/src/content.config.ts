import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

/**
 * Legal documents are authored as Markdown in the repo-level docs/legal/ folder (single source of truth,
 * reviewed by counsel there) and rendered at build time. `base` is relative to the Astro project root
 * (apps/web), so this works in CI as long as the whole monorepo is checked out.
 */
const legal = defineCollection({
  loader: glob({ pattern: ['*.md', '!README.md'], base: '../../docs/legal' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    version: z.string(),
    effectiveDate: z.string(),
    order: z.number(),
  }),
});

export const collections = { legal };
