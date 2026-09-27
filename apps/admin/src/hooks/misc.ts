import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Dashboard, System } from '../api/admin';
import { useAuth } from '../auth/AuthProvider';
import { CAP } from '../auth/permissions';
import { ENV } from '../env';
import { addDays, wibDate } from '../lib/format';

/** Re-renders every `ms` (for countdowns such as MFA freshness). */
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function defaultRange(days = 30): { from: string; to: string } {
  const to = wibDate();
  return { from: addDays(to, -(days - 1)), to };
}

/**
 * Integration modes (payments/email/push/sms/storage/kyc/…: MOCK · SANDBOX · LIVE) for the SANDBOX ribbon. Source:
 * /system/health (infra.db.read) or the KPI endpoint's systemHealth block (analytics.read); unknown otherwise.
 */
export function useIntegrationModes(): { modes: Record<string, string> | null; source: 'health' | 'kpis' | null } {
  const { can, status } = useAuth();
  const ready = status === 'ready';
  const canHealth = ready && can(CAP.infraRead);
  const canKpis = ready && !canHealth && can({ perms: ['analytics.read'] });
  const range = defaultRange(30);
  const health = useQuery({ queryKey: ['system', 'health'], queryFn: System.health, enabled: canHealth, refetchInterval: 60_000, staleTime: 30_000 });
  const kpis = useQuery({ queryKey: ['dashboard', 'kpis', range.from, range.to], queryFn: () => Dashboard.kpis(range), enabled: canKpis, staleTime: 60_000 });
  if (health.data) return { modes: health.data.integrations, source: 'health' };
  if (kpis.data?.systemHealth.integrations) return { modes: kpis.data.systemHealth.integrations, source: 'kpis' };
  return { modes: null, source: null };
}

export const MONEY_INTEGRATIONS = ['payments', 'paymentProviderEnv'];

export function nonLive(modes: Record<string, string> | null): [string, string][] {
  if (!modes) return [];
  return Object.entries(modes).filter(([k, v]) => k !== 'dbAdmin' && k !== 'insurance' && v !== 'LIVE');
}

export function isProduction(): boolean {
  return ENV.appEnv === 'production';
}
