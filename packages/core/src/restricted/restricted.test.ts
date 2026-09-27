import { describe, expect, it } from 'vitest';
import { RESTRICTED_RULES } from '../testing/fixtures';
import { type ClassifyItemInput, classifyItem, keywordMatches, mostSevere, normalizeText } from './index';

const DATE = new Date('2026-09-27T00:00:00Z');
const item = (over: Partial<ClassifyItemInput> = {}): ClassifyItemInput => ({
  origin: 'JP',
  destination: 'ID',
  categoryCode: 'TOYS_HOBBIES',
  hsCode: '9503',
  productName: 'Gundam RX-78 model kit',
  quantity: 1,
  valueUsd: '45',
  ...over,
});

describe('keyword matching', () => {
  it('is lowercase, accent-insensitive and word-bounded', () => {
    expect(normalizeText('Crème  Brûlée-Torch!')).toBe('creme brulee torch');
    expect(keywordMatches('Mini CRÈME BRÛLÉE TORCH set', 'creme brulee torch')).toBe(true);
    expect(keywordMatches('Anker Power-Bank 20000', 'power bank')).toBe(true);
    expect(keywordMatches('Vapers club t-shirt', 'vape')).toBe(false);
    expect(keywordMatches('Vape pod starter', 'VAPE')).toBe(true);
  });

  it('falls back to substring for CJK scripts', () => {
    expect(keywordMatches('日本製モバイルバッテリー大容量', 'モバイルバッテリー')).toBe(true);
  });
});

describe('classifyItem', () => {
  it('returns ALLOWED with no matches for an ordinary item', () => {
    const r = classifyItem(item(), RESTRICTED_RULES, DATE);
    expect(r.classification).toBe('ALLOWED');
    expect(r.blocksCheckout).toBe(false);
    expect(r.requiresAcknowledgement).toBe(false);
    expect(r.matches).toHaveLength(0);
  });

  it('blocks PROHIBITED categories', () => {
    const r = classifyItem(item({ categoryCode: 'WEAPONS_REPLICAS', productName: 'Airsoft replica' }), RESTRICTED_RULES, DATE);
    expect(r.classification).toBe('PROHIBITED');
    expect(r.blocksCheckout).toBe(true);
    expect(r.requiresAcknowledgement).toBe(false);
  });

  it('catches keyword rules even when miscategorised', () => {
    const r = classifyItem(item({ categoryCode: 'OTHER', productName: 'Rokok Elektrik pod kit' }), RESTRICTED_RULES, DATE);
    expect(r.classification).toBe('PROHIBITED');
    expect(r.matches[0]?.matchedKeyword).toBe('rokok elektrik');
    expect(r.matches[0]?.matchedOn).toEqual(['KEYWORD']);
  });

  it('PERMIT_REQUIRED requires acknowledgement and lists the authority', () => {
    const r = classifyItem(item({ categoryCode: 'MEDICINE', productName: 'Eye drops' }), RESTRICTED_RULES, DATE);
    expect(r.classification).toBe('PERMIT_REQUIRED');
    expect(r.requiresAcknowledgement).toBe(true);
    expect(r.permitAuthorities).toEqual(['BPOM']);
  });

  it('escalates to PROHIBITED when maxQuantity or maxValueUsd is exceeded', () => {
    const within = classifyItem(item({ categoryCode: 'BATTERIES_POWERBANK', quantity: 2 }), RESTRICTED_RULES, DATE);
    expect(within.classification).toBe('RESTRICTED');
    expect(within.airlineDg).toBe(true);
    expect(within.dgNotes).toEqual(['Kabin saja']);
    const over = classifyItem(item({ categoryCode: 'BATTERIES_POWERBANK', quantity: 3 }), RESTRICTED_RULES, DATE);
    expect(over.classification).toBe('PROHIBITED');
    expect(over.matches[0]?.limitExceeded).toEqual({ kind: 'QUANTITY', limit: '2', actual: '3' });
    const pricey = classifyItem(item({ categoryCode: 'ALCOHOL', valueUsd: '150.01' }), RESTRICTED_RULES, DATE);
    expect(pricey.classification).toBe('PROHIBITED');
    const noValue = classifyItem(item({ categoryCode: 'ALCOHOL', valueUsd: null }), RESTRICTED_RULES, DATE);
    expect(noValue.classification).toBe('RESTRICTED');
    expect(noValue.matches[0]?.valueCheckSkipped).toBe(true);
  });

  it('returns the most severe classification and all matching rules (HS + keyword)', () => {
    const r = classifyItem(
      item({ categoryCode: 'MOBILE_PHONES', hsCode: '8517.13', productName: 'Phone with butane lighter case' }),
      RESTRICTED_RULES,
      DATE,
    );
    expect(r.matches.map((m) => m.code)).toEqual(['CREME_BRULEE_TORCH', 'PHONE_IMEI']);
    expect(r.classification).toBe('RESTRICTED');
    expect(r.messagesEn).toHaveLength(2);
  });

  it('ignores DRAFT/RETIRED rules and non-DG items report airlineDg=false', () => {
    const retired = RESTRICTED_RULES.map((r) => (r.code === 'WEAPONS' ? { ...r, status: 'RETIRED' as const } : r));
    expect(classifyItem(item({ categoryCode: 'WEAPONS_REPLICAS' }), retired, DATE).classification).toBe('ALLOWED');
    const pending = RESTRICTED_RULES.map((r) => (r.code === 'WEAPONS' ? { ...r, status: 'PENDING_APPROVAL' as const } : r));
    expect(classifyItem(item({ categoryCode: 'WEAPONS_REPLICAS' }), pending, DATE).classification).toBe('ALLOWED');
    expect(classifyItem(item({ categoryCode: 'MEDICINE' }), RESTRICTED_RULES, DATE).airlineDg).toBe(false);
  });

  it('ignores expired and other-destination rules (effectiveUntil inclusive, WIB calendar)', () => {
    expect(classifyItem(item(), RESTRICTED_RULES, new Date('2025-05-01T00:00:00Z')).classification).toBe('PROHIBITED');
    expect(classifyItem(item(), RESTRICTED_RULES, new Date('2025-05-31T16:59:59Z')).classification).toBe('PROHIBITED');
    expect(classifyItem(item(), RESTRICTED_RULES, new Date('2025-05-31T17:00:00Z')).classification).toBe('ALLOWED');
    expect(classifyItem(item({ destination: 'MY', categoryCode: 'WEAPONS_REPLICAS' }), RESTRICTED_RULES, DATE).classification).toBe(
      'ALLOWED',
    );
  });

  it('mostSevere orders classifications', () => {
    expect(mostSevere('RESTRICTED', 'PERMIT_REQUIRED')).toBe('PERMIT_REQUIRED');
    expect(mostSevere('PROHIBITED', 'ALLOWED')).toBe('PROHIBITED');
  });
});
