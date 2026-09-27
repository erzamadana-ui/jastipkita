import type { RiskThresholdsConfig } from '../config';
import { type RiskDecision, riskDecisionSeverity } from '../domain';
import { CoreError } from '../errors';
import { clamp, compareStrings, sortBy } from '../internal/math';
import { HOUR_MS } from '../internal/time';
import { applyBps, formatIdr } from '../money';
import { normalizeText } from '../restricted';

export const RISK_ENGINE_VERSION = 'risk-rules-v1';

export const RISK_SUBJECT_TYPES = ['USER', 'LOGIN', 'TRANSACTION', 'PAYMENT', 'REFUND', 'REFERRAL', 'TRIP', 'PAYOUT', 'RECEIPT'] as const;
export type RiskSubjectType = (typeof RISK_SUBJECT_TYPES)[number];

export type RiskCategory =
  | 'MULTI_ACCOUNT'
  | 'DEVICE_ABUSE'
  | 'RAPID_ACCOUNT_CREATION'
  | 'SUSPICIOUS_TRANSACTION'
  | 'PAYMENT_ANOMALY'
  | 'REFUND_ABUSE'
  | 'REFERRAL_ABUSE'
  | 'LOCATION_ANOMALY'
  | 'TRAVELER_BEHAVIOR'
  | 'CHARGEBACK_RISK'
  | 'RECEIPT_FRAUD'
  | 'MODEL';

export interface GeoPoint {
  readonly lat: number;
  readonly lon: number;
  readonly at: Date;
  readonly country?: string;
}

export interface ReferralLinkSignals {
  readonly referrerId: string;
  readonly refereeId: string;
  readonly sharedDevice?: boolean;
  readonly sharedIp?: boolean;
  readonly sharedPaymentInstrument?: boolean;
  readonly sharedIdentity?: boolean;
  readonly referrerReferralsLast24h?: number;
}

/** Everything is optional: a rule only fires on the signals it understands. */
export interface RiskSignals {
  // Multi-account / device
  readonly sharedDeviceAccounts?: number;
  readonly sharedPaymentInstrumentAccounts?: number;
  readonly sharedIdentityHashAccounts?: number;
  readonly accountsOnDevice?: number;
  readonly accountsCreatedFromIpLast24h?: number;
  readonly accountsCreatedFromDeviceLast24h?: number;
  // Transaction
  readonly transactionValueIdr?: number;
  readonly userAvgTransactionIdr?: number;
  readonly userCompletedTransactions?: number;
  readonly isFirstTransaction?: boolean;
  readonly counterpartyIsNewTraveler?: boolean;
  readonly userCountry?: string;
  readonly ipCountry?: string;
  // Payment
  readonly failedPaymentsLast24h?: number;
  readonly cardBinCountry?: string | null;
  // Refund
  readonly refundCount?: number;
  readonly transactionCount?: number;
  // Referral
  readonly referral?: ReferralLinkSignals;
  // Location
  readonly previousLogin?: GeoPoint;
  readonly currentLogin?: GeoPoint;
  readonly tripOriginCountry?: string;
  readonly deviceCountryDuringTrip?: string;
  // Traveler behavior
  readonly travelerCancellations90d?: number;
  readonly lateDeliveryRate?: number;
  readonly priceChangeRequestRate?: number;
  readonly receiptReuseCount?: number;
  // Chargebacks
  readonly chargebackCount?: number;
}

export interface RiskReason {
  readonly code: string;
  readonly category: RiskCategory;
  readonly weight: number;
  readonly message: string;
  /** Floor for the final decision regardless of score (e.g. identity reuse → at least REVIEW). */
  readonly minDecision?: RiskDecision;
}

export interface RiskRuleContext {
  readonly subjectType: RiskSubjectType;
}

/** Plug-in point: a hand-written heuristic or an ML model wrapped as a rule. */
export interface RiskRule {
  readonly code: string;
  readonly category: RiskCategory;
  readonly appliesTo: readonly RiskSubjectType[] | 'ALL';
  evaluate(signals: RiskSignals, ctx: RiskRuleContext): readonly RiskReason[];
}

export interface RiskAssessment {
  readonly subjectType: RiskSubjectType;
  readonly score: number;
  readonly decision: RiskDecision;
  readonly reasons: readonly RiskReason[];
  readonly engineVersion: string;
}

export const DEFAULT_RISK_THRESHOLDS: RiskThresholdsConfig = { review: 40, hold: 70, block: 90 };

export function decisionForScore(score: number, t: RiskThresholdsConfig): RiskDecision {
  if (score >= t.block) return 'BLOCK';
  if (score >= t.hold) return 'HOLD';
  if (score >= t.review) return 'REVIEW';
  return 'ALLOW';
}

function r(code: string, category: RiskCategory, weight: number, message: string, minDecision?: RiskDecision): RiskReason {
  return minDecision ? { code, category, weight, message, minDecision } : { code, category, weight, message };
}

const gte = (v: number | undefined, n: number): boolean => v !== undefined && v >= n;

/** Great-circle distance in km. */
export function haversineKm(a: Pick<GeoPoint, 'lat' | 'lon'>, b: Pick<GeoPoint, 'lat' | 'lon'>): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export const IMPOSSIBLE_TRAVEL_KMH = 900;

// ---------------------------------------------------------------------------
// Default rules
// ---------------------------------------------------------------------------

export const DEFAULT_RISK_RULES: readonly RiskRule[] = [
  {
    code: 'MULTI_ACCOUNT',
    category: 'MULTI_ACCOUNT',
    appliesTo: ['USER', 'TRANSACTION', 'PAYMENT', 'REFERRAL', 'PAYOUT'],
    evaluate(s) {
      const out: RiskReason[] = [];
      if (gte(s.sharedIdentityHashAccounts, 1)) {
        out.push(r('SHARED_IDENTITY', 'MULTI_ACCOUNT', 40, `Identitas (hash KTP/paspor) dipakai ${s.sharedIdentityHashAccounts} akun lain`, 'REVIEW'));
      }
      if (gte(s.sharedPaymentInstrumentAccounts, 1)) {
        out.push(r('SHARED_PAYMENT_INSTRUMENT', 'MULTI_ACCOUNT', 25, `Instrumen pembayaran dipakai ${s.sharedPaymentInstrumentAccounts} akun lain`));
      }
      if (gte(s.sharedDeviceAccounts, 1)) {
        const w = Math.min(30, 10 + 5 * (s.sharedDeviceAccounts as number));
        out.push(r('SHARED_DEVICE', 'MULTI_ACCOUNT', w, `Perangkat dipakai ${s.sharedDeviceAccounts} akun lain`));
      }
      return out;
    },
  },
  {
    code: 'DEVICE_ABUSE',
    category: 'DEVICE_ABUSE',
    appliesTo: ['USER', 'LOGIN', 'REFERRAL'],
    evaluate(s) {
      if (gte(s.accountsOnDevice, 7)) return [r('DEVICE_FARM', 'DEVICE_ABUSE', 35, `${s.accountsOnDevice} akun di satu perangkat`)];
      if (gte(s.accountsOnDevice, 4)) return [r('DEVICE_MANY_ACCOUNTS', 'DEVICE_ABUSE', 20, `${s.accountsOnDevice} akun di satu perangkat`)];
      return [];
    },
  },
  {
    code: 'RAPID_ACCOUNT_CREATION',
    category: 'RAPID_ACCOUNT_CREATION',
    appliesTo: ['USER', 'LOGIN', 'REFERRAL'],
    evaluate(s) {
      const out: RiskReason[] = [];
      if (gte(s.accountsCreatedFromIpLast24h, 4)) {
        out.push(r('SIGNUP_BURST_IP', 'RAPID_ACCOUNT_CREATION', 15, `${s.accountsCreatedFromIpLast24h} akun baru dari IP yang sama (24 jam)`));
      }
      if (gte(s.accountsCreatedFromDeviceLast24h, 3)) {
        out.push(r('SIGNUP_BURST_DEVICE', 'RAPID_ACCOUNT_CREATION', 20, `${s.accountsCreatedFromDeviceLast24h} akun baru dari perangkat yang sama (24 jam)`));
      }
      return out;
    },
  },
  {
    code: 'SUSPICIOUS_TRANSACTION',
    category: 'SUSPICIOUS_TRANSACTION',
    appliesTo: ['TRANSACTION', 'PAYMENT'],
    evaluate(s) {
      const out: RiskReason[] = [];
      const v = s.transactionValueIdr;
      if (v === undefined) return out;
      if (s.userAvgTransactionIdr !== undefined && gte(s.userCompletedTransactions, 3) && v > 5 * s.userAvgTransactionIdr) {
        out.push(r('VALUE_FAR_ABOVE_HISTORY', 'SUSPICIOUS_TRANSACTION', 20, `Nilai ${formatIdr(v)} > 5× rata-rata (${formatIdr(s.userAvgTransactionIdr)})`));
      }
      if (s.isFirstTransaction === true && v >= 10_000_000) {
        out.push(r('FIRST_TX_HIGH_VALUE', 'SUSPICIOUS_TRANSACTION', 15, `Transaksi pertama bernilai tinggi (${formatIdr(v)})`));
      }
      if (s.counterpartyIsNewTraveler === true && v >= 5_000_000) {
        out.push(r('NEW_TRAVELER_HIGH_VALUE', 'SUSPICIOUS_TRANSACTION', 15, `Traveler baru dengan nilai ${formatIdr(v)}`));
      }
      if (s.userCountry && s.ipCountry && s.userCountry !== s.ipCountry) {
        out.push(r('COUNTRY_MISMATCH', 'SUSPICIOUS_TRANSACTION', 10, `Negara IP ${s.ipCountry} ≠ negara akun ${s.userCountry}`));
      }
      return out;
    },
  },
  {
    code: 'PAYMENT_ANOMALY',
    category: 'PAYMENT_ANOMALY',
    appliesTo: ['PAYMENT', 'TRANSACTION'],
    evaluate(s) {
      const out: RiskReason[] = [];
      if (gte(s.failedPaymentsLast24h, 6)) {
        out.push(r('MANY_FAILED_PAYMENTS', 'PAYMENT_ANOMALY', 30, `${s.failedPaymentsLast24h} pembayaran gagal (24 jam)`));
      } else if (gte(s.failedPaymentsLast24h, 3)) {
        out.push(r('FAILED_PAYMENTS', 'PAYMENT_ANOMALY', 15, `${s.failedPaymentsLast24h} pembayaran gagal (24 jam)`));
      }
      if (s.cardBinCountry && s.userCountry && s.cardBinCountry !== s.userCountry) {
        out.push(r('CARD_BIN_COUNTRY_MISMATCH', 'PAYMENT_ANOMALY', 15, `BIN kartu ${s.cardBinCountry} ≠ negara akun ${s.userCountry}`));
      }
      return out;
    },
  },
  {
    code: 'REFUND_ABUSE',
    category: 'REFUND_ABUSE',
    appliesTo: ['USER', 'TRANSACTION', 'REFUND'],
    evaluate(s) {
      if (s.refundCount === undefined || s.transactionCount === undefined || s.transactionCount < 3) return [];
      const rate = s.refundCount / s.transactionCount;
      if (rate > 0.5) return [r('REFUND_RATE_VERY_HIGH', 'REFUND_ABUSE', 35, `Tingkat refund ${Math.round(rate * 100)}%`)];
      if (rate > 0.3) return [r('REFUND_RATE_HIGH', 'REFUND_ABUSE', 20, `Tingkat refund ${Math.round(rate * 100)}%`)];
      return [];
    },
  },
  {
    code: 'REFERRAL_ABUSE',
    category: 'REFERRAL_ABUSE',
    appliesTo: ['REFERRAL'],
    evaluate(s) {
      const ref = s.referral;
      if (!ref) return [];
      const out: RiskReason[] = [];
      if (ref.referrerId === ref.refereeId || ref.sharedIdentity) {
        out.push(r('SELF_REFERRAL', 'REFERRAL_ABUSE', 60, 'Referrer dan referee adalah orang yang sama', 'BLOCK'));
      }
      if (ref.sharedPaymentInstrument) {
        out.push(r('REFERRAL_SHARED_PAYMENT', 'REFERRAL_ABUSE', 40, 'Referrer dan referee memakai instrumen pembayaran yang sama', 'HOLD'));
      }
      if (ref.sharedDevice) out.push(r('REFERRAL_SHARED_DEVICE', 'REFERRAL_ABUSE', 30, 'Referrer dan referee memakai perangkat yang sama'));
      if (ref.sharedIp) out.push(r('REFERRAL_SHARED_IP', 'REFERRAL_ABUSE', 10, 'Referrer dan referee memakai IP yang sama'));
      if (gte(ref.referrerReferralsLast24h, 6)) {
        out.push(r('REFERRAL_VELOCITY', 'REFERRAL_ABUSE', 20, `${ref.referrerReferralsLast24h} referral dalam 24 jam`));
      }
      return out;
    },
  },
  {
    code: 'LOCATION_ANOMALY',
    category: 'LOCATION_ANOMALY',
    appliesTo: ['LOGIN', 'TRIP', 'TRANSACTION', 'PAYOUT'],
    evaluate(s) {
      const out: RiskReason[] = [];
      if (s.previousLogin && s.currentLogin) {
        const km = haversineKm(s.previousLogin, s.currentLogin);
        const hours = Math.max((s.currentLogin.at.getTime() - s.previousLogin.at.getTime()) / HOUR_MS, 1 / 60);
        const speed = km / hours;
        if (km > 100 && speed > IMPOSSIBLE_TRAVEL_KMH) {
          out.push(r('IMPOSSIBLE_TRAVEL', 'LOCATION_ANOMALY', 25, `Perpindahan ${Math.round(km)} km dalam ${hours.toFixed(1)} jam`));
        }
      }
      if (s.tripOriginCountry && s.deviceCountryDuringTrip && s.tripOriginCountry !== s.deviceCountryDuringTrip) {
        out.push(r('TRIP_ORIGIN_MISMATCH', 'LOCATION_ANOMALY', 15, `Lokasi perangkat ${s.deviceCountryDuringTrip} ≠ asal trip ${s.tripOriginCountry}`));
      }
      return out;
    },
  },
  {
    code: 'TRAVELER_BEHAVIOR',
    category: 'TRAVELER_BEHAVIOR',
    appliesTo: ['USER', 'TRIP', 'TRANSACTION', 'PAYOUT'],
    evaluate(s) {
      const out: RiskReason[] = [];
      if (gte(s.receiptReuseCount, 1)) {
        out.push(r('RECEIPT_REUSE', 'TRAVELER_BEHAVIOR', 40, `Struk dipakai ulang ${s.receiptReuseCount} kali`, 'HOLD'));
      }
      if (gte(s.travelerCancellations90d, 3)) {
        out.push(r('FREQUENT_CANCELLATIONS', 'TRAVELER_BEHAVIOR', 15, `${s.travelerCancellations90d} pembatalan dalam 90 hari`));
      }
      if (s.lateDeliveryRate !== undefined && s.lateDeliveryRate > 0.3) {
        out.push(r('LATE_DELIVERIES', 'TRAVELER_BEHAVIOR', 10, `Terlambat ${Math.round(s.lateDeliveryRate * 100)}% pengiriman`));
      }
      if (s.priceChangeRequestRate !== undefined && s.priceChangeRequestRate > 0.3) {
        out.push(r('FREQUENT_PRICE_CHANGES', 'TRAVELER_BEHAVIOR', 15, `Perubahan harga pada ${Math.round(s.priceChangeRequestRate * 100)}% transaksi`));
      }
      return out;
    },
  },
  {
    code: 'CHARGEBACK_RISK',
    category: 'CHARGEBACK_RISK',
    appliesTo: ['USER', 'PAYMENT', 'TRANSACTION', 'PAYOUT'],
    evaluate(s) {
      if (gte(s.chargebackCount, 2)) return [r('REPEAT_CHARGEBACKS', 'CHARGEBACK_RISK', 50, `${s.chargebackCount} chargeback`, 'HOLD')];
      if (gte(s.chargebackCount, 1)) return [r('CHARGEBACK', 'CHARGEBACK_RISK', 30, `${s.chargebackCount} chargeback`)];
      return [];
    },
  },
];

function combine(subjectType: RiskSubjectType, reasons: RiskReason[], thresholds: RiskThresholdsConfig): RiskAssessment {
  const sorted = sortBy(reasons, (a, b) => b.weight - a.weight || compareStrings(a.code, b.code));
  const score = Math.round(clamp(sorted.reduce((sum, x) => sum + x.weight, 0), 0, 100));
  let decision = decisionForScore(score, thresholds);
  for (const x of sorted) {
    if (x.minDecision && riskDecisionSeverity(x.minDecision) > riskDecisionSeverity(decision)) decision = x.minDecision;
  }
  return { subjectType, score, decision, reasons: sorted, engineVersion: RISK_ENGINE_VERSION };
}

/** Weighted sum of rule hits, clamped to 0–100; decision from `risk.thresholds` + rule floors. */
export function assessRisk(
  subjectType: RiskSubjectType,
  signals: RiskSignals,
  thresholds: RiskThresholdsConfig = DEFAULT_RISK_THRESHOLDS,
  rules: readonly RiskRule[] = DEFAULT_RISK_RULES,
): RiskAssessment {
  const ctx: RiskRuleContext = { subjectType };
  const reasons: RiskReason[] = [];
  for (const rule of rules) {
    if (rule.appliesTo !== 'ALL' && !rule.appliesTo.includes(subjectType)) continue;
    for (const reason of rule.evaluate(signals, ctx)) {
      if (!(reason.weight >= 0) || !Number.isFinite(reason.weight)) {
        throw new CoreError('INVALID_RISK_WEIGHT', `Rule ${rule.code} returned an invalid weight`);
      }
      reasons.push(reason);
    }
  }
  return combine(subjectType, reasons, thresholds);
}

export interface RiskRuleRegistry {
  register(rule: RiskRule): RiskRuleRegistry;
  unregister(code: string): RiskRuleRegistry;
  list(): readonly RiskRule[];
  assess(subjectType: RiskSubjectType, signals: RiskSignals, thresholds?: RiskThresholdsConfig): RiskAssessment;
}

/** Immutable registry; `register` replaces a rule with the same code. */
export function createRiskRuleRegistry(rules: readonly RiskRule[] = DEFAULT_RISK_RULES): RiskRuleRegistry {
  const list = [...rules];
  return {
    register: (rule) => createRiskRuleRegistry([...list.filter((x) => x.code !== rule.code), rule]),
    unregister: (code) => createRiskRuleRegistry(list.filter((x) => x.code !== code)),
    list: () => list,
    assess: (subjectType, signals, thresholds = DEFAULT_RISK_THRESHOLDS) => assessRisk(subjectType, signals, thresholds, list),
  };
}

// ---------------------------------------------------------------------------
// Receipt / purchase-proof heuristics
// ---------------------------------------------------------------------------

export interface ReceiptProofInput {
  readonly transactionId: string;
  /** Perceptual or content hash of the receipt image. */
  readonly imageHash: string;
  readonly receiptNumber?: string | null;
  readonly merchantName: string;
  readonly purchasedAt: Date;
  readonly amountMinor: number;
  readonly currency: string;
  readonly serialNumber?: string | null;
  readonly hasVideo: boolean;
  readonly expected: {
    readonly paymentSecuredAt: Date | null;
    readonly purchaseApprovedAt?: Date | null;
    readonly approvedAmountMinor: number;
    readonly approvedCurrency: string;
    readonly merchantName?: string | null;
    readonly requiresSerial: boolean;
    readonly requiresVideo: boolean;
    /** Allowance for rounding / small differences (bps of approved). Default 0. */
    readonly toleranceBps?: number;
  };
  readonly now: Date;
}

export interface ReceiptHistory {
  readonly imageHashes: readonly { readonly hash: string; readonly transactionId: string }[];
  readonly receiptNumbers?: readonly { readonly merchant: string; readonly number: string; readonly transactionId: string }[];
  readonly serialNumbers?: readonly { readonly serial: string; readonly transactionId: string }[];
}

export interface ReceiptAssessment extends RiskAssessment {
  /** Feeds the PURCHASE_APPROVED → PURCHASED guard (`proofComplete`). */
  readonly proofComplete: boolean;
  /** Feeds `purchasePriceWithinApproved`. */
  readonly priceWithinApproved: boolean;
}

function merchantsMatch(a: string, b: string): boolean {
  const x = normalizeText(a);
  const y = normalizeText(b);
  return x === y || ` ${x} `.includes(` ${y} `) || ` ${y} `.includes(` ${x} `);
}

export function assessReceipt(
  proof: ReceiptProofInput,
  history: ReceiptHistory,
  thresholds: RiskThresholdsConfig = DEFAULT_RISK_THRESHOLDS,
): ReceiptAssessment {
  const reasons: RiskReason[] = [];
  const e = proof.expected;
  const other = (txId: string) => txId !== proof.transactionId;

  if (history.imageHashes.some((h) => h.hash === proof.imageHash && other(h.transactionId))) {
    reasons.push(r('DUPLICATE_RECEIPT_IMAGE', 'RECEIPT_FRAUD', 60, 'Foto struk sudah dipakai di transaksi lain', 'HOLD'));
  }
  if (proof.receiptNumber) {
    const num = normalizeText(proof.receiptNumber);
    if (
      (history.receiptNumbers ?? []).some(
        (h) => normalizeText(h.number) === num && merchantsMatch(h.merchant, proof.merchantName) && other(h.transactionId),
      )
    ) {
      reasons.push(r('DUPLICATE_RECEIPT_NUMBER', 'RECEIPT_FRAUD', 50, 'Nomor struk sudah dipakai di transaksi lain', 'HOLD'));
    }
  }
  if (proof.serialNumber) {
    const sn = normalizeText(proof.serialNumber);
    if ((history.serialNumbers ?? []).some((h) => normalizeText(h.serial) === sn && other(h.transactionId))) {
      reasons.push(r('DUPLICATE_SERIAL', 'RECEIPT_FRAUD', 50, 'Nomor seri sudah dipakai di transaksi lain', 'HOLD'));
    }
  }
  if (proof.purchasedAt.getTime() > proof.now.getTime()) {
    reasons.push(r('PURCHASE_TIME_IN_FUTURE', 'RECEIPT_FRAUD', 30, 'Waktu pembelian di masa depan'));
  }
  if (!e.paymentSecuredAt || proof.purchasedAt.getTime() < e.paymentSecuredAt.getTime()) {
    reasons.push(
      r('PURCHASED_BEFORE_PAYMENT_SECURED', 'RECEIPT_FRAUD', 40, 'Barang dibeli sebelum pembayaran diamankan (melanggar aturan emas)', 'REVIEW'),
    );
  } else if (e.purchaseApprovedAt && proof.purchasedAt.getTime() < e.purchaseApprovedAt.getTime()) {
    reasons.push(r('PURCHASED_BEFORE_APPROVAL', 'RECEIPT_FRAUD', 25, 'Barang dibeli sebelum Purchase Approved', 'REVIEW'));
  }
  let priceWithinApproved = true;
  if (proof.currency !== e.approvedCurrency) {
    priceWithinApproved = false;
    reasons.push(r('CURRENCY_MISMATCH', 'RECEIPT_FRAUD', 30, `Mata uang struk ${proof.currency} ≠ ${e.approvedCurrency}`));
  } else {
    const allowed = e.approvedAmountMinor + applyBps(e.approvedAmountMinor, e.toleranceBps ?? 0, 'FLOOR');
    if (proof.amountMinor > allowed) {
      priceWithinApproved = false;
      reasons.push(r('PRICE_ABOVE_APPROVED', 'RECEIPT_FRAUD', 30, `Harga struk ${proof.amountMinor} > disetujui ${e.approvedAmountMinor}`));
    }
  }
  if (e.merchantName && !merchantsMatch(proof.merchantName, e.merchantName)) {
    reasons.push(r('MERCHANT_MISMATCH', 'RECEIPT_FRAUD', 15, `Merchant "${proof.merchantName}" ≠ "${e.merchantName}"`));
  }
  const missingSerial = e.requiresSerial && !proof.serialNumber;
  const missingVideo = e.requiresVideo && !proof.hasVideo;
  if (missingSerial) reasons.push(r('MISSING_SERIAL', 'RECEIPT_FRAUD', 25, 'Kategori ini wajib nomor seri'));
  if (missingVideo) reasons.push(r('MISSING_VIDEO', 'RECEIPT_FRAUD', 20, 'Kategori ini wajib video unboxing/pembelian'));
  const proofComplete = !missingSerial && !missingVideo && proof.merchantName.trim() !== '' && proof.imageHash.trim() !== '';

  return { ...combine('RECEIPT', reasons, thresholds), proofComplete, priceWithinApproved };
}
