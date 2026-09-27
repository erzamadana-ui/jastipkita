/**
 * Referral unit-economics guardrail (daily). Metric definitions (docs/api/engagement.md):
 *   window                 trailing 90 days (referrals by rewarded_at / created_at)
 *   CAC proxy (IDR)        Σ REFERRAL_REWARD credit granted in the window ÷ referrals REWARDED in the
 *                          window (credit cost per acquired, transacting user; both sides' credit)
 *   LTV proxy (IDR)        trailing 180 days: Σ (platform revenue − promo cost) of COMPLETED
 *                          transactions (v_completed_transaction_lines) ÷ distinct buyers who completed
 *                          one — contribution per active buyer, a conservative LTV floor
 *   fraud rate             referrals evaluated at reward time in the window whose REFERRAL risk
 *                          assessment was not ALLOW ÷ all evaluated referrals
 * Verdict: core unitEconomicsGuardrail with referral.buyer.guardrails. When it says "do not increase"
 * (pause), a warning is logged and a security_events row REFERRAL_GUARDRAIL_TRIPPED (MEDIUM) is written
 * once per WIB day for RISK/MARKETING. Reward amounts are NOT changed automatically (maker-checker config).
 */
import { unitEconomicsGuardrail } from '@jastipkita/core';
import type { AppDeps } from '../../context';

export async function computeReferralEconomics(deps: AppDeps) {
  const now = deps.clock.now();
  const since90 = new Date(now.getTime() - 90 * 86400_000);
  const since180 = new Date(now.getTime() - 180 * 86400_000);
  const [cost] = await deps.sql<{ credit: number | null; rewarded: number }[]>`
    SELECT (SELECT coalesce(sum(amount_idr), 0) FROM credit_entries WHERE reason = 'REFERRAL_REWARD' AND created_at >= ${since90})::bigint AS credit,
           (SELECT count(*) FROM referrals WHERE status = 'REWARDED' AND rewarded_at >= ${since90})::int AS rewarded`;
  const [ltv] = await deps.sql<{ contribution: number | null; buyers: number }[]>`
    SELECT coalesce(sum(v.platform_revenue_idr - v.promo_cost_idr), 0)::bigint AS contribution, count(DISTINCT t.buyer_id)::int AS buyers
      FROM v_completed_transaction_lines v JOIN transactions t ON t.id = v.transaction_id
     WHERE t.completed_at >= ${since180}`;
  const [fraud] = await deps.sql<{ evaluated: number; flagged: number }[]>`
    WITH latest AS (
      SELECT DISTINCT ON (subject_id) subject_id, decision FROM risk_assessments
       WHERE subject_type = 'REFERRAL' AND created_at >= ${since90} AND signals->>'stage' = 'REWARD'
       ORDER BY subject_id, created_at DESC)
    SELECT count(*)::int AS evaluated, count(*) FILTER (WHERE decision <> 'ALLOW')::int AS flagged FROM latest`;
  const creditIdr = Number(cost?.credit ?? 0);
  const rewarded = cost?.rewarded ?? 0;
  const cac = rewarded > 0 ? Math.round(creditIdr / rewarded) : 0;
  const ltvIdr = (ltv?.buyers ?? 0) > 0 ? Math.round(Number(ltv!.contribution ?? 0) / ltv!.buyers) : 0;
  const evaluated = fraud?.evaluated ?? 0;
  const fraudRate = evaluated > 0 ? (fraud!.flagged ?? 0) / evaluated : 0;
  return { windowDays: 90, ltvWindowDays: 180, referralCreditIdr: creditIdr, rewardedReferrals: rewarded, cac, ltv: ltvIdr, evaluatedReferrals: evaluated, fraudRate };
}

export async function runReferralGuardrail(deps: AppDeps): Promise<Record<string, unknown>> {
  const m = await computeReferralEconomics(deps);
  if (m.evaluatedReferrals === 0 && m.rewardedReferrals === 0) return { status: 'INSUFFICIENT_DATA', ...m };
  const guardrails = (await deps.config.get('referral.buyer')).guardrails;
  const verdict = unitEconomicsGuardrail({ cac: m.cac, ltv: m.ltv, fraudRate: m.fraudRate }, guardrails);
  const out = { status: verdict.allowIncrease ? 'OK' : 'PAUSE_RECOMMENDED', ...m, cacToLtv: Number.isFinite(verdict.cacToLtv) ? verdict.cacToLtv : null, reasons: verdict.reasons.map((r) => r.code) };
  if (!verdict.allowIncrease) {
    deps.logger.warn('referral.guardrail_tripped', out);
    await deps.sql`
      INSERT INTO security_events (type, severity, meta)
      SELECT 'REFERRAL_GUARDRAIL_TRIPPED', 'MEDIUM', ${deps.sql.json({ ...out, guardrails } as never)}
       WHERE NOT EXISTS (
         SELECT 1 FROM security_events WHERE type = 'REFERRAL_GUARDRAIL_TRIPPED'
            AND (created_at AT TIME ZONE 'Asia/Jakarta')::date = (${deps.clock.now()}::timestamptz AT TIME ZONE 'Asia/Jakarta')::date)`;
  }
  return out;
}
