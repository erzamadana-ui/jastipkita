/**
 * Buyer requests ("titipan"): extraction drafts, CRUD, restriction classification, publish/cancel,
 * traveler listing views (no buyer PII).
 */
import { convert, toMinor } from '@jastipkita/core';
import type { AppDeps, AuthContext } from '../../context';
import type { Db } from '../../db/sql';
import { AppError, Errors } from '../../lib/errors';
import { fileContentUrl } from '../../lib/openapi';
import { UrlNotAllowedError } from '../../providers/extraction/ssrf';
import type { ExtractedProduct } from '../../providers/types';
import { emitEvent } from '../../services/outbox';
import { assertCategory, assertCurrency, assertDestinationCountry, assertOriginCountry } from '../catalog/service';
import { badCursor, decodeKeyset, encodeKeyset, iso, isIsoDate, numOrNull, tx, wibDate, wibEndOfDay } from '../catalog/shared';
import { getSpotRate, toIdrAtSpot } from '../fx/service';
import { type PublicProfileDto, loadUserSignals, publicProfile } from '../matching/signals';
import { closePendingOffers } from '../offers/lifecycle';
import { type ItemClassification, classifyRequestItem } from '../restricted/service';
import { getFile } from '../trips/repository';
import * as repo from './repository';
import type { RequestRow, RequestStatus, RestrictionClass } from './repository';

type Deps = Pick<AppDeps, 'sql' | 'config' | 'clock' | 'logger' | 'providers' | 'env'>;

/** Assumption (no business config key yet): an OPEN request without needed_by expires after 30 days. */
export const REQUEST_TTL_DAYS = 30;
const MAX_IMAGES = 5;

// ------------------------------------------------------------------------------------ extraction

export interface ExtractInput {
  url?: string | undefined;
  fileId?: string | undefined;
  query?: string | undefined;
  country?: string | undefined;
  hint?: string | undefined;
}

export interface ExtractionDraft {
  sourceType: 'URL' | 'PHOTO' | 'SEARCH';
  productUrl: string | null;
  productName: string | null;
  merchantName: string | null;
  merchantCountry: string | null;
  unitPriceMinor: number | null;
  priceCurrency: string | null;
  imageUrl: string | null;
  categoryCode: string | null;
  variant: string | null;
}

export interface ExtractionResult {
  drafts: ExtractionDraft[];
  confidence: number;
  needsManualInput: boolean;
  warnings: string[];
  mode: 'MOCK' | 'SANDBOX' | 'LIVE';
}

function toDraft(p: ExtractedProduct, sourceType: ExtractionDraft['sourceType'], productUrl: string | null, warnings: Set<string>): ExtractionDraft {
  let unitPriceMinor: number | null = null;
  if (p.price !== undefined && p.currency) {
    try {
      unitPriceMinor = toMinor(String(p.price), p.currency);
    } catch {
      warnings.add('PRICE_UNPARSEABLE');
    }
  }
  return {
    sourceType,
    productUrl,
    productName: p.productName ?? null,
    merchantName: p.merchantName ?? null,
    merchantCountry: p.merchantCountry ?? null,
    unitPriceMinor,
    priceCurrency: unitPriceMinor !== null ? (p.currency ?? null) : null,
    imageUrl: p.imageUrl ?? null,
    categoryCode: p.categoryCode ?? null,
    variant: p.variant ?? null,
  };
}

export async function extract(deps: Deps, auth: AuthContext, input: ExtractInput): Promise<ExtractionResult> {
  const given = [input.url, input.fileId, input.query].filter((x) => x !== undefined && x !== '');
  if (given.length !== 1) throw Errors.badRequest('EXTRACT_INPUT_INVALID', 'Isi tepat satu dari url, fileId, atau query');
  const provider = deps.providers.extraction;
  const warnings = new Set<string>();
  let products: ExtractedProduct[];
  let sourceType: ExtractionDraft['sourceType'];
  let productUrl: string | null = null;
  try {
    if (input.url) {
      sourceType = 'URL';
      productUrl = input.url;
      products = [await provider.fromUrl(input.url)];
    } else if (input.fileId) {
      sourceType = 'PHOTO';
      const file = await getFile(deps.sql, input.fileId);
      if (!file || file.owner_id !== auth.userId || file.deleted_at) throw Errors.notFound('File', 'FILE_NOT_FOUND');
      if (file.purpose !== 'PRODUCT_PHOTO') throw Errors.unprocessable('FILE_PURPOSE_MISMATCH', 'Foto harus diunggah dengan purpose PRODUCT_PHOTO');
      products = [await provider.fromImage({ fileKey: file.storage_key, ...(input.hint ? { hint: input.hint } : {}) })];
    } else {
      sourceType = 'SEARCH';
      products = await provider.search(input.query!, input.country);
    }
  } catch (err) {
    if (err instanceof UrlNotAllowedError) {
      throw Errors.unprocessable('URL_NOT_ALLOWED', 'URL tidak dapat diproses (hanya toko online publik yang didukung)', { reason: err.reason });
    }
    throw err;
  }
  for (const p of products) for (const w of p.warnings) warnings.add(w);
  const drafts = products.slice(0, 10).map((p) => toDraft(p, sourceType, productUrl, warnings));
  const first = drafts[0];
  const confidence = products[0]?.confidence ?? 0;
  const needsManualInput =
    !first || !first.productName || first.unitPriceMinor === null || !first.merchantCountry || !first.categoryCode || warnings.has('MANUAL_INPUT_REQUIRED');
  return { drafts, confidence, needsManualInput, warnings: [...warnings], mode: provider.mode };
}

// ------------------------------------------------------------------------------------ DTOs

export interface RestrictionDto {
  classification: RestrictionClass | null;
  ruleRef: string | null;
  requiresAcknowledgement: boolean;
  acknowledgedAt: string | null;
  blocksPublishing: boolean;
}

export interface RequestImageDto {
  fileId: string | null;
  /** Absolute: the merchant image URL, or the uploaded file's content URL. */
  url: string | null;
  /** Absolute API URL for uploaded images (GET /v1/files/{id}/content); null for merchant URLs. */
  contentUrl: string | null;
}

export interface RequestOwnerDto {
  id: string;
  status: RequestStatus;
  version: number;
  sourceType: RequestRow['source_type'];
  productUrl: string | null;
  productName: string;
  merchantName: string | null;
  merchantCountry: string | null;
  categoryCode: string | null;
  hsCode: string | null;
  quantity: number;
  variant: string | null;
  unitPriceMinor: number | null;
  priceCurrency: string | null;
  itemValueIdr: number | null;
  estWeightKg: number | null;
  notes: string | null;
  maxBudgetIdr: number | null;
  neededBy: string | null;
  destinationCountry: string;
  destinationCity: string | null;
  deliveryPreference: RequestRow['delivery_preference'];
  restriction: RestrictionDto;
  images: RequestImageDto[];
  pendingOffers: number;
  publishedAt: string | null;
  expiresAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RequestListingDto {
  id: string;
  status: RequestStatus;
  productUrl: string | null;
  productName: string;
  merchantName: string | null;
  merchantCountry: string | null;
  categoryCode: string | null;
  quantity: number;
  variant: string | null;
  unitPriceMinor: number | null;
  priceCurrency: string | null;
  itemValueIdr: number | null;
  estWeightKg: number | null;
  maxBudgetIdr: number | null;
  neededBy: string | null;
  destinationCountry: string;
  destinationCity: string | null;
  deliveryPreference: RequestRow['delivery_preference'];
  restrictionClass: RestrictionClass | null;
  images: RequestImageDto[];
  publishedAt: string | null;
  expiresAt: string | null;
  buyer: PublicProfileDto;
  matchingTripIds?: string[];
}

function restrictionDto(r: RequestRow): RestrictionDto {
  const cls = r.restriction_class;
  const requiresAck = cls !== null && cls !== 'ALLOWED' && cls !== 'PROHIBITED';
  return {
    classification: cls,
    ruleRef: r.restriction_rule_ref,
    requiresAcknowledgement: requiresAck,
    acknowledgedAt: iso(r.restriction_ack_at),
    blocksPublishing: cls === 'PROHIBITED' || (requiresAck && r.restriction_ack_at === null),
  };
}

type RateMemo = Map<string, Promise<string | null>>;

/** Spot IDR value (estimate). Rates are memoised per call so list views do one lookup per currency. */
async function itemValueIdrOrNull(
  db: Db,
  deps: Deps,
  r: Pick<RequestRow, 'unit_price_minor' | 'price_currency' | 'quantity'>,
  memo: RateMemo = new Map(),
): Promise<number | null> {
  if (r.unit_price_minor === null || !r.price_currency) return null;
  const ccy = r.price_currency;
  if (!memo.has(ccy)) {
    memo.set(
      ccy,
      getSpotRate(db, deps, ccy, 'IDR').then(
        (x) => x.spotRate,
        (err: unknown) => {
          if (err instanceof AppError) return null;
          throw err;
        },
      ),
    );
  }
  const rate = await memo.get(ccy)!;
  if (rate === null) return null;
  return convert(r.unit_price_minor * r.quantity, ccy, 'IDR', rate);
}

function imageDtos(rows: repo.ImageRow[] | undefined, apiBaseUrl: string): RequestImageDto[] {
  return (rows ?? []).map((i) => {
    const contentUrl = i.file_id ? fileContentUrl(apiBaseUrl, i.file_id) : null;
    return { fileId: i.file_id, url: i.source_url ?? contentUrl, contentUrl };
  });
}

export async function ownerDto(db: Db, deps: Deps, r: RequestRow): Promise<RequestOwnerDto> {
  const images = await repo.listImages(db, [r.id]);
  const pending = await repo.pendingOfferCount(db, [r.id]);
  return {
    id: r.id,
    status: r.status,
    version: r.version,
    sourceType: r.source_type,
    productUrl: r.product_url,
    productName: r.product_name,
    merchantName: r.merchant_name,
    merchantCountry: r.merchant_country,
    categoryCode: r.category_code,
    hsCode: r.hs_code,
    quantity: r.quantity,
    variant: r.variant,
    unitPriceMinor: r.unit_price_minor,
    priceCurrency: r.price_currency,
    itemValueIdr: await itemValueIdrOrNull(db, deps, r),
    estWeightKg: numOrNull(r.est_weight_kg),
    notes: r.notes,
    maxBudgetIdr: r.max_budget_idr,
    neededBy: r.needed_by,
    destinationCountry: r.destination_country,
    destinationCity: r.destination_city,
    deliveryPreference: r.delivery_preference,
    restriction: restrictionDto(r),
    images: imageDtos(images.get(r.id), deps.env.API_BASE_URL),
    pendingOffers: pending.get(r.id) ?? 0,
    publishedAt: iso(r.published_at),
    expiresAt: iso(r.expires_at),
    closedAt: iso(r.closed_at),
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

/** Traveler-facing view: no notes, no buyer contact data — buyer = public profile only. */
export async function listingDtos(db: Db, deps: Deps, rows: RequestRow[]): Promise<RequestListingDto[]> {
  const signals = await loadUserSignals(db, rows.map((r) => r.buyer_id));
  const images = await repo.listImages(db, rows.map((r) => r.id));
  const memo: RateMemo = new Map();
  const out: RequestListingDto[] = [];
  for (const r of rows) {
    out.push({
      id: r.id,
      status: r.status,
      productUrl: r.product_url,
      productName: r.product_name,
      merchantName: r.merchant_name,
      merchantCountry: r.merchant_country,
      categoryCode: r.category_code,
      quantity: r.quantity,
      variant: r.variant,
      unitPriceMinor: r.unit_price_minor,
      priceCurrency: r.price_currency,
      itemValueIdr: await itemValueIdrOrNull(db, deps, r, memo),
      estWeightKg: numOrNull(r.est_weight_kg),
      maxBudgetIdr: r.max_budget_idr,
      neededBy: r.needed_by,
      destinationCountry: r.destination_country,
      destinationCity: r.destination_city,
      deliveryPreference: r.delivery_preference,
      restrictionClass: r.restriction_class,
      images: imageDtos(images.get(r.id), deps.env.API_BASE_URL),
      publishedAt: iso(r.published_at),
      expiresAt: iso(r.expires_at),
      buyer: publicProfile(signals.get(r.buyer_id), r.buyer_id, 'BUYER'),
    });
  }
  return out;
}

// ------------------------------------------------------------------------------------ commands

export interface RequestInput {
  sourceType: RequestRow['source_type'];
  productUrl?: string | null;
  productName: string;
  merchantName?: string | null;
  merchantCountry: string;
  categoryCode: string;
  hsCode?: string | null;
  quantity: number;
  variant?: string | null;
  unitPriceMinor: number;
  priceCurrency: string;
  estWeightKg?: number | null;
  notes?: string | null;
  maxBudgetIdr?: number | null;
  neededBy?: string | null;
  destinationCountry: string;
  destinationCity?: string | null;
  deliveryPreference?: RequestRow['delivery_preference'];
  imageUrls?: string[];
  imageFileIds?: string[];
  extraction?: Record<string, unknown>;
  acknowledgeRestriction?: boolean;
  publish?: boolean;
}

interface Evaluated {
  values: repo.RequestValues;
  classification: ItemClassification;
  itemValueIdr: number;
}

function normalizeHs(hs: string | null | undefined): string | null {
  if (!hs) return null;
  const d = hs.replace(/[^0-9]/g, '');
  if (d.length < 4 || d.length > 10) throw Errors.validation({ issues: [{ path: 'hsCode', code: 'invalid_hs', message: 'Kode HS 4–10 digit' }] });
  return d;
}

/** Validates + classifies a full set of request values (used by create, patch and publish). */
async function evaluate(
  db: Db,
  deps: Deps,
  v: Omit<repo.RequestValues, 'restrictionClass' | 'restrictionRuleRef' | 'restrictionAckAt' | 'status' | 'publishedAt' | 'expiresAt'>,
  prev: { restrictionClass: RestrictionClass | null; ackAt: Date | null } | null,
  acknowledge: boolean,
): Promise<Evaluated> {
  const today = wibDate(deps.clock.now());
  await assertOriginCountry(db, v.merchantCountry, 'merchantCountry');
  await assertDestinationCountry(db, v.destinationCountry);
  if (v.merchantCountry === v.destinationCountry) throw Errors.unprocessable('SAME_COUNTRY', 'Negara toko dan tujuan harus berbeda');
  await assertCategory(db, v.categoryCode);
  await assertCurrency(db, v.priceCurrency, 'priceCurrency');
  if (v.neededBy !== null) {
    if (!isIsoDate(v.neededBy)) throw Errors.validation({ issues: [{ path: 'neededBy', code: 'invalid_date', message: 'Format tanggal YYYY-MM-DD' }] });
    if (v.neededBy < today) throw Errors.unprocessable('DATE_IN_PAST', 'Tanggal dibutuhkan sudah lewat', { neededBy: v.neededBy, today });
  }
  const total = v.unitPriceMinor * v.quantity;
  if (!Number.isSafeInteger(total)) throw Errors.validation({ issues: [{ path: 'unitPriceMinor', code: 'too_big', message: 'Harga terlalu besar' }] });
  const { idr: itemValueIdr } = await toIdrAtSpot(db, deps, total, v.priceCurrency);
  const min = (await deps.config.get('pricing.minimum_transaction')).minItemValueIdr;
  if (itemValueIdr < min) {
    throw Errors.unprocessable('BELOW_MINIMUM_TRANSACTION', `Nilai barang minimal Rp${min.toLocaleString('id-ID')}`, { itemValueIdr, minItemValueIdr: min });
  }
  if (v.maxBudgetIdr !== null && v.maxBudgetIdr < itemValueIdr) {
    throw Errors.unprocessable('BUDGET_BELOW_ITEM_VALUE', 'Anggaran maksimal lebih kecil dari estimasi harga barang', { itemValueIdr, maxBudgetIdr: v.maxBudgetIdr });
  }
  const classification = await classifyRequestItem(db, deps, {
    originCountry: v.merchantCountry,
    destinationCountry: v.destinationCountry,
    categoryCode: v.categoryCode,
    hsCode: v.hsCode,
    productName: v.productName,
    quantity: v.quantity,
    unitPriceMinor: v.unitPriceMinor,
    currency: v.priceCurrency,
  });
  const cls = classification.classification;
  const needsAck = classification.requiresAcknowledgement;
  // keep an earlier acknowledgement only while the classification is unchanged
  let ackAt: Date | null = prev && prev.restrictionClass === cls ? prev.ackAt : null;
  if (needsAck && acknowledge) ackAt = ackAt ?? deps.clock.now();
  if (!needsAck) ackAt = null;
  return {
    values: {
      ...v,
      restrictionClass: cls,
      restrictionRuleRef: classification.ruleRef,
      restrictionAckAt: ackAt,
      status: 'DRAFT',
      publishedAt: null,
      expiresAt: null,
    },
    classification,
    itemValueIdr,
  };
}

function assertPublishable(e: Evaluated, locale: 'id' | 'en' = 'id'): void {
  const c = e.classification;
  if (c.blocksCheckout) {
    throw Errors.unprocessable('ITEM_PROHIBITED', 'Barang ini dilarang dan tidak dapat dipublikasikan', {
      classification: c.classification,
      messages: locale === 'en' ? c.messagesEn : c.messagesId,
      ruleRef: c.ruleRef,
    });
  }
  if (c.requiresAcknowledgement && e.values.restrictionAckAt === null) {
    throw Errors.unprocessable('RESTRICTION_ACK_REQUIRED', 'Setujui peringatan barang terbatas sebelum mempublikasikan titipan', {
      classification: c.classification,
      messages: c.messagesId,
      permitAuthorities: c.permitAuthorities,
    });
  }
}

function expiryFor(deps: Deps, neededBy: string | null): Date {
  const now = deps.clock.now();
  const ttl = new Date(now.getTime() + REQUEST_TTL_DAYS * 86_400_000);
  if (!neededBy) return ttl;
  const end = wibEndOfDay(neededBy);
  return end.getTime() < ttl.getTime() ? end : ttl;
}

async function validateImages(db: Db, auth: AuthContext, urls: string[], fileIds: string[]) {
  if (urls.length + fileIds.length > MAX_IMAGES) throw Errors.unprocessable('TOO_MANY_IMAGES', `Maksimal ${MAX_IMAGES} gambar`);
  for (const u of urls) {
    if (!/^https?:\/\/\S+$/i.test(u) || u.length > 2000) throw Errors.validation({ issues: [{ path: 'imageUrls', code: 'invalid_url', message: 'URL gambar tidak valid' }] });
  }
  for (const id of fileIds) {
    const f = await getFile(db, id);
    if (!f || f.owner_id !== auth.userId || f.deleted_at) throw Errors.notFound('File', 'FILE_NOT_FOUND');
    if (f.purpose !== 'PRODUCT_PHOTO') throw Errors.unprocessable('FILE_PURPOSE_MISMATCH', 'Foto produk harus diunggah dengan purpose PRODUCT_PHOTO');
  }
  return [...fileIds.map((fileId) => ({ fileId, sourceUrl: null })), ...urls.map((sourceUrl) => ({ fileId: null, sourceUrl }))];
}

export async function createRequest(deps: Deps, auth: AuthContext, input: RequestInput): Promise<RequestOwnerDto> {
  const images = await validateImages(deps.sql, auth, input.imageUrls ?? [], input.imageFileIds ?? []);
  const e = await evaluate(
    deps.sql,
    deps,
    {
      sourceType: input.sourceType,
      productUrl: input.productUrl ?? null,
      productName: input.productName.trim(),
      merchantName: input.merchantName ?? null,
      merchantCountry: input.merchantCountry,
      categoryCode: input.categoryCode,
      hsCode: normalizeHs(input.hsCode),
      quantity: input.quantity,
      variant: input.variant ?? null,
      unitPriceMinor: input.unitPriceMinor,
      priceCurrency: input.priceCurrency,
      estWeightKg: input.estWeightKg ?? null,
      notes: input.notes ?? null,
      maxBudgetIdr: input.maxBudgetIdr ?? null,
      neededBy: input.neededBy ?? null,
      destinationCountry: input.destinationCountry,
      destinationCity: input.destinationCity ?? null,
      deliveryPreference: input.deliveryPreference ?? null,
      extraction: input.extraction ?? {},
    },
    null,
    input.acknowledgeRestriction === true,
  );
  if (input.publish) {
    assertPublishable(e);
    e.values.status = 'OPEN';
    e.values.publishedAt = deps.clock.now();
    e.values.expiresAt = expiryFor(deps, e.values.neededBy);
  }
  return tx(deps.sql, async (t) => {
    const id = await repo.insertRequest(t, auth.userId, e.values);
    await repo.replaceImages(t, id, images);
    const payload = {
      requestId: id,
      buyerId: auth.userId,
      status: e.values.status,
      merchantCountry: e.values.merchantCountry,
      destinationCountry: e.values.destinationCountry,
      categoryCode: e.values.categoryCode,
      restrictionClass: e.values.restrictionClass,
    };
    await emitEvent(t, 'request', id, 'request.created', payload);
    if (e.values.status === 'OPEN') await emitEvent(t, 'request', id, 'request.published', payload);
    return ownerDto(t, deps, (await repo.getRequest(t, id))!);
  });
}

async function loadOwned(db: Db, id: string, auth: AuthContext): Promise<RequestRow> {
  const r = await repo.getRequest(db, id, { forUpdate: true });
  if (!r || r.buyer_id !== auth.userId) throw Errors.notFound('Request', 'REQUEST_NOT_FOUND');
  return r;
}

const CORE_FIELDS = ['productName', 'merchantCountry', 'categoryCode', 'hsCode', 'quantity', 'unitPriceMinor', 'priceCurrency', 'estWeightKg', 'destinationCountry'] as const;

export type RequestPatch = Partial<Omit<RequestInput, 'sourceType' | 'publish' | 'extraction'>> & { version?: number };

function rowValues(r: RequestRow) {
  return {
    sourceType: r.source_type,
    productUrl: r.product_url,
    productName: r.product_name,
    merchantName: r.merchant_name,
    merchantCountry: r.merchant_country ?? '',
    categoryCode: r.category_code ?? '',
    hsCode: r.hs_code,
    quantity: r.quantity,
    variant: r.variant,
    unitPriceMinor: r.unit_price_minor ?? 0,
    priceCurrency: r.price_currency ?? '',
    estWeightKg: numOrNull(r.est_weight_kg),
    notes: r.notes,
    maxBudgetIdr: r.max_budget_idr,
    neededBy: r.needed_by,
    destinationCountry: r.destination_country,
    destinationCity: r.destination_city,
    deliveryPreference: r.delivery_preference,
    extraction: r.extraction ?? {},
  };
}

export async function updateRequestById(deps: Deps, auth: AuthContext, id: string, patch: RequestPatch): Promise<RequestOwnerDto> {
  return tx(deps.sql, async (t) => {
    const r = await loadOwned(t, id, auth);
    if (patch.version !== undefined && patch.version !== r.version) {
      throw Errors.conflict('VERSION_CONFLICT', 'Data sudah berubah, muat ulang lalu coba lagi', { currentVersion: r.version });
    }
    if (r.status !== 'DRAFT' && r.status !== 'OPEN') throw Errors.conflict('REQUEST_NOT_EDITABLE', `Titipan berstatus ${r.status} tidak dapat diubah`);
    const coreChanged = CORE_FIELDS.filter((f) => patch[f] !== undefined);
    if (r.status === 'OPEN' && coreChanged.length) {
      const pending = (await repo.pendingOfferCount(t, [r.id])).get(r.id) ?? 0;
      if (pending > 0) {
        throw Errors.conflict('REQUEST_HAS_PENDING_OFFERS', 'Ada penawaran yang menunggu; tolak penawaran dulu sebelum mengubah detail barang', {
          fields: coreChanged,
          pendingOffers: pending,
        });
      }
    }
    const base = rowValues(r);
    const merged = {
      ...base,
      ...(patch.productUrl !== undefined ? { productUrl: patch.productUrl } : {}),
      ...(patch.productName !== undefined ? { productName: patch.productName.trim() } : {}),
      ...(patch.merchantName !== undefined ? { merchantName: patch.merchantName } : {}),
      ...(patch.merchantCountry !== undefined ? { merchantCountry: patch.merchantCountry } : {}),
      ...(patch.categoryCode !== undefined ? { categoryCode: patch.categoryCode } : {}),
      ...(patch.hsCode !== undefined ? { hsCode: normalizeHs(patch.hsCode) } : {}),
      ...(patch.quantity !== undefined ? { quantity: patch.quantity } : {}),
      ...(patch.variant !== undefined ? { variant: patch.variant } : {}),
      ...(patch.unitPriceMinor !== undefined ? { unitPriceMinor: patch.unitPriceMinor } : {}),
      ...(patch.priceCurrency !== undefined ? { priceCurrency: patch.priceCurrency } : {}),
      ...(patch.estWeightKg !== undefined ? { estWeightKg: patch.estWeightKg } : {}),
      ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
      ...(patch.maxBudgetIdr !== undefined ? { maxBudgetIdr: patch.maxBudgetIdr } : {}),
      ...(patch.neededBy !== undefined ? { neededBy: patch.neededBy } : {}),
      ...(patch.destinationCountry !== undefined ? { destinationCountry: patch.destinationCountry } : {}),
      ...(patch.destinationCity !== undefined ? { destinationCity: patch.destinationCity } : {}),
      ...(patch.deliveryPreference !== undefined ? { deliveryPreference: patch.deliveryPreference } : {}),
    };
    const e = await evaluate(t, deps, merged, { restrictionClass: r.restriction_class, ackAt: r.restriction_ack_at }, patch.acknowledgeRestriction === true);
    e.values.status = r.status as 'DRAFT' | 'OPEN';
    e.values.publishedAt = r.published_at;
    e.values.expiresAt = r.status === 'OPEN' ? expiryFor(deps, e.values.neededBy) : null;
    if (r.status === 'OPEN') assertPublishable(e);
    await repo.updateRequest(t, r.id, e.values);
    if (patch.imageUrls !== undefined || patch.imageFileIds !== undefined) {
      const existing = (await repo.listImages(t, [r.id])).get(r.id) ?? [];
      const urls = patch.imageUrls ?? existing.filter((i) => i.source_url).map((i) => i.source_url!);
      const files = patch.imageFileIds ?? existing.filter((i) => i.file_id).map((i) => i.file_id!);
      await repo.replaceImages(t, r.id, await validateImages(t, auth, urls, files));
    }
    return ownerDto(t, deps, (await repo.getRequest(t, r.id))!);
  });
}

export async function publishRequest(deps: Deps, auth: AuthContext, id: string, acknowledgeRestriction: boolean): Promise<RequestOwnerDto> {
  return tx(deps.sql, async (t) => {
    const r = await loadOwned(t, id, auth);
    if (r.status === 'OPEN') return ownerDto(t, deps, r);
    if (r.status !== 'DRAFT') throw Errors.conflict('REQUEST_NOT_PUBLISHABLE', `Titipan berstatus ${r.status} tidak dapat dipublikasikan`);
    const e = await evaluate(t, deps, rowValues(r), { restrictionClass: r.restriction_class, ackAt: r.restriction_ack_at }, acknowledgeRestriction);
    assertPublishable(e);
    e.values.status = 'OPEN';
    e.values.publishedAt = deps.clock.now();
    e.values.expiresAt = expiryFor(deps, e.values.neededBy);
    await repo.updateRequest(t, r.id, e.values);
    await emitEvent(t, 'request', r.id, 'request.published', {
      requestId: r.id,
      buyerId: r.buyer_id,
      status: 'OPEN',
      merchantCountry: e.values.merchantCountry,
      destinationCountry: e.values.destinationCountry,
      categoryCode: e.values.categoryCode,
      restrictionClass: e.values.restrictionClass,
    });
    return ownerDto(t, deps, (await repo.getRequest(t, r.id))!);
  });
}

export async function cancelRequest(deps: Deps, auth: AuthContext, id: string, reason: string | null): Promise<RequestOwnerDto> {
  return tx(deps.sql, async (t) => {
    const r = await loadOwned(t, id, auth);
    if (r.status === 'CANCELLED') return ownerDto(t, deps, r);
    if (r.status !== 'DRAFT' && r.status !== 'OPEN') {
      throw Errors.conflict('REQUEST_NOT_CANCELLABLE', r.status === 'MATCHED' ? 'Titipan sudah cocok; batalkan lewat transaksi' : `Titipan berstatus ${r.status}`);
    }
    const now = deps.clock.now();
    await closePendingOffers(t, { requestId: r.id }, 'DECLINED', 'REQUEST_CANCELLED', now);
    await repo.setStatus(t, r.id, 'CANCELLED', now);
    await emitEvent(t, 'request', r.id, 'request.cancelled', { requestId: r.id, buyerId: r.buyer_id, reason: reason ?? null });
    return ownerDto(t, deps, (await repo.getRequest(t, r.id))!);
  });
}

// ------------------------------------------------------------------------------------ queries

export async function listMine(
  deps: Deps,
  auth: AuthContext,
  q: { limit: number; cursor?: string | undefined; status?: RequestStatus | undefined },
): Promise<{ data: RequestOwnerDto[]; nextCursor: string | null }> {
  const cur = decodeKeyset(q.cursor);
  if (q.cursor && !cur) throw badCursor();
  const db = deps.sql;
  const rows = await db<RequestRow[]>`
    SELECT ${repo.requestCols(db)} FROM requests r
     WHERE r.buyer_id = ${auth.userId}
       ${q.status ? db`AND r.status = ${q.status}` : db``}
       ${cur ? db`AND (r.created_at, r.id) < (${cur.t}::timestamptz, ${cur.id}::uuid)` : db``}
     ORDER BY r.created_at DESC, r.id DESC LIMIT ${q.limit + 1}`;
  const page = rows.slice(0, q.limit);
  const data: RequestOwnerDto[] = [];
  for (const r of page) data.push(await ownerDto(db, deps, r));
  const last = page[page.length - 1];
  return { data, nextCursor: rows.length > q.limit && last ? encodeKeyset(last.created_at.toISOString(), last.id) : null };
}

/**
 * Open requests a traveler can serve: merchant country = origin of one of their ACTIVE trips, same
 * destination country, trip arrives by needed_by, category not excluded. Own requests are hidden.
 */
export async function listOpenForTraveler(
  deps: Deps,
  auth: AuthContext,
  q: { limit: number; cursor?: string | undefined; tripId?: string | undefined; categoryCode?: string | undefined },
): Promise<{ data: RequestListingDto[]; nextCursor: string | null }> {
  const cur = decodeKeyset(q.cursor);
  if (q.cursor && !cur) throw badCursor();
  const db = deps.sql;
  const now = deps.clock.now();
  const rows = await db<(RequestRow & { trip_ids: string[] })[]>`
    SELECT ${repo.requestCols(db)}, m.trip_ids
      FROM requests r
      JOIN LATERAL (
        SELECT array_agg(t.id ORDER BY t.departure_date, t.id) AS trip_ids
          FROM trips t
         WHERE t.traveler_id = ${auth.userId}
           AND t.status = 'ACTIVE'
           ${q.tripId ? db`AND t.id = ${q.tripId}` : db``}
           AND t.origin_country = r.merchant_country
           AND t.destination_country = r.destination_country
           AND (r.needed_by IS NULL OR t.arrival_date <= r.needed_by)
           AND NOT (coalesce(r.category_code, '') = ANY (t.excluded_categories))
      ) m ON m.trip_ids IS NOT NULL
      JOIN users u ON u.id = r.buyer_id AND u.status = 'ACTIVE'
     WHERE r.status = 'OPEN'
       AND r.buyer_id <> ${auth.userId}
       AND (r.expires_at IS NULL OR r.expires_at > ${now})
       ${q.categoryCode ? db`AND r.category_code = ${q.categoryCode}` : db``}
       ${cur ? db`AND (r.published_at, r.id) < (${cur.t}::timestamptz, ${cur.id}::uuid)` : db``}
     ORDER BY r.published_at DESC, r.id DESC LIMIT ${q.limit + 1}`;
  const page = rows.slice(0, q.limit);
  const listings = await listingDtos(db, deps, page);
  const data = listings.map((l, i) => ({ ...l, matchingTripIds: page[i]!.trip_ids }));
  const last = page[page.length - 1];
  return { data, nextCursor: rows.length > q.limit && last && last.published_at ? encodeKeyset(last.published_at.toISOString(), last.id) : null };
}

/** Buyer sees the full request; others see the listing view of OPEN requests (or the matched traveler). */
export async function getRequestView(
  deps: Deps,
  auth: AuthContext,
  id: string,
): Promise<{ view: 'OWNER'; request: RequestOwnerDto } | { view: 'LISTING'; request: RequestListingDto }> {
  const r = await repo.getRequest(deps.sql, id);
  if (!r) throw Errors.notFound('Request', 'REQUEST_NOT_FOUND');
  if (r.buyer_id === auth.userId) return { view: 'OWNER', request: await ownerDto(deps.sql, deps, r) };
  let visible = r.status === 'OPEN';
  if (!visible && r.status !== 'DRAFT') {
    const [row] = await deps.sql<{ ok: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM offers WHERE request_id = ${r.id} AND traveler_id = ${auth.userId}) AS ok`;
    visible = row?.ok === true;
  }
  if (!visible) throw Errors.notFound('Request', 'REQUEST_NOT_FOUND');
  const [dto] = await listingDtos(deps.sql, deps, [r]);
  return { view: 'LISTING', request: dto! };
}

