import { assessRisk, assignVariant, evaluateReferralReward, type RiskSignals, type TransactionStatus } from '@jastipkita/core';
import type { AppDeps, AuthContext } from '../../context';
import type { TxSql } from '../../db/sql';
import { Errors } from '../../lib/errors';
import { audit } from '../../services/audit';
import { emitEvent } from '../../services/outbox';
import { recordRiskAssessment } from '../../services/risk';
import { grant } from '../credits/repository';
import { formatIdr, publicName } from '../notifications/templates/format';
import { deviceAccountStats, linkSignals } from '../trust/links';
import * as repo from './repository';

/** Referral may be applied up to 7 days after signup and before the first secured payment. */
export const APPLY_WINDOW_DAYS = 7;
/** ASSUMPTION: a PENDING referral expires if it does not qualify within 180 days (no config key yet). */
export const REFERRAL_TTL_DAYS = 180;

export function normalizeCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1');
}

export async function referralRiskSignals(deps: AppDeps, db: TxSql | AppDeps['sql'], referrerId: string, refereeId: string): Promise<RiskSignals> {
  const now = deps.clock.now();
  const [links, dev, last24h] = await Promise.all([
    linkSignals(db, referrerId, refereeId),
    deviceAccountStats(db, refereeId, now),
    repo.referralsSince(db, referrerId, new Date(now.getTime() - 86400_000)),
  ]);
  return {
    referral: { referrerId, refereeId, ...links, referrerReferralsLast24h: last24h },
    sharedDeviceAccounts: dev.sharedDeviceAccounts,
    accountsOnDevice: dev.accountsOnDevice,
    accountsCreatedFromDeviceLast24h: dev.accountsCreatedFromDeviceLast24h,
  };
}

export async function getMine(deps: AppDeps, auth: AuthContext) {
  const [me, buyerCfg, travelerCfg] = await Promise.all([repo.userBasics(deps.sql, auth.userId), deps.config.get('referral.buyer'), deps.config.get('referral.traveler')]);
  if (!me) throw Errors.notFound('Pengguna', 'USER_NOT_FOUND');
  const now = deps.clock.now();
  const [stats, list, mine] = await Promise.all([repo.referrerStats(deps.sql, auth.userId, now), repo.referralsOfReferrer(deps.sql, auth.userId), repo.referralOfReferee(deps.sql, auth.userId)]);
  const variant = buyerCfg.experiment.enabled ? assignVariant(auth.userId, buyerCfg.experiment.key, Object.keys(buyerCfg.experiment.variants)) : null;
  const buyerAmount = variant ? (buyerCfg.experiment.variants[variant] ?? buyerCfg.referrerCreditIdr) : null;
  return {
    code: me.referral_code,
    shareLink: `${deps.env.WEB_BASE_URL.replace(/\/+$/, '')}/r/${me.referral_code}`,
    programs: {
      buyer: {
        enabled: buyerCfg.enabled,
        referrerCreditIdr: buyerAmount ?? buyerCfg.referrerCreditIdr,
        refereeCreditIdr: buyerAmount ?? buyerCfg.refereeCreditIdr,
        minFirstTransactionIdr: buyerCfg.minFirstTransactionIdr,
        monthlyCapIdr: buyerCfg.monthlyCapIdr,
        creditExpiryDays: buyerCfg.creditExpiryDays,
        withdrawable: buyerCfg.withdrawable,
      },
      traveler: {
        enabled: travelerCfg.enabled,
        referrerCreditIdr: travelerCfg.referrerCreditIdr,
        requiredCompletedTransactions: travelerCfg.requiredCompletedTransactions,
        monthlyCapIdr: travelerCfg.monthlyCapIdr,
        creditExpiryDays: travelerCfg.creditExpiryDays,
        withdrawable: travelerCfg.withdrawable,
      },
    },
    stats: {
      invited: stats.invited,
      pending: stats.pending,
      underReview: stats.qualified,
      rewarded: stats.rewarded,
      rejected: stats.rejected,
      expired: stats.expired,
      totalEarnedIdr: Number(stats.total ?? 0),
      monthEarnedIdr: Number(stats.month ?? 0),
    },
    rewards: list.map((r) => ({
      referralId: r.id,
      program: r.program,
      status: r.status,
      refereeName: publicName(r.referee_name, 'Teman'),
      rewardIdr: Number(r.referrer_reward_idr),
      createdAt: r.created_at.toISOString(),
      rewardedAt: r.rewarded_at?.toISOString() ?? null,
    })),
    referredBy: mine ? { referralId: mine.id, program: mine.program, status: mine.status, rewardIdr: Number(mine.referee_reward_idr) } : null,
  };
}

export async function apply(deps: AppDeps, auth: AuthContext, input: { code: string; program?: 'BUYER' | 'TRAVELER' | undefined }) {
  const now = deps.clock.now();
  const code = normalizeCode(input.code);
  if (!/^[0-9A-Z]{4,16}$/.test(code)) throw Errors.unprocessable('REFERRAL_CODE_INVALID', 'Kode referral tidak valid');
  const me = await repo.userBasics(deps.sql, auth.userId);
  if (!me) throw Errors.notFound('Pengguna', 'USER_NOT_FOUND');
  if (me.referral_code === code) throw Errors.unprocessable('SELF_REFERRAL', 'Tidak bisa memakai kode referral sendiri');
  const referrer = await repo.userByReferralCode(deps.sql, code);
  if (!referrer || referrer.status !== 'ACTIVE') throw Errors.unprocessable('REFERRAL_CODE_INVALID', 'Kode referral tidak ditemukan');
  if (await repo.referralOfReferee(deps.sql, auth.userId)) throw Errors.conflict('REFERRAL_ALREADY_APPLIED', 'Kamu sudah memakai kode referral');
  if (now.getTime() - me.created_at.getTime() > APPLY_WINDOW_DAYS * 86400_000) {
    throw Errors.unprocessable('REFERRAL_WINDOW_CLOSED', `Kode referral hanya bisa dipakai dalam ${APPLY_WINDOW_DAYS} hari setelah mendaftar`);
  }
  if (await repo.hasSecuredPayment(deps.sql, auth.userId)) throw Errors.unprocessable('REFERRAL_NOT_NEW_USER', 'Kode referral hanya untuk pengguna baru sebelum transaksi pertama');
  const program = input.program ?? (me.active_mode === 'TRAVELER' ? 'TRAVELER' : 'BUYER');
  const [buyerCfg, travelerCfg, thresholds, versions] = await Promise.all([
    deps.config.get('referral.buyer'),
    deps.config.get('referral.traveler'),
    deps.config.get('risk.thresholds'),
    deps.config.versions([program === 'BUYER' ? 'referral.buyer' : 'referral.traveler']),
  ]);
  if (!(program === 'BUYER' ? buyerCfg.enabled : travelerCfg.enabled)) throw Errors.unprocessable('REFERRAL_PROGRAM_DISABLED', 'Program referral sedang tidak aktif');

  // Early fraud screen: identity reuse / self-referral is refused outright; weaker signals are
  // recorded and re-evaluated at reward time.
  const signals = await referralRiskSignals(deps, deps.sql, referrer.id, auth.userId);
  const risk = assessRisk('REFERRAL', signals, thresholds);
  if (risk.decision === 'BLOCK') {
    await recordRiskAssessment(deps.sql, 'USER', auth.userId, risk, { stage: 'REFERRAL_APPLY', ...signals });
    throw Errors.unprocessable('REFERRAL_NOT_ELIGIBLE', 'Kode referral tidak bisa dipakai untuk akun ini');
  }
  const variant = program === 'BUYER' && buyerCfg.experiment.enabled ? assignVariant(referrer.id, buyerCfg.experiment.key, Object.keys(buyerCfg.experiment.variants)) : null;

  const row = await deps.sql
    .begin(async (tq) => {
      const tx = tq as unknown as TxSql;
      const r = await repo.insertReferral(tx, {
        referrerId: referrer.id,
        refereeId: auth.userId,
        program,
        variant,
        configVersion: Object.values(versions)[0] ?? 0,
        fraudReasons: risk.reasons.map((x) => ({ code: x.code, stage: 'APPLY' })),
        expiresAt: new Date(now.getTime() + REFERRAL_TTL_DAYS * 86400_000),
        now,
      });
      await tx`UPDATE users SET referred_by = ${referrer.id} WHERE id = ${auth.userId} AND referred_by IS NULL`;
      // weaker signals are only noted (fraud_reasons, stage APPLY); the reward-time gate opens the RISK review
      await tx`
        INSERT INTO analytics_events (event_name, user_id, platform, properties, occurred_at, dedupe_key)
        VALUES ('referral_applied', ${auth.userId}, 'SERVER', ${tx.json({ program, source: 'server' } as never)}, ${now}, ${`srv:referral_applied:${r.id}`})
        ON CONFLICT DO NOTHING`;
      return r;
    })
    .catch((err: unknown) => {
      if ((err as { code?: string }).code === '23505') throw Errors.conflict('REFERRAL_ALREADY_APPLIED', 'Kamu sudah memakai kode referral');
      throw err;
    });
  return {
    referralId: row.id,
    program,
    status: row.status,
    variant,
    expiresAt: row.expires_at?.toISOString() ?? null,
    message:
      program === 'BUYER'
        ? `Kode berhasil dipakai. Kamu dan temanmu masing-masing mendapat credit setelah transaksi pertamamu (min. ${formatIdr(buyerCfg.minFirstTransactionIdr)}) selesai.`
        : `Kode berhasil dipakai. Temanmu mendapat credit setelah kamu menyelesaikan ${travelerCfg.requiredCompletedTransactions} transaksi sebagai traveler.`,
  };
}

/**
 * Outbox (transaction.status_changed → COMPLETED): evaluates the buyer program for the buyer and the
 * traveler program for the traveler. Fraud gate: core assessRisk(REFERRAL) — BLOCK/HOLD → REJECTED,
 * REVIEW → QUALIFIED (held for RISK review, released by the admin group), ALLOW → REWARDED + credit.
 * Idempotent: only PENDING referrals are processed (row lock), credits carry idempotency keys.
 */
export async function rewardOnCompleted(deps: AppDeps, transactionId: string): Promise<void> {
  const [t] = await deps.sql<{ id: string; status: string; buyer_id: string; traveler_id: string | null }[]>`
    SELECT id, status, buyer_id, traveler_id FROM transactions WHERE id = ${transactionId}`;
  if (!t || t.status !== 'COMPLETED') return;
  await evaluate(deps, t.id, t.buyer_id, 'BUYER');
  if (t.traveler_id) await evaluate(deps, t.id, t.traveler_id, 'TRAVELER');
}

async function evaluate(deps: AppDeps, txId: string, refereeId: string, program: 'BUYER' | 'TRAVELER') {
  const now = deps.clock.now();
  const [buyerCfg, travelerCfg, thresholds, versions] = await Promise.all([
    deps.config.get('referral.buyer'),
    deps.config.get('referral.traveler'),
    deps.config.get('risk.thresholds'),
    deps.config.versions([program === 'BUYER' ? 'referral.buyer' : 'referral.traveler']),
  ]);
  const cfg = { 'referral.buyer': buyerCfg, 'referral.traveler': travelerCfg };
  await deps.sql.begin(async (tq) => {
    const tx = tq as unknown as TxSql;
    const ref = await repo.pendingReferralForUpdate(tx, refereeId, program);
    if (!ref) return;
    const completed = program === 'TRAVELER' ? await repo.completedAsTraveler(tx, refereeId) : 0;
    // the traveler program waits for N completed transactions — not a rejection
    if (program === 'TRAVELER' && completed < travelerCfg.requiredCompletedTransactions) return;
    if (!(program === 'BUYER' ? buyerCfg.enabled : travelerCfg.enabled)) return; // paused program: keep PENDING

    const signals = await referralRiskSignals(deps, tx, ref.referrer_id, refereeId);
    const risk = assessRisk('REFERRAL', signals, thresholds);
    await recordRiskAssessment(tx, 'REFERRAL', ref.id, risk, { stage: 'REWARD', transactionId: txId, ...signals });
    const result = evaluateReferralReward(
      {
        program,
        referrer: { userId: ref.referrer_id },
        referee: { userId: refereeId, completedTransactions: completed },
        qualifyingTransaction: {
          id: txId,
          status: 'COMPLETED' as TransactionStatus,
          valueIdr: await repo.valueBeforeCredits(tx, txId),
          isRefereeFirstTransaction: program === 'BUYER' ? (await repo.firstCompletedAsBuyer(tx, refereeId)) === txId : true,
        },
        monthRewardedIdr: await repo.monthRewarded(tx, ref.referrer_id, program, now),
        signals: { decision: risk.decision },
        now,
      },
      cfg,
    );
    const reasons = [
      ...result.reasons.map((r) => ({ code: r.code, message: r.message })),
      ...risk.reasons.map((r) => ({ code: r.code, message: r.message, weight: r.weight, stage: 'RISK' })),
    ];
    if (result.status === 'REJECTED') {
      await repo.updateOutcome(tx, ref.id, { status: 'REJECTED', qualifyingTransactionId: null, referrerRewardIdr: 0, refereeRewardIdr: 0, reasons, now, rewarded: false, qualified: false });
      await audit(tx, { actorType: 'JOB', actorId: null, action: 'referral.rejected', entityType: 'referral', entityId: ref.id, after: { status: 'REJECTED', riskDecision: risk.decision, reasons: result.reasons.map((r) => r.code) } });
      return;
    }
    if (result.status === 'PENDING_REVIEW') {
      await repo.updateOutcome(tx, ref.id, {
        status: 'QUALIFIED',
        qualifyingTransactionId: txId,
        referrerRewardIdr: result.referrerRewardIdr,
        refereeRewardIdr: result.refereeRewardIdr,
        reasons,
        now,
        rewarded: false,
        qualified: true,
      });
      await audit(tx, { actorType: 'JOB', actorId: null, action: 'referral.held_for_review', entityType: 'referral', entityId: ref.id, after: { riskDecision: risk.decision, riskScore: risk.score } });
      return;
    }
    await repo.updateOutcome(tx, ref.id, {
      status: 'REWARDED',
      qualifyingTransactionId: txId,
      referrerRewardIdr: result.referrerRewardIdr,
      refereeRewardIdr: result.refereeRewardIdr,
      reasons,
      now,
      rewarded: true,
      qualified: true,
    });
    const recipients: [string, number, 'REFERRER' | 'REFEREE'][] = [
      [ref.referrer_id, result.referrerRewardIdr, 'REFERRER'],
      [refereeId, result.refereeRewardIdr, 'REFEREE'],
    ];
    for (const [userId, amount, role] of recipients) {
      if (amount <= 0) continue;
      const id = await grant(tx, {
        userId,
        amountIdr: amount,
        reason: 'REFERRAL_REWARD',
        referenceType: 'referral',
        referenceId: ref.id,
        expiresAt: result.expiresAt,
        idempotencyKey: `referral:${ref.id}:${role.toLowerCase()}`,
        note: `referral ${program} ${role.toLowerCase()} reward (config v${Object.values(versions)[0] ?? 0})`,
        now,
      });
      if (id !== null) {
        await emitEvent(tx, 'referral', ref.id, 'referral.rewarded', {
          referralId: ref.id,
          userId,
          amountIdr: amount,
          role,
          program,
          expiresAt: result.expiresAt?.toISOString() ?? null,
        });
      }
    }
    await audit(tx, {
      actorType: 'JOB',
      actorId: null,
      action: 'referral.rewarded',
      entityType: 'referral',
      entityId: ref.id,
      after: { referrerRewardIdr: result.referrerRewardIdr, refereeRewardIdr: result.refereeRewardIdr, cappedByMonthlyLimit: result.cappedByMonthlyLimit, variant: result.variant },
      meta: { program, transactionId: txId, riskDecision: risk.decision },
    });
  });
}

export async function runReferralExpiry(deps: AppDeps) {
  return { expired: await repo.expirePending(deps.sql, deps.clock.now()) };
}
