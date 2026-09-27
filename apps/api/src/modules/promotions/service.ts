import { evaluatePromotions, type PromoCart } from '@jastipkita/core';
import type { AppDeps, AuthContext } from '../../context';
import type { TxSql } from '../../db/sql';
import { Errors } from '../../lib/errors';
import { audit } from '../../services/audit';
import { emitEvent } from '../../services/outbox';
import { grant } from '../credits/repository';
import { publicPromotion, toCorePromotion } from './mapper';
import * as repo from './repository';

const DEFAULT_CASHBACK_EXPIRY_DAYS = 90;
const PREVIEW_STATUSES = new Set(['MATCHED', 'AWAITING_PAYMENT']);

const REASON_TEXT: Record<string, string> = {
  UNKNOWN_CODE: 'Kode promo tidak ditemukan',
  NOT_ACTIVE: 'Promo sedang tidak aktif',
  OUTSIDE_DATE_WINDOW: 'Promo belum dimulai atau sudah berakhir',
  NOT_FIRST_TRANSACTION: 'Promo khusus transaksi pertama',
  ORIGIN_NOT_ELIGIBLE: 'Promo tidak berlaku untuk negara asal barang ini',
  CATEGORY_NOT_ELIGIBLE: 'Promo tidak berlaku untuk kategori barang ini',
  TRAVELER_NOT_ELIGIBLE: 'Promo tidak berlaku untuk traveler ini',
  SEGMENT_NOT_ELIGIBLE: 'Promo tidak berlaku untuk akunmu',
  BELOW_MIN_ITEM_VALUE: 'Nilai barang belum memenuhi minimum promo',
  PER_USER_LIMIT_REACHED: 'Kamu sudah memakai promo ini',
  GLOBAL_LIMIT_REACHED: 'Kuota promo sudah habis',
  BUDGET_EXHAUSTED: 'Kuota promo sudah habis',
  BUDGET_INSUFFICIENT: 'Kuota promo tidak mencukupi',
  NOT_STACKABLE: 'Promo lain yang lebih besar sudah berlaku (promo tidak bisa digabung)',
  NO_BENEFIT: 'Promo tidak memberi potongan untuk transaksi ini',
  MISCONFIGURED_BENEFIT: 'Promo tidak valid',
};

export async function listActive(deps: AppDeps) {
  const rows = await repo.activePromotions(deps.sql, deps.clock.now());
  return {
    data: rows
      .filter((r) => (r.conditions ?? {}).public !== false && r.type !== 'TRAVELER' && !Array.isArray((r.conditions ?? {}).userSegments))
      .map(publicPromotion)
      .filter((p) => p.benefit !== null),
  };
}

/**
 * Preview only — no redemption (money group reserves/redeems at checkout). Uses the transaction's
 * quote in effect and the same core engine and stacking rules as pricing.
 */
export async function validate(deps: AppDeps, auth: AuthContext, input: { transactionId: string; code: string }) {
  const t = await repo.transactionContext(deps.sql, input.transactionId);
  if (!t || t.buyer_id !== auth.userId) throw Errors.notFound('Transaksi', 'TRANSACTION_NOT_FOUND');
  if (!PREVIEW_STATUSES.has(t.status)) throw Errors.unprocessable('PROMO_NOT_APPLICABLE', 'Promo hanya bisa dicek sebelum pembayaran', { status: t.status });
  const lines = await repo.quoteLines(deps.sql, t.id, t.active_quote_id);
  if (lines.length === 0) throw Errors.unprocessable('QUOTE_REQUIRED', 'Buat rincian harga (quote) dulu sebelum memakai promo');
  const amt = (type: string) => {
    const l = lines.find((x) => x.line_type === type);
    if (!l) return 0;
    const original = l.meta?.originalAmountIdr;
    return typeof original === 'number' ? original : Number(l.amount_idr);
  };
  const now = deps.clock.now();
  const code = input.code.trim().toUpperCase();
  const cart: PromoCart = {
    itemValueIdr: amt('ITEM_PRICE'),
    travelerFeeIdr: amt('TRAVELER_FEE'),
    platformFeeIdr: amt('PLATFORM_FEE'),
    originCountry: t.origin_country ?? t.merchant_country ?? 'XX',
    categoryCode: t.category_code ?? 'OTHER',
    travelerId: t.traveler_id,
    enteredCodes: [code],
  };
  const promos = (await repo.activePromotions(deps.sql, now)).map(toCorePromotion).filter((p): p is NonNullable<typeof p> => p !== null);
  const user = {
    id: auth.userId,
    isFirstTransaction: !(await repo.hadEarlierPayment(deps.sql, auth.userId, t.id)),
    usageByPromo: await repo.usageByPromo(deps.sql, auth.userId, t.id),
  };
  const res = evaluatePromotions(cart, promos, user, now);
  const target = promos.find((p) => p.code?.toUpperCase() === code);
  const applied = target ? res.applied.find((a) => a.promoId === target.id) : undefined;
  const rejected = target ? res.rejected.find((r) => r.promoId === target.id) : res.rejected.find((r) => r.promoId === `code:${code}`);
  const others = res.applied.filter((a) => a.promoId !== target?.id).map((a) => ({ promotionId: a.promoId, type: a.type, discountIdr: a.discountIdr, cashbackIdr: a.cashbackIdr, freePlatformFee: a.freePlatformFee }));
  if (applied) {
    return {
      valid: true,
      code,
      promotionId: applied.promoId,
      type: applied.type,
      discountIdr: applied.discountIdr,
      cashbackIdr: applied.cashbackIdr,
      freePlatformFee: applied.freePlatformFee,
      budgetCapped: applied.budgetCapped,
      reason: null,
      message: applied.cashbackIdr > 0 ? 'Cashback diberikan sebagai JastipKita Credit setelah transaksi selesai' : 'Promo bisa dipakai saat checkout',
      otherApplied: others,
    };
  }
  const reason = rejected?.code ?? 'UNKNOWN_CODE';
  return {
    valid: false,
    code,
    promotionId: target?.id ?? null,
    type: target?.type ?? null,
    discountIdr: 0,
    cashbackIdr: 0,
    freePlatformFee: false,
    budgetCapped: false,
    reason,
    message: REASON_TEXT[reason] ?? 'Promo tidak bisa dipakai',
    otherApplied: others,
  };
}

/** Outbox (COMPLETED): cashback promotions redeemed on this transaction become PROMO_CASHBACK credit. */
export async function cashbackOnCompleted(deps: AppDeps, transactionId: string): Promise<void> {
  const [t] = await deps.sql<{ status: string; number: string }[]>`SELECT status, number FROM transactions WHERE id = ${transactionId}`;
  if (t?.status !== 'COMPLETED') return;
  const rows = await repo.cashbackRedemptions(deps.sql, transactionId);
  const now = deps.clock.now();
  for (const r of rows) {
    const days = typeof r.conditions?.cashbackExpiryDays === 'number' ? (r.conditions.cashbackExpiryDays as number) : DEFAULT_CASHBACK_EXPIRY_DAYS;
    const expiresAt = new Date(now.getTime() + days * 86400_000);
    await deps.sql.begin(async (tq) => {
      const tx = tq as unknown as TxSql;
      const id = await grant(tx, {
        userId: r.user_id,
        amountIdr: Number(r.amount_idr),
        reason: 'PROMO_CASHBACK',
        referenceType: 'promotion_redemption',
        referenceId: r.id,
        expiresAt,
        idempotencyKey: `cashback:${r.id}`,
        note: `cashback ${r.name}`.slice(0, 200),
        now,
      });
      if (id === null) return;
      await emitEvent(tx, 'credit', r.user_id, 'credit.cashback_granted', {
        userId: r.user_id,
        transactionId,
        redemptionId: r.id,
        promotionId: r.promotion_id,
        promotionName: r.name,
        amountIdr: Number(r.amount_idr),
        expiresAt: expiresAt.toISOString(),
      });
      await audit(tx, { actorType: 'JOB', actorId: null, action: 'credit.cashback_granted', entityType: 'promotion_redemption', entityId: r.id, after: { amountIdr: Number(r.amount_idr), creditEntryId: id }, meta: { transactionId } });
    });
  }
}
