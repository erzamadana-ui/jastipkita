import { z } from '@hono/zod-openapi';
import { base64UrlDecode, base64UrlEncode } from './crypto';

export const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20).openapi({ example: 20 }),
  cursor: z.string().max(500).optional().openapi({ description: 'Opaque cursor from previous page' }),
});
export type PageQuery = z.infer<typeof PageQuery>;

/** Keyset cursor: (createdAt ISO, id). */
export interface Cursor {
  t: string;
  id: string;
}

export function encodeCursor(c: Cursor): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(c)));
}

export function decodeCursor(s?: string): Cursor | null {
  if (!s) return null;
  try {
    const v = JSON.parse(new TextDecoder().decode(base64UrlDecode(s))) as Cursor;
    if (typeof v.t !== 'string' || typeof v.id !== 'string') return null;
    return v;
  } catch {
    return null;
  }
}

export function pageResult<T extends { id: string; createdAt: string | Date }>(rows: T[], limit: number) {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const last = data[data.length - 1];
  return {
    data,
    nextCursor:
      hasMore && last
        ? encodeCursor({ t: typeof last.createdAt === 'string' ? last.createdAt : last.createdAt.toISOString(), id: last.id })
        : null,
  };
}

export const pageSchema = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ data: z.array(item), nextCursor: z.string().nullable() });
