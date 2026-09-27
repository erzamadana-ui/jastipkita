/**
 * BUILD-TIME ONLY bridge to @jastipkita/core (imported from .astro frontmatter; never shipped to the browser).
 * Every number shown on the static pages (price breakdown example, customs examples, fees, limits, SLAs)
 * is computed here from the real engines + DEFAULT_BUSINESS_CONFIG + the seed customs rules, so marketing
 * copy cannot drift from what the app will charge.
 */
import {
  DEFAULT_BUSINESS_CONFIG as cfg,
  buildQuote,
  createFxLock,
  estimateCustoms,
  markupBpsFor,
  PRODUCT_CATEGORIES,
  type CustomsRule,
} from '@jastipkita/core';
import { KMK_RATES } from '../data/kmk-rates.ts';
import { estimateNonPersonal, RULE_NON_PERSONAL } from './customs.ts';
import { formatIdr } from './money.ts';

export const BUSINESS = cfg;

/** Seed rule ID_PAX_NON_PERSONAL v1 (db/seeds/0100_customs_rules.sql), shape of packages/core CustomsRule. */
export const SEED_NON_PERSONAL_RULE: CustomsRule = {
  id: 'seed:ID_PAX_NON_PERSONAL@1',
  code: 'ID_PAX_NON_PERSONAL',
  version: 1,
  originCountry: null,
  destinationCountry: 'ID',
  hsCodePrefix: null,
  categoryCode: null,
  treatment: 'NON_PERSONAL',
  formulaCode: 'ID_PASSENGER_V2025',
  exemptionUsd: null,
  dutyRate: '0.100000',
  vatRate: '0.120000',
  vatDppFactor: '0.916667',
  luxuryTaxRate: '0.000000',
  incomeTaxRate: '0.050000',
  incomeTaxRateNoNpwp: null,
  rounding: 'CEIL_1000',
  priority: 100,
  effectiveFrom: '2025-06-06',
  effectiveUntil: null,
  sourceReference: RULE_NON_PERSONAL.sourceReference,
  sourceUrl: RULE_NON_PERSONAL.sourceUrl,
  lastVerifiedAt: '2026-09-27',
  status: 'ACTIVE',
};

const MINOR: Record<string, number> = { JPY: 0, KRW: 0, SGD: 2, USD: 2, MYR: 2, AUD: 2, EUR: 2, IDR: 0 };
const NOW = new Date('2026-09-27T03:00:00Z');

function toMinor(major: string, currency: string): number {
  const m = MINOR[currency] ?? 2;
  const [i = '0', f = ''] = major.split('.');
  return Number(i) * 10 ** m + Number((f + '0'.repeat(m)).slice(0, m) || '0');
}

export function categoryName(code: string, lang: 'id' | 'en' = 'id'): string {
  const c = PRODUCT_CATEGORIES.find((x) => x.code === code);
  return c ? (lang === 'id' ? c.nameId : c.nameEn) : code;
}

export function categoryMeta(code: string) {
  return PRODUCT_CATEGORIES.find((x) => x.code === code);
}

export interface CustomsExample {
  customsValueIdr: number;
  dutyIdr: number;
  vatIdr: number;
  incomeTaxIdr: number;
  importTaxIdr: number;
  totalIdr: number;
  rate: string;
  pct: string;
  steps: Array<{ label: string; formula: string; amount: number }>;
}

/**
 * Customs estimate with the weekly KMK tax rate via the REAL engine, cross-checked against the browser
 * fallback (src/lib/customs.ts). Throws — failing the build — if the two ever disagree.
 */
export function customsExample(currency: string, unitPrice: string, quantity: number, categoryCode: string): CustomsExample {
  const rate = KMK_RATES.rates[currency];
  if (!rate) throw new Error(`No KMK rate for ${currency}`);
  const est = estimateCustoms({
    originCountry: 'XX',
    destinationCountry: 'ID',
    categoryCode,
    itemValueMinor: toMinor(unitPrice, currency),
    currency,
    quantity,
    treatment: 'NON_PERSONAL',
    hasNpwp: true,
    fx: { itemToIdr: rate, usdToIdr: KMK_RATES.rates.USD },
    date: NOW,
    rules: [SEED_NON_PERSONAL_RULE],
  });
  const fb = estimateNonPersonal({ unitPrice, quantity, itemToIdr: rate, usdToIdr: KMK_RATES.rates.USD ?? '17707' });
  for (const [k, a, b] of [
    ['customsValue', est.customsValueIdr, fb.customsValueIdr],
    ['duty', est.dutyIdr, fb.dutyIdr],
    ['vat', est.vatIdr, fb.vatIdr],
    ['income', est.incomeTaxIdr, fb.incomeTaxIdr],
    ['total', est.totalIdr, fb.totalIdr],
  ] as const) {
    if (a !== b) throw new Error(`Customs fallback drift (${currency} ${unitPrice}): ${k} engine=${a} fallback=${b}`);
  }
  const pct = ((est.totalIdr / est.customsValueIdr) * 100).toFixed(1).replace('.', ',');
  return {
    customsValueIdr: est.customsValueIdr,
    dutyIdr: est.dutyIdr,
    vatIdr: est.vatIdr,
    incomeTaxIdr: est.incomeTaxIdr,
    importTaxIdr: est.importTaxIdr,
    totalIdr: est.totalIdr,
    rate,
    pct,
    steps: est.breakdownSteps.map((s) => ({ label: s.label, formula: s.formula, amount: s.amount })),
  };
}

export interface ExampleLine {
  type: string;
  labelId: string;
  labelEn: string;
  sub?: { id: string; en: string };
  amountIdr: number;
  isEstimate: boolean;
}

/**
 * The landing-page 11-line breakdown: ¥60.000 sneakers, illustrative spot ¥1 = Rp110 (+ configured JPY markup),
 * 10% traveler fee, Virtual Account, no promo/credit. Computed by core `buildQuote`.
 */
export function landingQuote() {
  const spot = '110';
  const lock = createFxLock({
    base: 'JPY',
    quote: 'IDR',
    spotRate: spot,
    markupBps: markupBpsFor('JPY', cfg['pricing.fx_markup']),
    now: NOW,
    lockMinutes: cfg['fx.lock'].lockMinutes,
  });
  const customs = estimateCustoms({
    originCountry: 'JP',
    destinationCountry: 'ID',
    categoryCode: 'FOOTWEAR',
    itemValueMinor: 60000,
    currency: 'JPY',
    quantity: 1,
    hasNpwp: true,
    fx: { itemToIdr: spot, usdToIdr: KMK_RATES.rates.USD },
    date: NOW,
    rules: [SEED_NON_PERSONAL_RULE],
  });
  const quote = buildQuote(
    {
      item: { unitPriceMinor: 60000, currency: 'JPY', quantity: 1 },
      fxLock: lock,
      travelerFee: { type: 'PERCENT', rateBps: 1000 },
      customs,
      paymentChannel: 'VA',
      now: NOW,
      configVersion: 1,
    },
    cfg,
  );
  const pf = cfg['pricing.platform_fee'];
  const pr = cfg['pricing.protection_fee'];
  const subs: Record<string, { id: string; en: string }> = {
    ITEM_PRICE: { id: `1 × ¥60.000 · kurs ¥1 = Rp ${lock.lockedRate.replace('.', ',')}`, en: `1 × ¥60,000 · rate ¥1 = IDR ${lock.lockedRate}` },
    TRAVELER_FEE: { id: '10% harga barang (ditawarkan traveler)', en: '10% of item price (set by the traveler)' },
    CUSTOMS_DUTY: { id: '10% nilai pabean', en: '10% of customs value' },
    IMPORT_TAX: { id: 'PPN + PPh 22', en: 'VAT + income tax art. 22' },
    PROTECTION_FEE: { id: `${bps(pr.rateBps)} harga barang`, en: `${bps(pr.rateBps, 'en')} of item price` },
    PLATFORM_FEE: { id: `${bps(pf.rateBps)} harga barang`, en: `${bps(pf.rateBps, 'en')} of item price` },
    SERVICE_TAX: { id: '12% × 11/12 atas fee layanan', en: '12% × 11/12 on service fees' },
    PAYMENT_FEE: { id: 'Virtual Account', en: 'Virtual Account' },
    DISCOUNT: { id: 'bila ada promo', en: 'if a promo applies' },
    REFERRAL_CREDIT: { id: 'bila punya credit', en: 'if you have credit' },
  };
  const labelsEn: Record<string, string> = {
    CUSTOMS_DUTY: 'Import duty',
    IMPORT_TAX: 'Import taxes',
    SERVICE_TAX: 'VAT on services',
  };
  const labelsId: Record<string, string> = {
    CUSTOMS_DUTY: 'Bea Masuk',
    IMPORT_TAX: 'Pajak Impor',
    SERVICE_TAX: 'PPN atas layanan',
    DISCOUNT: 'Diskon promo',
  };
  const lines: ExampleLine[] = quote.lines.map((l) => ({
    type: l.type,
    labelId: labelsId[l.type] ?? l.labelId,
    labelEn: labelsEn[l.type] ?? l.labelEn,
    sub: subs[l.type],
    amountIdr: l.amountIdr,
    isEstimate: l.isEstimate && l.type !== 'TOTAL',
  }));
  return { lines, totalIdr: quote.totalIdr, lockedRate: lock.lockedRate, spot, customs };
}

export function bps(v: number, lang: 'id' | 'en' = 'id'): string {
  const s = (v / 100).toString();
  return `${lang === 'id' ? s.replace('.', ',') : s}%`;
}

/** Fill {PLACEHOLDERS} used in data copy. */
export function fill(text: string, vars: Record<string, string>): string {
  return text.replace(/\{([A-Z_]+)\}/g, (m, k: string) => vars[k] ?? m);
}

export function configVars(lang: 'id' | 'en' = 'id'): Record<string, string> {
  return {
    MIN_ITEM: formatIdr(cfg['pricing.minimum_transaction'].minItemValueIdr, lang),
    MIN_TRAVELER_FEE: formatIdr(cfg['pricing.traveler_fee_bounds'].minIdr, lang),
    MIN_PLATFORM_FEE: formatIdr(cfg['pricing.platform_fee'].minIdr, lang),
  };
}
