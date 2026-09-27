/**
 * Admin · Settlement accounts (platform bank accounts) — MASKED ONLY, maker-checker:
 *   - list (finance.settlement.read_masked): mask `****0961`, holder mask, status, primary flag, whether the secret
 *     exists in the server secret store. Never the account number, never the secret_ref.
 *   - request change (finance.settlement.request_change + MFA): CREATE / UPDATE / DISABLE / SET_PRIMARY. The new
 *     account number is NEVER sent to or stored by the API: the requester gives a secret NAME that must exist in
 *     SETTLEMENT_SECRETS_JSON (server secret store) and the mask; the server checks that the secret's account number
 *     ends with the mask digits (and the bank code matches). The row stores masked data + `secret://<NAME>` only.
 *   - approve (FINANCE_SUPER_ADMIN + finance.settlement.approve_change + MFA ≤ 15 min, approver ≠ requester — also
 *     enforced by the DB guard) → apply_settlement_account_change(); reject.
 * Operator procedure for putting the real number into the secret store: docs/api/admin.md §9.
 */
import { AppError, Errors } from '../../../lib/errors';
import { type AdminCtx, adminAudit, inAdminTx, iso, makerChecker, mfaDate, requireRole } from '../common';

export interface SettlementSecret {
  bankCode?: string;
  accountNumber: string;
  holderName?: string;
}

/** Parses SETTLEMENT_SECRETS_JSON (never logged, never returned). */
export function settlementSecrets(json: string): Record<string, SettlementSecret> {
  try {
    const v = JSON.parse(json) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, SettlementSecret>) : {};
  } catch {
    return {};
  }
}

const NAME_RE = /^[A-Z][A-Z0-9_]{2,63}$/;

export function secretName(ref: string): string {
  const name = ref.startsWith('secret://') ? ref.slice('secret://'.length) : ref;
  if (!NAME_RE.test(name)) throw Errors.validation({ issues: [{ path: 'secretRef', message: 'secret name: A-Z, 0-9, _ (3–64), e.g. SETTLEMENT_MAIN' }] });
  return name;
}

function secretConfigured(ctx: AdminCtx, ref: string | null): boolean {
  if (!ref?.startsWith('secret://')) return false;
  return ref.slice('secret://'.length) in settlementSecrets(ctx.deps.env.SETTLEMENT_SECRETS_JSON);
}

/** Validates the named secret against the requested mask / bank without exposing the number. */
export function checkSecret(ctx: AdminCtx, name: string, mask: string, bankCode: string | undefined): void {
  const secret = settlementSecrets(ctx.deps.env.SETTLEMENT_SECRETS_JSON)[name];
  if (!secret || typeof secret.accountNumber !== 'string') {
    throw Errors.unprocessable('SETTLEMENT_SECRET_NOT_FOUND', `Secret ${name} belum ada di secret store server (SETTLEMENT_SECRETS_JSON). Minta tim ops menambahkannya dulu.`);
  }
  const digits = secret.accountNumber.replace(/\D/g, '');
  const maskDigits = mask.replace(/^\*+/, '');
  if (!/^\*{4}\d{2,4}$/.test(mask) || !digits.endsWith(maskDigits)) {
    throw Errors.unprocessable('SETTLEMENT_MASK_MISMATCH', 'Mask tidak cocok dengan digit akhir nomor rekening di secret store');
  }
  if (bankCode && secret.bankCode && secret.bankCode !== bankCode) {
    throw Errors.unprocessable('SETTLEMENT_BANK_MISMATCH', 'Kode bank tidak cocok dengan secret store');
  }
}

interface AccountRow {
  id: string;
  label: string;
  purpose: string;
  bank_code: string;
  secret_ref: string;
  account_mask: string;
  holder_name_mask: string;
  currency: string;
  status: string;
  is_primary: boolean;
  created_by: string | null;
  approved_by: string | null;
  activated_at: Date | null;
  disabled_at: Date | null;
  created_at: Date;
}

function accountDto(ctx: AdminCtx, a: AccountRow) {
  return {
    id: a.id,
    label: a.label,
    purpose: a.purpose,
    bankCode: a.bank_code,
    accountMask: a.account_mask,
    holderNameMask: a.holder_name_mask,
    currency: a.currency.trim(),
    status: a.status,
    isPrimary: a.is_primary,
    secretConfigured: secretConfigured(ctx, a.secret_ref),
    createdBy: a.created_by,
    approvedBy: a.approved_by,
    activatedAt: iso(a.activated_at),
    disabledAt: iso(a.disabled_at),
    createdAt: iso(a.created_at)!,
  };
}

export async function listAccounts(ctx: AdminCtx) {
  const r = await ctx.deps.sql<AccountRow[]>`SELECT * FROM settlement_accounts ORDER BY purpose, is_primary DESC, created_at`;
  return { data: r.map((a) => accountDto(ctx, a)), nextCursor: null };
}

interface ChangeRow {
  id: string;
  settlement_account_id: string | null;
  change_type: string;
  proposed: Record<string, unknown>;
  reason: string;
  requested_by: string;
  requested_at: Date;
  approved_by: string | null;
  rejected_by: string | null;
  status: string;
  decision_note: string | null;
  decided_at: Date | null;
  applied_at: Date | null;
  expires_at: Date;
}

function changeDto(ctx: AdminCtx, c: ChangeRow) {
  const { secretRef, ...proposed } = c.proposed as { secretRef?: string };
  return {
    id: c.id,
    settlementAccountId: c.settlement_account_id,
    changeType: c.change_type,
    proposed: { ...proposed, ...(secretRef ? { secretConfigured: secretConfigured(ctx, secretRef) } : {}) },
    reason: c.reason,
    requestedBy: c.requested_by,
    requestedAt: iso(c.requested_at)!,
    approvedBy: c.approved_by,
    rejectedBy: c.rejected_by,
    status: c.status,
    decisionNote: c.decision_note,
    decidedAt: iso(c.decided_at),
    appliedAt: iso(c.applied_at),
    expiresAt: iso(c.expires_at)!,
    canApprove: c.status === 'PENDING' && c.requested_by !== ctx.auth.userId && ctx.auth.roles.includes('FINANCE_SUPER_ADMIN'),
  };
}

export async function listChanges(ctx: AdminCtx, status?: string) {
  const r = await ctx.deps.sql<ChangeRow[]>`
    SELECT * FROM settlement_account_changes ${status ? ctx.deps.sql`WHERE status = ${status}` : ctx.deps.sql``} ORDER BY requested_at DESC LIMIT 200`;
  return { data: r.map((c) => changeDto(ctx, c)), nextCursor: null };
}

export interface ChangeInput {
  changeType: 'CREATE' | 'UPDATE' | 'DISABLE' | 'SET_PRIMARY';
  settlementAccountId?: string | undefined;
  label?: string | undefined;
  purpose?: 'PLATFORM_REVENUE' | 'TAX' | 'OPERATIONS' | undefined;
  bankCode?: string | undefined;
  secretRef?: string | undefined;
  accountMask?: string | undefined;
  holderNameMask?: string | undefined;
  currency?: string | undefined;
  isPrimary?: boolean | undefined;
  reason: string;
}

export async function requestChange(ctx: AdminCtx, input: ChangeInput) {
  const proposed: Record<string, unknown> = {};
  if (input.changeType === 'CREATE') {
    for (const f of ['label', 'purpose', 'bankCode', 'secretRef', 'accountMask', 'holderNameMask'] as const) {
      if (!input[f]) throw Errors.validation({ issues: [{ path: f, message: `${f} wajib untuk CREATE` }] });
    }
  } else if (!input.settlementAccountId) {
    throw Errors.validation({ issues: [{ path: 'settlementAccountId', message: 'wajib untuk UPDATE/DISABLE/SET_PRIMARY' }] });
  }
  let accountBank: string | undefined;
  if (input.settlementAccountId) {
    const [a] = await ctx.deps.sql<{ status: string; bank_code: string }[]>`SELECT status, bank_code FROM settlement_accounts WHERE id = ${input.settlementAccountId}`;
    if (!a) throw Errors.notFound('Rekening settlement', 'SETTLEMENT_ACCOUNT_NOT_FOUND');
    if (a.status === 'DISABLED') throw Errors.unprocessable('SETTLEMENT_ACCOUNT_DISABLED', 'Rekening sudah dinonaktifkan');
    accountBank = a.bank_code;
  }
  if (input.changeType === 'CREATE' || input.changeType === 'UPDATE') {
    if (input.secretRef) {
      if (!input.accountMask) throw Errors.validation({ issues: [{ path: 'accountMask', message: 'wajib bila secretRef diganti' }] });
      const name = secretName(input.secretRef);
      checkSecret(ctx, name, input.accountMask, input.bankCode ?? accountBank);
      proposed.secretRef = `secret://${name}`;
      proposed.accountMask = input.accountMask;
    } else if (input.accountMask) {
      throw Errors.unprocessable('SECRET_REF_REQUIRED', 'Mask hanya dapat diubah bersama secretRef');
    }
    if (input.label) proposed.label = input.label;
    if (input.purpose) proposed.purpose = input.purpose;
    if (input.bankCode) proposed.bankCode = input.bankCode;
    if (input.holderNameMask) proposed.holderNameMask = input.holderNameMask;
    if (input.changeType === 'CREATE') {
      proposed.currency = input.currency ?? 'IDR';
      proposed.isPrimary = input.isPrimary ?? false;
    }
    if (input.changeType === 'UPDATE' && Object.keys(proposed).length === 0) throw Errors.validation({ issues: [{ path: '', message: 'tidak ada perubahan' }] });
  }
  const row = await inAdminTx(ctx, async (tx) => {
    const [c] = await tx<ChangeRow[]>`
      INSERT INTO settlement_account_changes (settlement_account_id, change_type, proposed, reason, requested_by, requester_mfa_at)
      VALUES (${input.settlementAccountId ?? null}, ${input.changeType}, ${tx.json(proposed as never)}, ${input.reason}, ${ctx.auth.userId}, ${mfaDate(ctx.auth)})
      RETURNING *`;
    const { secretRef: _s, ...masked } = proposed as { secretRef?: string };
    void _s;
    await adminAudit(tx, ctx, {
      action: 'finance.settlement_change_requested',
      entityType: 'settlement_account',
      entityId: input.settlementAccountId ?? null,
      after: { changeId: c!.id, changeType: input.changeType, proposed: masked, status: 'PENDING' },
      meta: { reason: input.reason },
    });
    return c!;
  });
  return changeDto(ctx, row);
}

export async function approveChange(ctx: AdminCtx, id: string, note?: string) {
  requireRole(ctx.auth, 'FINANCE_SUPER_ADMIN', 'Persetujuan perubahan rekening settlement hanya oleh FINANCE_SUPER_ADMIN');
  const now = ctx.deps.clock.now();
  const out = await inAdminTx(ctx, async (tx) => {
    const [c] = await tx<ChangeRow[]>`SELECT * FROM settlement_account_changes WHERE id = ${id} FOR UPDATE`;
    if (!c) throw Errors.notFound('Perubahan rekening', 'SETTLEMENT_CHANGE_NOT_FOUND');
    makerChecker(c.requested_by, ctx.auth.userId, 'Perubahan rekening settlement harus disetujui admin lain (maker-checker)');
    if (c.status !== 'PENDING') throw Errors.unprocessable('SETTLEMENT_CHANGE_NOT_PENDING', 'Permintaan sudah diputuskan', { status: c.status });
    if (c.expires_at <= now) throw Errors.unprocessable('SETTLEMENT_CHANGE_EXPIRED', 'Permintaan sudah kedaluwarsa (72 jam)');
    const p = c.proposed as { secretRef?: string; accountMask?: string; bankCode?: string };
    if (p.secretRef) checkSecret(ctx, secretName(p.secretRef), p.accountMask ?? '', p.bankCode);
    await tx`UPDATE settlement_account_changes SET status = 'APPROVED', approved_by = ${ctx.auth.userId}, approver_mfa_at = ${mfaDate(ctx.auth)},
                    decision_note = ${note ?? null}, decided_at = ${now} WHERE id = ${id}`;
    const [acc] = await tx<AccountRow[]>`SELECT * FROM apply_settlement_account_change(${id}, ${ctx.auth.userId})`;
    await adminAudit(tx, ctx, {
      action: 'finance.settlement_change_approved',
      entityType: 'settlement_account',
      entityId: acc!.id,
      after: { changeId: id, status: 'APPLIED', accountMask: acc!.account_mask, isPrimary: acc!.is_primary, accountStatus: acc!.status },
      meta: { requestedBy: c.requested_by, note: note ?? null },
    });
    return acc!;
  });
  return { changeId: id, status: 'APPLIED', account: accountDto(ctx, out) };
}

export async function rejectChange(ctx: AdminCtx, id: string, note: string) {
  const now = ctx.deps.clock.now();
  await inAdminTx(ctx, async (tx) => {
    const [c] = await tx<ChangeRow[]>`SELECT * FROM settlement_account_changes WHERE id = ${id} FOR UPDATE`;
    if (!c) throw Errors.notFound('Perubahan rekening', 'SETTLEMENT_CHANGE_NOT_FOUND');
    if (c.status !== 'PENDING') throw Errors.unprocessable('SETTLEMENT_CHANGE_NOT_PENDING', 'Permintaan sudah diputuskan', { status: c.status });
    await tx`UPDATE settlement_account_changes SET status = 'REJECTED', rejected_by = ${ctx.auth.userId}, decision_note = ${note}, decided_at = ${now} WHERE id = ${id}`;
    await adminAudit(tx, ctx, { action: 'finance.settlement_change_rejected', entityType: 'settlement_account', entityId: c.settlement_account_id, after: { changeId: id, status: 'REJECTED' }, meta: { note } });
  });
  return { changeId: id, status: 'REJECTED' };
}

export function assertNever(x: never): never {
  throw new AppError(500, 'INTERNAL_ERROR', `unexpected ${String(x)}`);
}
