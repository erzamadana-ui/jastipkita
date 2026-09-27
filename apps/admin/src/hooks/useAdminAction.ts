import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useRef } from 'react';
import { runAction } from '../api/actions';
import { isApiError } from '../api/errors';
import { IdempotencyKeys } from '../api/idempotency';
import { MFA_CANCELLED } from '../api/mfa';
import { useToast } from '../components/Toast';

export interface AdminActionOptions<V, R> {
  /** Performs the call. `key` is the Idempotency-Key for this logical action (ignored by non-financial calls). */
  run: (vars: V, key: string) => Promise<R>;
  /** Logical action identity (e.g. `refund.approve:<id>`) → one Idempotency-Key per action until it finishes. */
  actionKey?: (vars: V) => string;
  invalidate?: QueryKey[];
  success?: string | ((r: R, v: V) => string | null);
  errorContext?: string;
  /** false when the caller shows errors inline (ActionDialog) — avoids a duplicate toast. */
  toastErrors?: boolean;
  onSuccess?: (r: R, v: V) => void;
}

/**
 * Mutation hook for admin actions: MFA step-up + retry, Idempotency-Key reuse on retry, cache invalidation,
 * toasts (errors show code + request id so an operator can quote them).
 */
export function useAdminAction<V, R>(opts: AdminActionOptions<V, R>) {
  const keys = useRef(new IdempotencyKeys());
  const qc = useQueryClient();
  const { toast, error } = useToast();
  const actionKey = (v: V) => opts.actionKey?.(v) ?? 'action';
  const m = useMutation({
    mutationFn: (vars: V) => runAction(keys.current, actionKey(vars), (key) => opts.run(vars, key)),
    onSuccess: async (r, v) => {
      const msg = typeof opts.success === 'function' ? opts.success(r, v) : opts.success;
      if (msg) toast({ tone: 'success', title: msg });
      opts.onSuccess?.(r, v);
      await Promise.all((opts.invalidate ?? []).map((k) => qc.invalidateQueries({ queryKey: k })));
    },
    onError: (e) => {
      if (opts.toastErrors === false) return;
      if (isApiError(e) && e.code === MFA_CANCELLED) toast({ tone: 'info', title: e.message });
      else error(e, opts.errorContext);
    },
  });
  return {
    ...m,
    /** Operator abandoned the action (closed the dialog) → the next attempt is a new logical action. */
    abandon: (v: V) => keys.current.complete(actionKey(v)),
    /** Current key (for display in confirmation dialogs / tests). */
    keyFor: (v: V) => keys.current.get(actionKey(v)),
  };
}
