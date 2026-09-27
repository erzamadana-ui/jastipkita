/**
 * Trust Score recompute (core computeTrustScore with `trust.weights`) + KYC level 5 evaluation.
 *   - writes trust_scores (the DB trigger appends trust_score_history and syncs users.trust_score)
 *   - respects an active admin override (maker-checker, applied via apply_trust_score_override):
 *     the computed breakdown is refreshed but the overridden score stays until `valid_until`
 *   - TRUSTED_TRAVELER (level 5, §2): level ≥ 4 + ≥ 10 COMPLETED as traveler + trust ≥ 80 + dispute
 *     rate < 3 %; granted and revoked automatically (5 → 4) → `kyc.level_changed`
 * Serialized per user (advisory lock); every change is audited.
 */
import { computeTrustScore } from '@jastipkita/core';
import type { AppDeps } from '../../context';
import type { TxSql } from '../../db/sql';
import { audit } from '../../services/audit';
import { emitEvent } from '../../services/outbox';
import { loadTrustSignals, trustedTravelerFacts } from './signals';

export const TRUSTED_TRAVELER = { minCompleted: 10, minTrust: 80, maxDisputeRate: 0.03 } as const;

export interface RecomputeResult {
  userId: string;
  score: number;
  computedScore: number;
  previousScore: number | null;
  overridden: boolean;
  kycLevel: number;
  levelChange: { from: number; to: number } | null;
}

export async function recomputeTrustScore(deps: AppDeps, userId: string, trigger: string): Promise<RecomputeResult | null> {
  const now = deps.clock.now();
  const [weights, versions] = await Promise.all([deps.config.get('trust.weights'), deps.config.versions(['trust.weights'])]);
  const cfgVersion = versions['trust.weights'] || 1;
  return deps.sql.begin(async (tq) => {
    const tx = tq as unknown as TxSql;
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'trust:' + userId}, 0))`;
    const [u] = await tx<{ id: string; kyc_level: number; status: string }[]>`SELECT id, kyc_level, status FROM users WHERE id = ${userId} FOR UPDATE`;
    if (!u || u.status === 'DELETED') return null;
    const signals = await loadTrustSignals(tx, userId, now);
    const result = computeTrustScore(signals, weights, now);
    const [cur] = await tx<{ score: number; override_id: string | null; o_status: string | null; valid_until: Date | null }[]>`
      SELECT ts.score, ts.override_id, o.status AS o_status, o.valid_until
        FROM trust_scores ts LEFT JOIN trust_score_overrides o ON o.id = ts.override_id
       WHERE ts.user_id = ${userId} FOR UPDATE OF ts`;
    const overrideActive = !!cur?.override_id && cur.o_status === 'APPLIED' && (!cur.valid_until || cur.valid_until > now);
    const components = {
      engine: result.version,
      computedScore: result.score,
      items: result.components, // (trigger is kept in the audit meta — history rows only on real changes)
      ...(overrideActive ? { override: { id: cur!.override_id, validUntil: cur!.valid_until?.toISOString() ?? null } } : {}),
    };
    const score = overrideActive ? cur!.score : result.score;
    await tx`
      INSERT INTO trust_scores (user_id, score, components, computed_at, version, override_id)
      VALUES (${userId}, ${score}, ${tx.json(components as never)}, ${now}, ${cfgVersion}, ${overrideActive ? cur!.override_id : null})
      ON CONFLICT (user_id) DO UPDATE
         SET score = EXCLUDED.score, components = EXCLUDED.components, computed_at = EXCLUDED.computed_at,
             version = EXCLUDED.version, override_id = EXCLUDED.override_id`;

    // ---- KYC level 5 (TRUSTED_TRAVELER)
    const facts = await trustedTravelerFacts(tx, userId);
    const qualifies =
      u.kyc_level >= 4 && facts.completedAsTraveler >= TRUSTED_TRAVELER.minCompleted && score >= TRUSTED_TRAVELER.minTrust && facts.disputeRate < TRUSTED_TRAVELER.maxDisputeRate;
    let levelChange: { from: number; to: number } | null = null;
    if (u.kyc_level === 4 && qualifies) levelChange = { from: 4, to: 5 };
    else if (u.kyc_level === 5 && !qualifies) levelChange = { from: 5, to: 4 };
    const factPayload = { completedAsTraveler: facts.completedAsTraveler, trustScore: score, disputeRatePct: Math.round(facts.disputeRate * 1000) / 10 };
    if (levelChange) {
      await tx`UPDATE users SET kyc_level = ${levelChange.to} WHERE id = ${userId} AND kyc_level = ${levelChange.from}`;
      await emitEvent(tx, 'user', userId, 'kyc.level_changed', {
        userId,
        from: levelChange.from,
        to: levelChange.to,
        reason: levelChange.to === 5 ? 'TRUSTED_TRAVELER_GRANTED' : 'TRUSTED_TRAVELER_REVOKED',
        source: 'trust_score_job',
        facts: factPayload,
      });
    }
    // audits last (hash-chain head lock held briefly)
    if (!cur || cur.score !== score) {
      await audit(tx, {
        actorType: 'JOB',
        actorId: null,
        action: 'trust.recomputed',
        entityType: 'user',
        entityId: userId,
        before: cur ? { score: cur.score } : null,
        after: { score, computedScore: result.score, overridden: overrideActive },
        meta: { trigger, weightsVersion: cfgVersion },
      });
    }
    if (levelChange) {
      await audit(tx, {
        actorType: 'JOB',
        actorId: null,
        action: 'kyc.level_changed',
        entityType: 'user',
        entityId: userId,
        before: { kycLevel: levelChange.from },
        after: { kycLevel: levelChange.to },
        meta: { rule: 'TRUSTED_TRAVELER', ...factPayload, thresholds: TRUSTED_TRAVELER },
      });
    }
    return {
      userId,
      score,
      computedScore: result.score,
      previousScore: cur?.score ?? null,
      overridden: overrideActive,
      kycLevel: levelChange?.to ?? u.kyc_level,
      levelChange,
    };
  });
}

/**
 * Hourly sweep for changes that do not come through the outbox: expired overrides, fraud
 * confirmations resolved by RISK after the last recompute.
 */
export async function runTrustSweep(deps: AppDeps): Promise<Record<string, number>> {
  const now = deps.clock.now();
  const rows = await deps.sql<{ user_id: string }[]>`
    SELECT ts.user_id FROM trust_scores ts JOIN trust_score_overrides o ON o.id = ts.override_id
     WHERE o.valid_until IS NOT NULL AND o.valid_until <= ${now}
    UNION
    SELECT rr.subject_id FROM risk_reviews rr LEFT JOIN trust_scores ts ON ts.user_id = rr.subject_id
     WHERE rr.subject_type = 'USER' AND rr.status IN ('CONFIRMED_FRAUD','CLEARED') AND rr.resolved_at IS NOT NULL
       AND (ts.computed_at IS NULL OR rr.resolved_at > ts.computed_at)
    LIMIT 200`;
  let failed = 0;
  for (const r of rows) {
    try {
      await recomputeTrustScore(deps, r.user_id, 'sweep');
    } catch (err) {
      failed++;
      deps.logger.warn('trust.sweep_failed', { userId: r.user_id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { users: rows.length, failed };
}
