import type { Db } from '../../db/sql';
import { iso } from '../auth/common';

export interface SubmissionRow {
  id: string;
  user_id: string;
  target_level: number;
  id_type: 'KTP' | 'PASSPORT' | null;
  status: 'PENDING' | 'IN_REVIEW' | 'APPROVED' | 'REJECTED' | 'EXPIRED';
  provider: string;
  provider_env: 'TEST' | 'LIVE';
  submitted_at: Date | null;
  reviewed_at: Date | null;
  decision_reason: string | null;
  rejection_code: string | null;
  created_at: Date;
}

export async function listSubmissions(db: Db, userId: string) {
  return db<SubmissionRow[]>`SELECT id, user_id, target_level, id_type, status, provider, provider_env, submitted_at, reviewed_at, decision_reason, rejection_code, created_at FROM kyc_submissions WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT 20`;
}

export async function getSubmission(db: Db, id: string) {
  const [r] = await db<SubmissionRow[]>`SELECT id, user_id, target_level, id_type, status, provider, provider_env, submitted_at, reviewed_at, decision_reason, rejection_code, created_at FROM kyc_submissions WHERE id = ${id}`;
  return r;
}

export function toSubmissionDto(s: SubmissionRow) {
  return {
    id: s.id,
    targetLevel: s.target_level,
    idType: s.id_type,
    status: s.status,
    provider: s.provider,
    providerEnv: s.provider_env,
    submittedAt: iso(s.submitted_at),
    reviewedAt: iso(s.reviewed_at),
    decisionReason: s.decision_reason,
    rejectionCode: s.rejection_code,
    createdAt: iso(s.created_at)!,
  };
}

export interface PayoutRow {
  id: string;
  user_id: string;
  bank_code: string;
  account_mask: string;
  holder_name: string;
  verification_status: 'UNVERIFIED' | 'PENDING' | 'VERIFIED' | 'FAILED' | 'NAME_MISMATCH';
  is_default: boolean;
  verified_at: Date | null;
  default_since: Date | null;
  disabled_at: Date | null;
  created_at: Date;
}

const payoutCols = (db: Db) => db`id, user_id, bank_code, account_mask, holder_name, verification_status, is_default, verified_at, default_since, disabled_at, created_at`;

export async function listPayoutAccounts(db: Db, userId: string) {
  return db<PayoutRow[]>`SELECT ${payoutCols(db)} FROM payout_accounts WHERE user_id = ${userId} AND disabled_at IS NULL ORDER BY is_default DESC, created_at`;
}

export async function getPayoutAccount(db: Db, userId: string, id: string, lock = false) {
  const [r] = lock
    ? await db<PayoutRow[]>`SELECT ${payoutCols(db)} FROM payout_accounts WHERE id = ${id} AND user_id = ${userId} AND disabled_at IS NULL FOR UPDATE`
    : await db<PayoutRow[]>`SELECT ${payoutCols(db)} FROM payout_accounts WHERE id = ${id} AND user_id = ${userId} AND disabled_at IS NULL`;
  return r;
}

/**
 * `payoutsFrom`: when the account may first receive a payout (new-account cooldown, money.policy.newPayoutAccountCooldownHours)
 * while that moment is still in the future; null once it passed (or without cooldown info).
 */
export function toPayoutDto(p: PayoutRow, cooldown?: { hours: number; now: Date }) {
  let payoutsFrom: string | null = null;
  if (cooldown) {
    const latest = Math.max(p.created_at.getTime(), p.verified_at?.getTime() ?? 0, p.default_since?.getTime() ?? 0);
    const ready = latest + Math.max(0, cooldown.hours) * 3600_000;
    if (ready > cooldown.now.getTime()) payoutsFrom = new Date(ready).toISOString();
  }
  return {
    id: p.id,
    bankCode: p.bank_code,
    accountMask: p.account_mask,
    holderName: p.holder_name,
    verificationStatus: p.verification_status,
    isDefault: p.is_default,
    verifiedAt: iso(p.verified_at),
    payoutsFrom,
    createdAt: iso(p.created_at)!,
  };
}
