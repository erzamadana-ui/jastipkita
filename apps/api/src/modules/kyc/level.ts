/**
 * Account level (docs/00-domain-model.md §2) derived from evidence:
 *   1 REGISTERED        account exists
 *   2 PHONE_VERIFIED    users.phone_verified_at
 *   3 IDENTITY_VERIFIED approved identity (identity_records.verified_at / APPROVED level-3 submission)
 *   4 TRAVELER_VERIFIED level ≥ 3 + VERIFIED, enabled payout account + ≥ 1 trip that reached VERIFIED
 *   5 TRUSTED_TRAVELER  evaluated by the engagement group's trust job — never set here
 *
 * The recomputation only RAISES the level (max(current, evidence)). Downgrades (KYC expiry, fraud,
 * admin revocation) are explicit admin/system actions, not a side effect of a missing row — this also
 * keeps admin-granted levels and test fixtures stable.
 */
import type { AppDeps } from '../../context';
import type { Db } from '../../db/sql';
import { audit } from '../../services/audit';
import { emitEvent } from '../../services/outbox';

export const LEVEL_CODES: Record<number, string> = {
  1: 'REGISTERED',
  2: 'PHONE_VERIFIED',
  3: 'IDENTITY_VERIFIED',
  4: 'TRAVELER_VERIFIED',
  5: 'TRUSTED_TRAVELER',
};

export interface LevelEvidence {
  phoneVerified: boolean;
  identityApproved: boolean;
  payoutVerified: boolean;
  tripVerified: boolean;
}

export async function loadLevelEvidence(db: Db, userId: string): Promise<LevelEvidence> {
  const [r] = await db<{ phone: boolean; identity: boolean; payout: boolean; trip: boolean }[]>`
    SELECT (u.phone_verified_at IS NOT NULL) AS phone,
           (EXISTS (SELECT 1 FROM identity_records ir WHERE ir.user_id = u.id AND ir.verified_at IS NOT NULL)
            OR EXISTS (SELECT 1 FROM kyc_submissions ks WHERE ks.user_id = u.id AND ks.target_level = 3 AND ks.status = 'APPROVED')) AS identity,
           EXISTS (SELECT 1 FROM payout_accounts pa WHERE pa.user_id = u.id AND pa.verification_status = 'VERIFIED' AND pa.disabled_at IS NULL) AS payout,
           EXISTS (SELECT 1 FROM trips t WHERE t.traveler_id = u.id AND t.verified_at IS NOT NULL) AS trip
      FROM users u WHERE u.id = ${userId}`;
  return { phoneVerified: !!r?.phone, identityApproved: !!r?.identity, payoutVerified: !!r?.payout, tripVerified: !!r?.trip };
}

/** Pure: target level from the current level and evidence (never above 4, never below current). */
export function computeLevel(current: number, e: LevelEvidence): number {
  let lvl = 1;
  if (e.phoneVerified) lvl = 2;
  if (Math.max(lvl, current) >= 2 && e.identityApproved) lvl = 3;
  if (Math.max(lvl, current) >= 3 && e.payoutVerified && e.tripVerified) lvl = 4;
  return Math.max(current, lvl);
}

export interface LevelChange {
  userId: string;
  from: number;
  to: number;
  changed: boolean;
}

/**
 * Recomputes users.kyc_level inside the caller's transaction (row-locked), emits `kyc.level_changed`
 * and audits the change. Idempotent: no change → no event.
 */
export async function recomputeKycLevel(deps: AppDeps, db: Db, userId: string, trigger: string): Promise<LevelChange> {
  const [u] = await db<{ kyc_level: number; status: string }[]>`SELECT kyc_level, status FROM users WHERE id = ${userId} FOR UPDATE`;
  if (!u || u.status === 'DELETED') return { userId, from: u?.kyc_level ?? 1, to: u?.kyc_level ?? 1, changed: false };
  const evidence = await loadLevelEvidence(db, userId);
  const to = computeLevel(u.kyc_level, evidence);
  if (to === u.kyc_level) return { userId, from: u.kyc_level, to, changed: false };
  await db`UPDATE users SET kyc_level = ${to} WHERE id = ${userId}`;
  await emitEvent(db, 'user', userId, 'kyc.level_changed', { userId, from: u.kyc_level, to });
  await audit(db, {
    actorType: 'SYSTEM',
    actorId: null,
    action: 'kyc.level_changed',
    entityType: 'user',
    entityId: userId,
    before: { kycLevel: u.kyc_level },
    after: { kycLevel: to },
    meta: { trigger, evidence, at: deps.clock.now().toISOString() },
  });
  return { userId, from: u.kyc_level, to, changed: true };
}
