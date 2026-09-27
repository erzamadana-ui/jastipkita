/**
 * Mock / log implementations for every provider. Used in development and tests, and as the default
 * until real credentials are configured. Everything here is labelled MOCK — never claim it is live.
 */
import { randomToken } from '../lib/crypto';
import type { Logger } from '../lib/logger';
import type {
  CheckoutSession,
  CreateCheckoutInput,
  DbAdminProvider,
  EmailMessage,
  EmailProvider,
  ExtractedProduct,
  ExtractionProvider,
  FxProvider,
  FxSnapshot,
  InsuranceProvider,
  KycProvider,
  MalwareScanner,
  ParsedWebhook,
  PaymentProvider,
  PayoutInput,
  PresignedUpload,
  ProviderPayment,
  PushMessage,
  PushProvider,
  RefundInput,
  SmsProvider,
  StorageProvider,
} from './types';

// ------------------------------------------------------------------ payment
interface MockSession {
  input: CreateCheckoutInput;
  providerRef: string;
  status: ProviderPayment['status'];
  channel?: string;
  paidAt?: Date;
}

export const MOCK_WEBHOOK_TOKEN = 'mock-webhook-token';

export class MockPaymentProvider implements PaymentProvider {
  readonly name = 'MOCK' as const;
  readonly mode = 'MOCK' as const;
  readonly sessions = new Map<string, MockSession>();
  readonly refunds: RefundInput[] = [];
  readonly payouts: PayoutInput[] = [];
  /** Channels for which refund is NOT supported (mirrors Xendit VA behaviour). */
  unrefundableChannels = new Set(['VA']);

  constructor(private readonly apiBaseUrl: string) {}

  async createCheckout(input: CreateCheckoutInput): Promise<CheckoutSession> {
    const existing = [...this.sessions.values()].find((s) => s.input.idempotencyKey === input.idempotencyKey);
    if (existing) return { providerRef: existing.providerRef, checkoutUrl: this.url(existing.providerRef), expiresAt: existing.input.expiresAt };
    const providerRef = `mock_ps_${randomToken(9)}`;
    this.sessions.set(providerRef, { input, providerRef, status: 'PENDING' });
    return { providerRef, checkoutUrl: this.url(providerRef), expiresAt: input.expiresAt };
  }

  private url(ref: string) {
    return `${this.apiBaseUrl}/v1/dev/mock-checkout/${ref}`;
  }

  async getPayment(providerRef: string): Promise<ProviderPayment> {
    const s = this.sessions.get(providerRef);
    if (!s) throw new Error(`mock payment ${providerRef} not found`);
    return {
      providerRef,
      referenceId: s.input.referenceId,
      status: s.status,
      amountIdr: s.input.amountIdr,
      currency: 'IDR',
      ...(s.channel ? { channel: s.channel } : {}),
      ...(s.paidAt ? { paidAt: s.paidAt } : {}),
    };
  }

  async verifyWebhook(headers: Headers): Promise<boolean> {
    return headers.get('x-callback-token') === MOCK_WEBHOOK_TOKEN;
  }

  parseWebhook(rawBody: string): ParsedWebhook {
    const b = JSON.parse(rawBody) as {
      id: string;
      event: string;
      data: { id: string; reference_id?: string; status: string; amount?: number; currency?: string; channel?: string; created?: string };
    };
    return {
      eventId: b.id,
      eventType: b.event,
      kind: b.event.startsWith('payment') ? 'PAYMENT' : b.event.startsWith('refund') ? 'REFUND' : b.event.startsWith('payout') ? 'PAYOUT' : 'OTHER',
      providerRef: b.data.id,
      ...(b.data.reference_id ? { referenceId: b.data.reference_id } : {}),
      status: b.data.status,
      ...(b.data.amount !== undefined ? { amountIdr: b.data.amount } : {}),
      ...(b.data.currency ? { currency: b.data.currency } : {}),
      ...(b.data.channel ? { channel: b.data.channel } : {}),
      ...(b.data.created ? { occurredAt: new Date(b.data.created) } : {}),
      raw: b,
    };
  }

  /** Builds the webhook body the mock "provider" would send. Tests POST it to /v1/webhooks/payments/mock. */
  buildPaymentWebhook(providerRef: string, status: 'SUCCEEDED' | 'EXPIRED' | 'FAILED' = 'SUCCEEDED', overrides: { amount?: number; channel?: string } = {}) {
    const s = this.sessions.get(providerRef);
    if (!s) throw new Error(`mock payment ${providerRef} not found`);
    if (status === 'SUCCEEDED') {
      s.status = 'SECURED';
      s.channel = overrides.channel ?? 'QRIS';
      s.paidAt = new Date();
    } else s.status = status === 'EXPIRED' ? 'EXPIRED' : 'FAILED';
    return JSON.stringify({
      id: `evt_${randomToken(9)}`,
      event: status === 'SUCCEEDED' ? 'payment.succeeded' : status === 'EXPIRED' ? 'payment.expired' : 'payment.failed',
      data: {
        id: providerRef,
        reference_id: s.input.referenceId,
        status,
        amount: overrides.amount ?? s.input.amountIdr,
        currency: 'IDR',
        channel: overrides.channel ?? 'QRIS',
        created: new Date().toISOString(),
      },
    });
  }

  async simulatePayment(providerRef: string, channel = 'QRIS'): Promise<void> {
    this.buildPaymentWebhook(providerRef, 'SUCCEEDED', { channel });
  }

  async refund(input: RefundInput) {
    const s = this.sessions.get(input.paymentProviderRef);
    if (s?.channel && this.unrefundableChannels.has(s.channel)) return { supported: false, status: 'FAILED' as const };
    this.refunds.push(input);
    return { supported: true, providerRef: `mock_rf_${randomToken(9)}`, status: 'SUCCEEDED' as const };
  }

  async payout(input: PayoutInput) {
    this.payouts.push(input);
    return { providerRef: `mock_po_${randomToken(9)}`, status: 'SUCCEEDED' as const };
  }

  async validateBankAccount(input: { bankCode: string; accountNumber: string }) {
    const valid = /^\d{6,20}$/.test(input.accountNumber);
    return valid ? { valid, holderName: 'NAMA SESUAI REKENING (MOCK)' } : { valid };
  }
}

// ------------------------------------------------------------------ email / push / sms
export class LogEmailProvider implements EmailProvider {
  readonly mode = 'MOCK' as const;
  readonly outbox: EmailMessage[] = [];
  constructor(private readonly logger?: Logger) {}
  async send(msg: EmailMessage) {
    this.outbox.push(msg);
    this.logger?.info('email.mock_send', { subject: msg.subject, tags: msg.tags });
    return { providerRef: `mock_email_${randomToken(9)}` };
  }
}

export class LogPushProvider implements PushProvider {
  readonly mode = 'MOCK' as const;
  readonly sent: PushMessage[] = [];
  async send(msg: PushMessage) {
    this.sent.push(msg);
    return { sent: msg.tokens.length, invalidTokens: msg.tokens.filter((t) => t.startsWith('invalid')) };
  }
}

export class LogSmsProvider implements SmsProvider {
  readonly mode = 'MOCK' as const;
  readonly sent: { to: string; body: string; channel?: 'SMS' | 'WHATSAPP' }[] = [];
  async send(input: { to: string; body: string; channel?: 'SMS' | 'WHATSAPP' }) {
    this.sent.push(input);
    return { providerRef: `mock_sms_${randomToken(9)}` };
  }
}

// ------------------------------------------------------------------ storage
interface PendingUpload {
  key: string;
  contentType: string;
  maxBytes: number;
  expiresAt: Date;
}

/** In-memory object storage (dev/test). Upload URLs point at the API's dev upload route. */
export class MemoryStorageProvider implements StorageProvider {
  readonly mode = 'MOCK' as const;
  readonly objects = new Map<string, { body: Uint8Array; contentType: string }>();
  private readonly pending = new Map<string, PendingUpload>();
  private readonly downloads = new Map<string, { key: string; expiresAt: Date; filename?: string }>();

  constructor(private readonly apiBaseUrl: string) {}

  async presignUpload(input: { key: string; contentType: string; maxBytes: number; expiresSec: number }): Promise<PresignedUpload> {
    const token = randomToken(24);
    const expiresAt = new Date(Date.now() + input.expiresSec * 1000);
    this.pending.set(token, { key: input.key, contentType: input.contentType, maxBytes: input.maxBytes, expiresAt });
    return { url: `${this.apiBaseUrl}/v1/dev/storage/upload/${token}`, method: 'PUT', headers: { 'content-type': input.contentType }, expiresAt };
  }

  /** Used by the dev upload route. Returns false if token invalid/expired or payload too large/wrong type. */
  acceptUpload(token: string, body: Uint8Array, contentType: string): { ok: boolean; reason?: string; key?: string } {
    const p = this.pending.get(token);
    if (!p) return { ok: false, reason: 'UPLOAD_TOKEN_INVALID' };
    this.pending.delete(token);
    if (p.expiresAt.getTime() < Date.now()) return { ok: false, reason: 'UPLOAD_TOKEN_EXPIRED' };
    if (body.length > p.maxBytes) return { ok: false, reason: 'FILE_TOO_LARGE' };
    if (contentType.split(';')[0] !== p.contentType) return { ok: false, reason: 'CONTENT_TYPE_MISMATCH' };
    this.objects.set(p.key, { body, contentType: p.contentType });
    return { ok: true, key: p.key };
  }

  async presignDownload(input: { key: string; expiresSec: number; filename?: string }): Promise<string> {
    const token = randomToken(24);
    this.downloads.set(token, { key: input.key, expiresAt: new Date(Date.now() + input.expiresSec * 1000), ...(input.filename ? { filename: input.filename } : {}) });
    return `${this.apiBaseUrl}/v1/dev/storage/download/${token}`;
  }

  resolveDownload(token: string): { key: string; filename?: string } | null {
    const d = this.downloads.get(token);
    if (!d || d.expiresAt.getTime() < Date.now()) return null;
    return { key: d.key, ...(d.filename ? { filename: d.filename } : {}) };
  }

  async put(key: string, body: Uint8Array, contentType: string) {
    this.objects.set(key, { body, contentType });
  }
  async get(key: string) {
    return this.objects.get(key) ?? null;
  }
  async head(key: string) {
    const o = this.objects.get(key);
    return o ? { size: o.body.length, contentType: o.contentType } : null;
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
}

// ------------------------------------------------------------------ fx
/**
 * Static MOCK rates (USD base). Values are illustrative snapshots, NOT market data:
 * USD/IDR ≈ 17.900 (JISDOR 2026-09 per docs/research/03-fx-providers.md), others approximate.
 */
export const MOCK_USD_RATES: Record<string, number> = {
  IDR: 17900,
  JPY: 157.4,
  SGD: 1.29,
  KRW: 1385,
  MYR: 4.21,
  AUD: 1.52,
  EUR: 0.86,
  CNY: 7.1,
  HKD: 7.8,
  GBP: 0.75,
  CHF: 0.8,
  NZD: 1.66,
  CAD: 1.37,
  THB: 32.4,
  TRY: 41.5,
};

export class StaticFxProvider implements FxProvider {
  readonly mode = 'MOCK' as const;
  readonly source = 'static-mock';
  constructor(private readonly asOf: () => Date = () => new Date()) {}
  async latest(base: string, symbols: string[]): Promise<FxSnapshot> {
    const baseUsd = base === 'USD' ? 1 : MOCK_USD_RATES[base];
    if (!baseUsd) throw new Error(`FX_RATE_UNAVAILABLE:${base}`);
    const rates: Record<string, number> = {};
    for (const s of symbols) {
      if (s === base) continue;
      const q = s === 'USD' ? 1 : MOCK_USD_RATES[s];
      if (q) rates[s] = q / baseUsd;
    }
    return { source: this.source, base, asOf: this.asOf(), rates };
  }
}

// ------------------------------------------------------------------ kyc / insurance / extraction / malware
export class MockKycProvider implements KycProvider {
  readonly mode = 'MOCK' as const;
  readonly name = 'mock';
  /** Keys containing "fail" fail liveness — lets tests exercise rejection paths. */
  async verify(input: { submissionId: string; documentFileKey: string; selfieFileKey?: string; livenessFileKey?: string }) {
    const failing = [input.documentFileKey, input.selfieFileKey, input.livenessFileKey].some((k) => k?.includes('fail'));
    return failing
      ? { status: 'FAILED' as const, livenessScore: 0.2, faceMatchScore: 0.3, reasons: ['LIVENESS_FAILED'], providerRef: `mock_kyc_${randomToken(6)}` }
      : { status: 'PASSED' as const, livenessScore: 0.97, faceMatchScore: 0.93, reasons: [], providerRef: `mock_kyc_${randomToken(6)}` };
  }
}

/** Manual review: every submission goes to the admin KYC queue. */
export class ManualKycProvider implements KycProvider {
  readonly mode = 'LIVE' as const;
  readonly name = 'manual';
  async verify() {
    return { status: 'MANUAL_REVIEW' as const, reasons: ['MANUAL_REVIEW_REQUIRED'] };
  }
}

export class MockInsuranceProvider implements InsuranceProvider {
  readonly mode = 'MOCK' as const;
  readonly name = 'mock-insurer';
  async quote(input: { coverages: string[]; sumInsuredIdr: number }) {
    const premium = Math.max(5000, Math.round((input.sumInsuredIdr * 0.01) / 100) * 100);
    return { productCode: 'MOCK-JASTIP-PROTECT', premiumIdr: premium, coverages: input.coverages };
  }
  async bind() {
    return { policyRef: `mock_pol_${randomToken(8)}` };
  }
  async fileClaim() {
    return { claimRef: `mock_clm_${randomToken(8)}`, status: 'SUBMITTED' };
  }
}

export class MockExtractionProvider implements ExtractionProvider {
  readonly mode = 'MOCK' as const;
  async fromUrl(url: string): Promise<ExtractedProduct> {
    return { productName: `Produk dari ${new URL(url).hostname}`, confidence: 0.3, source: 'URL', warnings: ['MOCK_EXTRACTION'] };
  }
  async fromImage(): Promise<ExtractedProduct> {
    return { confidence: 0, source: 'PHOTO', warnings: ['MOCK_EXTRACTION', 'MANUAL_INPUT_REQUIRED'] };
  }
  async search(query: string): Promise<ExtractedProduct[]> {
    return [{ productName: query, confidence: 0.2, source: 'SEARCH', warnings: ['MOCK_EXTRACTION'] }];
  }
}

export class MockMalwareScanner implements MalwareScanner {
  readonly mode = 'MOCK' as const;
  /** EICAR test string → INFECTED, everything else CLEAN. */
  async scan(input: { body: Uint8Array }) {
    const text = new TextDecoder().decode(input.body.slice(0, 256));
    return text.includes('EICAR-STANDARD-ANTIVIRUS-TEST-FILE')
      ? { status: 'INFECTED' as const, engine: 'mock', signature: 'EICAR-Test-File' }
      : { status: 'CLEAN' as const, engine: 'mock' };
  }
}

export class NoMalwareScanner implements MalwareScanner {
  readonly mode = 'MOCK' as const;
  async scan() {
    return { status: 'CLEAN' as const, engine: 'none' };
  }
}

/** Generic Postgres: no provider API → backups are "managed by provider" and cannot be triggered from Admin. */
export class GenericDbAdminProvider implements DbAdminProvider {
  readonly name = 'generic-postgres';
  readonly capabilities = { backups: false, pitr: false, branching: false, replicationInfo: true };
  async info() {
    return { provider: 'postgres', notes: ['Backup/PITR dikelola di luar aplikasi (pg_dump terjadwal atau fitur provider).'] };
  }
  async listBackups() {
    return [];
  }
  async createBackup(): Promise<never> {
    throw new Error('DB_ADMIN_UNSUPPORTED: generic provider cannot create backups via API');
  }
  async restoreToNew(): Promise<never> {
    throw new Error('DB_ADMIN_UNSUPPORTED: generic provider cannot restore via API');
  }
}
