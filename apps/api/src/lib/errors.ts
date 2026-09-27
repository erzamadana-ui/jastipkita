import type { ContentfulStatusCode } from 'hono/utils/http-status';

/**
 * Canonical API error. Every error response has the shape:
 * { "error": { "code": "PAYMENT_NOT_SECURED", "message": "...", "details": {...}, "requestId": "..." } }
 */
export class AppError extends Error {
  constructor(
    public readonly status: ContentfulStatusCode,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const Errors = {
  badRequest: (code: string, message: string, details?: Record<string, unknown>) => new AppError(400, code, message, details),
  validation: (details: Record<string, unknown>) => new AppError(400, 'VALIDATION_ERROR', 'Input tidak valid', details),
  unauthorized: (message = 'Autentikasi diperlukan', code = 'UNAUTHORIZED') => new AppError(401, code, message),
  forbidden: (message = 'Akses ditolak', code = 'FORBIDDEN', details?: Record<string, unknown>) =>
    new AppError(403, code, message, details),
  notFound: (entity = 'Resource', code = 'NOT_FOUND') => new AppError(404, code, `${entity} tidak ditemukan`),
  conflict: (code: string, message: string, details?: Record<string, unknown>) => new AppError(409, code, message, details),
  unprocessable: (code: string, message: string, details?: Record<string, unknown>) => new AppError(422, code, message, details),
  tooMany: (message = 'Terlalu banyak permintaan, coba lagi nanti', details?: Record<string, unknown>) =>
    new AppError(429, 'RATE_LIMITED', message, details),
  kycRequired: (required: number, current: number) =>
    new AppError(403, 'KYC_LEVEL_REQUIRED', `Butuh verifikasi akun level ${required}`, { required, current }),
  mfaRequired: () => new AppError(403, 'MFA_REQUIRED', 'Verifikasi MFA diperlukan untuk aksi ini'),
  internal: (message = 'Terjadi kesalahan pada server') => new AppError(500, 'INTERNAL_ERROR', message),
  unavailable: (code: string, message: string) => new AppError(503, code, message),
};

/** Maps PostgreSQL errors (incl. custom JKxxx SQLSTATEs raised by our functions/triggers) to AppError. */
export function fromPgError(err: unknown): AppError | null {
  if (!err || typeof err !== 'object' || !('code' in err)) return null;
  const e = err as { code?: string; message?: string; detail?: string; constraint_name?: string; constraint?: string };
  const detail = parseDetail(e.detail);
  switch (e.code) {
    case 'JK404':
      return new AppError(404, 'NOT_FOUND', e.message ?? 'Not found', detail);
    case 'JK409':
      return new AppError(409, 'VERSION_CONFLICT', 'Data sudah berubah, muat ulang lalu coba lagi', detail);
    case 'JK422':
      return new AppError(422, 'ILLEGAL_TRANSITION', e.message ?? 'Perubahan status tidak diizinkan', detail);
    case 'JK403':
      return new AppError(403, 'ACTOR_NOT_ALLOWED', e.message ?? 'Aktor tidak diizinkan', detail);
    case 'JK001':
      return new AppError(500, 'IMMUTABLE_RECORD', 'Catatan bersifat append-only');
    case '23505':
      return new AppError(409, 'DUPLICATE', 'Data sudah ada', { constraint: e.constraint_name ?? e.constraint });
    case '23503':
      return new AppError(422, 'REFERENCE_INVALID', 'Referensi data tidak valid', { constraint: e.constraint_name ?? e.constraint });
    case '23514':
      return new AppError(422, 'CONSTRAINT_VIOLATION', 'Data melanggar aturan', { constraint: e.constraint_name ?? e.constraint });
    case '40001':
    case '40P01':
      return new AppError(409, 'RETRY_TRANSACTION', 'Konflik bersamaan, silakan coba lagi');
    default:
      if (e.code && /^JK/.test(e.code)) return new AppError(422, e.code, e.message ?? 'Aturan bisnis dilanggar', detail);
      return null;
  }
}

function parseDetail(detail?: string): Record<string, unknown> | undefined {
  if (!detail) return undefined;
  try {
    const v = JSON.parse(detail);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : { detail };
  } catch {
    return { detail };
  }
}
