/**
 * Traveler payouts (§15.7): scheduling at completion (or for cancellation compensation), the payout
 * processor (PAYOUT_CLEAR guard: risk decision, no open dispute, verified payout account), ledger
 * PAYOUT_PAID, retries/hold, and the traveler's earnings view.
 */
import { payoutFsm, type RiskDecision } from '@jastipkita/core';
import type { AppDeps, AuthContext } from '../../context';
import { camel, type Db, type TxSql } from '../../db/sql';
import type { Bytes } from '../../lib/crypto';
import { providerEnv } from '../../providers/payment';
import { audit } from '../../services/audit';
import { emitEvent } from '../../services/outbox';
import { postJournal } from '../ledger/service';
import { moneyPolicy, setDbActor, type TxRow } from '../transactions/common';

export interface PayoutRow {
  id: string;
  number: string;
  travelerId: string;
  transactionId: string | null;
  payoutAccountId: string;
  amountIdr: number;
  feeIdr: number;
  netIdr: number;
  status: 'SCHEDULED' | 'ON_HOLD' | 'PROCESSING' | 'PAID' | 'FAILED' | 'CANCELLED';
  holdReason: string | null;
  scheduledFor: Date;
  provider: string;
  providerEnv: string;
  providerRef: string | null;
  paidAt: Date | null;
  failureReason: string | null;
  idempotencyKey: string | null;
  attempts: number;
  createdAt: Date;
}

async function loadPayout(db: Db, id: string, forUpdate = false): Promise<PayoutRow | null> {
  const rows = forUpdate
    ? await db<Record<string, unknown>[]>`SELECT * FROM payouts WHERE id = ${id} FOR UPDATE`
    : await db<Record<string, unknown>[]>`SELECT * FROM payouts WHERE id = ${id}`;
  return rows[0] ? camel<PayoutRow>(rows[0]) : null;
}

/** Default (or most recent) active payout account of the traveler. */
export async function travelerPayoutAccount(db: Db, travelerId: string) {
  const [row] = await db<{ id: string; bank_code: string; account_mask: string; verification_status: string; is_default: boolean }[]>`
    SELECT id, bank_code, account_mask, verification_status, is_default FROM payout_accounts
     WHERE user_id = ${travelerId} AND disabled_at IS NULL AND account_number_enc IS NOT NULL
     ORDER BY is_default DESC, (verification_status = 'VERIFIED') DESC, created_at DESC LIMIT 1`;
  return row ?? null;
}

/**
 * Risk decision for PAYOUT_CLEAR: HOLD when the transaction carries a payout hold flag (flagged proof,
 * PIN brute force, amount mismatch); otherwise the most severe OPEN/IN_REVIEW risk review on the
 * transaction, its payments or purchase proofs; ALLOW when none.
 */
export async function payoutRiskDecision(db: Db, tx: Pick<TxRow, 'id' | 'payoutHoldReason'>): Promise<{ decision: RiskDecision; reason: string | null }> {
  if (tx.payoutHoldReason) return { decision: 'HOLD', reason: tx.payoutHoldReason };
  const [r] = await db<{ decision: RiskDecision }[]>`
    SELECT a.decision FROM risk_reviews rv JOIN risk_assessments a ON a.id = rv.assessment_id
     WHERE rv.status IN ('OPEN','IN_REVIEW')
       AND ((rv.subject_type = 'TRANSACTION' AND rv.subject_id = ${tx.id})
         OR (rv.subject_type = 'PAYMENT' AND rv.subject_id IN (SELECT id FROM payments WHERE transaction_id = ${tx.id}))
         OR (rv.subject_type = 'PURCHASE_PROOF' AND rv.subject_id IN (SELECT id FROM purchase_proofs WHERE transaction_id = ${tx.id})))
     ORDER BY CASE a.decision WHEN 'BLOCK' THEN 4 WHEN 'HOLD' THEN 3 WHEN 'REVIEW' THEN 2 ELSE 1 END DESC LIMIT 1`;
  if (!r) return { decision: 'ALLOW', reason: null };
  return { decision: r.decision, reason: r.decision === 'ALLOW' ? null : `RISK_${r.decision}` };
}

export async function openDispute(db: Db, transactionId: string): Promise<boolean> {
  const [d] = await db`SELECT 1 FROM disputes WHERE transaction_id = ${transactionId} AND status <> 'CLOSED' LIMIT 1`;
  return !!d;
}

/**
 * Schedules a payout (inside the caller's DB transaction). Returns null when the traveler has no payout
 * account yet. A risk hold puts it straight ON_HOLD (SCHEDULED → ON_HOLD, reason recorded).
 */
export async function schedulePayout(
  deps: AppDeps,
  db: TxSql,
  tx: TxRow,
  input: { amountIdr: number; kind: 'EARNING' | 'COMPENSATION' | 'REMAINDER' },
): Promise<PayoutRow | null> {
  if (!tx.travelerId || input.amountIdr <= 0) return null;
  const key = `payout:${tx.id}`;
  const [existing] = await db<{ id: string }[]>`SELECT id FROM payouts WHERE idempotency_key = ${key}`;
  if (existing) return loadPayout(db, existing.id);
  const account = await travelerPayoutAccount(db, tx.travelerId);
  if (!account) return null;
  const policy = await moneyPolicy(db);
  const now = deps.clock.now();
  const provider = deps.providers.payment;
  const [ins] = await db<{ id: string }[]>`
    INSERT INTO payouts (traveler_id, transaction_id, payout_account_id, amount_idr, fee_idr, status, scheduled_for,
                         provider, provider_env, idempotency_key)
    VALUES (${tx.travelerId}, ${tx.id}, ${account.id}, ${input.amountIdr}, 0, 'SCHEDULED',
            ${new Date(now.getTime() + policy.payoutDelayHours * 3600_000)}, ${provider.name}, ${providerEnv(provider)}, ${key})
    RETURNING id`;
  let payout = (await loadPayout(db, ins!.id))!;
  const risk = await payoutRiskDecision(db, tx);
  const payload = { payoutId: payout.id, payoutNumber: payout.number, travelerId: tx.travelerId, transactionId: tx.id, amountIdr: payout.amountIdr, kind: input.kind };
  if (risk.decision === 'HOLD' || risk.decision === 'BLOCK') {
    const reason = risk.reason ?? `RISK_${risk.decision}`;
    await db`UPDATE payouts SET status = 'ON_HOLD', hold_reason = ${reason} WHERE id = ${payout.id}`;
    payout = (await loadPayout(db, payout.id))!;
    await emitEvent(db, 'payout', payout.id, 'payout.on_hold', { ...payload, reason });
  } else {
    await emitEvent(db, 'payout', payout.id, 'payout.scheduled', { ...payload, scheduledFor: payout.scheduledFor.toISOString() });
  }
  await audit(db, {
    actorType: 'SYSTEM',
    actorId: null,
    action: 'payout.scheduled',
    entityType: 'payout',
    entityId: payout.id,
    after: { status: payout.status, amountIdr: payout.amountIdr },
    meta: { transactionId: tx.id, kind: input.kind, holdReason: payout.holdReason },
  });
  return payout;
}

/**
 * Sweep: earnings credited to TRAVELER_EARNING without a live payout (e.g. the traveler had no payout account at
 * completion/cancellation time) get a payout once an account exists. Never duplicates (unique live payout per tx).
 */
export async function scheduleOwedPayouts(deps: AppDeps): Promise<{ scheduled: number }> {
  const rows = await deps.sql<{ transaction_id: string; net_credit: number }[]>`
    SELECT l.transaction_id, l.net_credit FROM v_transaction_ledger l
     WHERE l.bucket = 'TRAVELER_EARNING' AND l.currency = 'IDR' AND l.net_credit > 0
       AND NOT EXISTS (SELECT 1 FROM payouts p WHERE p.transaction_id = l.transaction_id)
     LIMIT 100`;
  let scheduled = 0;
  for (const r of rows) {
    const ok = await deps.sql.begin(async (db) => {
      const { loadTx } = await import('../transactions/common');
      const tx = await loadTx(db, r.transaction_id, { forUpdate: true });
      if (!tx) return false;
      return (await schedulePayout(deps, db, tx, { amountIdr: Number(r.net_credit), kind: 'EARNING' })) !== null;
    });
    if (ok) scheduled++;
  }
  return { scheduled };
}

// ------------------------------------------------------------------ processor

async function decryptAccountNumber(deps: AppDeps, accountId: string, blob: Bytes): Promise<string> {
  // AAD convention (identity group): "<table>.<col>:<id>". Accept both spellings + legacy no-AAD blobs.
  const candidates = [`payout_accounts.account_number:${accountId}`, `payout_accounts.account_number_enc:${accountId}`, undefined];
  let lastErr: unknown;
  for (const aad of candidates) {
    try {
      return await deps.crypto.decryptString(blob, aad);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('cannot decrypt payout account');
}

export interface PayoutRunResult {
  paid: number;
  held: number;
  failed: number;
  skipped: number;
}

/**
 * SYSTEM auto-release (§15.7 ON_HOLD → SCHEDULED, guard HOLD_RELEASE for SYSTEM): a payout the processor itself held
 * because a dispute was open (`hold_reason = DISPUTE_OPEN`, `held_by IS NULL`) goes back to SCHEDULED once every dispute
 * of the transaction is CLOSED (after the appeal window or an admin close), no risk review on the transaction, its payments
 * or proofs is OPEN/IN_REVIEW, and the transaction carries no payout hold flag. Anything else keeps the manual
 * maker-checker release (POST /v1/admin/payouts/{id}/release).
 */
export async function releaseClearedDisputeHolds(deps: AppDeps, filter: { transactionId?: string | undefined } = {}): Promise<number> {
  const now = deps.clock.now();
  const candidates = await deps.sql<{ id: string }[]>`
    SELECT p.id FROM payouts p JOIN transactions t ON t.id = p.transaction_id
     WHERE p.status = 'ON_HOLD' AND p.hold_reason = 'DISPUTE_OPEN' AND p.held_by IS NULL AND t.payout_hold_reason IS NULL
       AND NOT EXISTS (SELECT 1 FROM disputes d WHERE d.transaction_id = p.transaction_id AND d.status <> 'CLOSED')
       ${filter.transactionId ? deps.sql`AND p.transaction_id = ${filter.transactionId}` : deps.sql``}
     ORDER BY p.created_at LIMIT 100`;
  let released = 0;
  for (const { id } of candidates) {
    const ok = await deps.sql.begin(async (db) => {
      await setDbActor(db, 'SYSTEM', null);
      const [row] = await db<{ id: string; number: string; status: string; hold_reason: string | null; held_by: string | null; traveler_id: string; transaction_id: string; amount_idr: number; scheduled_for: Date }[]>`
        SELECT id, number, status, hold_reason, held_by, traveler_id, transaction_id, amount_idr, scheduled_for FROM payouts WHERE id = ${id} FOR UPDATE SKIP LOCKED`;
      if (!row || row.status !== 'ON_HOLD' || row.hold_reason !== 'DISPUTE_OPEN' || row.held_by) return false;
      const [t] = await db<{ payout_hold_reason: string | null }[]>`SELECT payout_hold_reason FROM transactions WHERE id = ${row.transaction_id} FOR UPDATE`;
      const [openDisputes] = await db<{ n: number }[]>`SELECT count(*)::int AS n FROM disputes WHERE transaction_id = ${row.transaction_id} AND status <> 'CLOSED'`;
      const [openReviews] = await db<{ n: number }[]>`
        SELECT count(*)::int AS n FROM risk_reviews rv
         WHERE rv.status IN ('OPEN','IN_REVIEW')
           AND ((rv.subject_type = 'TRANSACTION' AND rv.subject_id = ${row.transaction_id})
             OR (rv.subject_type = 'PAYMENT' AND rv.subject_id IN (SELECT id FROM payments WHERE transaction_id = ${row.transaction_id}))
             OR (rv.subject_type = 'PURCHASE_PROOF' AND rv.subject_id IN (SELECT id FROM purchase_proofs WHERE transaction_id = ${row.transaction_id})))`;
      const eligible = !t?.payout_hold_reason && (openDisputes?.n ?? 0) === 0 && (openReviews?.n ?? 0) === 0;
      const check = payoutFsm.canTransition('ON_HOLD', 'SCHEDULED', 'SYSTEM', { autoReleaseEligible: eligible });
      if (!check.ok) return false;
      const scheduledFor = row.scheduled_for > now ? row.scheduled_for : now;
      await db`UPDATE payouts SET status = 'SCHEDULED', hold_reason = NULL, released_at = ${now}, scheduled_for = ${scheduledFor} WHERE id = ${id}`;
      await emitEvent(db, 'payout', id, 'payout.scheduled', {
        payoutId: id,
        payoutNumber: row.number,
        travelerId: row.traveler_id,
        transactionId: row.transaction_id,
        amountIdr: Number(row.amount_idr),
        scheduledFor: scheduledFor.toISOString(),
        kind: 'HOLD_AUTO_RELEASED',
      });
      await audit(db, { actorType: 'SYSTEM', actorId: null, action: 'payout.auto_released', entityType: 'payout', entityId: id, before: { status: 'ON_HOLD', holdReason: 'DISPUTE_OPEN' }, after: { status: 'SCHEDULED' }, meta: { transactionId: row.transaction_id } });
      return true;
    });
    if (ok) released++;
  }
  return released;
}

export async function processPayouts(deps: AppDeps, filter: { transactionId?: string | undefined } = {}): Promise<PayoutRunResult> {
  const policy = await moneyPolicy(deps.sql);
  await releaseClearedDisputeHolds(deps, filter);
  const now = deps.clock.now();
  const due = await deps.sql<{ id: string }[]>`
    SELECT id FROM payouts WHERE status = 'SCHEDULED' AND scheduled_for <= ${now}
      ${filter.transactionId ? deps.sql`AND transaction_id = ${filter.transactionId}` : deps.sql``}
     ORDER BY scheduled_for LIMIT 100`;
  const res: PayoutRunResult = { paid: 0, held: 0, failed: 0, skipped: 0 };
  for (const { id } of due) {
    const r = await processOnePayout(deps, id, policy.payoutMaxSystemRetries);
    if (r === 'PAID') res.paid++;
    else if (r === 'ON_HOLD') res.held++;
    else if (r === 'FAILED') res.failed++;
    else res.skipped++;
  }
  return res;
}

async function processOnePayout(deps: AppDeps, payoutId: string, maxRetries: number): Promise<'PAID' | 'ON_HOLD' | 'FAILED' | 'PENDING' | 'SKIPPED'> {
  const claim = await deps.sql.begin(async (db) => {
    await setDbActor(db, 'SYSTEM', null);
    const [row] = await db<Record<string, unknown>[]>`SELECT * FROM payouts WHERE id = ${payoutId} FOR UPDATE SKIP LOCKED`;
    if (!row) return { kind: 'SKIP' as const };
    const p = camel<PayoutRow>(row);
    if (p.status !== 'SCHEDULED') return { kind: 'SKIP' as const };
    const [acc] = await db<{ id: string; bank_code: string; account_number_enc: Buffer | null; holder_name: string; verification_status: string; disabled_at: Date | null }[]>`
      SELECT id, bank_code, account_number_enc, holder_name, verification_status, disabled_at FROM payout_accounts WHERE id = ${p.payoutAccountId}`;
    const txRows = p.transactionId ? await db<Record<string, unknown>[]>`SELECT id, payout_hold_reason FROM transactions WHERE id = ${p.transactionId}` : [];
    const txInfo = txRows[0] ? { id: String(txRows[0].id), payoutHoldReason: (txRows[0].payout_hold_reason as string | null) ?? null } : null;
    const risk = txInfo ? await payoutRiskDecision(db, txInfo) : { decision: 'ALLOW' as RiskDecision, reason: null };
    const dispute = txInfo ? await openDispute(db, txInfo.id) : false;
    const verified = !!acc && acc.verification_status === 'VERIFIED' && !acc.disabled_at && !!acc.account_number_enc;
    const check = payoutFsm.canTransition('SCHEDULED', 'PROCESSING', 'SYSTEM', { riskDecision: risk.decision, disputeOpen: dispute, bankAccountVerified: verified });
    if (!check.ok) {
      if (check.code === 'BANK_ACCOUNT_UNVERIFIED') {
        deps.logger.warn('payout.account_unverified', { payoutId: p.id });
        return { kind: 'SKIP' as const };
      }
      const reason = check.code === 'DISPUTE_OPEN' ? 'DISPUTE_OPEN' : risk.reason ?? check.code;
      await db`UPDATE payouts SET status = 'ON_HOLD', hold_reason = ${reason} WHERE id = ${p.id}`;
      await emitEvent(db, 'payout', p.id, 'payout.on_hold', { payoutId: p.id, travelerId: p.travelerId, transactionId: p.transactionId, amountIdr: p.amountIdr, reason });
      await audit(db, { actorType: 'SYSTEM', actorId: null, action: 'payout.on_hold', entityType: 'payout', entityId: p.id, meta: { reason } });
      return { kind: 'HOLD' as const };
    }
    const accountNumber = await decryptAccountNumber(deps, acc!.id, new Uint8Array(acc!.account_number_enc!));
    await db`UPDATE payouts SET status = 'PROCESSING', attempts = attempts + 1, failure_reason = NULL WHERE id = ${p.id}`;
    return { kind: 'GO' as const, payout: p, bankCode: acc!.bank_code, accountNumber, holderName: acc!.holder_name };
  });
  if (claim.kind === 'SKIP') return 'SKIPPED';
  if (claim.kind === 'HOLD') return 'ON_HOLD';

  let outcome: { status: 'SUCCEEDED' | 'PENDING' | 'FAILED'; providerRef?: string; reason?: string };
  try {
    const r = await deps.providers.payment.payout({
      referenceId: claim.payout.number,
      amountIdr: claim.payout.netIdr,
      bankCode: claim.bankCode,
      accountNumber: claim.accountNumber,
      accountHolderName: claim.holderName,
      description: `Pembayaran JastipKita ${claim.payout.number}`,
      idempotencyKey: `payout:${claim.payout.id}`,
    });
    outcome = { status: r.status, providerRef: r.providerRef, ...(r.status === 'FAILED' ? { reason: 'DISBURSEMENT_FAILED' } : {}) };
  } catch (err) {
    outcome = { status: 'FAILED', reason: `PROVIDER_ERROR: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}` };
  }

  return deps.sql.begin(async (db) => {
    await setDbActor(db, 'SYSTEM', null);
    const p = (await loadPayout(db, claim.payout.id, true))!;
    if (p.status !== 'PROCESSING') return 'SKIPPED' as const;
    if (outcome.status === 'SUCCEEDED') {
      await markPayoutPaid(deps, db, p, outcome.providerRef ?? null);
      return 'PAID' as const;
    }
    if (outcome.status === 'PENDING') {
      if (outcome.providerRef) await db`UPDATE payouts SET provider_ref = ${outcome.providerRef} WHERE id = ${p.id}`;
      return 'PENDING' as const;
    }
    await markPayoutFailed(deps, db, p, outcome.reason ?? 'FAILED', maxRetries);
    return 'FAILED' as const;
  });
}

export async function markPayoutPaid(deps: AppDeps, db: TxSql, p: PayoutRow, providerRef: string | null): Promise<void> {
  const now = deps.clock.now();
  await db`UPDATE payouts SET status = 'PAID', paid_at = ${now}, provider_ref = coalesce(${providerRef}, provider_ref) WHERE id = ${p.id}`;
  await postJournal(db, {
    kind: 'PAYOUT_PAID',
    description: `Payout ${p.number} to traveler`,
    transactionId: p.transactionId,
    idempotencyKey: `payout-paid:${p.id}`,
    refs: { payoutId: p.id },
    entries: [
      { bucket: 'TRAVELER_EARNING', owner: p.travelerId, direction: 'DEBIT', amount: p.amountIdr },
      { bucket: 'PROVIDER_CASH', direction: 'CREDIT', amount: p.netIdr },
      { bucket: 'PAYMENT_FEE', direction: 'CREDIT', amount: p.feeIdr, memo: 'payout fee withheld' },
    ],
  });
  await emitEvent(db, 'payout', p.id, 'payout.paid', { payoutId: p.id, payoutNumber: p.number, travelerId: p.travelerId, transactionId: p.transactionId, amountIdr: p.netIdr });
  await audit(db, { actorType: 'SYSTEM', actorId: null, action: 'payout.paid', entityType: 'payout', entityId: p.id, before: { status: 'PROCESSING' }, after: { status: 'PAID' }, meta: { amountIdr: p.netIdr } });
}

async function markPayoutFailed(deps: AppDeps, db: TxSql, p: PayoutRow, reason: string, maxRetries: number): Promise<void> {
  await db`UPDATE payouts SET status = 'FAILED', failure_reason = ${reason} WHERE id = ${p.id}`;
  if (p.attempts < maxRetries) {
    const backoffMin = 15 * 2 ** Math.max(0, p.attempts - 1);
    await db`UPDATE payouts SET status = 'SCHEDULED', scheduled_for = ${new Date(deps.clock.now().getTime() + backoffMin * 60_000)} WHERE id = ${p.id}`;
  } else {
    await db`UPDATE payouts SET status = 'ON_HOLD', hold_reason = ${`REPEATED_FAILURE: ${reason}`.slice(0, 500)} WHERE id = ${p.id}`;
    await emitEvent(db, 'payout', p.id, 'payout.on_hold', { payoutId: p.id, travelerId: p.travelerId, transactionId: p.transactionId, amountIdr: p.amountIdr, reason: 'REPEATED_FAILURE' });
  }
  await emitEvent(db, 'payout', p.id, 'payout.failed', { payoutId: p.id, travelerId: p.travelerId, transactionId: p.transactionId, amountIdr: p.amountIdr, reason, attempts: p.attempts });
  await audit(db, { actorType: 'SYSTEM', actorId: null, action: 'payout.failed', entityType: 'payout', entityId: p.id, meta: { reason, attempts: p.attempts } });
}

export async function processPayoutEvent(deps: AppDeps, e: { providerRef: string; referenceId?: string | undefined; status: string }): Promise<string> {
  const policy = await moneyPolicy(deps.sql);
  return deps.sql.begin(async (db) => {
    await setDbActor(db, 'SYSTEM', null);
    const rows = await db<Record<string, unknown>[]>`
      SELECT * FROM payouts WHERE provider_ref = ${e.providerRef} OR number = ${e.referenceId ?? ''} LIMIT 1 FOR UPDATE`;
    if (!rows[0]) {
      // Refund disbursements are payouts at the provider too.
      const { processRefundEvent } = await import('../refunds/service');
      return processRefundEvent(deps, e);
    }
    const p = camel<PayoutRow>(rows[0]);
    if (p.status !== 'PROCESSING') return 'ALREADY_PROCESSED';
    if (e.status === 'SUCCEEDED') {
      await markPayoutPaid(deps, db, p, e.providerRef || null);
      return 'PAID';
    }
    if (e.status === 'FAILED') {
      await markPayoutFailed(deps, db, p, 'PROVIDER_REPORTED_FAILURE', policy.payoutMaxSystemRetries);
      return 'FAILED';
    }
    return 'IGNORED';
  });
}

// ------------------------------------------------------------------ traveler view

export async function myPayouts(deps: AppDeps, auth: AuthContext, opts: { limit: number; cursor?: { t: string; id: string } | null }) {
  const db = deps.sql;
  const rows = await db<Record<string, unknown>[]>`
    SELECT p.*, t.number AS transaction_number, a.bank_code, a.account_mask
      FROM payouts p
      LEFT JOIN transactions t ON t.id = p.transaction_id
      JOIN payout_accounts a ON a.id = p.payout_account_id
     WHERE p.traveler_id = ${auth.userId}
       ${opts.cursor ? db`AND (p.created_at, p.id) < (${opts.cursor.t}::timestamptz, ${opts.cursor.id}::uuid)` : db``}
     ORDER BY p.created_at DESC, p.id DESC LIMIT ${opts.limit + 1}`;
  const [sum] = await db<{ scheduled: number; paid: number; held: number; processing: number; failed: number }[]>`
    SELECT coalesce(sum(net_idr) FILTER (WHERE status = 'SCHEDULED'), 0)::bigint AS scheduled,
           coalesce(sum(net_idr) FILTER (WHERE status = 'PAID'), 0)::bigint AS paid,
           coalesce(sum(net_idr) FILTER (WHERE status = 'ON_HOLD'), 0)::bigint AS held,
           coalesce(sum(net_idr) FILTER (WHERE status = 'PROCESSING'), 0)::bigint AS processing,
           coalesce(sum(net_idr) FILTER (WHERE status = 'FAILED'), 0)::bigint AS failed
      FROM payouts WHERE traveler_id = ${auth.userId}`;
  const data = rows.map((row) => {
    const r = camel<PayoutRow & { transactionNumber: string | null; bankCode: string; accountMask: string }>(row);
    return {
      id: r.id,
      number: r.number,
      transactionId: r.transactionId,
      transactionNumber: r.transactionNumber,
      amountIdr: r.amountIdr,
      feeIdr: r.feeIdr,
      netIdr: r.netIdr,
      status: r.status,
      holdReason: r.status === 'ON_HOLD' ? r.holdReason : null,
      scheduledFor: new Date(r.scheduledFor).toISOString(),
      paidAt: r.paidAt ? new Date(r.paidAt).toISOString() : null,
      destination: { bankCode: r.bankCode, accountMask: r.accountMask },
      providerEnv: r.providerEnv,
      createdAt: new Date(r.createdAt).toISOString(),
    };
  });
  return {
    data,
    summary: {
      scheduledIdr: Number(sum?.scheduled ?? 0),
      paidIdr: Number(sum?.paid ?? 0),
      heldIdr: Number(sum?.held ?? 0),
      processingIdr: Number(sum?.processing ?? 0),
      failedIdr: Number(sum?.failed ?? 0),
    },
  };
}
