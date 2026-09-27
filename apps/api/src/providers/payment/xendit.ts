/**
 * Xendit payment adapter (SafePay). SANDBOX until the Xendit contract and legal review are done —
 * see docs/research/02-xendit-integration.md and docs/04-payments-ledger.md. Never claim LIVE.
 *
 * - Money-in: Payment Sessions API (`POST /sessions`, `mode: PAYMENT_LINK`, `session_type: PAY`),
 *   `GET /sessions/{id}` to re-verify a webhook before securing funds.
 * - Refund: `POST /refunds` (needs the session's `payment_request_id`). VA / retail channels are not
 *   refundable → `{ supported: false }` so the caller disburses to the buyer's bank account instead.
 * - Payout: `POST /v2/payouts` (header `Idempotency-key` is mandatory there).
 * - Webhooks: static `x-callback-token` per account (no HMAC) compared in constant time; retries up to
 *   6× and out of order → processing must be idempotent (done by the money services).
 * - Auth: HTTP Basic with the secret key as username and an empty password.
 * - Bank-account name validation is an Iluma product (NEEDS_VERIFICATION) → explicit fallback that
 *   returns `valid: false` with a reason instead of pretending an account is valid.
 *
 * Every HTTP call goes through the injected `fetch` (unit tests use a fake; no network in tests).
 */
import { bytesToHex, sha256, timingSafeEqual } from '../../lib/crypto';
import type {
  CheckoutSession,
  CreateCheckoutInput,
  ParsedWebhook,
  PaymentProvider,
  PayoutInput,
  ProviderPayment,
  ProviderPaymentStatus,
  RefundInput,
} from '../types';
import { normalizeChannel } from './channels';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface XenditConfig {
  secretKey: string;
  webhookToken: string;
  /** `test` → SANDBOX (default); `live` requires ALLOW_LIVE_PAYMENTS in env validation. */
  env: 'test' | 'live';
  baseUrl?: string;
  /** xenPlatform sub-account holding escrow funds (`for-user-id`); empty = master account. */
  forUserId?: string | null;
  successReturnUrl?: string | null;
  cancelReturnUrl?: string | null;
  fetch?: FetchLike;
}

export class XenditApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly errorCode: string,
    message: string,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'XenditApiError';
  }
}

/** Our channel groups → Xendit Payment Sessions `allowed_payment_channels` (NEEDS_VERIFICATION: exact codes). */
export const XENDIT_CHANNEL_CODES: Readonly<Record<string, readonly string[]>> = {
  VA: ['BCA_VIRTUAL_ACCOUNT', 'BNI_VIRTUAL_ACCOUNT', 'BRI_VIRTUAL_ACCOUNT', 'MANDIRI_VIRTUAL_ACCOUNT', 'PERMATA_VIRTUAL_ACCOUNT', 'BSI_VIRTUAL_ACCOUNT'],
  QRIS: ['QRIS'],
  EWALLET: ['OVO', 'DANA', 'SHOPEEPAY', 'LINKAJA'],
  CARD: ['CARDS'],
};

/** Xendit session / payment statuses → provider-neutral payment status. */
export function mapSessionStatus(status: string | undefined | null): ProviderPaymentStatus {
  switch ((status ?? '').toUpperCase()) {
    case 'COMPLETED':
    case 'SUCCEEDED':
    case 'PAID':
    case 'SETTLED':
    case 'CAPTURED':
      return 'SECURED';
    case 'EXPIRED':
    case 'CANCELED':
    case 'CANCELLED':
      return 'EXPIRED';
    case 'FAILED':
      return 'FAILED';
    default:
      return 'PENDING';
  }
}

/** Webhook event → normalized status consumed by the money services (SUCCEEDED | EXPIRED | FAILED | PENDING). */
export function mapWebhookStatus(event: string, dataStatus: string | undefined): string {
  const e = event.toLowerCase();
  if (e === 'payment_session.completed' || e === 'payment.capture' || e === 'payment.succeeded') return 'SUCCEEDED';
  if (e === 'payment_session.expired' || e === 'payment.expiry' || e === 'payment_request.expiry') return 'EXPIRED';
  if (e === 'payment.failure' || e === 'payment_request.failure') return 'FAILED';
  if (e.startsWith('refund.') || e.includes('payout')) {
    if (e.endsWith('succeeded') || e.endsWith('completed')) return 'SUCCEEDED';
    if (e.endsWith('failed') || e.endsWith('reversed') || e.endsWith('rejected') || e.endsWith('cancelled')) return 'FAILED';
  }
  const s = (dataStatus ?? '').toUpperCase();
  if (['SUCCEEDED', 'COMPLETED', 'PAID', 'SETTLED', 'CAPTURED'].includes(s)) return 'SUCCEEDED';
  if (['EXPIRED', 'CANCELED', 'CANCELLED'].includes(s)) return 'EXPIRED';
  if (['FAILED', 'REVERSED', 'REJECTED'].includes(s)) return 'FAILED';
  return 'PENDING';
}

function basicAuth(secretKey: string): string {
  return `Basic ${btoa(`${secretKey}:`)}`;
}

function toIdr(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v);
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Math.round(Number(v));
  return undefined;
}

export class XenditPaymentProvider implements PaymentProvider {
  readonly name = 'XENDIT' as const;
  readonly mode: 'SANDBOX' | 'LIVE';
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly cfg: XenditConfig) {
    if (!cfg.secretKey) throw new Error('XENDIT_SECRET_KEY is required');
    this.mode = cfg.env === 'live' ? 'LIVE' : 'SANDBOX';
    this.baseUrl = (cfg.baseUrl ?? 'https://api.xendit.co').replace(/\/+$/, '');
    this.fetchImpl = cfg.fetch ?? ((input, init) => fetch(input, init));
    // A development key against live mode (or the reverse) is a configuration error.
    if (cfg.env === 'live' && cfg.secretKey.startsWith('xnd_development_')) throw new Error('Xendit live mode with a development key');
    if (cfg.env === 'test' && cfg.secretKey.startsWith('xnd_production_')) throw new Error('Xendit test mode with a production key');
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      authorization: basicAuth(this.cfg.secretKey),
      'content-type': 'application/json',
      accept: 'application/json',
      ...(this.cfg.forUserId ? { 'for-user-id': this.cfg.forUserId } : {}),
      ...extra,
    };
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(extraHeaders),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text.slice(0, 500) };
    }
    if (!res.ok) {
      const j = (json ?? {}) as { error_code?: string; message?: string };
      throw new XenditApiError(res.status, j.error_code ?? `HTTP_${res.status}`, j.message ?? `Xendit ${method} ${path} failed`, json);
    }
    return json as T;
  }

  async createCheckout(input: CreateCheckoutInput): Promise<CheckoutSession> {
    const channels = (input.channels ?? []).flatMap((c) => XENDIT_CHANNEL_CODES[c] ?? []);
    const body = {
      reference_id: input.referenceId,
      session_type: 'PAY',
      mode: 'PAYMENT_LINK',
      amount: input.amountIdr,
      currency: 'IDR',
      country: 'ID',
      capture_method: 'AUTOMATIC',
      expires_at: input.expiresAt.toISOString(),
      description: input.description.slice(0, 255),
      ...(channels.length ? { allowed_payment_channels: channels } : {}),
      customer: {
        reference_id: input.referenceId,
        type: 'INDIVIDUAL',
        ...(input.customer.email ? { email: input.customer.email } : {}),
        ...(input.customer.phone ? { mobile_number: input.customer.phone } : {}),
        individual_detail: { given_names: (input.customer.name ?? 'Pembeli JastipKita').slice(0, 50) },
      },
      ...((input.successUrl ?? this.cfg.successReturnUrl) ? { success_return_url: input.successUrl ?? this.cfg.successReturnUrl } : {}),
      ...((input.failureUrl ?? this.cfg.cancelReturnUrl) ? { cancel_return_url: input.failureUrl ?? this.cfg.cancelReturnUrl } : {}),
      metadata: { ...(input.metadata ?? {}), sandbox: this.mode === 'SANDBOX' ? 'true' : 'false' },
    };
    // Idempotency header is not documented for Sessions (NEEDS_VERIFICATION); unique reference_id is the
    // primary guard (409 DUPLICATE_ERROR). Sending it is harmless and protects if/when supported.
    const res = await this.call<{ payment_session_id: string; payment_link_url: string; expires_at?: string; status?: string }>(
      'POST',
      '/sessions',
      body,
      { 'idempotency-key': input.idempotencyKey.slice(0, 100) },
    );
    return {
      providerRef: res.payment_session_id,
      checkoutUrl: res.payment_link_url,
      expiresAt: res.expires_at ? new Date(res.expires_at) : input.expiresAt,
      raw: { status: res.status ?? null },
    };
  }

  async getPayment(providerRef: string): Promise<ProviderPayment> {
    const s = await this.call<{
      payment_session_id: string;
      reference_id?: string;
      status?: string;
      amount?: number | string;
      currency?: string;
      payment_request_id?: string;
      updated?: string;
      channel_code?: string;
    }>('GET', `/sessions/${encodeURIComponent(providerRef)}`);
    const channel = normalizeChannel(s.channel_code);
    const status = mapSessionStatus(s.status);
    return {
      providerRef: s.payment_session_id ?? providerRef,
      ...(s.reference_id ? { referenceId: s.reference_id } : {}),
      status,
      amountIdr: toIdr(s.amount) ?? 0,
      currency: s.currency ?? 'IDR',
      ...(channel ? { channel } : {}),
      ...(status === 'SECURED' && s.updated ? { paidAt: new Date(s.updated) } : {}),
    };
  }

  /** Constant-time comparison of `x-callback-token` (hash both sides first so length does not leak). Fails closed. */
  async verifyWebhook(headers: Headers, _rawBody: string): Promise<boolean> {
    const expected = this.cfg.webhookToken;
    const got = headers.get('x-callback-token');
    if (!expected || !got) return false;
    const [a, b] = await Promise.all([sha256(got), sha256(expected)]);
    return timingSafeEqual(a, b);
  }

  parseWebhook(rawBody: string): ParsedWebhook {
    const b = JSON.parse(rawBody) as {
      id?: string;
      event?: string;
      created?: string;
      business_id?: string;
      data?: Record<string, unknown>;
    } & Record<string, unknown>;
    // Payout v2 callbacks may arrive without an `event` envelope (NEEDS_VERIFICATION): treat the body as data.
    const event = typeof b.event === 'string' ? b.event : typeof b.status === 'string' && typeof b.reference_id === 'string' ? 'payout.callback' : 'unknown';
    const d = (b.data && typeof b.data === 'object' ? b.data : b) as Record<string, unknown>;
    const str = (k: string): string | undefined => (typeof d[k] === 'string' ? (d[k] as string) : undefined);
    const lower = event.toLowerCase();
    const kind: ParsedWebhook['kind'] = lower.startsWith('payment')
      ? 'PAYMENT'
      : lower.startsWith('refund')
        ? 'REFUND'
        : lower.includes('payout')
          ? 'PAYOUT'
          : 'OTHER';
    const providerRef =
      kind === 'PAYMENT'
        ? str('payment_session_id') ?? str('payment_request_id') ?? str('payment_id') ?? str('id') ?? ''
        : str('id') ?? '';
    const status = mapWebhookStatus(event, str('status'));
    const amountIdr = toIdr(d.amount ?? d.request_amount ?? d.captured_amount);
    const channel = normalizeChannel(str('channel_code') ?? str('payment_channel'));
    // Stable id for retries of the SAME notification (the route prefers the `webhook-id` header when present).
    const eventId = b.id ?? `${event}:${providerRef || str('reference_id') || 'unknown'}:${str('status') ?? status}:${b.created ?? str('updated') ?? ''}`;
    return {
      eventId,
      eventType: event,
      kind,
      providerRef,
      ...(str('reference_id') ? { referenceId: str('reference_id') as string } : {}),
      status,
      ...(amountIdr !== undefined ? { amountIdr } : {}),
      ...(str('currency') ? { currency: str('currency') as string } : {}),
      ...(channel ? { channel } : {}),
      ...(b.created ? { occurredAt: new Date(b.created) } : {}),
      raw: b,
    };
  }

  async refund(input: RefundInput): Promise<{ supported: boolean; providerRef?: string; status: 'PENDING' | 'SUCCEEDED' | 'FAILED' }> {
    let paymentRequestId: string | undefined;
    try {
      const s = await this.call<{ payment_request_id?: string }>('GET', `/sessions/${encodeURIComponent(input.paymentProviderRef)}`);
      paymentRequestId = s.payment_request_id;
    } catch (err) {
      if (err instanceof XenditApiError && err.status === 404) return { supported: false, status: 'FAILED' };
      throw err;
    }
    if (!paymentRequestId) return { supported: false, status: 'FAILED' };
    try {
      const r = await this.call<{ id: string; status?: string }>(
        'POST',
        '/refunds',
        {
          payment_request_id: paymentRequestId,
          reference_id: input.referenceId,
          amount: input.amountIdr,
          currency: 'IDR',
          reason: 'CANCELLATION',
          metadata: { note: input.reason.slice(0, 200) },
        },
        { 'idempotency-key': input.idempotencyKey.slice(0, 100) },
      );
      const st = (r.status ?? 'PENDING').toUpperCase();
      return { supported: true, providerRef: r.id, status: st === 'SUCCEEDED' ? 'SUCCEEDED' : st === 'FAILED' || st === 'CANCELLED' ? 'FAILED' : 'PENDING' };
    } catch (err) {
      if (err instanceof XenditApiError && ['REFUND_NOT_SUPPORTED', 'PARTIAL_REFUND_NOT_SUPPORTED', 'INELIGIBLE_TRANSACTION_STATUS'].includes(err.errorCode)) {
        return { supported: false, status: 'FAILED' };
      }
      throw err;
    }
  }

  async payout(input: PayoutInput): Promise<{ providerRef: string; status: 'PENDING' | 'SUCCEEDED' | 'FAILED' }> {
    const r = await this.call<{ id: string; status?: string }>(
      'POST',
      '/v2/payouts',
      {
        reference_id: input.referenceId,
        channel_code: input.bankCode.startsWith('ID_') ? input.bankCode : `ID_${input.bankCode}`,
        channel_properties: { account_holder_name: input.accountHolderName, account_number: input.accountNumber },
        amount: input.amountIdr,
        currency: 'IDR',
        description: input.description.slice(0, 100),
      },
      { 'idempotency-key': input.idempotencyKey.slice(0, 100) },
    );
    const st = (r.status ?? 'ACCEPTED').toUpperCase();
    return {
      providerRef: r.id,
      status: st === 'SUCCEEDED' ? 'SUCCEEDED' : ['FAILED', 'CANCELLED', 'REVERSED'].includes(st) ? 'FAILED' : 'PENDING',
    };
  }

  /**
   * Name validation needs Iluma (separate contract, endpoint NEEDS_VERIFICATION). Until it is wired, the
   * adapter refuses to vouch for an account: callers must treat `valid:false` as "not verified".
   */
  async validateBankAccount(_input: { bankCode: string; accountNumber: string }): Promise<{ valid: boolean; holderName?: string; reason?: string }> {
    return { valid: false, reason: 'NAME_VALIDATION_UNAVAILABLE' };
  }
}

/** Redacted fingerprint of a key for logs/diagnostics (never log the key itself). */
export async function keyFingerprint(secretKey: string): Promise<string> {
  return bytesToHex(await sha256(secretKey)).slice(0, 12);
}
