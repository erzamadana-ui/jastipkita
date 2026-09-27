/**
 * MFA step-up coordination (docs/api/admin.md: on 403 MFA_REQUIRED run POST /v1/auth/mfa/verify, then retry).
 * The React MfaProvider registers the handler that shows the TOTP dialog; `withStepUp` wraps any sensitive call.
 * Single-flight: several requests failing with MFA_REQUIRED at once share one dialog.
 */
import { ApiError, isApiError } from './errors';

export type StepUpHandler = () => Promise<boolean>;

let handler: StepUpHandler | null = null;
let inflight: Promise<boolean> | null = null;

export function registerStepUpHandler(h: StepUpHandler): () => void {
  handler = h;
  return () => {
    if (handler === h) handler = null;
  };
}

export function requestStepUp(): Promise<boolean> {
  if (inflight) return inflight;
  if (!handler) return Promise.resolve(false);
  const p = handler().finally(() => {
    if (inflight === p) inflight = null;
  });
  inflight = p;
  return p;
}

export const MFA_CANCELLED = 'MFA_CANCELLED';

/**
 * Runs `fn`; when the API answers MFA_REQUIRED, asks for a TOTP step-up and runs `fn` ONCE more.
 * `fn` must be replay-safe: financial calls pass the same Idempotency-Key on the retry (see IdempotencyKeys).
 */
export async function withStepUp<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (!isApiError(e) || e.code !== 'MFA_REQUIRED') throw e;
    const ok = await requestStepUp();
    if (!ok) throw new ApiError(403, MFA_CANCELLED, 'Verifikasi MFA dibatalkan — aksi tidak dijalankan.', {}, e.requestId);
    return fn();
  }
}
