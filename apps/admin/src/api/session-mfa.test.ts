/**
 * SEC-01 (docs/security/review-2026-09.md): the API now refuses every /v1/admin/* read with MFA_REQUIRED when the
 * admin session has not passed TOTP (or it lapsed). Queries must trigger the shared step-up dialog and refetch.
 */
import { QueryObserver } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeQueryClient } from '../App';
import { ApiError } from './errors';
import { registerStepUpHandler } from './mfa';

let unregister: (() => void) | null = null;
afterEach(() => {
  unregister?.();
  unregister = null;
});

describe('query MFA_REQUIRED → step-up → refetch', () => {
  it('runs the TOTP step-up once and refetches the query', async () => {
    const handler = vi.fn(async () => true);
    unregister = registerStepUpHandler(handler);
    const qc = makeQueryClient();
    const fn = vi.fn().mockRejectedValueOnce(new ApiError(403, 'MFA_REQUIRED', 'Verifikasi MFA diperlukan', { scope: 'SESSION' })).mockResolvedValue({ data: [] });
    // an active query (a mounted page), like useQuery in the app
    const obs = new QueryObserver(qc, { queryKey: ['users'], queryFn: fn, retry: false });
    const unsub = obs.subscribe(() => undefined);
    await vi.waitFor(() => expect(fn).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(obs.getCurrentResult().data).toEqual({ data: [] }));
    expect(handler).toHaveBeenCalledTimes(1);
    unsub();
  });

  it('does not refetch when the operator cancels, and ignores other errors', async () => {
    const handler = vi.fn(async () => false);
    unregister = registerStepUpHandler(handler);
    const qc = makeQueryClient();
    const fn = vi.fn().mockRejectedValue(new ApiError(403, 'MFA_REQUIRED', 'Verifikasi MFA diperlukan'));
    const obs = new QueryObserver(qc, { queryKey: ['kyc'], queryFn: fn, retry: false });
    const unsub = obs.subscribe(() => undefined);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(fn).toHaveBeenCalledTimes(1);
    unsub();
    const other = vi.fn().mockRejectedValue(new ApiError(403, 'PERMISSION_DENIED', 'Izin tidak cukup'));
    await qc.fetchQuery({ queryKey: ['x'], queryFn: other, retry: false }).catch(() => undefined);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
