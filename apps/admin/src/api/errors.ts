/**
 * Error normalization to the API error shape `{ error: { code, message, details, requestId } }`
 * (CONVENTIONS.md). Every failure the UI sees — HTTP error, network failure, malformed body — becomes an ApiError.
 */
export interface ApiErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown>; requestId?: string };
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown>;
  readonly requestId: string | null;

  constructor(status: number, code: string, message: string, details: Record<string, unknown> = {}, requestId: string | null = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

function isErrorBody(v: unknown): v is ApiErrorBody {
  if (!v || typeof v !== 'object') return false;
  const e = (v as { error?: unknown }).error;
  return !!e && typeof e === 'object' && typeof (e as { code?: unknown }).code === 'string';
}

const STATUS_FALLBACK: Record<number, [string, string]> = {
  400: ['BAD_REQUEST', 'Permintaan tidak valid.'],
  401: ['UNAUTHORIZED', 'Sesi berakhir. Silakan masuk lagi.'],
  403: ['FORBIDDEN', 'Anda tidak memiliki akses untuk aksi ini.'],
  404: ['NOT_FOUND', 'Data tidak ditemukan.'],
  409: ['CONFLICT', 'Terjadi konflik data. Muat ulang lalu coba lagi.'],
  422: ['UNPROCESSABLE', 'Aturan bisnis menolak aksi ini.'],
  429: ['RATE_LIMITED', 'Terlalu banyak percobaan. Tunggu sebentar.'],
  502: ['BAD_GATEWAY', 'Provider eksternal gagal merespons.'],
  503: ['UNAVAILABLE', 'Layanan sedang tidak tersedia.'],
};

/** Builds an ApiError from a status + parsed body (any shape) + optional response (for X-Request-Id). */
export function normalizeError(status: number, body: unknown, response?: Response | null): ApiError {
  const headerRid = response?.headers.get('X-Request-Id') ?? null;
  if (isErrorBody(body)) {
    const e = body.error;
    return new ApiError(status, e.code, e.message || e.code, e.details ?? {}, e.requestId ?? headerRid);
  }
  const [code, message] = STATUS_FALLBACK[status] ?? ['HTTP_ERROR', `Kesalahan server (HTTP ${status}).`];
  const details: Record<string, unknown> = typeof body === 'string' && body ? { body: body.slice(0, 300) } : {};
  return new ApiError(status, code, message, details, headerRid);
}

export function networkError(cause: unknown): ApiError {
  const msg = cause instanceof Error ? cause.message : String(cause);
  return new ApiError(0, 'NETWORK_ERROR', 'Tidak dapat menghubungi API. Periksa koneksi atau status layanan.', { cause: msg.slice(0, 200) });
}

/** Human message for toasts/banners, including the code and request id for support tickets. */
export function describeError(e: unknown): { title: string; detail: string | null } {
  if (isApiError(e)) {
    const extra = [e.code, e.requestId ? `req ${e.requestId}` : null].filter(Boolean).join(' · ');
    return { title: e.message, detail: extra || null };
  }
  if (e instanceof Error) return { title: e.message, detail: null };
  return { title: 'Terjadi kesalahan tak terduga.', detail: null };
}

/** Validation issues from CONFIG_INVALID / VALIDATION_ERROR details, as `{path, message}` rows. */
export function validationIssues(e: unknown): { path: string; message: string }[] {
  if (!isApiError(e)) return [];
  const d = e.details as { errors?: unknown; issues?: unknown };
  const list = Array.isArray(d.errors) ? d.errors : Array.isArray(d.issues) ? d.issues : [];
  return list
    .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
    .map((x) => ({ path: String(x.path ?? ''), message: String(x.message ?? x.code ?? '') }));
}
