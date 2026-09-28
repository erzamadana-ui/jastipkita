/**
 * Session state for the whole app: tokens (api/session), the admin profile (GET /v1/me), roles → permissions,
 * and the login-time TOTP gate (the UI requires TOTP once per tab session on top of the API's per-action step-up).
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Auth } from '../api/admin';
import { isApiError } from '../api/errors';
import { session, type SessionSnapshot } from '../api/session';
import type { Profile } from '../api/types';
import { hasCapability, isAdmin, missingFor, permissionsFor, type Capability, type Permission } from './permissions';

const GATE_KEY = 'jk_admin_mfa_gate';

function readGate(): boolean {
  try {
    return window.sessionStorage.getItem(GATE_KEY) === '1';
  } catch {
    return false;
  }
}

export type AuthStatus = 'loading' | 'anonymous' | 'not-admin' | 'mfa-enroll' | 'mfa-verify' | 'ready' | 'error';

export interface AuthState {
  status: AuthStatus;
  me: Profile | null;
  roles: string[];
  perms: Set<Permission>;
  snapshot: SessionSnapshot;
  can: (cap: Capability) => boolean;
  missing: (cap: Capability) => string[];
  passGate: () => void;
  logout: () => Promise<void>;
  reloadMe: () => Promise<unknown>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const qc = useQueryClient();
  const [gate, setGate] = useState(readGate);
  const meQ = useQuery({
    queryKey: ['me', snapshot.sessionId ?? 'anon'],
    queryFn: Auth.me,
    enabled: snapshot.authenticated,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const me = snapshot.authenticated ? (meQ.data ?? null) : null;
  const roles = useMemo(() => me?.roles ?? [], [me]);
  const perms = useMemo(() => permissionsFor(roles, me?.permissions), [roles, me]);

  const passGate = useCallback(() => {
    try {
      window.sessionStorage.setItem(GATE_KEY, '1');
    } catch {
      /* ignore */
    }
    setGate(true);
  }, []);

  const logout = useCallback(async () => {
    try {
      if (session.getAccessToken() || session.getRefreshToken()) await Auth.logout();
    } catch {
      /* revoke best-effort; local session is cleared regardless */
    }
    try {
      window.sessionStorage.removeItem(GATE_KEY);
    } catch {
      /* ignore */
    }
    setGate(false);
    session.clear('LOGOUT');
    qc.clear();
  }, [qc]);

  let status: AuthStatus;
  if (!snapshot.authenticated) status = 'anonymous';
  else if (meQ.isPending) status = 'loading';
  else if (meQ.isError) status = isApiError(meQ.error) && meQ.error.status === 401 ? 'anonymous' : 'error';
  else if (!me || !isAdmin(me.roles)) status = 'not-admin';
  else if (!me.mfaEnabled) status = 'mfa-enroll';
  else if (!gate && !snapshot.mfaAt) status = 'mfa-verify';
  else status = 'ready';

  const value = useMemo<AuthState>(
    () => ({
      status,
      me,
      roles,
      perms,
      snapshot,
      can: (cap) => hasCapability(perms, roles, cap),
      missing: (cap) => missingFor(perms, roles, cap),
      passGate,
      logout,
      reloadMe: () => meQ.refetch(),
    }),
    [status, me, roles, perms, snapshot, passGate, logout, meQ],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAuth outside AuthProvider');
  return c;
}

/** Capability check + human "why not" for disabled buttons. */
export function useCan(cap: Capability): { allowed: boolean; reason: string | null } {
  const a = useAuth();
  const allowed = a.can(cap);
  return { allowed, reason: allowed ? null : `Butuh izin: ${a.missing(cap).join(', ')}` };
}
