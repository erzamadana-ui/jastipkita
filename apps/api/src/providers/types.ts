/**
 * Provider abstractions. Every external dependency sits behind one of these interfaces so it can be
 * swapped (Xendit → another PSP, Resend → SES, R2 → S3, manual KYC → Verihubs/VIDA, …) without touching
 * mobile/web clients or business services. Each kind MUST have a mock/log implementation for dev/test.
 */

export type ProviderMode = 'MOCK' | 'SANDBOX' | 'LIVE';

// ------------------------------------------------------------------ payment
export type ProviderPaymentStatus = 'PENDING' | 'SECURED' | 'EXPIRED' | 'FAILED';

export interface CreateCheckoutInput {
  /** Our payment id (uuid) — used as provider reference_id. */
  referenceId: string;
  amountIdr: number;
  description: string;
  customer: { name?: string | null; email?: string | null; phone?: string | null };
  /** Allowed channel groups: VA | QRIS | EWALLET | CARD */
  channels?: string[];
  expiresAt: Date;
  successUrl?: string;
  failureUrl?: string;
  idempotencyKey: string;
  metadata?: Record<string, string>;
}

export interface CheckoutSession {
  providerRef: string;
  checkoutUrl: string;
  expiresAt: Date;
  raw?: unknown;
}

export interface ProviderPayment {
  providerRef: string;
  referenceId?: string;
  status: ProviderPaymentStatus;
  amountIdr: number;
  currency: string;
  channel?: string;
  paidAt?: Date;
}

export interface ParsedWebhook {
  eventId: string;
  eventType: string;
  kind: 'PAYMENT' | 'REFUND' | 'PAYOUT' | 'OTHER';
  providerRef: string;
  referenceId?: string;
  status: string;
  amountIdr?: number;
  currency?: string;
  channel?: string;
  occurredAt?: Date;
  raw: unknown;
}

export interface RefundInput {
  paymentProviderRef: string;
  referenceId: string;
  amountIdr: number;
  reason: string;
  idempotencyKey: string;
}

export interface PayoutInput {
  referenceId: string;
  amountIdr: number;
  bankCode: string;
  accountNumber: string;
  accountHolderName: string;
  description: string;
  idempotencyKey: string;
}

export interface PaymentProvider {
  readonly name: 'MOCK' | 'XENDIT';
  readonly mode: ProviderMode;
  createCheckout(input: CreateCheckoutInput): Promise<CheckoutSession>;
  getPayment(providerRef: string): Promise<ProviderPayment>;
  /** MUST be constant-time and fail closed. */
  verifyWebhook(headers: Headers, rawBody: string): Promise<boolean>;
  parseWebhook(rawBody: string): ParsedWebhook;
  /** Some channels (e.g., VA, retail) cannot be refunded → `supported:false`, caller must refund via payout. */
  refund(input: RefundInput): Promise<{ supported: boolean; providerRef?: string; status: 'PENDING' | 'SUCCEEDED' | 'FAILED' }>;
  payout(input: PayoutInput): Promise<{ providerRef: string; status: 'PENDING' | 'SUCCEEDED' | 'FAILED' }>;
  validateBankAccount(input: { bankCode: string; accountNumber: string }): Promise<{ valid: boolean; holderName?: string }>;
  /**
   * Best effort: stop an open checkout session so it can no longer be paid (e.g. the trip was cancelled). Optional —
   * funds that still arrive are captured as a late payment and refunded automatically.
   */
  cancelCheckout?(providerRef: string): Promise<void>;
  /** Sandbox/mock only: mark a checkout paid (for E2E tests and demos). */
  simulatePayment?(providerRef: string, channel?: string): Promise<void>;
}

// ------------------------------------------------------------------ email / push / sms
export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  tags?: Record<string, string>;
  idempotencyKey?: string;
  replyTo?: string;
}
export interface EmailProvider {
  readonly mode: ProviderMode;
  send(msg: EmailMessage): Promise<{ providerRef: string }>;
}

export interface PushMessage {
  tokens: string[];
  title: string;
  body: string;
  data?: Record<string, string>;
  /** Android notification channel id */
  channelId?: string;
}
export interface PushProvider {
  readonly mode: ProviderMode;
  send(msg: PushMessage): Promise<{ sent: number; invalidTokens: string[] }>;
}

export interface SmsProvider {
  readonly mode: ProviderMode;
  send(input: { to: string; body: string; channel?: 'SMS' | 'WHATSAPP' }): Promise<{ providerRef: string }>;
}

// ------------------------------------------------------------------ storage
export interface PresignedUpload {
  url: string;
  method: 'PUT';
  headers: Record<string, string>;
  expiresAt: Date;
}
export interface StorageProvider {
  readonly mode: ProviderMode;
  presignUpload(input: { key: string; contentType: string; maxBytes: number; expiresSec: number }): Promise<PresignedUpload>;
  presignDownload(input: { key: string; expiresSec: number; filename?: string }): Promise<string>;
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<{ body: Uint8Array; contentType: string } | null>;
  head(key: string): Promise<{ size: number; contentType: string } | null>;
  delete(key: string): Promise<void>;
}

// ------------------------------------------------------------------ fx
export interface FxSnapshot {
  source: string;
  base: string;
  asOf: Date;
  rates: Record<string, number>;
}
export interface FxProvider {
  readonly mode: ProviderMode;
  readonly source: string;
  latest(base: string, symbols: string[]): Promise<FxSnapshot>;
}

// ------------------------------------------------------------------ kyc
export interface KycCheckResult {
  status: 'PASSED' | 'FAILED' | 'MANUAL_REVIEW';
  livenessScore?: number;
  faceMatchScore?: number;
  reasons: string[];
  providerRef?: string;
}
export interface KycProvider {
  readonly mode: ProviderMode;
  readonly name: string;
  /**
   * `livenessFileKey` = first liveness capture (kept for providers that accept one); `livenessFileKeys` = all captures
   * (1–5, capture order) for providers that score a multi-frame / active liveness sequence.
   */
  verify(input: {
    submissionId: string;
    documentType: string;
    documentFileKey: string;
    selfieFileKey?: string;
    livenessFileKey?: string;
    livenessFileKeys?: string[];
  }): Promise<KycCheckResult>;
}

// ------------------------------------------------------------------ insurance
export interface InsuranceProvider {
  readonly mode: ProviderMode;
  readonly name: string;
  quote(input: { coverages: string[]; sumInsuredIdr: number; category: string; originCountry: string }): Promise<{ productCode: string; premiumIdr: number; coverages: string[] }>;
  bind(input: { transactionId: string; productCode: string; sumInsuredIdr: number; premiumIdr: number }): Promise<{ policyRef: string }>;
  fileClaim(input: { policyRef: string; coverage: string; amountIdr: number; description: string }): Promise<{ claimRef: string; status: string }>;
}

// ------------------------------------------------------------------ AI product extraction
export interface ExtractedProduct {
  productName?: string;
  merchantName?: string;
  merchantCountry?: string;
  price?: number;
  currency?: string;
  imageUrl?: string;
  categoryCode?: string;
  variant?: string;
  confidence: number;
  source: 'URL' | 'PHOTO' | 'SEARCH';
  warnings: string[];
}
export interface ExtractionProvider {
  readonly mode: ProviderMode;
  fromUrl(url: string): Promise<ExtractedProduct>;
  fromImage(input: { fileKey: string; hint?: string }): Promise<ExtractedProduct>;
  search(query: string, country?: string): Promise<ExtractedProduct[]>;
}

// ------------------------------------------------------------------ malware scan
export interface MalwareScanner {
  readonly mode: ProviderMode;
  scan(input: { key: string; body: Uint8Array; contentType: string }): Promise<{ status: 'CLEAN' | 'INFECTED' | 'FAILED'; engine: string; signature?: string }>;
}

// ------------------------------------------------------------------ database admin (DB & Infra Center)
export interface DbBackup {
  id: string;
  createdAt: Date;
  kind: 'AUTOMATIC' | 'MANUAL' | 'BRANCH' | 'PITR';
  sizeBytes?: number;
  status: string;
}
export interface DbAdminProvider {
  readonly name: string;
  readonly capabilities: { backups: boolean; pitr: boolean; branching: boolean; replicationInfo: boolean };
  info(): Promise<{ provider: string; region?: string; plan?: string; pitrWindowHours?: number; notes: string[] }>;
  listBackups(): Promise<DbBackup[]>;
  createBackup(label: string): Promise<DbBackup>;
  /** Restore into a NEW branch/database (never in-place) and return its identifier. */
  restoreToNew(input: { backupId?: string; pointInTime?: Date; label: string }): Promise<{ targetId: string; status: string }>;
}

export interface Providers {
  payment: PaymentProvider;
  email: EmailProvider;
  push: PushProvider;
  sms: SmsProvider;
  storage: StorageProvider;
  fx: FxProvider;
  kyc: KycProvider;
  insurance: InsuranceProvider;
  extraction: ExtractionProvider;
  malware: MalwareScanner;
  dbAdmin: DbAdminProvider;
}
