import { describe, expect, it } from 'vitest';
import { channelSupportsProviderRefund, normalizeChannel } from './channels';
import { mapSessionStatus, mapWebhookStatus, XenditApiError, XenditPaymentProvider, type FetchLike } from './xendit';

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
}

function fakeFetch(responder: (req: Captured) => { status?: number; body: unknown }) {
  const calls: Captured[] = [];
  const f: FetchLike = async (url, init) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    const req = { url, method: init?.method ?? 'GET', headers, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(req);
    const r = responder(req);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  return { f, calls };
}

const cfg = { secretKey: 'xnd_development_secret123', webhookToken: 'tok_callback_abc', env: 'test' as const, baseUrl: 'https://api.xendit.test' };

describe('XenditPaymentProvider (SANDBOX, fake fetch — no network)', () => {
  it('is SANDBOX in test mode and refuses mismatched key/env', () => {
    expect(new XenditPaymentProvider({ ...cfg, fetch: fakeFetch(() => ({ body: {} })).f }).mode).toBe('SANDBOX');
    expect(() => new XenditPaymentProvider({ ...cfg, env: 'live' })).toThrow(/development key/);
    expect(() => new XenditPaymentProvider({ ...cfg, secretKey: 'xnd_production_x' })).toThrow(/production key/);
  });

  it('createCheckout: POST /sessions with Basic auth, idempotency header and the Payment Sessions body', async () => {
    const { f, calls } = fakeFetch(() => ({
      status: 201,
      body: { payment_session_id: 'ps-123', payment_link_url: 'https://checkout-staging.xendit.co/ps-123', status: 'ACTIVE', expires_at: '2026-09-27T10:30:00.000Z' },
    }));
    const x = new XenditPaymentProvider({ ...cfg, fetch: f, forUserId: 'sub-escrow-1' });
    const s = await x.createCheckout({
      referenceId: '6f1f3b0e-0a0b-4c55-9d8b-2a2f7e5d1c11',
      amountIdr: 3_081_234,
      description: 'JastipKita JK-260927-ABCDEF',
      customer: { email: 'buyer@example.com' },
      channels: ['QRIS', 'VA'],
      expiresAt: new Date('2026-09-27T10:30:00Z'),
      idempotencyKey: 'pay:6f1f3b0e-0a0b-4c55-9d8b-2a2f7e5d1c11',
      metadata: { transactionId: 'tx-1' },
    });
    expect(s).toMatchObject({ providerRef: 'ps-123', checkoutUrl: 'https://checkout-staging.xendit.co/ps-123' });
    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.method).toBe('POST');
    expect(c.url).toBe('https://api.xendit.test/sessions');
    expect(c.headers.authorization).toBe(`Basic ${btoa('xnd_development_secret123:')}`);
    expect(c.headers['idempotency-key']).toBe('pay:6f1f3b0e-0a0b-4c55-9d8b-2a2f7e5d1c11');
    expect(c.headers['for-user-id']).toBe('sub-escrow-1');
    expect(c.body).toMatchObject({
      reference_id: '6f1f3b0e-0a0b-4c55-9d8b-2a2f7e5d1c11',
      session_type: 'PAY',
      mode: 'PAYMENT_LINK',
      amount: 3_081_234,
      currency: 'IDR',
      country: 'ID',
      expires_at: '2026-09-27T10:30:00.000Z',
      metadata: { transactionId: 'tx-1', sandbox: 'true' },
    });
    expect(c.body.allowed_payment_channels).toContain('QRIS');
    expect(c.body.allowed_payment_channels).toContain('BCA_VIRTUAL_ACCOUNT');
  });

  it('surfaces API errors with the Xendit error code', async () => {
    const { f } = fakeFetch(() => ({ status: 409, body: { error_code: 'DUPLICATE_ERROR', message: 'reference_id already used' } }));
    const x = new XenditPaymentProvider({ ...cfg, fetch: f });
    await expect(
      x.createCheckout({ referenceId: 'r', amountIdr: 1, description: 'd', customer: {}, expiresAt: new Date(), idempotencyKey: 'k' }),
    ).rejects.toMatchObject({ status: 409, errorCode: 'DUPLICATE_ERROR' } satisfies Partial<XenditApiError>);
  });

  it('getPayment maps session statuses', async () => {
    const { f, calls } = fakeFetch(() => ({ body: { payment_session_id: 'ps-1', reference_id: 'ref', status: 'COMPLETED', amount: 1000, currency: 'IDR', channel_code: 'BCA_VIRTUAL_ACCOUNT' } }));
    const x = new XenditPaymentProvider({ ...cfg, fetch: f });
    const p = await x.getPayment('ps-1');
    expect(p).toMatchObject({ status: 'SECURED', amountIdr: 1000, currency: 'IDR', channel: 'VA', referenceId: 'ref' });
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.url).toBe('https://api.xendit.test/sessions/ps-1');
    expect(mapSessionStatus('ACTIVE')).toBe('PENDING');
    expect(mapSessionStatus('EXPIRED')).toBe('EXPIRED');
    expect(mapSessionStatus('CANCELED')).toBe('EXPIRED');
    expect(mapSessionStatus('FAILED')).toBe('FAILED');
  });

  it('verifyWebhook: constant-time token check, fails closed on missing/incorrect tokens', async () => {
    const x = new XenditPaymentProvider({ ...cfg, fetch: fakeFetch(() => ({ body: {} })).f });
    expect(await x.verifyWebhook(new Headers({ 'x-callback-token': 'tok_callback_abc' }), '{}')).toBe(true);
    expect(await x.verifyWebhook(new Headers({ 'x-callback-token': 'tok_callback_abd' }), '{}')).toBe(false);
    expect(await x.verifyWebhook(new Headers({ 'x-callback-token': 'tok' }), '{}')).toBe(false);
    expect(await x.verifyWebhook(new Headers(), '{}')).toBe(false);
    const noToken = new XenditPaymentProvider({ ...cfg, webhookToken: '', fetch: fakeFetch(() => ({ body: {} })).f });
    expect(await noToken.verifyWebhook(new Headers({ 'x-callback-token': '' }), '{}')).toBe(false);
  });

  it('parseWebhook maps Payment Session, payment, refund and payout events', () => {
    const x = new XenditPaymentProvider({ ...cfg, fetch: fakeFetch(() => ({ body: {} })).f });
    const completed = x.parseWebhook(
      JSON.stringify({
        event: 'payment_session.completed',
        business_id: 'b1',
        created: '2026-09-27T10:01:00Z',
        data: { payment_session_id: 'ps-9', reference_id: 'pay-uuid', status: 'COMPLETED', amount: 250000, currency: 'IDR', channel_code: 'QRIS' },
      }),
    );
    expect(completed).toMatchObject({ kind: 'PAYMENT', providerRef: 'ps-9', referenceId: 'pay-uuid', status: 'SUCCEEDED', amountIdr: 250000, currency: 'IDR', channel: 'QRIS' });
    expect(completed.eventId).toContain('payment_session.completed:ps-9');
    const expired = x.parseWebhook(JSON.stringify({ event: 'payment_session.expired', data: { payment_session_id: 'ps-9', status: 'EXPIRED' } }));
    expect(expired).toMatchObject({ kind: 'PAYMENT', status: 'EXPIRED' });
    expect(x.parseWebhook(JSON.stringify({ event: 'payment.failure', data: { payment_id: 'py-1', status: 'FAILED' } }))).toMatchObject({ kind: 'PAYMENT', status: 'FAILED' });
    expect(x.parseWebhook(JSON.stringify({ event: 'refund.succeeded', data: { id: 'rfd-1', reference_id: 'RFD-260927-ABCDEF', status: 'SUCCEEDED' } }))).toMatchObject({
      kind: 'REFUND',
      providerRef: 'rfd-1',
      status: 'SUCCEEDED',
    });
    expect(x.parseWebhook(JSON.stringify({ id: 'disb-1', reference_id: 'PO-260927-ABCDEF', status: 'FAILED' }))).toMatchObject({ kind: 'PAYOUT', status: 'FAILED' });
    expect(mapWebhookStatus('v3_payout.succeeded', undefined)).toBe('SUCCEEDED');
  });

  it('refund: resolves payment_request_id then POST /refunds; VA → supported:false', async () => {
    const { f, calls } = fakeFetch((req) =>
      req.method === 'GET'
        ? { body: { payment_session_id: 'ps-1', payment_request_id: 'pr-1' } }
        : { status: 200, body: { id: 'rfd-9', status: 'SUCCEEDED' } },
    );
    const x = new XenditPaymentProvider({ ...cfg, fetch: f });
    const r = await x.refund({ paymentProviderRef: 'ps-1', referenceId: 'RFD-1', amountIdr: 5000, reason: 'BUYER_CANCEL', idempotencyKey: 'refund:1' });
    expect(r).toEqual({ supported: true, providerRef: 'rfd-9', status: 'SUCCEEDED' });
    expect(calls[1]!.url).toBe('https://api.xendit.test/refunds');
    expect(calls[1]!.body).toMatchObject({ payment_request_id: 'pr-1', reference_id: 'RFD-1', amount: 5000, currency: 'IDR', reason: 'CANCELLATION' });
    expect(calls[1]!.headers['idempotency-key']).toBe('refund:1');

    const va = fakeFetch((req) =>
      req.method === 'GET' ? { body: { payment_request_id: 'pr-2' } } : { status: 400, body: { error_code: 'REFUND_NOT_SUPPORTED', message: 'VA' } },
    );
    const x2 = new XenditPaymentProvider({ ...cfg, fetch: va.f });
    expect(await x2.refund({ paymentProviderRef: 'ps-2', referenceId: 'RFD-2', amountIdr: 1, reason: 'x', idempotencyKey: 'refund:2' })).toEqual({ supported: false, status: 'FAILED' });
  });

  it('payout: POST /v2/payouts with mandatory Idempotency-key; status mapping', async () => {
    const { f, calls } = fakeFetch(() => ({ body: { id: 'disb-1', status: 'ACCEPTED' } }));
    const x = new XenditPaymentProvider({ ...cfg, fetch: f });
    const r = await x.payout({ referenceId: 'PO-1', amountIdr: 2_500_000, bankCode: 'BCA', accountNumber: '1234567890', accountHolderName: 'BUDI', description: 'Payout', idempotencyKey: 'payout:1' });
    expect(r).toEqual({ providerRef: 'disb-1', status: 'PENDING' });
    expect(calls[0]!.url).toBe('https://api.xendit.test/v2/payouts');
    expect(calls[0]!.headers['idempotency-key']).toBe('payout:1');
    expect(calls[0]!.body).toMatchObject({
      reference_id: 'PO-1',
      channel_code: 'ID_BCA',
      channel_properties: { account_holder_name: 'BUDI', account_number: '1234567890' },
      amount: 2_500_000,
      currency: 'IDR',
    });
  });

  it('validateBankAccount is an explicit fallback (Iluma not wired): valid:false with a reason', async () => {
    const x = new XenditPaymentProvider({ ...cfg, fetch: fakeFetch(() => ({ body: {} })).f });
    expect(await x.validateBankAccount({ bankCode: 'BCA', accountNumber: '1234567890' })).toEqual({ valid: false, reason: 'NAME_VALIDATION_UNAVAILABLE' });
  });

  it('channel policy: VA/retail cannot be refunded; codes normalize to groups', () => {
    expect(channelSupportsProviderRefund('VA')).toBe(false);
    expect(channelSupportsProviderRefund('RETAIL')).toBe(false);
    expect(channelSupportsProviderRefund('QRIS')).toBe(true);
    expect(channelSupportsProviderRefund(null)).toBe(false);
    expect(normalizeChannel('MANDIRI_VIRTUAL_ACCOUNT')).toBe('VA');
    expect(normalizeChannel('SHOPEEPAY')).toBe('EWALLET');
    expect(normalizeChannel('CARDS')).toBe('CARD');
  });
});
