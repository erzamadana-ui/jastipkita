import { describe, expect, it } from 'vitest';
import { fromPgError } from './errors';

const pg = (code: string, message: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(message), { code, ...extra });

describe('fromPgError (SEC-20: no raw DB text to clients)', () => {
  it('JKC01 hides user id and balance behind fixed text', () => {
    const e = fromPgError(pg('JKC01', 'credit balance of user 0b6c… would become negative (25000 + -50000)'))!;
    expect(e.status).toBe(422);
    expect(e.code).toBe('JKC01');
    expect(e.message).toBe('Saldo kredit tidak mencukupi');
    expect(e.message).not.toMatch(/user|25000/);
    expect(e.details).toBeUndefined();
  });

  it('ledger/quote invariants are server faults (500) with generic text', () => {
    for (const code of ['JKL01', 'JKL02', 'JKL03', 'JKQ01']) {
      const e = fromPgError(pg(code, `journal 7f… is not balanced in IDR: debits 10 <> credits 9`, { detail: '{"x":1}' }))!;
      expect(e.status).toBe(500);
      expect(e.message).not.toMatch(/journal|debits|7f/);
      expect(e.details).toBeUndefined();
    }
  });

  it('JK423 keeps structured blockers (callers act on them) but not the DB message', () => {
    const e = fromPgError(pg('JK423', 'user 1234 cannot be anonymized yet', { detail: '{"openTransactions":2}' }))!;
    expect(e.message).not.toContain('1234');
    expect(e.details).toEqual({ openTransactions: 2 });
  });

  it('unknown JK codes get a generic rule message', () => {
    const e = fromPgError(pg('JKZ99', 'internal detail 42'))!;
    expect(e.message).toBe('Aturan bisnis dilanggar');
  });

  it('unique violations do not leak the constraint name', () => {
    const e = fromPgError(pg('23505', 'duplicate key value violates unique constraint "users_phone_hash_key"', { constraint_name: 'users_phone_hash_key' }))!;
    expect(e.status).toBe(409);
    expect(e.code).toBe('DUPLICATE');
    expect(JSON.stringify(e.details ?? {})).not.toContain('users_phone_hash_key');
  });

  it('optimistic lock keeps currentVersion for clients to reload', () => {
    const e = fromPgError(pg('JK409', 'version conflict', { detail: '{"currentVersion":3,"currentStatus":"MATCHED"}' }))!;
    expect(e.status).toBe(409);
    expect(e.details).toEqual({ currentVersion: 3, currentStatus: 'MATCHED' });
  });

  it('non-postgres errors are not mapped', () => {
    expect(fromPgError(new Error('boom'))).toBeNull();
    expect(fromPgError(null)).toBeNull();
  });
});
