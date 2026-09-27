/**
 * Runs an admin action with MFA step-up and Idempotency-Key discipline.
 *
 * Key lifecycle mirrors the API middleware order (requireRecentMfa runs BEFORE requireIdempotency, and the
 * middleware stores the first 2xx/4xx response for 24 h, but lets a 5xx / network failure be retried):
 *   - MFA_REQUIRED → step-up → replay with the SAME key (nothing was stored yet)
 *   - network error / 5xx / 409 IDEMPOTENCY_IN_PROGRESS / MFA cancelled → keep the key: a retry must not
 *     create a second financial operation
 *   - success or a 4xx business answer → the logical action is finished; the next attempt (possibly with
 *     different inputs) gets a NEW key (reusing it with a different body would be 422 IDEMPOTENCY_KEY_REUSED)
 */
import { isApiError } from './errors';
import type { IdempotencyKeys } from './idempotency';
import { MFA_CANCELLED, withStepUp } from './mfa';

export function keepKeyAfter(e: unknown): boolean {
  if (!isApiError(e)) return true;
  if (e.status === 0 || e.status >= 500) return true;
  return e.code === 'MFA_REQUIRED' || e.code === MFA_CANCELLED || e.code === 'IDEMPOTENCY_IN_PROGRESS';
}

export async function runAction<R>(keys: IdempotencyKeys, actionKey: string, run: (idempotencyKey: string) => Promise<R>): Promise<R> {
  const key = keys.get(actionKey);
  try {
    const r = await withStepUp(() => run(key));
    keys.complete(actionKey);
    return r;
  } catch (e) {
    if (!keepKeyAfter(e)) keys.complete(actionKey);
    throw e;
  }
}
