/**
 * Admin · Growth.
 * Promotions (promotions.manage): CRUD with the JSON conditions/benefit contract of docs/api/engagement.md §7
 * (benefit validated with engagement's toBenefit mapper), activate (maker-checker: approved_by = activator ≠ creator,
 * DB CHECK; fresh MFA) / pause / end, budget & usage from promotion_redemptions.
 * Referral program (referrals.manage): unit-economics stats (engagement guardrail metrics + conversion, repeat, gross
 * margin), referral list, reject, hold (QUALIFIED awaiting release) and release (QUALIFIED → REWARDED + credits, once
 * RISK cleared the review). Reward amounts/caps change only through the business-config workflow.
 */
import { unitEconomicsGuardrail } from '@jastipkita/core';
import type { TxSql } from '../../../db/sql';
import { Errors } from '../../../lib/errors';
import { emitEvent } from '../../../services/outbox';
import { recordRiskAssessment } from '../../../services/risk';
import { grant } from '../../credits/repository';
import { toBenefit } from '../../promotions/mapper';
import { computeReferralEconomics } from '../../referrals/guardrail';
import { type AdminCtx, adminAudit, inAdminTx, iso, makerChecker, maskName, num, parseCsv } from '../common';

const PROMO_STATUSES = ['DRAFT', 'ACTIVE', 'PAUSED', 'ENDED'] as const;

interface PromoRow {
  id: string;
  code: string | null;
  name: string;
  description: string | null;
  type: string;
  conditions: Record<string, unknown>;
  benefit: Record<string, unknown>;
  budget_total_idr: number | null;
  budget_used_idr: number;
  usage_limit_total: number | null;
  usage_count: number;
  usage_limit_per_user: number | null;
  starts_at: Date;
  ends_at: Date | null;
  status: string;
  funded_by: string;
  created_by: string | null;
  approved_by: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
  reserved?: number;
  applied?: number;
  reversed?: number;
  applied_idr?: number;
}

function promoDto(p: PromoRow) {
  const budget = p.budget_total_idr === null ? null : num(p.budget_total_idr);
  const used = num(p.budget_used_idr);
  return {
    id: p.id,
    code: p.code,
    name: p.name,
    description: p.description,
    type: p.type,
    conditions: p.conditions,
    benefit: p.benefit,
    status: p.status,
    fundedBy: p.funded_by,
    startsAt: iso(p.starts_at)!,
    endsAt: iso(p.ends_at),
    budget: { totalIdr: budget, usedIdr: used, remainingIdr: budget === null ? null : budget - used, usedRatio: budget ? Math.round((used / budget) * 10000) / 10000 : null },
    usage: {
      count: p.usage_count,
      limitTotal: p.usage_limit_total,
      limitPerUser: p.usage_limit_per_user,
      redemptions: { reserved: p.reserved ?? 0, applied: p.applied ?? 0, reversed: p.reversed ?? 0, appliedIdr: num(p.applied_idr) },
    },
    createdBy: p.created_by,
    approvedBy: p.approved_by,
    version: p.version,
    createdAt: iso(p.created_at)!,
    updatedAt: iso(p.updated_at)!,
  };
}

const PROMO_SELECT = (db: AdminCtx['deps']['sql']) => db`
  SELECT p.*,
         (SELECT count(*) FROM promotion_redemptions r WHERE r.promotion_id = p.id AND r.status = 'RESERVED')::int AS reserved,
         (SELECT count(*) FROM promotion_redemptions r WHERE r.promotion_id = p.id AND r.status = 'APPLIED')::int AS applied,
         (SELECT count(*) FROM promotion_redemptions r WHERE r.promotion_id = p.id AND r.status = 'REVERSED')::int AS reversed,
         (SELECT coalesce(sum(amount_idr), 0) FROM promotion_redemptions r WHERE r.promotion_id = p.id AND r.status = 'APPLIED')::bigint AS applied_idr
    FROM promotions p`;

export async function listPromotions(ctx: AdminCtx, status?: string) {
  const db = ctx.deps.sql;
  const statuses = parseCsv(status, PROMO_STATUSES, 'status');
  const r = await db<PromoRow[]>`${PROMO_SELECT(db)} ${statuses ? db`WHERE p.status = ANY(${statuses}::text[])` : db``} ORDER BY p.created_at DESC LIMIT 200`;
  return { data: r.map(promoDto), nextCursor: null };
}

async function loadPromo(db: AdminCtx['deps']['sql'] | TxSql, id: string): Promise<PromoRow> {
  const [p] = await db<PromoRow[]>`${PROMO_SELECT(db as AdminCtx['deps']['sql'])} WHERE p.id = ${id}`;
  if (!p) throw Errors.notFound('Promo', 'PROMOTION_NOT_FOUND');
  return p;
}

export async function promotionDetail(ctx: AdminCtx, id: string) {
  return promoDto(await loadPromo(ctx.deps.sql, id));
}

export interface PromoInput {
  code?: string | null | undefined;
  name?: string | undefined;
  description?: string | null | undefined;
  type?: string | undefined;
  conditions?: Record<string, unknown> | undefined;
  benefit?: Record<string, unknown> | undefined;
  budgetTotalIdr?: number | null | undefined;
  usageLimitTotal?: number | null | undefined;
  usageLimitPerUser?: number | null | undefined;
  startsAt?: string | undefined;
  endsAt?: string | null | undefined;
  fundedBy?: string | undefined;
}

function assertBenefit(b: Record<string, unknown> | undefined) {
  if (b !== undefined && !toBenefit(b)) {
    throw Errors.unprocessable('PROMO_BENEFIT_INVALID', 'Format benefit tidak valid (lihat docs/api/engagement.md §7)', { benefit: b });
  }
}

function columns(i: PromoInput): Record<string, unknown> {
  const map: [keyof PromoInput, string][] = [
    ['code', 'code'], ['name', 'name'], ['description', 'description'], ['type', 'type'], ['conditions', 'conditions'], ['benefit', 'benefit'],
    ['budgetTotalIdr', 'budget_total_idr'], ['usageLimitTotal', 'usage_limit_total'], ['usageLimitPerUser', 'usage_limit_per_user'],
    ['startsAt', 'starts_at'], ['endsAt', 'ends_at'], ['fundedBy', 'funded_by'],
  ];
  const out: Record<string, unknown> = {};
  for (const [k, col] of map) if (i[k] !== undefined) out[col] = i[k];
  return out;
}

function jsonify(tx: TxSql, v: Record<string, unknown>): Record<string, unknown> {
  const out = { ...v };
  for (const k of ['conditions', 'benefit']) if (out[k] !== undefined) out[k] = tx.json(out[k] as never);
  return out;
}

export async function createPromotion(ctx: AdminCtx, input: PromoInput & { name: string; type: string; benefit: Record<string, unknown>; startsAt: string }) {
  assertBenefit(input.benefit);
  if (input.type === 'PROMO_CODE' && !input.code) throw Errors.validation({ issues: [{ path: 'code', message: 'PROMO_CODE membutuhkan code' }] });
  const id = await inAdminTx(ctx, async (tx) => {
    const values = jsonify(tx, { ...columns(input), conditions: input.conditions ?? {}, status: 'DRAFT', created_by: ctx.auth.userId });
    const [p] = await tx<{ id: string }[]>`INSERT INTO promotions ${tx(values as never)} RETURNING id`;
    await adminAudit(tx, ctx, { action: 'promotions.created', entityType: 'promotion', entityId: p!.id, after: { name: input.name, type: input.type, benefit: input.benefit, budgetTotalIdr: input.budgetTotalIdr ?? null, status: 'DRAFT' } });
    return p!.id;
  });
  return promotionDetail(ctx, id);
}

export async function updatePromotion(ctx: AdminCtx, id: string, patch: PromoInput) {
  assertBenefit(patch.benefit);
  await inAdminTx(ctx, async (tx) => {
    const [cur] = await tx<PromoRow[]>`SELECT * FROM promotions WHERE id = ${id} FOR UPDATE`;
    if (!cur) throw Errors.notFound('Promo', 'PROMOTION_NOT_FOUND');
    if (cur.status === 'ENDED') throw Errors.unprocessable('PROMOTION_ENDED', 'Promo sudah berakhir');
    if (cur.status === 'ACTIVE') throw Errors.unprocessable('PROMOTION_ACTIVE', 'Jeda (pause) promo dulu sebelum mengubahnya');
    if (patch.budgetTotalIdr !== undefined && patch.budgetTotalIdr !== null && patch.budgetTotalIdr < num(cur.budget_used_idr)) {
      throw Errors.unprocessable('BUDGET_BELOW_USED', 'Budget tidak boleh di bawah yang sudah terpakai', { usedIdr: num(cur.budget_used_idr) });
    }
    const values = jsonify(tx, columns(patch));
    if (!Object.keys(values).length) throw Errors.validation({ issues: [{ path: '', message: 'tidak ada perubahan' }] });
    await tx`UPDATE promotions SET ${tx(values as never, ...Object.keys(values))}, version = version + 1 WHERE id = ${id}`;
    await adminAudit(tx, ctx, { action: 'promotions.updated', entityType: 'promotion', entityId: id, before: Object.fromEntries(Object.keys(values).map((k) => [k, (cur as unknown as Record<string, unknown>)[k] ?? null])), after: columns(patch), meta: { version: cur.version + 1 } });
  });
  return promotionDetail(ctx, id);
}

export async function setPromotionStatus(ctx: AdminCtx, id: string, to: 'ACTIVE' | 'PAUSED' | 'ENDED', reason?: string) {
  const now = ctx.deps.clock.now();
  await inAdminTx(ctx, async (tx) => {
    const [cur] = await tx<PromoRow[]>`SELECT * FROM promotions WHERE id = ${id} FOR UPDATE`;
    if (!cur) throw Errors.notFound('Promo', 'PROMOTION_NOT_FOUND');
    const allowed: Record<string, string[]> = { ACTIVE: ['DRAFT', 'PAUSED'], PAUSED: ['ACTIVE'], ENDED: ['DRAFT', 'ACTIVE', 'PAUSED'] };
    if (!allowed[to]!.includes(cur.status)) throw Errors.unprocessable('PROMOTION_TRANSITION_NOT_ALLOWED', `Tidak dapat mengubah ${cur.status} → ${to}`);
    if (to === 'ACTIVE') {
      makerChecker(cur.created_by, ctx.auth.userId, 'Promo harus diaktifkan oleh admin yang berbeda dari pembuatnya (maker-checker)');
      if (cur.ends_at && cur.ends_at <= now) throw Errors.unprocessable('PROMOTION_EXPIRED', 'Tanggal berakhir promo sudah lewat');
      if (!toBenefit(cur.benefit)) throw Errors.unprocessable('PROMO_BENEFIT_INVALID', 'Format benefit tidak valid');
      await tx`UPDATE promotions SET status = 'ACTIVE', approved_by = ${ctx.auth.userId} WHERE id = ${id}`;
    } else {
      await tx`UPDATE promotions SET status = ${to} ${to === 'ENDED' && (!cur.ends_at || cur.ends_at > now) && cur.starts_at < now ? tx`, ends_at = ${now}` : tx``} WHERE id = ${id}`;
    }
    await adminAudit(tx, ctx, { action: `promotions.${to === 'ACTIVE' ? 'activated' : to === 'PAUSED' ? 'paused' : 'ended'}`, entityType: 'promotion', entityId: id, before: { status: cur.status }, after: { status: to }, meta: { reason: reason ?? null, makerId: cur.created_by } });
  });
  return promotionDetail(ctx, id);
}

// ------------------------------------------------------------------ referrals

export async function referralStats(ctx: AdminCtx) {
  const db = ctx.deps.sql;
  const m = await computeReferralEconomics(ctx.deps);
  const since = new Date(ctx.deps.clock.now().getTime() - 90 * 86400_000);
  const [c] = await db<{ total: number; qualified: number; rewarded: number; rejected: number; expired: number; pending: number; repeat: number; contribution: number }[]>`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE status IN ('QUALIFIED','REWARDED'))::int AS qualified,
           count(*) FILTER (WHERE status = 'REWARDED')::int AS rewarded,
           count(*) FILTER (WHERE status = 'REJECTED')::int AS rejected,
           count(*) FILTER (WHERE status = 'EXPIRED')::int AS expired,
           count(*) FILTER (WHERE status = 'PENDING')::int AS pending,
           count(*) FILTER (WHERE (SELECT count(*) FROM transactions t WHERE t.buyer_id = r.referee_id AND t.status = 'COMPLETED') >= 2)::int AS repeat,
           coalesce((SELECT sum(v.platform_revenue_idr - v.promo_cost_idr) FROM v_completed_transaction_lines v JOIN transactions t ON t.id = v.transaction_id
                      WHERE t.buyer_id IN (SELECT referee_id FROM referrals x WHERE x.created_at >= ${since})), 0)::bigint AS contribution
      FROM referrals r WHERE r.created_at >= ${since}`;
  const guardrails = (await ctx.deps.config.get('referral.buyer')).guardrails;
  const verdict = unitEconomicsGuardrail({ cac: m.cac, ltv: m.ltv, fraudRate: m.fraudRate }, guardrails);
  const total = c?.total ?? 0;
  const metric = (value: number | null, definition: string, sample: number) => ({ value, definition, sampleSize: sample, dataQuality: sample === 0 ? 'Belum ada data.' : sample < 30 ? `Sampel kecil (n=${sample}).` : null });
  return {
    windowDays: 90,
    metrics: {
      cacProxyIdr: metric(m.cac, 'Σ credit REFERRAL_REWARD 90 hari ÷ referral REWARDED 90 hari (engagement guardrail).', m.rewardedReferrals),
      ltvProxyIdr: metric(m.ltv, 'Σ (platform revenue − promo) transaksi COMPLETED 180 hari ÷ pembeli berbeda (lantai konservatif).', m.rewardedReferrals),
      conversion: metric(total > 0 ? Math.round(((c?.qualified ?? 0) / total) * 10000) / 10000 : null, 'Referral QUALIFIED/REWARDED ÷ referral dibuat (90 hari).', total),
      fraudRate: metric(Math.round(m.fraudRate * 10000) / 10000, 'Referral dinilai saat reward dengan keputusan risiko ≠ ALLOW ÷ semua yang dinilai (90 hari).', m.evaluatedReferrals),
      repeatRate: metric(total > 0 ? Math.round(((c?.repeat ?? 0) / total) * 10000) / 10000 : null, 'Referee dengan ≥ 2 transaksi COMPLETED sebagai pembeli ÷ referral dibuat (90 hari).', total),
      grossMarginIdr: metric(num(c?.contribution) - m.referralCreditIdr, 'Kontribusi (platform revenue − promo) transaksi referee − biaya credit referral (90 hari).', total),
    },
    counts: { total, pending: c?.pending ?? 0, qualified: c?.qualified ?? 0, rewarded: c?.rewarded ?? 0, rejected: c?.rejected ?? 0, expired: c?.expired ?? 0 },
    guardrail: { allowIncrease: verdict.allowIncrease, cacToLtv: Number.isFinite(verdict.cacToLtv) ? verdict.cacToLtv : null, reasons: verdict.reasons.map((r) => r.code), thresholds: guardrails },
    note: 'Nominal reward & batas bulanan hanya diubah lewat business config (referral.buyer / referral.traveler, maker-checker).',
  };
}

interface ReferralRow {
  id: string;
  referrer_id: string;
  referee_id: string;
  program: string;
  status: string;
  qualifying_transaction_id: string | null;
  referrer_reward_idr: number;
  referee_reward_idr: number;
  fraud_reasons: unknown[];
  created_at: Date;
  qualified_at: Date | null;
  rewarded_at: Date | null;
  referrer_name?: string | null;
  referee_name?: string | null;
  open_reviews?: number;
}

function referralDto(r: ReferralRow) {
  const reasons = Array.isArray(r.fraud_reasons) ? r.fraud_reasons : [];
  return {
    id: r.id,
    program: r.program,
    status: r.status,
    referrer: { id: r.referrer_id, displayName: maskName(r.referrer_name ?? null) },
    referee: { id: r.referee_id, displayName: maskName(r.referee_name ?? null) },
    qualifyingTransactionId: r.qualifying_transaction_id,
    referrerRewardIdr: num(r.referrer_reward_idr),
    refereeRewardIdr: num(r.referee_reward_idr),
    fraudReasons: reasons,
    adminHold: reasons.some((x) => (x as { code?: string }).code === 'ADMIN_HOLD'),
    openRiskReviews: r.open_reviews ?? 0,
    createdAt: iso(r.created_at)!,
    qualifiedAt: iso(r.qualified_at),
    rewardedAt: iso(r.rewarded_at),
  };
}

export async function listReferrals(ctx: AdminCtx, status?: string) {
  const db = ctx.deps.sql;
  const statuses = parseCsv(status, ['PENDING', 'QUALIFIED', 'REWARDED', 'REJECTED', 'EXPIRED'] as const, 'status');
  const r = await db<ReferralRow[]>`
    SELECT r.*, a.display_name AS referrer_name, b.display_name AS referee_name,
           (SELECT count(*) FROM risk_reviews rv WHERE rv.subject_type = 'REFERRAL' AND rv.subject_id = r.id AND rv.status IN ('OPEN','IN_REVIEW'))::int AS open_reviews
      FROM referrals r JOIN users a ON a.id = r.referrer_id JOIN users b ON b.id = r.referee_id
     ${statuses ? db`WHERE r.status = ANY(${statuses}::text[])` : db``}
     ORDER BY r.created_at DESC LIMIT 200`;
  return { data: r.map(referralDto), nextCursor: null };
}

async function lockReferral(tx: TxSql, id: string): Promise<ReferralRow> {
  const [r] = await tx<ReferralRow[]>`SELECT * FROM referrals WHERE id = ${id} FOR UPDATE`;
  if (!r) throw Errors.notFound('Referral', 'REFERRAL_NOT_FOUND');
  return r;
}

export async function rejectReferral(ctx: AdminCtx, id: string, reason: string) {
  const now = ctx.deps.clock.now();
  await inAdminTx(ctx, async (tx) => {
    const r = await lockReferral(tx, id);
    if (!['PENDING', 'QUALIFIED'].includes(r.status)) throw Errors.unprocessable('REFERRAL_NOT_REJECTABLE', 'Referral yang sudah di-reward/ditutup tidak dapat ditolak', { status: r.status });
    const reasons = [...(Array.isArray(r.fraud_reasons) ? r.fraud_reasons : []), { code: 'ADMIN_REJECTED', message: reason, by: ctx.auth.userId, at: now.toISOString() }];
    await tx`UPDATE referrals SET status = 'REJECTED', fraud_reasons = ${tx.json(reasons as never)} WHERE id = ${id}`;
    await adminAudit(tx, ctx, { action: 'referrals.rejected', entityType: 'referral', entityId: id, before: { status: r.status }, after: { status: 'REJECTED' }, meta: { reason } });
  });
  return { id, status: 'REJECTED' };
}

export async function holdReferral(ctx: AdminCtx, id: string, reason: string) {
  const now = ctx.deps.clock.now();
  await inAdminTx(ctx, async (tx) => {
    const r = await lockReferral(tx, id);
    if (r.status !== 'QUALIFIED') throw Errors.unprocessable('REFERRAL_NOT_QUALIFIED', 'Hold hanya untuk referral QUALIFIED yang menunggu rilis reward; tolak referral PENDING yang mencurigakan', { status: r.status });
    const reasons = [...(Array.isArray(r.fraud_reasons) ? r.fraud_reasons : []), { code: 'ADMIN_HOLD', message: reason, by: ctx.auth.userId, at: now.toISOString() }];
    await tx`UPDATE referrals SET fraud_reasons = ${tx.json(reasons as never)} WHERE id = ${id}`;
    const [open] = await tx`SELECT 1 FROM risk_reviews WHERE subject_type = 'REFERRAL' AND subject_id = ${id} AND status IN ('OPEN','IN_REVIEW')`;
    if (!open) {
      await recordRiskAssessment(tx, 'REFERRAL', id, { score: 50, decision: 'REVIEW', reasons: [{ code: 'ADMIN_HOLD', message: reason }] }, { stage: 'ADMIN_HOLD', by: ctx.auth.userId }, 'admin-manual');
    }
    await adminAudit(tx, ctx, { action: 'referrals.held', entityType: 'referral', entityId: id, meta: { reason } });
  });
  return { id, status: 'QUALIFIED', adminHold: true };
}

export async function releaseReferral(ctx: AdminCtx, id: string, note: string) {
  const now = ctx.deps.clock.now();
  const out = await inAdminTx(ctx, async (tx) => {
    const r = await lockReferral(tx, id);
    if (r.status !== 'QUALIFIED') throw Errors.unprocessable('REFERRAL_NOT_QUALIFIED', 'Hanya referral QUALIFIED yang dapat dirilis', { status: r.status });
    const reviews = await tx<{ id: string }[]>`SELECT id FROM risk_reviews WHERE subject_type = 'REFERRAL' AND subject_id = ${id} AND status IN ('OPEN','IN_REVIEW')`;
    if (reviews.length) throw Errors.unprocessable('RISK_REVIEW_OPEN', 'Review risiko referral ini masih terbuka; minta tim Risk menyelesaikan (CLEARED) dulu', { reviewIds: reviews.map((x) => x.id) });
    const cfg = await ctx.deps.config.get(r.program === 'TRAVELER' ? 'referral.traveler' : 'referral.buyer');
    const expiresAt = new Date(now.getTime() + cfg.creditExpiryDays * 86400_000);
    const reasons = (Array.isArray(r.fraud_reasons) ? r.fraud_reasons : []).filter((x) => (x as { code?: string }).code !== 'ADMIN_HOLD');
    await tx`UPDATE referrals SET status = 'REWARDED', rewarded_at = ${now}, fraud_reasons = ${tx.json([...reasons, { code: 'ADMIN_RELEASED', message: note, by: ctx.auth.userId, at: now.toISOString() }] as never)} WHERE id = ${id}`;
    const granted: { userId: string; amountIdr: number; role: string }[] = [];
    for (const [userId, amount, role] of [[r.referrer_id, num(r.referrer_reward_idr), 'REFERRER'], [r.referee_id, num(r.referee_reward_idr), 'REFEREE']] as const) {
      if (amount <= 0) continue;
      const entry = await grant(tx, { userId, amountIdr: amount, reason: 'REFERRAL_REWARD', referenceType: 'referral', referenceId: id, expiresAt, idempotencyKey: `referral:${id}:${role.toLowerCase()}`, note: `referral ${r.program} ${role.toLowerCase()} reward (admin release)`, now });
      if (entry !== null) {
        await emitEvent(tx, 'referral', id, 'referral.rewarded', { referralId: id, userId, amountIdr: amount, role, program: r.program, expiresAt: expiresAt.toISOString() });
        granted.push({ userId, amountIdr: amount, role });
      }
    }
    await adminAudit(tx, ctx, { action: 'referrals.released', entityType: 'referral', entityId: id, before: { status: 'QUALIFIED' }, after: { status: 'REWARDED', granted }, meta: { note } });
    return granted;
  });
  return { id, status: 'REWARDED', granted: out };
}
