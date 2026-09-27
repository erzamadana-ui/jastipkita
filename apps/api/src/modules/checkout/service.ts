/**
 * Quote (transparent landed-cost breakdown, §10) and checkout (SafePay payment creation).
 */
import {
  buildQuote,
  computePaymentFee,
  computeRateFee,
  convert,
  invertRate,
  type PaymentFeesConfig,
  type Quote,
  type RiskLevel,
} from '@jastipkita/core';
import type { AppDeps, AuthContext } from '../../context';
import type { TxSql } from '../../db/sql';
import { AppError, Errors } from '../../lib/errors';
import { CHANNEL_LIMITS, PAYMENT_CHANNELS, channelSupportsProviderRefund } from '../../providers/payment/channels';
import { audit } from '../../services/audit';
import { emitEvent } from '../../services/outbox';
import { createPayment } from '../payments/service';
import { paymentView } from '../payments/repository';
import { assertCanTransition, requireParty, setDbActor, transitionTx, withCore } from '../transactions/common';
import {
  availableCredit,
  checkUserLimit,
  classifyFromDb,
  estimateCustomsFromDb,
  evaluatePromos,
  findSpotRate,
  lockFx,
} from './adapters';
import { loadQuote, loadRequest, loadTrip, type LoadedQuote, type PaymentOptionView, type QuoteMeta } from './repository';

export interface QuoteRequest {
  channel?: string | undefined;
  promoCode?: string | undefined;
  useCredit?: boolean | undefined;
}

const PRICING_KEYS = [
  'pricing.platform_fee',
  'pricing.protection_fee',
  'pricing.service_tax',
  'pricing.payment_fees',
  'pricing.traveler_fee_bounds',
  'pricing.minimum_transaction',
  'pricing.fx_markup',
  'fx.lock',
  'limits.transaction',
] as const;

/**
 * Fee & total for every configured payment channel, from the same core engine as the PAYMENT_FEE line: the fee is
 * the last component of the total, so each option = (TOTAL − PAYMENT_FEE of the priced channel) + that channel's fee.
 * `refundable` follows the provider capability (VA / retail outlets cannot be refunded by Xendit — refunds go out
 * as a payout to the buyer's bank account); limits are the per-transaction channel caps (QRIS Rp10.000.000).
 */
export function paymentOptionsFor(payableBeforeFeeIdr: number, fees: PaymentFeesConfig, selectedChannel: string): PaymentOptionView[] {
  // stable display order (jsonb does not keep key order): known channel groups first, then the rest by name
  const rank = (c: string) => {
    const i = (PAYMENT_CHANNELS as readonly string[]).indexOf(c);
    return i === -1 ? PAYMENT_CHANNELS.length : i;
  };
  const channels = Object.entries(fees.channels).sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b));
  return channels.map(([channel, cfg]) => {
    const fee = computePaymentFee(payableBeforeFeeIdr, cfg);
    const totalIdr = payableBeforeFeeIdr + fee.chargedIdr;
    const lim = CHANNEL_LIMITS[channel];
    const unavailableReason = lim && totalIdr > lim.maxIdr ? 'ABOVE_CHANNEL_MAX' : lim && totalIdr < lim.minIdr ? 'BELOW_CHANNEL_MIN' : null;
    return {
      channel,
      label: cfg.label,
      feeIdr: fee.chargedIdr,
      totalIdr,
      bearer: cfg.bearer,
      refundable: channelSupportsProviderRefund(channel),
      minAmountIdr: lim?.minIdr ?? null,
      maxAmountIdr: lim?.maxIdr ?? null,
      available: unavailableReason === null,
      unavailableReason,
      selected: channel === selectedChannel,
    };
  });
}

function usdValueString(itemIdrAtSpot: number, usdToIdr: string | null): string | null {
  if (!usdToIdr) return null;
  const cents = convert(itemIdrAtSpot, 'IDR', 'USD', invertRate(usdToIdr));
  return (cents / 100).toFixed(2);
}

/** BUG-QA-02: no quote/checkout for a transaction whose trip is cancelled or already completed. */
function assertTripPayable(tripStatus: string) {
  if (tripStatus === 'CANCELLED' || tripStatus === 'COMPLETED') {
    throw Errors.unprocessable('TRIP_NOT_AVAILABLE', 'Trip traveler sudah dibatalkan/selesai; transaksi ini tidak dapat dibayar', { tripStatus });
  }
}

export async function createQuote(deps: AppDeps, auth: AuthContext, id: string, input: QuoteRequest) {
  const now = deps.clock.now();
  const { tx } = await requireParty(deps.sql, id, auth, { role: 'BUYER' });
  if (tx.status !== 'MATCHED') {
    throw Errors.unprocessable('QUOTE_NOT_ALLOWED', 'Penawaran harga hanya dapat dibuat saat transaksi berstatus MATCHED', { status: tx.status });
  }
  const req = await loadRequest(deps.sql, tx.requestId);
  const trip = tx.tripId ? await loadTrip(deps.sql, tx.tripId) : null;
  if (!req || !trip || !tx.offerId || !tx.travelerId) throw Errors.unprocessable('TRANSACTION_INCOMPLETE', 'Data transaksi belum lengkap');
  assertTripPayable(trip.status);
  if (req.unitPriceMinor === null || !req.priceCurrency) throw Errors.unprocessable('ITEM_PRICE_MISSING', 'Harga barang belum diisi pada request');
  if (!req.categoryCode) throw Errors.unprocessable('CATEGORY_REQUIRED', 'Kategori barang wajib diisi');
  const [offer] = await deps.sql<{ traveler_fee_idr: number }[]>`SELECT traveler_fee_idr FROM offers WHERE id = ${tx.offerId}`;
  const [cat] = await deps.sql<{ risk_level: RiskLevel }[]>`SELECT risk_level FROM product_categories WHERE code = ${req.categoryCode}`;
  const origin = req.merchantCountry ?? trip.originCountry;
  const [country] = await deps.sql<{ risk_level: RiskLevel }[]>`SELECT risk_level FROM countries WHERE code = ${origin}`;
  const currency = req.priceCurrency;
  const quantity = req.quantity;
  const itemTotalMinor = req.unitPriceMinor * quantity;
  const cfg = {
    'pricing.platform_fee': await deps.config.get('pricing.platform_fee'),
    'pricing.protection_fee': await deps.config.get('pricing.protection_fee'),
    'pricing.service_tax': await deps.config.get('pricing.service_tax'),
    'pricing.payment_fees': await deps.config.get('pricing.payment_fees'),
    'pricing.traveler_fee_bounds': await deps.config.get('pricing.traveler_fee_bounds'),
    'pricing.minimum_transaction': await deps.config.get('pricing.minimum_transaction'),
  };
  const channel = input.channel ?? cfg['pricing.payment_fees'].defaultChannel;
  if (!cfg['pricing.payment_fees'].channels[channel]) {
    throw Errors.unprocessable('UNKNOWN_PAYMENT_CHANNEL', 'Metode pembayaran tidak tersedia', { channel, available: Object.keys(cfg['pricing.payment_fees'].channels) });
  }

  const computed = await withCore(async () => {
    // 1. FX lock (markup from config) — IDR items need none.
    const fx = currency === 'IDR' ? null : await lockFx(deps, currency, now);
    const usd = currency === 'USD' ? fx?.spot ?? null : await findSpotRate(deps.sql, 'USD', 'IDR');
    const itemIdrSpot = currency === 'IDR' ? itemTotalMinor : convert(itemTotalMinor, currency, 'IDR', fx!.spot.rate);
    const itemIdr = currency === 'IDR' ? itemTotalMinor : convert(itemTotalMinor, currency, 'IDR', fx!.lock.lockedRate);
    // 2. Customs estimate (NON_PERSONAL); NO_RULE blocks.
    const customs = await estimateCustomsFromDb(deps.sql, {
      originCountry: origin,
      destinationCountry: req.destinationCountry,
      hsCode: req.hsCode,
      categoryCode: req.categoryCode!,
      unitPriceMinor: req.unitPriceMinor!,
      currency,
      quantity,
      itemToIdr: fx ? fx.spot.rate : null,
      usdToIdr: usd?.rate ?? null,
      now,
    });
    if (customs.ruleId === null) {
      throw new AppError(422, 'CUSTOMS_NO_RULE', 'Aturan bea & pajak untuk barang ini belum tersedia; checkout diblokir', { warnings: customs.warnings });
    }
    // 3. Restricted items: PROHIBITED blocks; others need acknowledgement at checkout.
    const restricted = await classifyFromDb(
      deps.sql,
      { origin, destination: req.destinationCountry, categoryCode: req.categoryCode!, hsCode: req.hsCode, productName: req.productName, quantity, valueUsd: usdValueString(itemIdrSpot, usd?.rate ?? null) },
      now,
    );
    if (restricted.blocksCheckout) {
      throw new AppError(422, 'ITEM_PROHIBITED', restricted.messagesId[0] ?? 'Barang ini dilarang', {
        classification: restricted.classification,
        messagesId: restricted.messagesId,
        rules: restricted.matches.map((m) => m.code),
      });
    }
    // 4. Promotions & credit.
    const promotion = await evaluatePromos(deps.sql, {
      userId: auth.userId,
      transactionId: tx.id,
      promoCode: input.promoCode ?? null,
      cart: {
        itemValueIdr: itemIdr,
        travelerFeeIdr: offer?.traveler_fee_idr ?? 0,
        platformFeeIdr: computeRateFee(itemIdr, cfg['pricing.platform_fee']),
        originCountry: origin,
        categoryCode: req.categoryCode!,
        travelerId: tx.travelerId!,
      },
      now,
    });
    const credit = input.useCredit ? await availableCredit(deps.sql, auth.userId, now) : { availableIdr: 0, balanceIdr: 0, nextExpiryAt: null };
    const versions = await deps.config.versions([...PRICING_KEYS]);
    // 5. Landed-cost quote (core).
    const quote: Quote = buildQuote(
      {
        item: { unitPriceMinor: req.unitPriceMinor!, currency, quantity },
        fxLock: fx?.lock ?? null,
        travelerFee: { type: 'FIXED', amountIdr: offer?.traveler_fee_idr ?? 0 },
        customs,
        paymentChannel: channel,
        promotion: { discountIdr: promotion.discountIdr, freePlatformFee: promotion.freePlatformFee, promoIds: promotion.promoIds },
        referralCreditAvailableIdr: credit.availableIdr,
        now,
        configVersion: versions['pricing.platform_fee'] ?? 1,
      },
      cfg,
    );
    return { fx, usd, customs, restricted, promotion, credit, quote, versions, itemIdr };
  });
  const { fx, customs, restricted, promotion, credit, quote, versions, itemIdr } = computed;

  const blocking = quote.issues.find((i) => i.blocking);
  if (blocking) throw new AppError(422, blocking.code, blocking.message, { issues: quote.issues });
  const lim = CHANNEL_LIMITS[channel];
  if (lim && (quote.totalIdr < lim.minIdr || quote.totalIdr > lim.maxIdr)) {
    throw Errors.unprocessable('CHANNEL_LIMIT_EXCEEDED', `Total di luar batas metode ${channel}; pilih metode lain`, { channel, ...lim, totalIdr: quote.totalIdr });
  }
  // 6. Limits for both parties.
  const buyerLimit = await checkUserLimit(deps, auth.userId, 'BUYER', quote.totalIdr, cat?.risk_level ?? 'MEDIUM', country?.risk_level ?? 'MEDIUM', now);
  if (!buyerLimit.ok) throw Errors.unprocessable('LIMIT_EXCEEDED', buyerLimit.message ?? 'Melebihi limit transaksi', { role: 'BUYER', code: buyerLimit.code, reasons: buyerLimit.limit.reasons });
  const travelerLimit = await checkUserLimit(deps, tx.travelerId!, 'TRAVELER', itemIdr, cat?.risk_level ?? 'MEDIUM', country?.risk_level ?? 'MEDIUM', now);
  if (!travelerLimit.ok) throw Errors.unprocessable('LIMIT_EXCEEDED', 'Nilai barang melebihi limit traveler', { role: 'TRAVELER', code: travelerLimit.code });

  const lines = quote.lines.map((l) => ({
    ...l,
    ruleRef: l.ruleRef?.replace(/^business_configs:([a-z_.]+?)(\.[A-Z_]+)?@v\d+$/, (_m, key: string, sub: string | undefined) => `business_configs:${key}${sub ?? ''}@v${versions[key] ?? 0}`),
  }));
  const meta: QuoteMeta = {
    paymentChannel: quote.paymentChannel,
    platformBornePaymentFeeIdr: quote.platformBornePaymentFeeIdr,
    itemCurrency: currency,
    itemTotalMinor,
    quantity,
    unitPriceMinor: req.unitPriceMinor,
    restricted: {
      classification: restricted.classification,
      requiresAcknowledgement: restricted.requiresAcknowledgement,
      blocksCheckout: restricted.blocksCheckout,
      messagesId: [...restricted.messagesId],
      messagesEn: [...restricted.messagesEn],
      ruleCodes: restricted.matches.map((m) => `${m.code}@v${m.version}`),
      airlineDg: restricted.airlineDg,
    },
    promotion: {
      promoIds: [...promotion.promoIds],
      discountIdr: -(quote.amounts.DISCOUNT),
      cashbackIdr: promotion.cashbackIdr,
      freePlatformFee: promotion.freePlatformFee,
      applied: promotion.applied.map((a) => ({ ...a })),
      rejected: promotion.rejected.map((r) => ({ ...r })),
    },
    credit: { requested: !!input.useCredit, availableIdr: credit.availableIdr, appliedIdr: -quote.amounts.REFERRAL_CREDIT },
    limits: {
      buyer: { effectiveMaxIdr: buyerLimit.limit.effectiveMaxIdr, perTransactionMaxIdr: buyerLimit.limit.perTransactionMaxIdr },
      traveler: { effectiveMaxIdr: travelerLimit.limit.effectiveMaxIdr, perTransactionMaxIdr: travelerLimit.limit.perTransactionMaxIdr },
    },
    fx: fx
      ? { spotRate: fx.lock.spotRate, lockedRate: fx.lock.lockedRate, markupBps: fx.lock.markupBps, source: fx.lock.source, rateAsOf: fx.lock.rateAsOf?.toISOString() ?? null }
      : null,
    adjustments: quote.adjustments.map((a) => ({ ...a })),
    customsWarnings: customs.warnings.map((w) => ({ ...w })),
    paymentOptions: await withCore(() => paymentOptionsFor(quote.totalIdr - quote.amounts.PAYMENT_FEE, cfg['pricing.payment_fees'], quote.paymentChannel)),
  };
  const lockCfg = await deps.config.get('fx.lock');
  const expiresAt = fx ? fx.lock.expiresAt : new Date(now.getTime() + lockCfg.lockMinutes * 60_000);
  const ruleRefs = [...new Set([...lines.map((l) => l.ruleRef).filter((x): x is string => !!x), ...meta.restricted.ruleCodes.map((c) => `restricted_items:${c}`)])];
  const customsJson = {
    ruleId: customs.ruleId,
    ruleCode: customs.ruleCode,
    ruleVersion: customs.ruleVersion,
    formulaCode: customs.formulaCode,
    treatment: customs.treatment,
    hsCodeUsed: customs.hsCodeUsed,
    customsValueIdr: customs.customsValueIdr,
    dutyIdr: customs.dutyIdr,
    vatIdr: customs.vatIdr,
    luxuryTaxIdr: customs.luxuryTaxIdr,
    incomeTaxIdr: customs.incomeTaxIdr,
    importTaxIdr: customs.importTaxIdr,
    totalIdr: customs.totalIdr,
    isEstimate: true,
    sourceReference: customs.sourceReference,
    lastVerifiedAt: customs.lastVerifiedAt?.toISOString() ?? null,
    warnings: customs.warnings,
    breakdownSteps: customs.breakdownSteps,
  };

  const quoteId = await deps.sql.begin(async (db) => {
    await setDbActor(db, 'BUYER', auth.userId);
    const { tx: locked } = await requireParty(db, id, auth, { role: 'BUYER', forUpdate: true });
    if (locked.status !== 'MATCHED') throw Errors.unprocessable('QUOTE_NOT_ALLOWED', 'Status transaksi berubah; muat ulang', { status: locked.status });
    let fxLockId: string | null = null;
    if (fx) {
      const [l] = await db<{ id: string }[]>`
        INSERT INTO fx_locks (base, quote, spot_rate, markup_bps, locked_rate, locked_at, expires_at, status, source_rate_id)
        VALUES (${fx.lock.base}, ${fx.lock.quote}, ${fx.lock.spotRate}, ${fx.lock.markupBps}, ${fx.lock.lockedRate}, ${fx.lock.lockedAt},
                ${fx.lock.expiresAt}, 'ACTIVE', ${fx.spot.rateId})
        RETURNING id`;
      fxLockId = l!.id;
    }
    const previous = await db<{ id: string }[]>`
      UPDATE quotes SET status = 'SUPERSEDED' WHERE transaction_id = ${locked.id} AND status IN ('ACTIVE','ACCEPTED') RETURNING id`;
    const newId = crypto.randomUUID();
    await db`
      INSERT INTO quotes (id, transaction_id, fx_lock_id, total_idr, customs, config_versions, rule_refs, status, expires_at, meta)
      VALUES (${newId}, ${locked.id}, ${fxLockId}, ${quote.totalIdr}, ${db.json(customsJson as never)}, ${db.json(versions as never)},
              ${db.json(ruleRefs as never)}, 'ACTIVE', ${expiresAt}, ${db.json(meta as never)})`;
    let sort = 1;
    for (const l of lines) {
      await db`
        INSERT INTO quote_lines (quote_id, line_type, label_id, label_en, amount_idr, bucket, is_estimate, rule_ref, meta, sort)
        VALUES (${newId}, ${l.type}, ${l.labelId}, ${l.labelEn}, ${l.amountIdr}, ${l.type === 'TOTAL' ? null : l.bucket}, ${l.isEstimate},
                ${l.ruleRef ?? null}, ${db.json((l.originalAmountIdr !== undefined ? { originalAmountIdr: l.originalAmountIdr } : {}) as never)}, ${sort++})`;
    }
    for (const p of previous) await db`UPDATE quotes SET superseded_by = ${newId} WHERE id = ${p.id}`;
    await db`UPDATE transactions SET active_quote_id = ${newId}, total_idr = ${quote.totalIdr}, item_currency = ${currency}, quantity = ${quantity}
              WHERE id = ${locked.id}`;
    await audit(db, {
      actorType: 'BUYER',
      actorId: auth.userId,
      action: 'transaction.quote_created',
      entityType: 'quote',
      entityId: newId,
      meta: { transactionId: locked.id, totalIdr: quote.totalIdr, channel: quote.paymentChannel, supersedes: previous.map((p) => p.id) },
    });
    return newId;
  });
  return quoteView((await loadQuote(deps.sql, quoteId))!);
}

/** numeric(20,10) text → shortest decimal ("107.5000000000" → "107.5"). */
function trimRate(r: string): string {
  return r.includes('.') ? r.replace(/0+$/, '').replace(/\.$/, '') : r;
}

export function quoteView(q: LoadedQuote) {
  const m = q.quote.meta;
  const customs = q.quote.customs as Record<string, unknown>;
  return {
    quoteId: q.quote.id,
    transactionId: q.quote.transactionId,
    status: q.quote.status,
    createdAt: new Date(q.quote.createdAt).toISOString(),
    expiresAt: new Date(q.quote.expiresAt).toISOString(),
    currency: 'IDR' as const,
    totalIdr: q.quote.totalIdr,
    paymentChannel: m.paymentChannel,
    paymentOptions: (m.paymentOptions ?? []).map((o) => ({ ...o, selected: o.channel === m.paymentChannel })),
    item: { currency: m.itemCurrency, unitPriceMinor: m.unitPriceMinor, quantity: m.quantity, totalMinor: m.itemTotalMinor },
    lines: q.lines.map((l) => ({
      type: l.lineType,
      labelId: l.labelId,
      labelEn: l.labelEn,
      amountIdr: l.amountIdr,
      bucket: l.bucket,
      isEstimate: l.isEstimate,
      ruleRef: l.ruleRef,
      ...(typeof l.meta?.originalAmountIdr === 'number' ? { originalAmountIdr: l.meta.originalAmountIdr as number } : {}),
    })),
    estimateBadges: q.lines.filter((l) => l.isEstimate).map((l) => l.lineType),
    fx: q.fxLock
      ? {
          base: q.fxLock.base.trim(),
          quote: q.fxLock.quote.trim(),
          spotRate: trimRate(q.fxLock.spotRate),
          markupBps: q.fxLock.markupBps,
          lockedRate: trimRate(q.fxLock.lockedRate),
          lockedAt: new Date(q.fxLock.lockedAt).toISOString(),
          expiresAt: new Date(q.fxLock.expiresAt).toISOString(),
          status: q.fxLock.status,
          source: m.fx?.source ?? null,
          rateAsOf: m.fx?.rateAsOf ?? null,
        }
      : null,
    customs: {
      ruleCode: (customs.ruleCode as string | null) ?? null,
      ruleVersion: (customs.ruleVersion as number | null) ?? null,
      treatment: (customs.treatment as string | null) ?? null,
      dutyIdr: Number(customs.dutyIdr ?? 0),
      importTaxIdr: Number(customs.importTaxIdr ?? 0),
      totalIdr: Number(customs.totalIdr ?? 0),
      isEstimate: true,
      sourceReference: (customs.sourceReference as string | null) ?? null,
      warnings: (customs.warnings as unknown[]) ?? [],
      disclaimerId: 'Bea masuk & pajak impor adalah estimasi; jumlah final ditetapkan petugas Bea dan Cukai.',
    },
    restricted: m.restricted,
    promotion: m.promotion,
    credit: { ...m.credit, withdrawable: false as const },
    limits: m.limits,
    adjustments: m.adjustments,
    configVersions: q.quote.configVersions,
    ruleRefs: q.quote.ruleRefs,
  };
}

// ------------------------------------------------------------------ checkout

export interface CheckoutRequest {
  quoteId: string;
  channel?: string | undefined;
  acknowledgeRestricted?: boolean | undefined;
}

export async function checkout(deps: AppDeps, auth: AuthContext, id: string, input: CheckoutRequest) {
  const now = deps.clock.now();
  return deps.sql.begin(async (db) => {
    await setDbActor(db, 'BUYER', auth.userId);
    const { tx } = await requireParty(db, id, auth, { role: 'BUYER', forUpdate: true });
    if (tx.status === 'AWAITING_PAYMENT') {
      const [pending] = await db<{ id: string }[]>`SELECT id FROM payments WHERE transaction_id = ${tx.id} AND status = 'PENDING' ORDER BY created_at DESC LIMIT 1`;
      throw Errors.conflict('PAYMENT_ALREADY_PENDING', 'Pembayaran untuk transaksi ini sedang menunggu; selesaikan atau tunggu kedaluwarsa', {
        paymentId: pending?.id ?? null,
      });
    }
    if (tx.status !== 'MATCHED') throw Errors.unprocessable('CHECKOUT_NOT_ALLOWED', 'Checkout tidak tersedia pada status ini', { status: tx.status });
    // FOR SHARE serializes with POST /trips/{id}/cancel (which updates the trip row): either the trip is cancelled
    // first and checkout is refused, or checkout commits first and the trip.cancelled consumer stops the invoice.
    const [tripRow] = tx.tripId ? await db<{ status: string }[]>`SELECT status FROM trips WHERE id = ${tx.tripId} FOR SHARE` : [];
    if (tripRow) assertTripPayable(tripRow.status);
    const q = await loadQuote(db, input.quoteId, { forUpdate: true });
    if (!q || q.quote.transactionId !== tx.id) throw Errors.notFound('Penawaran harga', 'QUOTE_NOT_FOUND');
    if (q.quote.id !== tx.activeQuoteId || q.quote.status !== 'ACTIVE') {
      throw Errors.unprocessable('QUOTE_NOT_ACTIVE', 'Penawaran harga sudah tidak aktif; buat penawaran baru', { status: q.quote.status });
    }
    const fxLockValid = !q.fxLock || (q.fxLock.status === 'ACTIVE' && now.getTime() >= new Date(q.fxLock.lockedAt).getTime() && now.getTime() < new Date(q.fxLock.expiresAt).getTime());
    if (!fxLockValid) throw Errors.unprocessable('FX_LOCK_EXPIRED', 'Kurs terkunci sudah kedaluwarsa; buat penawaran harga baru', { expiresAt: q.fxLock?.expiresAt ?? null });
    if (now.getTime() >= new Date(q.quote.expiresAt).getTime()) throw Errors.unprocessable('QUOTE_EXPIRED', 'Penawaran harga kedaluwarsa; buat penawaran baru');
    const meta = q.quote.meta;
    const channel = input.channel ?? meta.paymentChannel;
    if (channel !== meta.paymentChannel) {
      throw Errors.unprocessable('CHANNEL_MISMATCH', 'Biaya pembayaran dihitung untuk metode lain; buat penawaran baru untuk metode ini', { quoted: meta.paymentChannel, requested: channel });
    }
    if (q.quote.totalIdr <= 0) throw Errors.unprocessable('TOTAL_ZERO_UNSUPPORTED', 'Total Rp0 tidak dapat diproses melalui payment gateway');
    const acknowledged = meta.restricted.classification === 'ALLOWED' || input.acknowledgeRestricted === true;
    assertCanTransition(tx.status, 'AWAITING_PAYMENT', 'BUYER', {
      quoteActive: true,
      fxLockValid: true,
      buyerKycLevel: auth.kycLevel,
      restrictedClassification: meta.restricted.classification as never,
      restrictedAcknowledged: acknowledged,
    });
    const creditUsed = -q.amounts.REFERRAL_CREDIT;
    if (creditUsed > 0) {
      const c = await availableCredit(db, auth.userId, now);
      if (c.availableIdr < creditUsed) throw Errors.unprocessable('CREDIT_INSUFFICIENT', 'Saldo JastipKita Credit berubah; buat penawaran baru', { availableIdr: c.availableIdr, requiredIdr: creditUsed });
    }
    // SEC-02: promotion limits were only evaluated when the quote was built; re-check them under a per-promotion
    // lock so N quotes (or N concurrent checkouts) cannot all redeem a once-per-user / last-unit promotion.
    await revalidatePromotions(db, {
      buyerId: auth.userId,
      transactionId: tx.id,
      applied: (meta.promotion.applied as { promoId: string; valueIdr: number }[]).filter((a) => a.valueIdr > 0),
      now,
    });
    const payment = await createPayment(deps, db, {
      tx,
      purpose: 'CHECKOUT',
      quoteId: q.quote.id,
      amountIdr: q.quote.totalIdr,
      channel,
      expiresAt: new Date(q.quote.expiresAt),
      description: `JastipKita ${tx.number}`,
    });
    if (creditUsed > 0) {
      await db`
        INSERT INTO credit_entries (user_id, amount_idr, reason, reference_type, reference_id, idempotency_key, note)
        VALUES (${auth.userId}, ${-creditUsed}, 'CHECKOUT_REDEEM', 'payment', ${payment.id}, ${`redeem:${payment.id}`}, ${`Checkout ${tx.number}`})`;
    }
    for (const a of meta.promotion.applied as { promoId: string; valueIdr: number }[]) {
      if (!(a.valueIdr > 0)) continue;
      await db`
        INSERT INTO promotion_redemptions (promotion_id, user_id, transaction_id, quote_id, amount_idr, status, reserved_at)
        VALUES (${a.promoId}, ${auth.userId}, ${tx.id}, ${q.quote.id}, ${a.valueIdr}, 'RESERVED', ${now})
        ON CONFLICT (promotion_id, transaction_id) DO UPDATE
          SET status = 'RESERVED', quote_id = EXCLUDED.quote_id, amount_idr = EXCLUDED.amount_idr, reserved_at = EXCLUDED.reserved_at,
              applied_at = NULL, reversed_at = NULL`;
    }
    await db`UPDATE quotes SET status = 'ACCEPTED', accepted_at = ${now} WHERE id = ${q.quote.id}`;
    if (q.fxLock) await db`UPDATE fx_locks SET status = 'CONSUMED', consumed_at = ${now} WHERE id = ${q.fxLock.id}`;
    if (meta.restricted.classification !== 'ALLOWED') await db`UPDATE requests SET restriction_ack_at = ${now} WHERE id = ${tx.requestId}`;
    const next = await transitionTx(db, tx, 'AWAITING_PAYMENT', 'BUYER', auth.userId, 'Checkout dimulai', {
      paymentId: payment.id,
      quoteId: q.quote.id,
      restrictedAcknowledged: acknowledged,
    });
    await emitEvent(db, 'payment', payment.id, 'payment.checkout_created', {
      paymentId: payment.id,
      transactionId: tx.id,
      buyerId: tx.buyerId,
      amountIdr: payment.amountIdr,
      expiresAt: payment.expiresAt?.toISOString() ?? null,
      purpose: 'CHECKOUT',
    });
    await audit(db, {
      actorType: 'BUYER',
      actorId: auth.userId,
      action: 'payment.checkout_created',
      entityType: 'payment',
      entityId: payment.id,
      after: { status: 'PENDING', amountIdr: payment.amountIdr },
      meta: { transactionId: tx.id, quoteId: q.quote.id, provider: payment.provider, providerEnv: payment.providerEnv },
    });
    return {
      paymentId: payment.id,
      checkoutUrl: payment.checkoutUrl,
      expiresAt: payment.expiresAt?.toISOString() ?? null,
      amountIdr: payment.amountIdr,
      channel,
      provider: payment.provider,
      providerEnv: payment.providerEnv,
      sandbox: payment.providerEnv !== 'LIVE',
      transactionStatus: next.status,
      payment: paymentView(payment, { includeCheckoutUrl: true }),
    };
  });
}

/**
 * SEC-02 (docs/security/review-2026-09.md): re-validates the promotions a quote applied, inside the checkout DB
 * transaction and serialized per promotion (advisory lock), against the redemptions that exist NOW:
 * status/date window, per-user and global usage, budget, and "first transaction" (another transaction of the
 * buyer already past MATCHED — including one awaiting payment — disqualifies). Any failure → 422
 * PROMO_NO_LONGER_VALID: the buyer requests a new quote (which will no longer carry the discount).
 */
export async function revalidatePromotions(
  db: TxSql,
  input: { buyerId: string; transactionId: string; applied: { promoId: string; valueIdr: number }[]; now: Date },
): Promise<void> {
  const ids = [...new Set(input.applied.map((a) => a.promoId))].sort();
  for (const id of ids) {
    await db`SELECT pg_advisory_xact_lock(hashtextextended(${`promo:${id}`}, 0))`;
    const [p] = await db<{
      status: string;
      type: string;
      starts_at: Date;
      ends_at: Date | null;
      conditions: Record<string, unknown> | null;
      usage_limit_per_user: number | null;
      usage_limit_total: number | null;
      budget_total_idr: string | null;
      budget_used_idr: string;
      usage_count: number;
    }[]>`
      SELECT status, type, starts_at, ends_at, conditions, usage_limit_per_user, usage_limit_total, budget_total_idr::text,
             budget_used_idr::text, usage_count
        FROM promotions WHERE id = ${id}`;
    const fail = (reason: string) =>
      Errors.unprocessable('PROMO_NO_LONGER_VALID', 'Promo sudah tidak berlaku untuk transaksi ini; buat penawaran harga baru', { promoId: id, reason });
    if (!p || p.status !== 'ACTIVE') throw fail('NOT_ACTIVE');
    if (input.now.getTime() < new Date(p.starts_at).getTime() || (p.ends_at && input.now.getTime() >= new Date(p.ends_at).getTime())) {
      throw fail('OUTSIDE_DATE_WINDOW');
    }
    const [u] = await db<{ mine: number; total: number; used: string }[]>`
      SELECT count(*) FILTER (WHERE user_id = ${input.buyerId})::int AS mine, count(*)::int AS total, coalesce(sum(amount_idr), 0)::text AS used
        FROM promotion_redemptions
       WHERE promotion_id = ${id} AND status IN ('RESERVED','APPLIED') AND transaction_id <> ${input.transactionId}`;
    if (p.usage_limit_per_user !== null && u!.mine >= p.usage_limit_per_user) throw fail('PER_USER_LIMIT_REACHED');
    if (p.usage_limit_total !== null && Math.max(u!.total, p.usage_count) >= p.usage_limit_total) throw fail('GLOBAL_LIMIT_REACHED');
    if (p.budget_total_idr !== null && Math.max(Number(u!.used), Number(p.budget_used_idr)) >= Number(p.budget_total_idr)) throw fail('BUDGET_EXHAUSTED');
    if (p.type === 'FIRST_TRANSACTION' || (p.conditions as { firstTransactionOnly?: boolean } | null)?.firstTransactionOnly === true) {
      const [other] = await db<{ n: number }[]>`
        SELECT count(*)::int AS n FROM transactions
         WHERE buyer_id = ${input.buyerId} AND id <> ${input.transactionId}
           AND status NOT IN ('REQUEST_CREATED','MATCHED','CANCELLED')`;
      if (other!.n > 0) throw fail('NOT_FIRST_TRANSACTION');
    }
  }
}
