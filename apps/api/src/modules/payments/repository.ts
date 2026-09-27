import { camel, type Db } from '../../db/sql';

export interface PaymentRow {
  id: string;
  transactionId: string;
  quoteId: string | null;
  purpose: 'CHECKOUT' | 'SUPPLEMENTAL';
  provider: 'XENDIT' | 'MOCK';
  providerEnv: 'TEST' | 'LIVE';
  providerRef: string | null;
  channel: string | null;
  amountIdr: number;
  providerFeeIdr: number;
  refundedIdr: number;
  status: 'PENDING' | 'SECURED' | 'EXPIRED' | 'FAILED' | 'REFUNDED' | 'PARTIALLY_REFUNDED';
  checkoutUrl: string | null;
  expiresAt: Date | null;
  securedAt: Date | null;
  failureReason: string | null;
  idempotencyKey: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export async function loadPayment(db: Db, id: string, opts: { forUpdate?: boolean } = {}): Promise<PaymentRow | null> {
  const rows = opts.forUpdate
    ? await db<Record<string, unknown>[]>`SELECT * FROM payments WHERE id = ${id} FOR UPDATE`
    : await db<Record<string, unknown>[]>`SELECT * FROM payments WHERE id = ${id}`;
  return rows[0] ? camel<PaymentRow>(rows[0]) : null;
}

export async function findPaymentByProviderRef(db: Db, provider: string, providerRef: string): Promise<PaymentRow | null> {
  const rows = await db<Record<string, unknown>[]>`
    SELECT * FROM payments WHERE provider = ${provider} AND provider_ref = ${providerRef} ORDER BY created_at DESC LIMIT 1`;
  return rows[0] ? camel<PaymentRow>(rows[0]) : null;
}

export async function paymentsForTx(db: Db, transactionId: string): Promise<PaymentRow[]> {
  const rows = await db<Record<string, unknown>[]>`SELECT * FROM payments WHERE transaction_id = ${transactionId} ORDER BY created_at`;
  return rows.map((r) => camel<PaymentRow>(r));
}

export async function securedPaymentsForTx(db: Db, transactionId: string): Promise<PaymentRow[]> {
  const rows = await db<Record<string, unknown>[]>`
    SELECT * FROM payments WHERE transaction_id = ${transactionId} AND status IN ('SECURED','PARTIALLY_REFUNDED')
     ORDER BY created_at`;
  return rows.map((r) => camel<PaymentRow>(r));
}

export function paymentView(p: PaymentRow, opts: { includeCheckoutUrl: boolean }) {
  return {
    id: p.id,
    purpose: p.purpose,
    status: p.status,
    amountIdr: p.amountIdr,
    refundedIdr: p.refundedIdr,
    channel: p.channel,
    provider: p.provider,
    providerEnv: p.providerEnv,
    sandbox: p.providerEnv !== 'LIVE',
    checkoutUrl: opts.includeCheckoutUrl && p.status === 'PENDING' ? p.checkoutUrl : null,
    expiresAt: p.expiresAt ? p.expiresAt.toISOString() : null,
    securedAt: p.securedAt ? p.securedAt.toISOString() : null,
    failureReason: p.failureReason,
    createdAt: p.createdAt.toISOString(),
  };
}
