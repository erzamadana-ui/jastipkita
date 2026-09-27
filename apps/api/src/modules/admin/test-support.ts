/**
 * Admin test fixtures (NOT a test file): admins per role with/without a fresh MFA step-up, request helpers that
 * re-issue tokens when the test clock moves, idempotency headers.
 */
import { issueSession } from '../../services/session';
import type { TestContext, TestUser } from '../../../test/helpers';
import { call, createFile, createMatchedTx, type Parties, quoteAndPay, seedFx, setupParties, txLedger } from '../transactions/test-fixtures';

export interface Admin extends TestUser {
  roles: string[];
  mfa: boolean;
  issuedAt: number;
}

export async function createAdmin(t: TestContext, roles: string[], opts: { mfa?: boolean; displayName?: string } = {}): Promise<Admin> {
  const u = await t.createUser({ kycLevel: 2, roles, mfa: opts.mfa ?? true, displayName: opts.displayName ?? `Admin ${roles.join('+')}` });
  return { ...u, roles, mfa: opts.mfa ?? true, issuedAt: t.clock.now().getTime() };
}

/** Calls the API as an admin (fresh token with MFA when the clock moved > 10 min). */
export async function as(
  t: TestContext,
  who: Admin | (TestUser & { issuedAt?: number; mfa?: boolean }),
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const issued = (who as Admin).issuedAt ?? 0;
  if (t.clock.now().getTime() - issued > 10 * 60_000) {
    const s = await issueSession(t.deps, t.sql, who.id, { mfaAt: (who as Admin).mfa ? Math.floor(t.clock.now().getTime() / 1000) : null });
    who.accessToken = s.accessToken;
    (who as Admin).issuedAt = t.clock.now().getTime();
  }
  return t.request(method, path, { token: who.accessToken, ...(body !== undefined ? { body } : {}), headers });
}

export const idem = () => ({ 'idempotency-key': crypto.randomUUID() });

export async function auditRows(t: TestContext, action: string, entityId?: string) {
  return entityId
    ? t.adminSql<{ actor_id: string | null; before: unknown; after: unknown; meta: Record<string, unknown> }[]>`
        SELECT actor_id, before, after, meta FROM audit_logs WHERE action = ${action} AND entity_id = ${entityId} ORDER BY id`
    : t.adminSql<{ actor_id: string | null; before: unknown; after: unknown; meta: Record<string, unknown> }[]>`
        SELECT actor_id, before, after, meta FROM audit_logs WHERE action = ${action} ORDER BY id`;
}

/**
 * A paid SafePay transaction advanced to PURCHASED through the real API (quote → checkout → mock webhook →
 * price-check → purchase proof). Escrow holds the full payment.
 */
export async function purchasedTx(t: TestContext, opts: { parties?: Parties } = {}) {
  await seedFx(t);
  const p = opts.parties ?? (await setupParties(t));
  const tx = await createMatchedTx(t, p);
  const { quote } = await quoteAndPay(t, p, tx);
  const pc = await call(t, p.traveler, 'POST', `/v1/transactions/${tx.id}/price-check`, { actualUnitPriceMinor: 20000, currency: 'JPY' });
  if (pc.status !== 200) throw new Error(`price-check failed: ${JSON.stringify(pc.body)}`);
  const receipt = await createFile(t, p.traveler.id, 'RECEIPT');
  const photo = await createFile(t, p.traveler.id, 'PRODUCT_PHOTO');
  const pp = await call(t, p.traveler, 'POST', `/v1/transactions/${tx.id}/purchase-proof`, {
    receiptFileId: receipt,
    productPhotoFileIds: [photo],
    merchantName: 'Yodobashi Camera Akiba',
    actualPriceMinor: 20000,
    currency: 'JPY',
    purchasedAt: t.clock.now().toISOString(),
  });
  if (pp.status !== 201 || pp.body.transactionStatus !== 'PURCHASED') throw new Error(`purchase-proof failed: ${JSON.stringify(pp.body)}`);
  return { p, tx, quote: quote as { totalIdr: number; lines: { type: string; amountIdr: number }[] } };
}

/** Sum of every journal's debits and credits for a transaction must match; returns escrow buckets. */
export async function ledgerCheck(t: TestContext, transactionId: string) {
  const unbalanced = await t.adminSql`
    SELECT j.id FROM ledger_journals j JOIN ledger_entries e ON e.journal_id = j.id WHERE j.transaction_id = ${transactionId}
     GROUP BY j.id HAVING sum(CASE WHEN e.direction = 'DEBIT' THEN e.amount ELSE -e.amount END) <> 0`;
  return { balanced: unbalanced.length === 0, buckets: await txLedger(t, transactionId) };
}
