/**
 * promotions row → core `Promotion` (packages/core promotions engine). JSON contract for the admin
 * group (documented in docs/api/engagement.md):
 *   conditions: { minItemValueIdr?, originCountries?, categories?, firstTransactionOnly?, travelerIds?,
 *                 userSegments?, priority?, public? (default true; false hides it from GET /promotions/active),
 *                 cashbackExpiryDays? }
 *   benefit:    { kind: 'PERCENT', rateBps, capIdr?, base? } | { kind: 'FIXED', amountIdr }
 *             | { kind: 'FREE_PLATFORM_FEE' } | { kind: 'CASHBACK_CREDIT', rateBps? | amountIdr?, capIdr?, base? }
 */
import type { PromoBenefit, Promotion } from '@jastipkita/core';

export interface PromotionRow {
  id: string;
  code: string | null;
  name: string;
  description: string | null;
  type: Promotion['type'];
  conditions: Record<string, unknown>;
  benefit: Record<string, unknown>;
  budget_total_idr: number | null;
  budget_used_idr: number;
  usage_limit_total: number | null;
  usage_count: number;
  usage_limit_per_user: number | null;
  starts_at: Date;
  ends_at: Date | null;
  status: Promotion['status'];
}

const BASES = new Set(['ITEM_PRICE', 'TRAVELER_FEE', 'PLATFORM_FEE', 'SUBTOTAL']);
const int = (v: unknown): number | undefined => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined);
const strs = (v: unknown): string[] | undefined => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined);

export function toBenefit(b: Record<string, unknown>): PromoBenefit | null {
  const base = typeof b.base === 'string' && BASES.has(b.base) ? (b.base as 'ITEM_PRICE') : undefined;
  switch (b.kind) {
    case 'PERCENT': {
      const rateBps = int(b.rateBps);
      if (rateBps === undefined || rateBps > 10_000) return null;
      return { kind: 'PERCENT', rateBps, capIdr: int(b.capIdr) ?? null, ...(base ? { base } : {}) };
    }
    case 'FIXED': {
      const amountIdr = int(b.amountIdr);
      return amountIdr === undefined ? null : { kind: 'FIXED', amountIdr };
    }
    case 'FREE_PLATFORM_FEE':
      return { kind: 'FREE_PLATFORM_FEE' };
    case 'CASHBACK_CREDIT': {
      const rateBps = int(b.rateBps);
      const amountIdr = int(b.amountIdr);
      if (rateBps === undefined && amountIdr === undefined) return null;
      return { kind: 'CASHBACK_CREDIT', ...(rateBps !== undefined ? { rateBps } : {}), ...(amountIdr !== undefined ? { amountIdr } : {}), capIdr: int(b.capIdr) ?? null, ...(base ? { base } : {}) };
    }
    default:
      return null;
  }
}

export function toCorePromotion(r: PromotionRow): Promotion | null {
  const benefit = toBenefit(r.benefit ?? {});
  if (!benefit) return null;
  const c = r.conditions ?? {};
  return {
    id: r.id,
    code: r.code,
    type: r.type,
    name: r.name,
    status: r.status,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    conditions: {
      ...(int(c.minItemValueIdr) !== undefined ? { minItemValueIdr: int(c.minItemValueIdr)! } : {}),
      ...(strs(c.originCountries) ? { originCountries: strs(c.originCountries)! } : {}),
      ...(strs(c.categories) ? { categories: strs(c.categories)! } : {}),
      ...(c.firstTransactionOnly === true ? { firstTransactionOnly: true } : {}),
      ...(strs(c.travelerIds) ? { travelerIds: strs(c.travelerIds)! } : {}),
      ...(strs(c.userSegments) ? { userSegments: strs(c.userSegments)! } : {}),
    },
    limits: { perUser: r.usage_limit_per_user, global: r.usage_limit_total, budgetIdr: r.budget_total_idr === null ? null : Number(r.budget_total_idr) },
    usage: { globalCount: r.usage_count, budgetUsedIdr: Number(r.budget_used_idr) },
    benefit,
    priority: typeof c.priority === 'number' ? c.priority : 0,
  };
}

/** Public (user-facing) view: no budget, usage, funding or targeting internals. */
export function publicPromotion(r: PromotionRow) {
  const b = toBenefit(r.benefit ?? {});
  const c = r.conditions ?? {};
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    description: r.description,
    type: r.type,
    benefit: b
      ? {
          kind: b.kind,
          rateBps: 'rateBps' in b ? (b.rateBps ?? null) : null,
          amountIdr: 'amountIdr' in b ? (b.amountIdr ?? null) : null,
          capIdr: 'capIdr' in b ? (b.capIdr ?? null) : null,
        }
      : null,
    conditions: {
      minItemValueIdr: int(c.minItemValueIdr) ?? null,
      originCountries: strs(c.originCountries) ?? [],
      categories: strs(c.categories) ?? [],
      firstTransactionOnly: c.firstTransactionOnly === true,
    },
    startsAt: r.starts_at.toISOString(),
    endsAt: r.ends_at?.toISOString() ?? null,
  };
}
