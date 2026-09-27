import { afterEach, describe, expect, it, vi } from 'vitest';
import { runAction } from './actions';
import { ApiError } from './errors';
import { IdempotencyKeys } from './idempotency';
import { MFA_CANCELLED, registerStepUpHandler, withStepUp } from './mfa';

let unregister: (() => void) | null = null;
afterEach(() => {
  unregister?.();
  unregister = null;
});

const mfaRequired = () => new ApiError(403, 'MFA_REQUIRED', 'Verifikasi MFA diperlukan');

describe('MFA step-up retry (withStepUp)', () => {
  it('asks for TOTP once on MFA_REQUIRED, then replays the call', async () => {
    const handler = vi.fn(async () => true);
    unregister = registerStepUpHandler(handler);
    const fn = vi.fn().mockRejectedValueOnce(mfaRequired()).mockResolvedValueOnce({ status: 'APPLIED' });
    await expect(withStepUp(fn)).resolves.toEqual({ status: 'APPLIED' });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('shares one TOTP dialog between concurrent MFA_REQUIRED failures', async () => {
    let resolveDialog: (ok: boolean) => void = () => undefined;
    const handler = vi.fn(() => new Promise<boolean>((r) => (resolveDialog = r)));
    unregister = registerStepUpHandler(handler);
    const a = vi.fn().mockRejectedValueOnce(mfaRequired()).mockResolvedValueOnce('a');
    const b = vi.fn().mockRejectedValueOnce(mfaRequired()).mockResolvedValueOnce('b');
    const pa = withStepUp(a);
    const pb = withStepUp(b);
    await new Promise((r) => setTimeout(r, 0));
    resolveDialog(true);
    await expect(Promise.all([pa, pb])).resolves.toEqual(['a', 'b']);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('does not run the action again when the operator cancels the step-up', async () => {
    unregister = registerStepUpHandler(async () => false);
    const fn = vi.fn().mockRejectedValue(mfaRequired());
    await expect(withStepUp(fn)).rejects.toMatchObject({ code: MFA_CANCELLED });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('passes other errors through untouched', async () => {
    const handler = vi.fn(async () => true);
    unregister = registerStepUpHandler(handler);
    await expect(withStepUp(() => Promise.reject(new ApiError(403, 'MAKER_CHECKER_VIOLATION', 'x')))).rejects.toMatchObject({ code: 'MAKER_CHECKER_VIOLATION' });
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('Idempotency-Key reuse (runAction)', () => {
  it('replays with the SAME key after MFA step-up, and uses a NEW key for the next action', async () => {
    unregister = registerStepUpHandler(async () => true);
    const keys = new IdempotencyKeys();
    const seen: string[] = [];
    let first = true;
    const run = async (key: string) => {
      seen.push(key);
      if (first) {
        first = false;
        throw mfaRequired();
      }
      return 'ok';
    };
    await runAction(keys, 'refund.approve:r1', run);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
    await runAction(keys, 'refund.approve:r1', async (k) => (seen.push(k), 'ok'));
    expect(seen[2]).not.toBe(seen[0]);
  });

  it('keeps the key after a network error / 5xx so a manual retry cannot double-spend', async () => {
    const keys = new IdempotencyKeys();
    const seen: string[] = [];
    await expect(runAction(keys, 'payout.release:p1', async (k) => (seen.push(k), Promise.reject(new ApiError(0, 'NETWORK_ERROR', 'offline'))))).rejects.toBeTruthy();
    await expect(runAction(keys, 'payout.release:p1', async (k) => (seen.push(k), Promise.reject(new ApiError(503, 'UNAVAILABLE', 'x'))))).rejects.toBeTruthy();
    await runAction(keys, 'payout.release:p1', async (k) => (seen.push(k), 'ok'));
    expect(new Set(seen).size).toBe(1);
  });

  it('drops the key after a stored 4xx business answer (next attempt may carry different inputs)', async () => {
    const keys = new IdempotencyKeys();
    const seen: string[] = [];
    await expect(runAction(keys, 'tx.refund:t1', async (k) => (seen.push(k), Promise.reject(new ApiError(422, 'REFUND_EXCEEDS_HELD', 'x'))))).rejects.toBeTruthy();
    await runAction(keys, 'tx.refund:t1', async (k) => (seen.push(k), 'ok'));
    expect(seen[0]).not.toBe(seen[1]);
  });

  it('gives different logical actions different keys (UUID v4)', () => {
    const keys = new IdempotencyKeys();
    const a = keys.get('refund.approve:a');
    const b = keys.get('refund.approve:b');
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(keys.get('refund.approve:a')).toBe(a);
  });
});
