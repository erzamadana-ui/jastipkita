/**
 * Money-group test fixtures (NOT a test file). Creates MATCHED transactions directly in the DB the way the
 * marketplace offer-acceptance does (request + trip + accepted offer + transaction → transition MATCHED),
 * FX rates, files, payout accounts, and small API helpers that re-issue access tokens when the test clock
 * moves past their 15-minute lifetime.
 */
import { randomBytes as nodeRandomBytes, createHash } from 'node:crypto';
import { issueSession } from '../../services/session';
import type { TestContext, TestUser } from '../../../test/helpers';

export interface Party extends TestUser {
  tokenIssuedAt: number;
}

export interface Parties {
  buyer: Party;
  traveler: Party;
  payoutAccountId: string;
}

export async function setupParties(t: TestContext, opts: { buyerKyc?: number; travelerKyc?: number; payoutAccount?: boolean } = {}): Promise<Parties> {
  const buyer = await t.createUser({ kycLevel: opts.buyerKyc ?? 3, displayName: 'Penitip Uji' });
  const traveler = await t.createUser({ kycLevel: opts.travelerKyc ?? 4, mode: 'TRAVELER', displayName: 'Traveler Uji' });
  const now = t.clock.now().getTime();
  let payoutAccountId = '';
  if (opts.payoutAccount !== false) payoutAccountId = await createPayoutAccount(t, traveler.id);
  return { buyer: { ...buyer, tokenIssuedAt: now }, traveler: { ...traveler, tokenIssuedAt: now }, payoutAccountId };
}

export async function createPayoutAccount(t: TestContext, userId: string, opts: { verified?: boolean; accountNumber?: string } = {}): Promise<string> {
  const id = crypto.randomUUID();
  const number = opts.accountNumber ?? `1234${Math.floor(Math.random() * 1e6).toString().padStart(6, '0')}`;
  const enc = await t.deps.crypto.encrypt(number, `payout_accounts.account_number:${id}`);
  const hash = await t.deps.crypto.hashIdentifier('bank_account', `BCA:${number}`);
  const verified = opts.verified ?? true;
  await t.adminSql`
    INSERT INTO payout_accounts (id, user_id, bank_code, account_number_enc, account_number_hash, account_mask, holder_name, enc_key_id,
                                 verification_status, verified_at, is_default)
    VALUES (${id}, ${userId}, 'BCA', ${Buffer.from(enc)}, ${Buffer.from(hash)}, ${`****${number.slice(-4)}`}, 'TRAVELER UJI',
            ${t.deps.crypto.activeKeyId}, ${verified ? 'VERIFIED' : 'UNVERIFIED'}, ${verified ? t.clock.now() : null}, true)`;
  return id;
}

export async function seedFx(t: TestContext, rates: Record<string, string> = { JPY: '107.5', USD: '17900' }) {
  const asOf = new Date(t.clock.now().getTime() - 3600_000);
  for (const [ccy, rate] of Object.entries(rates)) {
    await t.adminSql`
      INSERT INTO fx_rates (base, quote, rate, source, as_of) VALUES (${ccy}, 'IDR', ${rate}, 'frankfurter', ${asOf})
      ON CONFLICT DO NOTHING`;
  }
}

export interface MatchedTx {
  id: string;
  number: string;
  requestId: string;
  tripId: string;
  offerId: string;
}

export interface TxOptions {
  unitPriceMinor?: number;
  currency?: string;
  quantity?: number;
  categoryCode?: string;
  productName?: string;
  merchantName?: string;
  travelerFeeIdr?: number;
  maxBudgetIdr?: number | null;
  arrivalInDays?: number;
}

export async function createMatchedTx(t: TestContext, p: Parties, o: TxOptions = {}): Promise<MatchedTx> {
  const today = new Date(t.clock.now().getTime() + 7 * 3600_000).toISOString().slice(0, 10);
  const arrival = new Date(t.clock.now().getTime() + 7 * 3600_000 + (o.arrivalInDays ?? 0) * 86400_000).toISOString().slice(0, 10);
  const [req] = await t.adminSql<{ id: string }[]>`
    INSERT INTO requests (buyer_id, source_type, product_name, merchant_name, merchant_country, category_code, quantity,
                          unit_price_minor, price_currency, max_budget_idr, destination_country, destination_city, status)
    VALUES (${p.buyer.id}, 'MANUAL', ${o.productName ?? 'Figur Gundam RX-78 Master Grade'}, ${o.merchantName ?? 'Yodobashi Camera'}, 'JP',
            ${o.categoryCode ?? 'TOYS_HOBBIES'}, ${o.quantity ?? 1}, ${o.unitPriceMinor ?? 20000}, ${o.currency ?? 'JPY'},
            ${o.maxBudgetIdr === undefined ? 5_000_000 : o.maxBudgetIdr}, 'ID', 'Jakarta', 'OPEN')
    RETURNING id`;
  const [trip] = await t.adminSql<{ id: string }[]>`
    INSERT INTO trips (traveler_id, origin_country, origin_city, destination_country, destination_city, departure_date, arrival_date,
                       capacity_kg, fee_type, fee_value)
    VALUES (${p.traveler.id}, 'JP', 'Tokyo', 'ID', 'Jakarta', ${today}, ${arrival}, 10, 'FIXED', ${o.travelerFeeIdr ?? 150000})
    RETURNING id`;
  const [offer] = await t.adminSql<{ id: string }[]>`
    INSERT INTO offers (request_id, trip_id, traveler_id, initiated_by, traveler_fee_idr, status, responded_at)
    VALUES (${req!.id}, ${trip!.id}, ${p.traveler.id}, 'TRAVELER', ${o.travelerFeeIdr ?? 150000}, 'ACCEPTED', now())
    RETURNING id`;
  const [tx] = await t.adminSql<{ id: string; number: string }[]>`
    INSERT INTO transactions (request_id, trip_id, offer_id, buyer_id, traveler_id, item_currency, quantity)
    VALUES (${req!.id}, ${trip!.id}, ${offer!.id}, ${p.buyer.id}, ${p.traveler.id}, ${o.currency ?? 'JPY'}, ${o.quantity ?? 1})
    RETURNING id, number`;
  await t.adminSql`SELECT transition_transaction(${tx!.id}, 1, 'MATCHED', 'BUYER', ${p.buyer.id}, 'offer accepted (fixture)')`;
  return { id: tx!.id, number: tx!.number, requestId: req!.id, tripId: trip!.id, offerId: offer!.id };
}

export async function setTripStatus(t: TestContext, tripId: string, path: string[]) {
  for (const to of path) {
    const [row] = await t.adminSql<{ version: number }[]>`SELECT version FROM trips WHERE id = ${tripId}`;
    await t.adminSql`SELECT transition_trip(${tripId}, ${row!.version}, ${to}, 'SYSTEM', NULL, 'fixture')`;
  }
}

export async function createFile(
  t: TestContext,
  ownerId: string,
  purpose: 'RECEIPT' | 'PRODUCT_PHOTO' | 'EVIDENCE' | 'DELIVERY_PROOF',
  opts: { content?: string; mime?: string } = {},
): Promise<string> {
  const content = opts.content ?? nodeRandomBytes(16).toString('hex');
  const sha = createHash('sha256').update(content).digest();
  const [f] = await t.adminSql<{ id: string }[]>`
    INSERT INTO files (owner_id, purpose, storage_provider, storage_key, mime, size_bytes, sha256, scan_status, scanned_at)
    VALUES (${ownerId}, ${purpose}, 'MOCK', ${`test/${crypto.randomUUID()}`}, ${opts.mime ?? 'image/jpeg'}, ${content.length}, ${sha}, 'CLEAN', now())
    RETURNING id`;
  return f!.id;
}

/** Calls the API as `user`, re-issuing an access token when the test clock outran it. */
export async function call(
  t: TestContext,
  user: Party,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  if (t.clock.now().getTime() - user.tokenIssuedAt > 10 * 60_000) {
    const s = await issueSession(t.deps, t.sql, user.id);
    user.accessToken = s.accessToken;
    user.tokenIssuedAt = t.clock.now().getTime();
  }
  return t.request(method, path, { token: user.accessToken, ...(body !== undefined ? { body } : {}), headers });
}

export const idem = () => ({ 'idempotency-key': crypto.randomUUID() });

export async function providerRef(t: TestContext, paymentId: string): Promise<string> {
  const [p] = await t.adminSql<{ provider_ref: string }[]>`SELECT provider_ref FROM payments WHERE id = ${paymentId}`;
  return p!.provider_ref;
}

/** Sends the mock provider webhook for a payment (optionally tampered) through the real webhook route. */
export async function payViaWebhook(
  t: TestContext,
  paymentId: string,
  opts: { status?: 'SUCCEEDED' | 'EXPIRED' | 'FAILED'; amount?: number; channel?: string; token?: string } = {},
) {
  const ref = await providerRef(t, paymentId);
  const body = t.payment.buildPaymentWebhook(ref, opts.status ?? 'SUCCEEDED', {
    ...(opts.amount !== undefined ? { amount: opts.amount } : {}),
    ...(opts.channel ? { channel: opts.channel } : {}),
  });
  const res = await t.request('POST', '/v1/webhooks/payments/mock', {
    rawBody: body,
    headers: { 'content-type': 'application/json', 'x-callback-token': opts.token ?? 'mock-webhook-token' },
  });
  return { res, body };
}

export async function txStatus(t: TestContext, id: string): Promise<string> {
  const [r] = await t.adminSql<{ status: string }[]>`SELECT status FROM transactions WHERE id = ${id}`;
  return r!.status;
}

/** Escrow per bucket for one transaction (credit-positive, v_transaction_ledger). */
export async function txLedger(t: TestContext, id: string): Promise<Record<string, number>> {
  const rows = await t.adminSql<{ bucket: string; net_credit: string }[]>`
    SELECT bucket, net_credit::text FROM v_transaction_ledger WHERE transaction_id = ${id}`;
  return Object.fromEntries(rows.map((r) => [r.bucket, Number(r.net_credit)]));
}

/** Normal-side balance of an account from the ledger_balances view. */
export async function accountBalance(t: TestContext, bucket: string, owner: string | null = null): Promise<number> {
  const rows = owner
    ? await t.adminSql<{ balance: string }[]>`SELECT balance::text FROM ledger_balances WHERE bucket = ${bucket} AND owner_user_id = ${owner}`
    : await t.adminSql<{ balance: string }[]>`SELECT balance::text FROM ledger_balances WHERE bucket = ${bucket} AND owner_user_id IS NULL`;
  return rows.reduce((s, r) => s + Number(r.balance), 0);
}

/** quote → checkout → mock webhook (SUCCEEDED). Returns ids and the quote body. */
export async function quoteAndPay(
  t: TestContext,
  p: Parties,
  tx: MatchedTx,
  opts: { channel?: string; payChannel?: string; quoteBody?: Record<string, unknown> } = {},
) {
  const q = await call(t, p.buyer, 'POST', `/v1/transactions/${tx.id}/quote`, { channel: opts.channel ?? 'QRIS', ...(opts.quoteBody ?? {}) });
  if (q.status !== 201) throw new Error(`quote failed: ${JSON.stringify(q.body)}`);
  const co = await call(t, p.buyer, 'POST', `/v1/transactions/${tx.id}/checkout`, { quoteId: q.body.quoteId, acknowledgeRestricted: true }, idem());
  if (co.status !== 201) throw new Error(`checkout failed: ${JSON.stringify(co.body)}`);
  const { res } = await payViaWebhook(t, co.body.paymentId, { channel: opts.payChannel ?? opts.channel ?? 'QRIS' });
  if (res.status !== 200) throw new Error(`webhook failed: ${JSON.stringify(res.body)}`);
  return { quote: q.body, checkout: co.body };
}

export function lineAmount(quote: { lines: { type: string; amountIdr: number }[] }, type: string): number {
  return quote.lines.find((l) => l.type === type)?.amountIdr ?? 0;
}
