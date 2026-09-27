/**
 * Shared domain enumerations — mirrors docs/00-domain-model.md (binding spec).
 * Every list is `as const` so the union type and the runtime list never drift.
 */

// §1 Actors
export const ACTORS = ['BUYER', 'TRAVELER', 'SYSTEM', 'ADMIN'] as const;
export type Actor = (typeof ACTORS)[number];

export const ADMIN_ROLES = [
  'SUPER_ADMIN',
  'OPERATIONS',
  'FINANCE',
  'FINANCE_SUPER_ADMIN',
  'RISK',
  'SUPPORT',
  'MARKETING',
  'COMPLIANCE',
] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

// §2 KYC levels
export const KYC_LEVELS = [1, 2, 3, 4, 5] as const;
export type KycLevel = (typeof KYC_LEVELS)[number];
export const KYC_LEVEL_CODES: Readonly<Record<KycLevel, string>> = {
  1: 'REGISTERED',
  2: 'PHONE_VERIFIED',
  3: 'IDENTITY_VERIFIED',
  4: 'TRAVELER_VERIFIED',
  5: 'TRUSTED_TRAVELER',
};
/** Minimum KYC level for a buyer checkout (§2). */
export const MIN_KYC_LEVEL_CHECKOUT: KycLevel = 2;
/** Minimum KYC level for a traveler to accept transactions (§1). */
export const MIN_KYC_LEVEL_TRAVELER_ACCEPT: KycLevel = 3;

export function isKycLevel(value: unknown): value is KycLevel {
  return value === 1 || value === 2 || value === 3 || value === 4 || value === 5;
}

// §3 Trip
export const TRIP_STATUSES = [
  'DRAFT',
  'VERIFICATION_PENDING',
  'VERIFIED',
  'ACTIVE',
  'FULL',
  'TRAVELING',
  'COMPLETED',
  'CANCELLED',
] as const;
export type TripStatus = (typeof TRIP_STATUSES)[number];

// §4 Transaction
export const TRANSACTION_STATUSES = [
  'REQUEST_CREATED',
  'MATCHED',
  'AWAITING_PAYMENT',
  'PAYMENT_SECURED',
  'PRICE_CHANGE_PENDING',
  'PURCHASE_APPROVED',
  'PURCHASED',
  'TRAVELING',
  'ARRIVED',
  'CUSTOMS_PROCESS',
  'READY_FOR_HANDOVER',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'BUYER_CONFIRMED',
  'COMPLETED',
  'CANCELLED',
  'DISPUTED',
  'REFUND_PENDING',
  'REFUNDED',
] as const;
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];
export const TERMINAL_TRANSACTION_STATUSES = ['COMPLETED', 'CANCELLED', 'REFUNDED'] as const;

// §5 Price confirmation
export const PRICE_CONFIRMATION_STATUSES = [
  'PENDING',
  'APPROVED',
  'REJECTED',
  'CLARIFICATION_REQUESTED',
  'EXPIRED',
] as const;
export type PriceConfirmationStatus = (typeof PRICE_CONFIRMATION_STATUSES)[number];

// §6 Dispute
export const DISPUTE_STATUSES = [
  'OPEN',
  'EVIDENCE_COLLECTION',
  'UNDER_REVIEW',
  'RESOLVED',
  'APPEALED',
  'CLOSED',
] as const;
export type DisputeStatus = (typeof DISPUTE_STATUSES)[number];
export const DISPUTE_TYPES = [
  'ITEM_NOT_RECEIVED',
  'WRONG_ITEM',
  'DAMAGED_ITEM',
  'COUNTERFEIT',
  'PRICE_DISPUTE',
  'DELIVERY_DISPUTE',
  'OTHER',
] as const;
export type DisputeType = (typeof DISPUTE_TYPES)[number];
export const DISPUTE_RESOLUTIONS = [
  'REFUND_FULL',
  'REFUND_PARTIAL',
  'NO_REFUND',
  'RETURN_AND_REFUND',
  'OTHER',
] as const;
export type DisputeResolution = (typeof DISPUTE_RESOLUTIONS)[number];

// §15 Secondary state machines
export const KYC_SUBMISSION_STATUSES = ['PENDING', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'EXPIRED'] as const;
export type KycSubmissionStatus = (typeof KYC_SUBMISSION_STATUSES)[number];
export const PAYMENT_STATUSES = ['PENDING', 'SECURED', 'EXPIRED', 'FAILED', 'PARTIALLY_REFUNDED', 'REFUNDED'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];
export const REFUND_STATUSES = [
  'REQUESTED',
  'PENDING_APPROVAL',
  'APPROVED',
  'PROCESSING',
  'SUCCEEDED',
  'FAILED',
  'REJECTED',
  'CANCELLED',
] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];
export const PAYOUT_STATUSES = ['SCHEDULED', 'ON_HOLD', 'PROCESSING', 'PAID', 'FAILED', 'CANCELLED'] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];
export const QUOTE_STATUSES = ['ACTIVE', 'ACCEPTED', 'EXPIRED', 'SUPERSEDED'] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];
export const FX_LOCK_STATUSES = ['ACTIVE', 'CONSUMED', 'EXPIRED'] as const;
export type FxLockStatus = (typeof FX_LOCK_STATUSES)[number];

// §16 Rule data (customs_rules, restricted_items)
export const RULE_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'ACTIVE', 'RETIRED'] as const;
export type RuleStatus = (typeof RULE_STATUSES)[number];

// §7 Restricted items — ordered from least to most severe.
export const RESTRICTED_CLASSIFICATIONS = [
  'ALLOWED',
  'DECLARATION_REQUIRED',
  'RESTRICTED',
  'PERMIT_REQUIRED',
  'PROHIBITED',
] as const;
export type RestrictedClassification = (typeof RESTRICTED_CLASSIFICATIONS)[number];

export function classificationSeverity(c: RestrictedClassification): number {
  return RESTRICTED_CLASSIFICATIONS.indexOf(c);
}

// §8 Cancellation stage
export const CANCELLATION_STAGES = [
  'BEFORE_MATCH',
  'AFTER_MATCH',
  'AFTER_PAYMENT',
  'BEFORE_PURCHASE',
  'AFTER_PURCHASE',
  'DURING_TRAVEL',
  'AFTER_ARRIVAL',
] as const;
export type CancellationStage = (typeof CANCELLATION_STAGES)[number];

// §9 Fund buckets
export const FUND_BUCKETS = [
  'PRODUCT_FUND',
  'TRAVELER_EARNING',
  'CUSTOMS_RESERVE',
  'PLATFORM_REVENUE',
  'TAX_PAYABLE',
  'PAYMENT_FEE',
  'REFUND',
  'PROMOTION_CREDIT',
  'CLEARING',
] as const;
export type FundBucket = (typeof FUND_BUCKETS)[number];

// §10 Price lines — display order
export const PRICE_LINE_TYPES = [
  'ITEM_PRICE',
  'TRAVELER_FEE',
  'CUSTOMS_DUTY',
  'IMPORT_TAX',
  'PROTECTION_FEE',
  'PLATFORM_FEE',
  'SERVICE_TAX',
  'PAYMENT_FEE',
  'DISCOUNT',
  'REFERRAL_CREDIT',
  'TOTAL',
] as const;
export type PriceLineType = (typeof PRICE_LINE_TYPES)[number];
/** Lines that are charged to the buyer (positive) — refundable per cancellation matrix. */
export const CHARGE_LINE_TYPES = [
  'ITEM_PRICE',
  'TRAVELER_FEE',
  'CUSTOMS_DUTY',
  'IMPORT_TAX',
  'PROTECTION_FEE',
  'PLATFORM_FEE',
  'SERVICE_TAX',
  'PAYMENT_FEE',
] as const;
export type ChargeLineType = (typeof CHARGE_LINE_TYPES)[number];
export const CREDIT_LINE_TYPES = ['DISCOUNT', 'REFERRAL_CREDIT'] as const;
export type CreditLineType = (typeof CREDIT_LINE_TYPES)[number];

export const PRICE_LINE_BUCKET: Readonly<Record<PriceLineType, FundBucket>> = {
  ITEM_PRICE: 'PRODUCT_FUND',
  TRAVELER_FEE: 'TRAVELER_EARNING',
  CUSTOMS_DUTY: 'CUSTOMS_RESERVE',
  IMPORT_TAX: 'CUSTOMS_RESERVE',
  PROTECTION_FEE: 'PLATFORM_REVENUE',
  PLATFORM_FEE: 'PLATFORM_REVENUE',
  SERVICE_TAX: 'TAX_PAYABLE',
  PAYMENT_FEE: 'PAYMENT_FEE',
  DISCOUNT: 'PROMOTION_CREDIT',
  REFERRAL_CREDIT: 'PROMOTION_CREDIT',
  TOTAL: 'CLEARING',
};

// §11 Delivery
export const DELIVERY_METHODS = ['MEETUP', 'COURIER', 'PARTNER_LOGISTICS'] as const;
export type DeliveryMethod = (typeof DELIVERY_METHODS)[number];
export const DELIVERY_CONFIRMED_VIA = ['PIN', 'QR', 'BUYER_APP', 'AUTO', 'ADMIN'] as const;
export type DeliveryConfirmedVia = (typeof DELIVERY_CONFIRMED_VIA)[number];

// §13 Risk
export const RISK_DECISIONS = ['ALLOW', 'REVIEW', 'HOLD', 'BLOCK'] as const;
export type RiskDecision = (typeof RISK_DECISIONS)[number];
export function riskDecisionSeverity(d: RiskDecision): number {
  return RISK_DECISIONS.indexOf(d);
}
export const RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

// §14 Document numbers
export const DOCUMENT_NUMBER_PREFIXES = ['JK', 'DSP', 'RFD', 'TKT', 'PO'] as const;
export type DocumentNumberPrefix = (typeof DOCUMENT_NUMBER_PREFIXES)[number];

export function isOneOf<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (list as readonly string[]).includes(value);
}
