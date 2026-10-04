/**
 * SEC-18 (docs/security/review-2026-09.md): uploaded files must never render as active content.
 *
 *  - Only raster images (jpeg/png/webp/heic) may be shown `inline`; everything else (PDF, MP4, JSON exports, unknown)
 *    is forced to `Content-Disposition: attachment`, so a polyglot PDF/HTML is downloaded instead of rendered.
 *  - Responses the API serves itself (`/v1/files/{id}/content`, dev storage routes) also carry
 *    `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; sandbox`
 *    (app.ts keeps a route's own CSP instead of the API-wide one).
 *  - Presigned S3/R2 URLs cannot carry arbitrary headers: they pin `response-content-type` and
 *    `response-content-disposition` (signed query parameters). nosniff/CSP for objects fetched straight from the
 *    bucket need the separate storage domain + transform rule (residual, see the review row).
 */
export const INLINE_SAFE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'] as const;

export type Disposition = 'inline' | 'attachment';

/** Raster image types that cannot carry script and may be displayed inline. */
export function isInlineSafe(contentType: string | null | undefined): boolean {
  const base = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  return (INLINE_SAFE_TYPES as readonly string[]).includes(base);
}

/** The disposition actually used: `inline` only when requested (default inline for images) AND the type is a raster image. */
export function effectiveDisposition(contentType: string | null | undefined, requested?: Disposition): Disposition {
  if (!isInlineSafe(contentType)) return 'attachment';
  return requested ?? 'inline';
}

/** ASCII-safe filename for the header (no quotes, separators or control characters). */
export function safeFilename(name: string | undefined): string | null {
  if (!name) return null;
  const cleaned = name.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 120);
  return cleaned || null;
}

/** `Content-Disposition` value for a stored file. */
export function contentDisposition(contentType: string | null | undefined, filename?: string, requested?: Disposition): string {
  const d = effectiveDisposition(contentType, requested);
  const f = safeFilename(filename);
  return f ? `${d}; filename="${f}"` : d;
}

/** Headers for every file body served by the API (in addition to content-type / content-disposition / cache-control). */
export const FILE_RESPONSE_SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  // default-src 'none' + sandbox (SEC-18); frame-ancestors 'none' kept from the API-wide policy
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'; sandbox",
} as const;

/** Content-type to serve: the declared type, or a neutral binary type when unknown. */
export function servedContentType(contentType: string | null | undefined): string {
  const base = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(base) ? base : 'application/octet-stream';
}
