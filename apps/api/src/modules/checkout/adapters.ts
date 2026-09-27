/**
 * Thin local adapters (parallel-work note in the money brief): they load rules/rates from the DB and call
 * @jastipkita/core directly. The marketplace group owns the public FX/customs/restricted services; when
 * those land, these adapters can delegate to them without changing the quote contract.
 */
import {
  type ClassificationResult,
  classifyItem,
  computeTransactionLimit,
  CoreError,
  type CustomsEstimate,
  type CustomsRule,
  checkLimit,
  crossRate,
  estimateCustoms,
  evaluatePromotions,
  type FxLock,
  createFxLockFromConfig,
  invertRate,
  type LimitResult,
  type Promotion,
  type PromotionEvaluation,
  type RestrictedItemRule,
  type RiskLevel,
} from '@jastipkita/core';
import type { AppDeps } from '../../context';
import type { Db } from '../../db/sql';

// ------------------------------------------------------------------ FX

export interface SpotRate {
  rate: string;
  asOf: Date;
  source: string;
  rateId: string | null;
}

/**
 * Latest spot rate from→to from `fx_rates` (direct, inverse, or a cross via a common base such as
 * USD/EUR). Returns null when nothing is available. Staleness is enforced by core when locking.
 */
export async function findSpotRate(db: Db, from: string, to: string): Promise<SpotRate | null> {
  if (from === to) return { rate: '1', asOf: new Date(0), source: 'identity', rateId: null };
  const direct = await db<{ id: string; rate: string; as_of: Date; source: string }[]>`
    SELECT id, rate::text AS rate, as_of, source FROM v_fx_rates_latest WHERE base = ${from} AND quote = ${to}`;
  if (direct[0]) return { rate: direct[0].rate, asOf: direct[0].as_of, source: direct[0].source, rateId: direct[0].id };
  const inverse = await db<{ id: string; rate: string; as_of: Date; source: string }[]>`
    SELECT id, rate::text AS rate, as_of, source FROM v_fx_rates_latest WHERE base = ${to} AND quote = ${from}`;
  if (inverse[0]) return { rate: invertRate(inverse[0].rate), asOf: inverse[0].as_of, source: inverse[0].source, rateId: inverse[0].id };
  const cross = await db<{ base: string; r_from: string; r_to: string; as_of: Date; source: string }[]>`
    SELECT a.base, a.rate::text AS r_from, b.rate::text AS r_to, least(a.as_of, b.as_of) AS as_of, a.source
      FROM v_fx_rates_latest a JOIN v_fx_rates_latest b ON b.base = a.base AND b.quote = ${to}
     WHERE a.quote = ${from}
     ORDER BY least(a.as_of, b.as_of) DESC LIMIT 1`;
  if (cross[0]) {
    const c = cross[0];
    return {
      rate: crossRate({ base: c.base, asOf: c.as_of, rates: { [from]: c.r_from, [to]: c.r_to } }, from, to),
      asOf: c.as_of,
      source: c.source,
      rateId: null,
    };
  }
  return null;
}

export async function lockFx(deps: AppDeps, currency: string, now: Date): Promise<{ lock: FxLock; spot: SpotRate }> {
  const spot = await findSpotRate(deps.sql, currency, 'IDR');
  if (!spot) {
    throw new CoreError('FX_RATE_UNAVAILABLE', `Kurs ${currency}→IDR belum tersedia`, { currency, reason: 'MISSING_FROM_TABLE' });
  }
  const [lockCfg, markupCfg] = await Promise.all([deps.config.get('fx.lock'), deps.config.get('pricing.fx_markup')]);
  const lock = createFxLockFromConfig(
    { base: currency, quote: 'IDR', spotRate: spot.rate, rateAsOf: spot.asOf, now, source: spot.source },
    { 'fx.lock': lockCfg, 'pricing.fx_markup': markupCfg },
  );
  return { lock, spot };
}

// ------------------------------------------------------------------ customs

export async function loadCustomsRules(db: Db): Promise<CustomsRule[]> {
  const rows = await db<Record<string, unknown>[]>`
    SELECT id, code, version, origin_country, destination_country, hs_code_prefix, category_code, treatment, formula_code,
           exemption_usd::text AS exemption_usd, duty_rate::text AS duty_rate, vat_rate::text AS vat_rate,
           vat_dpp_factor::text AS vat_dpp_factor, luxury_tax_rate::text AS luxury_tax_rate,
           income_tax_rate::text AS income_tax_rate, income_tax_rate_no_npwp::text AS income_tax_rate_no_npwp,
           rounding, priority, effective_from::text AS effective_from, effective_until::text AS effective_until,
           source_reference, source_url, last_verified_at::text AS last_verified_at, status
      FROM customs_rules WHERE status = 'ACTIVE'`;
  return rows.map((r) => ({
    id: String(r.id),
    code: String(r.code),
    version: Number(r.version),
    originCountry: (r.origin_country as string | null)?.trim() ?? null,
    destinationCountry: String(r.destination_country).trim(),
    hsCodePrefix: (r.hs_code_prefix as string | null) ?? null,
    categoryCode: (r.category_code as string | null) ?? null,
    treatment: r.treatment as CustomsRule['treatment'],
    formulaCode: r.formula_code as CustomsRule['formulaCode'],
    exemptionUsd: (r.exemption_usd as string | null) ?? null,
    dutyRate: String(r.duty_rate),
    vatRate: String(r.vat_rate),
    vatDppFactor: String(r.vat_dpp_factor),
    luxuryTaxRate: String(r.luxury_tax_rate),
    incomeTaxRate: String(r.income_tax_rate),
    incomeTaxRateNoNpwp: (r.income_tax_rate_no_npwp as string | null) ?? null,
    rounding: r.rounding as CustomsRule['rounding'],
    priority: Number(r.priority),
    effectiveFrom: String(r.effective_from),
    effectiveUntil: (r.effective_until as string | null) ?? null,
    sourceReference: String(r.source_reference),
    sourceUrl: (r.source_url as string | null) ?? null,
    lastVerifiedAt: String(r.last_verified_at),
    status: r.status as CustomsRule['status'],
  }));
}

export interface CustomsInput {
  originCountry: string;
  destinationCountry: string;
  hsCode: string | null;
  categoryCode: string;
  unitPriceMinor: number;
  currency: string;
  quantity: number;
  itemToIdr: string | null;
  usdToIdr: string | null;
  now: Date;
}

export async function estimateCustomsFromDb(db: Db, i: CustomsInput): Promise<CustomsEstimate> {
  const rules = await loadCustomsRules(db);
  return estimateCustoms({
    originCountry: i.originCountry,
    destinationCountry: i.destinationCountry,
    hsCode: i.hsCode,
    categoryCode: i.categoryCode,
    itemValueMinor: i.unitPriceMinor,
    currency: i.currency,
    quantity: i.quantity,
    treatment: 'NON_PERSONAL', // jastip goods are commercial (research 01 §2)
    fx: { ...(i.itemToIdr ? { itemToIdr: i.itemToIdr } : {}), ...(i.usdToIdr ? { usdToIdr: i.usdToIdr } : {}) },
    date: i.now,
    rules,
  });
}

// ------------------------------------------------------------------ restricted items

export async function loadRestrictedRules(db: Db): Promise<RestrictedItemRule[]> {
  const rows = await db<Record<string, unknown>[]>`
    SELECT id, code, version, origin_country, destination_country, category_code, hs_code_prefix, keywords, classification,
           max_quantity, max_value_usd::text AS max_value_usd, permit_authority, airline_dg, message_id, message_en,
           source_reference, effective_from::text AS effective_from, effective_until::text AS effective_until, status
      FROM restricted_items WHERE status = 'ACTIVE'`;
  return rows.map((r) => ({
    id: String(r.id),
    code: String(r.code),
    version: Number(r.version),
    originCountry: (r.origin_country as string | null)?.trim() ?? null,
    destinationCountry: String(r.destination_country).trim(),
    categoryCode: (r.category_code as string | null) ?? null,
    hsCodePrefix: (r.hs_code_prefix as string | null) ?? null,
    keywords: (r.keywords as string[] | null) ?? [],
    classification: r.classification as RestrictedItemRule['classification'],
    maxQuantity: (r.max_quantity as number | null) ?? null,
    maxValueUsd: (r.max_value_usd as string | null) ?? null,
    permitAuthority: (r.permit_authority as string | null) ?? null,
    airlineDg: Boolean(r.airline_dg),
    messageId: String(r.message_id),
    messageEn: String(r.message_en),
    sourceReference: String(r.source_reference),
    effectiveFrom: String(r.effective_from),
    effectiveUntil: (r.effective_until as string | null) ?? null,
    status: r.status as RestrictedItemRule['status'],
  }));
}

export async function classifyFromDb(
  db: Db,
  input: { origin: string; destination: string; categoryCode: string; hsCode: string | null; productName: string; quantity: number; valueUsd: string | null },
  now: Date,
): Promise<ClassificationResult> {
  const rules = await loadRestrictedRules(db);
  return classifyItem(
    {
      origin: input.origin,
      destination: input.destination,
      categoryCode: input.categoryCode,
      hsCode: input.hsCode,
      productName: input.productName,
      quantity: input.quantity,
      valueUsd: input.valueUsd,
    },
    rules,
    now,
  );
}

// ------------------------------------------------------------------ limits

export interface LimitsOutcome {
  ok: boolean;
  code?: string;
  message?: string;
  limit: LimitResult;
}

export async function checkUserLimit(
  deps: AppDeps,
  userId: string,
  role: 'BUYER' | 'TRAVELER',
  amountIdr: number,
  productRisk: RiskLevel,
  countryRisk: RiskLevel,
  now: Date,
): Promise<LimitsOutcome> {
  const db = deps.sql;
  const [u] = await db<{ kyc_level: number; trust_score: number }[]>`SELECT kyc_level, trust_score FROM users WHERE id = ${userId}`;
  const [c] = await db<{ n: number }[]>`
    SELECT count(*)::int AS n FROM transactions
     WHERE status = 'COMPLETED' AND ${role === 'BUYER' ? db`buyer_id` : db`traveler_id`} = ${userId}`;
  const month = new Date(now.getTime() + 7 * 3600_000).toISOString().slice(0, 7) + '-01';
  const [usage] = await db<{ amount_idr: number | null }[]>`
    SELECT amount_idr FROM v_transaction_limits_usage WHERE user_id = ${userId} AND role = ${role} AND month_wib = ${month}::date`;
  const cfg = await deps.config.get('limits.transaction');
  const input = {
    kycLevel: u?.kyc_level ?? 1,
    trustScore: u?.trust_score ?? 0,
    completedTransactions: c?.n ?? 0,
    productRisk,
    countryRisk,
    role,
    monthUsedIdr: Number(usage?.amount_idr ?? 0),
  } as const;
  const r = checkLimit(amountIdr, input, cfg);
  return r.ok ? { ok: true, limit: r.limit } : { ok: false, code: r.code, message: r.message, limit: r.limit };
}

export { computeTransactionLimit };

// ------------------------------------------------------------------ promotions

export async function loadPromotions(db: Db, userId: string, transactionId: string, promoCode: string | null): Promise<{ promos: Promotion[]; usageByPromo: Record<string, number> }> {
  const rows = await db<Record<string, unknown>[]>`
    SELECT p.id, p.code::text AS code, p.type, p.name, p.status, p.starts_at, p.ends_at, p.conditions, p.benefit,
           p.budget_total_idr, p.usage_limit_total, p.usage_limit_per_user,
           greatest(p.usage_count, coalesce(r.n, 0))::int AS global_count,
           greatest(p.budget_used_idr, coalesce(r.amount, 0)) AS budget_used
      FROM promotions p
      LEFT JOIN (SELECT promotion_id, count(*) AS n, sum(amount_idr) AS amount
                   FROM promotion_redemptions WHERE status IN ('RESERVED','APPLIED') AND transaction_id <> ${transactionId}
                  GROUP BY promotion_id) r ON r.promotion_id = p.id
     WHERE p.status = 'ACTIVE' AND (p.type <> 'PROMO_CODE' OR upper(p.code::text) = upper(${promoCode ?? ''}))`;
  const promos: Promotion[] = rows.map((r) => {
    const cond = (r.conditions ?? {}) as Record<string, unknown>;
    return {
      id: String(r.id),
      code: (r.code as string | null) ?? null,
      type: r.type as Promotion['type'],
      name: String(r.name),
      status: r.status as Promotion['status'],
      startsAt: r.starts_at as Date,
      endsAt: (r.ends_at as Date | null) ?? null,
      conditions: cond as Promotion['conditions'],
      limits: {
        perUser: (r.usage_limit_per_user as number | null) ?? null,
        global: (r.usage_limit_total as number | null) ?? null,
        budgetIdr: r.budget_total_idr === null || r.budget_total_idr === undefined ? null : Number(r.budget_total_idr),
      },
      usage: { globalCount: Number(r.global_count ?? 0), budgetUsedIdr: Number(r.budget_used ?? 0) },
      benefit: r.benefit as Promotion['benefit'],
      priority: typeof cond.priority === 'number' ? (cond.priority as number) : 0,
    };
  });
  const usage = await db<{ promotion_id: string; n: number }[]>`
    SELECT promotion_id, count(*)::int AS n FROM promotion_redemptions
     WHERE user_id = ${userId} AND status IN ('RESERVED','APPLIED') AND transaction_id <> ${transactionId}
     GROUP BY promotion_id`;
  return { promos, usageByPromo: Object.fromEntries(usage.map((u) => [u.promotion_id, u.n])) };
}

export async function evaluatePromos(
  db: Db,
  args: {
    userId: string;
    transactionId: string;
    promoCode: string | null;
    cart: { itemValueIdr: number; travelerFeeIdr: number; platformFeeIdr: number; originCountry: string; categoryCode: string; travelerId: string };
    now: Date;
  },
): Promise<PromotionEvaluation> {
  const { promos, usageByPromo } = await loadPromotions(db, args.userId, args.transactionId, args.promoCode);
  const [first] = await db<{ n: number }[]>`
    SELECT count(*)::int AS n FROM transactions
     WHERE buyer_id = ${args.userId} AND id <> ${args.transactionId}
       AND status NOT IN ('REQUEST_CREATED','MATCHED','AWAITING_PAYMENT','CANCELLED')`;
  return evaluatePromotions(
    { ...args.cart, ...(args.promoCode ? { enteredCodes: [args.promoCode.toUpperCase()] } : {}) },
    promos,
    { id: args.userId, isFirstTransaction: (first?.n ?? 0) === 0, usageByPromo },
    args.now,
  );
}

// ------------------------------------------------------------------ JastipKita Credit

/**
 * Spendable, non-withdrawable credit, expiry-aware: debits (redeem/expiry/negative adjustments) consume
 * grants in expiry order (FIFO by expires_at, open-ended last); what remains on grants not yet expired at
 * `now` is spendable. Never exceeds the ledger balance (the DB trigger forbids negative balances).
 */
export async function availableCredit(db: Db, userId: string, now: Date): Promise<{ availableIdr: number; balanceIdr: number; nextExpiryAt: Date | null }> {
  const rows = await db<{ amount_idr: number; expires_at: Date | null }[]>`
    SELECT amount_idr, expires_at FROM credit_entries WHERE user_id = ${userId} ORDER BY id`;
  const lots = rows
    .filter((r) => r.amount_idr > 0)
    .map((r) => ({ remaining: Number(r.amount_idr), expiresAt: r.expires_at }))
    .sort((a, b) => (a.expiresAt?.getTime() ?? Number.MAX_SAFE_INTEGER) - (b.expiresAt?.getTime() ?? Number.MAX_SAFE_INTEGER));
  let debits = rows.filter((r) => r.amount_idr < 0).reduce((s, r) => s - Number(r.amount_idr), 0);
  for (const lot of lots) {
    const take = Math.min(lot.remaining, debits);
    lot.remaining -= take;
    debits -= take;
    if (debits === 0) break;
  }
  const balance = rows.reduce((s, r) => s + Number(r.amount_idr), 0);
  const live = lots.filter((l) => l.remaining > 0 && (!l.expiresAt || l.expiresAt.getTime() > now.getTime()));
  const available = Math.max(0, Math.min(balance, live.reduce((s, l) => s + l.remaining, 0)));
  const next = live.filter((l) => l.expiresAt).map((l) => l.expiresAt as Date)[0] ?? null;
  return { availableIdr: available, balanceIdr: balance, nextExpiryAt: next };
}
