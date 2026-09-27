/**
 * Signup risk: gathers multi-account / velocity signals and runs the core fraud engine
 * (@jastipkita/core assessRisk). BLOCK prevents the signup; REVIEW/HOLD are allowed but recorded
 * (risk_assessments + risk_reviews via services/risk.ts). Signals stored are counts only (no PII).
 */
import { assessRisk, type RiskAssessment, type RiskSignals } from '@jastipkita/core';
import type { AppDeps } from '../../context';
import type { Db } from '../../db/sql';
import { recordRiskAssessment } from '../../services/risk';
import { buf } from './common';

export interface SignupContext {
  fingerprintHash: Uint8Array | null;
  ipHash: Uint8Array | null;
  emailHash: Uint8Array | null;
}

export async function gatherSignupSignals(deps: AppDeps, db: Db, ctx: SignupContext): Promise<RiskSignals & Record<string, number | boolean>> {
  const since = new Date(deps.clock.now().getTime() - 24 * 3600_000);
  let devAccounts = 0;
  let devRecent = 0;
  if (ctx.fingerprintHash) {
    const [r] = await db<{ total: number; recent: number }[]>`
      SELECT count(DISTINCT ud.user_id)::int AS total,
             count(DISTINCT ud.user_id) FILTER (WHERE u.created_at >= ${since})::int AS recent
        FROM devices d JOIN user_devices ud ON ud.device_id = d.id JOIN users u ON u.id = ud.user_id
       WHERE d.fingerprint_hash = ${buf(ctx.fingerprintHash)} AND u.status <> 'DELETED'`;
    devAccounts = r?.total ?? 0;
    devRecent = r?.recent ?? 0;
  }
  let ipRecent = 0;
  if (ctx.ipHash) {
    const [r] = await db<{ n: number }[]>`
      SELECT count(*)::int AS n FROM security_events
       WHERE type = 'USER_REGISTERED' AND ip_hash = ${buf(ctx.ipHash)} AND created_at >= ${since}`;
    ipRecent = r?.n ?? 0;
  }
  let deletedIdentity = 0;
  if (ctx.emailHash) {
    const [r] = await db<{ n: number }[]>`
      SELECT count(*)::int AS n FROM email_suppressions WHERE email_hash = ${buf(ctx.emailHash)} AND reason = 'ACCOUNT_DELETED'`;
    deletedIdentity = r?.n ?? 0;
  }
  // "+1": the account being created counts toward the per-device / per-IP totals
  return {
    ...(ctx.fingerprintHash ? { accountsOnDevice: devAccounts + 1, sharedDeviceAccounts: devAccounts, accountsCreatedFromDeviceLast24h: devRecent + 1 } : {}),
    ...(ctx.ipHash ? { accountsCreatedFromIpLast24h: ipRecent + 1 } : {}),
    ...(deletedIdentity ? { sharedIdentityHashAccounts: deletedIdentity } : {}),
    deviceKnown: devAccounts > 0,
  };
}

export async function assessSignup(deps: AppDeps, db: Db, ctx: SignupContext): Promise<{ assessment: RiskAssessment; signals: Record<string, unknown> }> {
  const signals = await gatherSignupSignals(deps, db, ctx);
  const thresholds = await deps.config.get('risk.thresholds');
  return { assessment: assessRisk('USER', signals, thresholds), signals };
}

export async function recordSignupRisk(db: Db, subjectId: string, r: { assessment: RiskAssessment; signals: Record<string, unknown> }, method: string) {
  return recordRiskAssessment(db, 'USER', subjectId, r.assessment, { ...r.signals, stage: 'SIGNUP', method }, r.assessment.engineVersion);
}
