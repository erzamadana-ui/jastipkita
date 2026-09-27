/**
 * Heuristic product extraction (no AI): fetches a product page with strict SSRF protection and reads
 * JSON-LD Product/Offer, OpenGraph/product meta tags and common microdata. Merchant domains map to a
 * country; the category is guessed from keywords. Photo extraction returns "manual input needed"
 * (pluggable AI provider later). Everything returned is a DRAFT for the buyer to confirm.
 *
 * `price` in ExtractedProduct is in MAJOR units (e.g. 19.99 USD, 12800 JPY); the API converts to
 * minor units with @jastipkita/core `toMinor`.
 */
import { isSupportedCurrency, keywordMatches } from '@jastipkita/core';
import type { ExtractedProduct, ExtractionProvider } from '../types';
import { type Resolver, UrlNotAllowedError, assertPublicUrl, defaultResolver } from './ssrf';

export { UrlNotAllowedError } from './ssrf';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HeuristicExtractionOptions {
  fetch?: FetchLike;
  resolve?: Resolver;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  userAgent?: string;
}

// ------------------------------------------------------------------------------ merchant → country

interface MerchantRule {
  test: (host: string) => boolean;
  country: string;
  name?: string;
}
const endsWith = (...suffixes: string[]) => (h: string) => suffixes.some((s) => h === s || h.endsWith(`.${s}`));

export const MERCHANT_RULES: readonly MerchantRule[] = [
  // Japan
  { test: endsWith('amazon.co.jp'), country: 'JP', name: 'Amazon Japan' },
  { test: endsWith('rakuten.co.jp'), country: 'JP', name: 'Rakuten' },
  { test: (h) => /(^|\.)uniqlo\.com$/.test(h), country: 'JP', name: 'UNIQLO' }, // refined by path /jp/ below
  { test: endsWith('mercari.com', 'jp.mercari.com'), country: 'JP', name: 'Mercari' },
  { test: endsWith('yodobashi.com'), country: 'JP', name: 'Yodobashi' },
  { test: endsWith('biccamera.com'), country: 'JP', name: 'Bic Camera' },
  { test: endsWith('muji.com'), country: 'JP', name: 'MUJI' },
  // Korea
  { test: endsWith('oliveyoung.co.kr', 'global.oliveyoung.com'), country: 'KR', name: 'Olive Young' },
  { test: endsWith('musinsa.com'), country: 'KR', name: 'MUSINSA' },
  { test: endsWith('coupang.com'), country: 'KR', name: 'Coupang' },
  { test: endsWith('gmarket.co.kr'), country: 'KR', name: 'Gmarket' },
  // Singapore
  { test: endsWith('lazada.sg'), country: 'SG', name: 'Lazada Singapore' },
  { test: endsWith('shopee.sg'), country: 'SG', name: 'Shopee Singapore' },
  // Malaysia
  { test: endsWith('lazada.com.my'), country: 'MY', name: 'Lazada Malaysia' },
  { test: endsWith('shopee.com.my'), country: 'MY', name: 'Shopee Malaysia' },
  // US
  { test: endsWith('amazon.com'), country: 'US', name: 'Amazon' },
  { test: endsWith('target.com'), country: 'US', name: 'Target' },
  { test: endsWith('bestbuy.com'), country: 'US', name: 'Best Buy' },
  { test: endsWith('sephora.com'), country: 'US', name: 'Sephora' },
  { test: endsWith('walmart.com'), country: 'US', name: 'Walmart' },
  { test: endsWith('costco.com'), country: 'US', name: 'Costco' },
  // Australia
  { test: endsWith('chemistwarehouse.com.au'), country: 'AU', name: 'Chemist Warehouse' },
];

const TLD_COUNTRY: readonly [RegExp, string][] = [
  [/\.(co\.)?jp$/, 'JP'],
  [/\.(co\.)?kr$/, 'KR'],
  [/\.(com\.)?sg$/, 'SG'],
  [/\.(com\.)?my$/, 'MY'],
  [/\.(com\.)?au$/, 'AU'],
];

const CURRENCY_COUNTRY: Readonly<Record<string, string>> = { JPY: 'JP', KRW: 'KR', SGD: 'SG', MYR: 'MY', AUD: 'AU', USD: 'US' };

export function merchantFromUrl(url: URL): { country: string | null; name: string | null } {
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  // UNIQLO: /jp/ → JP, /us/ → US, /sg/ → SG…
  if (/(^|\.)uniqlo\.com$/.test(host)) {
    const seg = url.pathname.split('/')[1]?.toLowerCase() ?? '';
    const map: Record<string, string> = { jp: 'JP', us: 'US', sg: 'SG', my: 'MY', au: 'AU', kr: 'KR' };
    return { country: map[seg] ?? 'JP', name: 'UNIQLO' };
  }
  for (const r of MERCHANT_RULES) if (r.test(host)) return { country: r.country, name: r.name ?? null };
  for (const [re, c] of TLD_COUNTRY) if (re.test(host)) return { country: c, name: null };
  return { country: null, name: null };
}

// ------------------------------------------------------------------------------ category keywords

export const CATEGORY_KEYWORDS: readonly [string, readonly string[]][] = [
  ['COLLECTIBLES_TCG', ['pokemon card', 'trading card', 'tcg', 'booster box', 'booster pack', 'one piece card']],
  ['BATTERIES_POWERBANK', ['power bank', 'powerbank', 'portable charger', 'battery pack']],
  ['MOBILE_PHONES', ['iphone', 'smartphone', 'galaxy s', 'pixel', 'handphone', 'ponsel']],
  ['COMPUTERS_TABLETS', ['laptop', 'macbook', 'ipad', 'tablet', 'notebook pc']],
  ['CAMERAS', ['camera', 'kamera', 'lens', 'lensa', 'instax', 'mirrorless']],
  ['GAMING', ['nintendo', 'playstation', 'ps5', 'xbox', 'console', 'konsol', 'joy con']],
  ['ELECTRONICS_AUDIO', ['headphone', 'headphones', 'earbuds', 'earphone', 'airpods', 'speaker', 'walkman']],
  ['WATCHES_JEWELRY', ['watch', 'jam tangan', 'necklace', 'kalung', 'ring', 'cincin', 'bracelet', 'gelang', 'earrings', 'anting']],
  ['PERFUME', ['perfume', 'parfum', 'eau de parfum', 'eau de toilette', 'cologne', 'fragrance']],
  ['COSMETICS_SKINCARE', ['serum', 'toner', 'essence', 'moisturizer', 'cream', 'krim', 'sunscreen', 'sunblock', 'cushion', 'lipstick', 'lip tint', 'foundation', 'mascara', 'skincare', 'cleanser', 'sheet mask', 'masker']],
  ['SUPPLEMENTS_VITAMINS', ['vitamin', 'supplement', 'suplemen', 'collagen', 'kolagen', 'probiotic', 'omega 3', 'fish oil']],
  ['MEDICINE', ['obat', 'medicine', 'tablet obat', 'pain relief', 'eye drops', 'tetes mata']],
  ['FOOTWEAR', ['sneaker', 'sneakers', 'shoe', 'shoes', 'sepatu', 'sandal', 'sandals', 'boots', 'loafer']],
  ['BAGS_ACCESSORIES', ['bag', 'tas', 'backpack', 'ransel', 'wallet', 'dompet', 'tote', 'pouch', 'belt', 'sabuk']],
  ['BABY_KIDS', ['baby', 'bayi', 'stroller', 'diaper', 'popok']],
  ['TOYS_HOBBIES', ['lego', 'figure', 'figur', 'gundam', 'gunpla', 'plush', 'boneka', 'toy', 'toys', 'mainan', 'tamiya', 'nendoroid']],
  ['BOOKS_MEDIA', ['book', 'buku', 'manga', 'novel', 'artbook', 'vinyl', 'blu ray']],
  ['FOOD_SNACKS', ['snack', 'chocolate', 'cokelat', 'kitkat', 'matcha', 'candy', 'permen', 'cookies', 'biskuit', 'ramen']],
  ['SPORTS_OUTDOOR', ['golf', 'yoga mat', 'tennis', 'badminton', 'hiking', 'camping']],
  ['FASHION_APPAREL', ['t shirt', 'tshirt', 'shirt', 'kemeja', 'kaos', 'jacket', 'jaket', 'hoodie', 'sweater', 'dress', 'pants', 'celana', 'jeans', 'skirt', 'rok', 'uniqlo', 'airism', 'heattech']],
];

export function guessCategory(text: string): string | null {
  if (!text.trim()) return null;
  for (const [code, kws] of CATEGORY_KEYWORDS) if (kws.some((k) => keywordMatches(text, k))) return code;
  return null;
}

// ------------------------------------------------------------------------------ HTML parsing

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1]?.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function clean(s: unknown, max = 300): string | undefined {
  if (typeof s !== 'string') return undefined;
  const v = decodeEntities(s).replace(/\s+/g, ' ').trim();
  return v ? v.slice(0, max) : undefined;
}

/** Parses "<meta …>" tags into a lowercase key → content map (property / name / itemprop). */
export function parseMeta(html: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of html.matchAll(/<meta\b([^>]*)>/gi)) {
    const attrs = new Map<string, string>();
    for (const a of (m[1] ?? '').matchAll(/([a-zA-Z_:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
      attrs.set(a[1]!.toLowerCase(), a[3] ?? a[4] ?? a[5] ?? '');
    }
    const key = (attrs.get('property') ?? attrs.get('name') ?? attrs.get('itemprop'))?.toLowerCase();
    const content = attrs.get('content');
    if (key && content !== undefined && !out.has(key)) out.set(key, decodeEntities(content));
  }
  return out;
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function typeIncludes(node: { [k: string]: Json }, t: string): boolean {
  const ty = node['@type'];
  if (typeof ty === 'string') return ty.toLowerCase() === t.toLowerCase() || ty.toLowerCase().endsWith(`/${t.toLowerCase()}`);
  return Array.isArray(ty) && ty.some((x) => typeof x === 'string' && x.toLowerCase() === t.toLowerCase());
}

/** Finds Product / ProductGroup nodes in every JSON-LD block (handles @graph and arrays). */
export function jsonLdProducts(html: string): { [k: string]: Json }[] {
  const out: { [k: string]: Json }[] = [];
  const visit = (n: Json, depth: number) => {
    if (depth > 8 || n === null || typeof n !== 'object') return;
    if (Array.isArray(n)) {
      for (const x of n) visit(x, depth + 1);
      return;
    }
    if (typeIncludes(n, 'Product') || typeIncludes(n, 'ProductGroup')) out.push(n);
    if (n['@graph']) visit(n['@graph'], depth + 1);
    if (n.mainEntity) visit(n.mainEntity, depth + 1);
  };
  for (const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)) {
    const raw = (m[1] ?? '').replace(/^\s*<!--/, '').replace(/-->\s*$/, '').replace(/^\s*\/\/<!\[CDATA\[/, '').replace(/\/\/\]\]>\s*$/, '').trim();
    try {
      visit(JSON.parse(raw) as Json, 0);
    } catch {
      /* malformed JSON-LD — ignore block */
    }
  }
  return out;
}

function firstString(v: Json | undefined): string | undefined {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) {
    for (const x of v) {
      const s = firstString(x);
      if (s) return s;
    }
  }
  if (v && typeof v === 'object' && !Array.isArray(v)) return firstString(v.url ?? v.name ?? v['@id']);
  return undefined;
}

interface OfferInfo {
  price?: string;
  currency?: string;
}

function offerFrom(v: Json | undefined): OfferInfo {
  if (!v) return {};
  if (Array.isArray(v)) {
    for (const x of v) {
      const o = offerFrom(x);
      if (o.price) return o;
    }
    return {};
  }
  if (typeof v !== 'object') return {};
  const spec = v.priceSpecification;
  const specObj = Array.isArray(spec) ? spec[0] : spec;
  const price =
    firstString(v.price) ??
    firstString(v.lowPrice) ??
    (specObj && typeof specObj === 'object' && !Array.isArray(specObj) ? firstString(specObj.price) : undefined);
  const currency =
    firstString(v.priceCurrency) ??
    (specObj && typeof specObj === 'object' && !Array.isArray(specObj) ? firstString(specObj.priceCurrency) : undefined);
  if (!price && v.offers) return offerFrom(v.offers);
  return { ...(price ? { price } : {}), ...(currency ? { currency } : {}) };
}

/**
 * Normalizes a human price ("¥12,800", "1.234,56", "$19.99", "₩ 25,000") into a decimal string in
 * major units, using the currency's minor units to disambiguate separators.
 */
export function normalizePrice(raw: string, minorUnits: number | null): string | null {
  const s = raw.replace(/[^\d.,]/g, '');
  if (!/\d/.test(s)) return null;
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  let intPart = s;
  let frac = '';
  const sepIdx = Math.max(lastDot, lastComma);
  if (sepIdx >= 0) {
    const after = s.slice(sepIdx + 1);
    const both = lastDot >= 0 && lastComma >= 0;
    let isDecimal: boolean;
    if (both) isDecimal = true;
    else if (minorUnits === 0) isDecimal = /^0{1,2}$/.test(after); // "12800.00" JPY
    else isDecimal = after.length > 0 && after.length <= (minorUnits ?? 2);
    if (isDecimal) {
      intPart = s.slice(0, sepIdx);
      frac = after;
    }
  }
  const digits = intPart.replace(/[.,]/g, '');
  if (!/^\d{1,15}$/.test(digits)) return null;
  frac = frac.replace(/0+$/, '');
  const norm = frac ? `${digits}.${frac}` : digits;
  return Number(norm) >= 0 ? norm.replace(/^0+(?=\d)/, '') : null;
}

const MINOR: Readonly<Record<string, number>> = { JPY: 0, KRW: 0, IDR: 0, VND: 0, USD: 2, SGD: 2, MYR: 2, AUD: 2, EUR: 2, GBP: 2, HKD: 2, CNY: 2, TWD: 2, THB: 2 };

// ------------------------------------------------------------------------------ provider

export class HeuristicExtractionProvider implements ExtractionProvider {
  readonly mode = 'LIVE' as const;
  private readonly fetchFn: FetchLike;
  private readonly resolve: Resolver;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly maxRedirects: number;
  private readonly userAgent: string;

  constructor(opts: HeuristicExtractionOptions = {}) {
    this.fetchFn = opts.fetch ?? ((u, i) => fetch(u, i));
    this.resolve = opts.resolve ?? defaultResolver;
    this.timeoutMs = opts.timeoutMs ?? 5000;
    this.maxBytes = opts.maxBytes ?? 1024 * 1024;
    this.maxRedirects = opts.maxRedirects ?? 3;
    this.userAgent = opts.userAgent ?? 'JastipKitaBot/1.0 (+https://jastipkita.id/bot; product preview)';
  }

  /** Fetches with manual redirects (each target re-validated), 1 MB cap and one overall timeout. */
  async fetchPage(rawUrl: string): Promise<{ finalUrl: URL; html: string; truncated: boolean; contentType: string }> {
    let url = await assertPublicUrl(rawUrl, this.resolve);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      for (let hop = 0; ; hop++) {
        const res = await this.fetchFn(url.toString(), {
          method: 'GET',
          redirect: 'manual',
          signal: ac.signal,
          headers: { accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1', 'user-agent': this.userAgent, 'accept-language': 'en,ja;q=0.8,ko;q=0.7,id;q=0.6' },
        });
        if (res.status >= 300 && res.status < 400) {
          const loc = res.headers.get('location');
          await res.body?.cancel().catch(() => {});
          if (!loc) throw new ExtractionFetchError('REDIRECT_WITHOUT_LOCATION');
          if (hop >= this.maxRedirects) throw new UrlNotAllowedError('TOO_MANY_REDIRECTS', 'Terlalu banyak redirect');
          url = await assertPublicUrl(new URL(loc, url), this.resolve);
          continue;
        }
        if (!res.ok) {
          await res.body?.cancel().catch(() => {});
          throw new ExtractionFetchError(`HTTP_${res.status}`);
        }
        const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
        if (contentType && !/text\/html|application\/xhtml\+xml/.test(contentType)) {
          await res.body?.cancel().catch(() => {});
          throw new ExtractionFetchError('UNSUPPORTED_CONTENT_TYPE');
        }
        const declared = Number(res.headers.get('content-length') ?? '0');
        const { bytes, truncated } = await readCapped(res, this.maxBytes);
        const charset = /charset=([\w-]+)/.exec(contentType)?.[1] ?? 'utf-8';
        let decoder: TextDecoder;
        try {
          decoder = new TextDecoder(charset);
        } catch {
          decoder = new TextDecoder('utf-8');
        }
        return { finalUrl: url, html: decoder.decode(bytes), truncated: truncated || declared > this.maxBytes, contentType };
      }
    } catch (err) {
      if (err instanceof UrlNotAllowedError || err instanceof ExtractionFetchError) throw err;
      if (ac.signal.aborted) throw new ExtractionFetchError('TIMEOUT');
      throw new ExtractionFetchError('FETCH_FAILED');
    } finally {
      clearTimeout(timer);
    }
  }

  /** Pure parse step (exported for tests): HTML + URL → draft. */
  parse(html: string, url: URL, warnings: string[] = []): ExtractedProduct {
    const meta = parseMeta(html);
    const products = jsonLdProducts(html);
    const p = products[0];
    let name: string | undefined;
    let brand: string | undefined;
    let image: string | undefined;
    let priceRaw: string | undefined;
    let currency: string | undefined;
    let categoryText = '';
    let fromJsonLd = false;
    if (p) {
      fromJsonLd = true;
      name = clean(firstString(p.name));
      brand = clean(firstString(p.brand));
      image = clean(firstString(p.image), 2000);
      const offer = offerFrom(p.offers ?? p.hasVariant);
      priceRaw = offer.price;
      currency = offer.currency?.toUpperCase();
      categoryText = clean(firstString(p.category)) ?? '';
    }
    name ??= clean(meta.get('og:title')) ?? clean(meta.get('twitter:title')) ?? clean(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]);
    image ??= clean(meta.get('og:image') ?? meta.get('og:image:url') ?? meta.get('twitter:image'), 2000);
    priceRaw ??= meta.get('product:price:amount') ?? meta.get('og:price:amount') ?? meta.get('price');
    currency ??= (meta.get('product:price:currency') ?? meta.get('og:price:currency') ?? meta.get('pricecurrency'))?.toUpperCase();
    brand ??= clean(meta.get('product:brand') ?? meta.get('og:brand'));

    const merchant = merchantFromUrl(url);
    const siteName = clean(meta.get('og:site_name'), 100);
    if (currency && (!/^[A-Z]{3}$/.test(currency) || !isSupportedCurrency(currency))) {
      warnings.push('CURRENCY_UNSUPPORTED');
      currency = undefined;
    }
    let price: number | undefined;
    if (priceRaw) {
      const norm = normalizePrice(priceRaw, currency ? (MINOR[currency] ?? null) : null);
      if (norm !== null && Number.isFinite(Number(norm))) price = Number(norm);
    }
    if (price === undefined) warnings.push('PRICE_NOT_FOUND');
    if (!currency) warnings.push('CURRENCY_NOT_FOUND');
    const merchantCountry = merchant.country ?? (currency ? (CURRENCY_COUNTRY[currency] ?? undefined) : undefined);
    if (!merchant.country) warnings.push(merchantCountry ? 'MERCHANT_COUNTRY_FROM_CURRENCY' : 'MERCHANT_COUNTRY_UNKNOWN');
    if (image && image.startsWith('/')) image = new URL(image, url).toString();
    if (image && !/^https?:\/\//i.test(image)) image = undefined;
    const productName = name && brand && !name.toLowerCase().includes(brand.toLowerCase()) ? `${brand} ${name}` : name;
    const categoryCode = guessCategory(`${productName ?? ''} ${categoryText}`) ?? undefined;
    if (!categoryCode) warnings.push('CATEGORY_UNKNOWN');
    if (!productName) warnings.push('NAME_NOT_FOUND');

    let confidence = 0;
    if (productName) confidence += 0.3;
    if (price !== undefined && currency) confidence += 0.3;
    if (image) confidence += 0.1;
    if (merchant.country) confidence += 0.15;
    if (categoryCode) confidence += 0.1;
    if (fromJsonLd) confidence += 0.05;
    return {
      ...(productName ? { productName: productName.slice(0, 300) } : {}),
      merchantName: merchant.name ?? siteName ?? url.hostname.replace(/^www\./, ''),
      ...(merchantCountry ? { merchantCountry } : {}),
      ...(price !== undefined ? { price } : {}),
      ...(currency ? { currency } : {}),
      ...(image ? { imageUrl: image } : {}),
      ...(categoryCode ? { categoryCode } : {}),
      confidence: Math.round(Math.min(1, confidence) * 100) / 100,
      source: 'URL',
      warnings: [...new Set(['HEURISTIC_EXTRACTION', ...warnings])],
    };
  }

  async fromUrl(rawUrl: string): Promise<ExtractedProduct> {
    const url = await assertPublicUrl(rawUrl, this.resolve); // throws UrlNotAllowedError before any network I/O
    try {
      const page = await this.fetchPage(url.toString());
      return this.parse(page.html, page.finalUrl, page.truncated ? ['CONTENT_TRUNCATED'] : []);
    } catch (err) {
      if (err instanceof UrlNotAllowedError) throw err;
      // Page could not be read: return what the URL itself tells us (merchant/country) + manual input.
      const merchant = merchantFromUrl(url);
      const code = err instanceof ExtractionFetchError ? err.code : 'FETCH_FAILED';
      return {
        merchantName: merchant.name ?? url.hostname.replace(/^www\./, ''),
        ...(merchant.country ? { merchantCountry: merchant.country } : {}),
        confidence: merchant.country ? 0.1 : 0,
        source: 'URL',
        warnings: ['HEURISTIC_EXTRACTION', `FETCH_${code}`, 'MANUAL_INPUT_REQUIRED'],
      };
    }
  }

  async fromImage(input: { fileKey: string; hint?: string }): Promise<ExtractedProduct> {
    const hint = input.hint?.trim();
    const categoryCode = hint ? guessCategory(hint) : null;
    return {
      ...(hint ? { productName: hint.slice(0, 300) } : {}),
      ...(categoryCode ? { categoryCode } : {}),
      confidence: 0,
      source: 'PHOTO',
      warnings: ['AI_EXTRACTION_NOT_CONFIGURED', 'MANUAL_INPUT_REQUIRED'],
    };
  }

  async search(query: string, country?: string): Promise<ExtractedProduct[]> {
    const q = query.replace(/\s+/g, ' ').trim().slice(0, 300);
    const categoryCode = guessCategory(q);
    return [
      {
        productName: q,
        ...(country ? { merchantCountry: country } : {}),
        ...(categoryCode ? { categoryCode } : {}),
        confidence: 0.2,
        source: 'SEARCH',
        warnings: ['SEARCH_DRAFT_ONLY', 'PRICE_NOT_FOUND', ...(categoryCode ? [] : ['CATEGORY_UNKNOWN'])],
      },
    ];
  }
}

export class ExtractionFetchError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ExtractionFetchError';
  }
}

async function readCapped(res: Response, maxBytes: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    return buf.length > maxBytes ? { bytes: buf.slice(0, maxBytes), truncated: true } : { bytes: buf, truncated: false };
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.length > maxBytes) {
      chunks.push(value.slice(0, maxBytes - total));
      total = maxBytes;
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return { bytes: out, truncated };
}
