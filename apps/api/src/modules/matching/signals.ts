/**
 * User signals shared by discovery, matching and offers: public profile (no PII), rating summaries,
 * completed transactions, trust score, and traveler/buyer transaction limits (core limits engine).
 */
import { type LimitResult, type RiskLevel, computeTransactionLimit } from '@jastipkita/core';
import type { AppDeps } from '../../context';
import type { Db } from '../../db/sql';
import { type TrustBadgeTier, type TrustTierCode, numOrNull, publicDisplayName, trustBadge, trustTier, wibDate } from '../catalog/shared';

export interface UserSignals {
  userId: string;
  /** internal only — never returned raw */
  displayName: string | null;
  kycLevel: number;
  trustScore: number;
  status: string;
  travelerRating: { average: number | null; count: number };
  buyerRating: { average: number | null; count: number };
  travelerCompleted: number;
  buyerCompleted: number;
}

interface SignalRow {
  id: string;
  display_name: string | null;
  kyc_level: number;
  trust_score: number;
  status: string;
  as_traveler_count: number | null;
  as_traveler_avg: string | null;
  as_traveler_weighted: string | null;
  as_buyer_count: number | null;
  as_buyer_avg: string | null;
  as_buyer_weighted: string | null;
  traveler_completed: number;
  buyer_completed: number;
}

export async function loadUserSignals(db: Db, userIds: string[]): Promise<Map<string, UserSignals>> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return new Map();
  const rows = await db<SignalRow[]>`
    SELECT u.id, u.display_name, u.kyc_level, u.trust_score, u.status,
           rs.as_traveler_count, rs.as_traveler_avg::text AS as_traveler_avg, rs.as_traveler_weighted::text AS as_traveler_weighted,
           rs.as_buyer_count, rs.as_buyer_avg::text AS as_buyer_avg, rs.as_buyer_weighted::text AS as_buyer_weighted,
           (SELECT count(*) FROM transactions t WHERE t.traveler_id = u.id AND t.status = 'COMPLETED')::int AS traveler_completed,
           (SELECT count(*) FROM transactions t WHERE t.buyer_id = u.id AND t.status = 'COMPLETED')::int AS buyer_completed
      FROM users u
      LEFT JOIN user_rating_summaries rs ON rs.user_id = u.id
     WHERE u.id IN ${db(ids)}`;
  const out = new Map<string, UserSignals>();
  for (const r of rows) {
    out.set(r.id, {
      userId: r.id,
      displayName: r.display_name,
      kycLevel: r.kyc_level,
      trustScore: r.trust_score,
      status: r.status,
      travelerRating: { average: numOrNull(r.as_traveler_weighted ?? r.as_traveler_avg), count: r.as_traveler_count ?? 0 },
      buyerRating: { average: numOrNull(r.as_buyer_weighted ?? r.as_buyer_avg), count: r.as_buyer_count ?? 0 },
      travelerCompleted: r.traveler_completed,
      buyerCompleted: r.buyer_completed,
    });
  }
  return out;
}

export interface PublicProfileDto {
  /** public profile id (= user id); no e-mail/phone/name */
  id: string;
  displayName: string;
  trustBadge: { tier: TrustBadgeTier; label: string };
  trustScore: number;
  trustTier: { tier: TrustTierCode; label: string; labelEn: string };
  kycLevel: number;
  identityVerified: boolean;
  rating: { average: number | null; count: number };
  completedTransactions: number;
}

export function publicProfile(s: UserSignals | undefined, userId: string, role: 'TRAVELER' | 'BUYER'): PublicProfileDto {
  if (!s) {
    return {
      id: userId,
      displayName: 'Pengguna JastipKita',
      trustBadge: trustBadge(1),
      trustScore: 0,
      trustTier: trustTier(0),
      kycLevel: 1,
      identityVerified: false,
      rating: { average: null, count: 0 },
      completedTransactions: 0,
    };
  }
  return {
    id: s.userId,
    displayName: publicDisplayName(s.displayName, role === 'TRAVELER' ? 'Traveler JastipKita' : 'Penitip JastipKita'),
    trustBadge: trustBadge(s.kycLevel),
    trustScore: s.trustScore,
    trustTier: trustTier(s.trustScore),
    kycLevel: s.kycLevel,
    identityVerified: s.kycLevel >= 3,
    rating: role === 'TRAVELER' ? s.travelerRating : s.buyerRating,
    completedTransactions: role === 'TRAVELER' ? s.travelerCompleted : s.buyerCompleted,
  };
}

/**
 * Value already used this calendar month (WIB) by the user in `role`, from live transactions.
 * Uses the quoted total when known (null before quote → counted as 0; an approximation until money
 * attaches quotes).
 */
export async function monthUsedIdr(db: Db, userId: string, role: 'BUYER' | 'TRAVELER', now: Date): Promise<number> {
  const monthStart = new Date(`${wibDate(now).slice(0, 7)}-01T00:00:00+07:00`);
  const rows =
    role === 'TRAVELER'
      ? await db<{ s: number }[]>`SELECT coalesce(sum(total_idr), 0)::bigint AS s FROM transactions
            WHERE traveler_id = ${userId} AND created_at >= ${monthStart} AND status NOT IN ('CANCELLED','REFUNDED')`
      : await db<{ s: number }[]>`SELECT coalesce(sum(total_idr), 0)::bigint AS s FROM transactions
            WHERE buyer_id = ${userId} AND created_at >= ${monthStart} AND status NOT IN ('CANCELLED','REFUNDED')`;
  return Number(rows[0]?.s ?? 0);
}

/** Traveler's current limit via core computeTransactionLimit + `limits.transaction`. */
export async function travelerLimit(
  db: Db,
  deps: Pick<AppDeps, 'config' | 'clock'>,
  s: UserSignals,
  productRisk: RiskLevel,
  countryRisk: RiskLevel,
): Promise<LimitResult> {
  const cfg = await deps.config.get('limits.transaction');
  const kyc = Math.min(5, Math.max(1, s.kycLevel));
  return computeTransactionLimit(
    {
      kycLevel: kyc,
      trustScore: s.trustScore,
      completedTransactions: s.travelerCompleted,
      productRisk,
      countryRisk,
      role: 'TRAVELER',
      monthUsedIdr: await monthUsedIdr(db, s.userId, 'TRAVELER', deps.clock.now()),
    },
    cfg,
  );
}

/** Estimated unit weight: request estimate → category default → 0.5 kg. */
export function unitWeightKg(estWeightKg: string | number | null | undefined, categoryDefaultKg: string | number | null | undefined): number {
  return numOrNull(estWeightKg) ?? numOrNull(categoryDefaultKg) ?? 0.5;
}
