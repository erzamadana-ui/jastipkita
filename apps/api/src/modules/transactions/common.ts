/**
 * Shared helpers for the money module group (transactions, checkout, payments, ledger, refunds, …).
 * Local to the money group — nothing here is imported by other groups except the documented service APIs.
 */
import {
  type Actor,
  CoreError,
  canTransition,
  type TransactionGuardContext,
  type TransactionStatus,
} from '@jastipkita/core';
import type { AppDeps, AuthContext } from '../../context';
import { camel, type Db, type TxSql } from '../../db/sql';
import { AppError, Errors } from '../../lib/errors';

export type PartyRole = 'BUYER' | 'TRAVELER';

export interface TxRow {
  id: string;
  number: string;
  requestId: string;
  tripId: string | null;
  offerId: string | null;
  buyerId: string;
  travelerId: string | null;
  status: TransactionStatus;
  activeQuoteId: string | null;
  itemCurrency: string | null;
  quantity: number;
  totalIdr: number | null;
  securedIdr: number;
  deliveryMethod: 'MEETUP' | 'COURIER' | 'PARTNER_LOGISTICS' | null;
  purchaseDeadline: Date | null;
  autoConfirmAt: Date | null;
  statusChangedAt: Date;
  deliveredAt: Date | null;
  disputedAt: Date | null;
  completedAt: Date | null;
  refundedAt: Date | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  cancelledByType: string | null;
  cancellationStage: string | null;
  purchaseCeilingMinor: number | null;
  purchaseCeilingIdr: number | null;
  purchaseApprovedAt: Date | null;
  payoutHoldReason: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export async function loadTx(db: Db, id: string, opts: { forUpdate?: boolean } = {}): Promise<TxRow | null> {
  const rows = opts.forUpdate
    ? await db<Record<string, unknown>[]>`SELECT * FROM transactions WHERE id = ${id} FOR UPDATE`
    : await db<Record<string, unknown>[]>`SELECT * FROM transactions WHERE id = ${id}`;
  return rows[0] ? camel<TxRow>(rows[0]) : null;
}

export function partyRole(tx: Pick<TxRow, 'buyerId' | 'travelerId'>, userId: string): PartyRole | null {
  if (tx.buyerId === userId) return 'BUYER';
  if (tx.travelerId === userId) return 'TRAVELER';
  return null;
}

/** Loads the transaction and checks the caller is a party. Non-parties get 404 (no enumeration). */
export async function requireParty(
  db: Db,
  id: string,
  auth: AuthContext,
  opts: { role?: PartyRole; forUpdate?: boolean } = {},
): Promise<{ tx: TxRow; role: PartyRole }> {
  const tx = await loadTx(db, id, { forUpdate: opts.forUpdate ?? false });
  const role = tx ? partyRole(tx, auth.userId) : null;
  if (!tx || !role) throw Errors.notFound('Transaksi', 'TRANSACTION_NOT_FOUND');
  if (opts.role && role !== opts.role) {
    throw Errors.forbidden(
      opts.role === 'BUYER' ? 'Hanya penitip yang dapat melakukan aksi ini' : 'Hanya traveler yang dapat melakukan aksi ini',
      opts.role === 'BUYER' ? 'BUYER_ONLY' : 'TRAVELER_ONLY',
    );
  }
  return { tx, role };
}

const FRIENDLY: Record<string, string> = {
  INVALID_TRANSITION: 'Aksi ini tidak tersedia pada status transaksi saat ini',
  ACTOR_NOT_ALLOWED: 'Anda tidak berwenang melakukan aksi ini pada status saat ini',
  TERMINAL_STATUS: 'Transaksi sudah selesai/ditutup',
  QUOTE_NOT_ACTIVE: 'Penawaran harga sudah tidak aktif; buat penawaran baru',
  FX_LOCK_INVALID: 'Kurs terkunci sudah kedaluwarsa; buat penawaran baru',
  KYC_LEVEL_INSUFFICIENT: 'Verifikasi nomor HP diperlukan sebelum membayar',
  RESTRICTED_NOT_ACKNOWLEDGED: 'Anda wajib menyetujui peringatan barang terbatas',
  ITEM_PROHIBITED: 'Barang ini dilarang dan tidak dapat diproses',
  PURCHASE_PROOF_INCOMPLETE: 'Bukti pembelian belum lengkap',
  PURCHASE_PRICE_EXCEEDS_APPROVED: 'Harga pembelian melebihi harga yang disetujui',
  TRIP_NOT_TRAVELING: 'Trip belum berstatus berangkat (TRAVELING)',
  TRIP_NOT_ARRIVED: 'Trip belum tiba',
  CUSTOMS_PROOF_MISSING: 'Unggah deklarasi & bukti pembayaran bea masuk terlebih dahulu',
  DELIVERY_METHOD_INVALID: 'Metode pengiriman tidak sesuai',
  TRACKING_NUMBER_MISSING: 'Nomor resi wajib diisi',
  PIN_NOT_VERIFIED: 'PIN/QR penitip belum terverifikasi',
  DELIVERY_PROOF_MISSING: 'Bukti pengiriman wajib diunggah',
  DISPUTE_OPEN: 'Ada dispute yang masih terbuka',
  CANCELLATION_NOT_ALLOWED: 'Pembatalan tidak diizinkan pada tahap ini',
  PRICE_OUTSIDE_TOLERANCE: 'Harga di luar toleransi; konfirmasi penitip diperlukan',
};

/** Runs the core FSM + guard check; throws 422 with the core code (Bahasa Indonesia message). */
export function assertCanTransition(
  from: TransactionStatus,
  to: TransactionStatus,
  actor: Actor,
  ctx: TransactionGuardContext,
): void {
  const r = canTransition(from, to, actor, ctx);
  if (!r.ok) {
    throw new AppError(422, r.code, FRIENDLY[r.code] ?? 'Aksi tidak diizinkan pada status transaksi saat ini', {
      from,
      to,
      actor,
      reason: r.message,
    });
  }
}

/** The ONLY way the money group changes transactions.status (DB function writes events/audit/outbox). */
export async function transitionTx(
  db: TxSql,
  tx: TxRow,
  to: TransactionStatus,
  actorType: Actor,
  actorId: string | null,
  reason: string | null = null,
  meta: Record<string, unknown> = {},
): Promise<TxRow> {
  const rows = await db<Record<string, unknown>[]>`
    SELECT * FROM transition_transaction(${tx.id}, ${tx.version}, ${to}, ${actorType}, ${actorId}, ${reason}, ${db.json(meta as never)}::jsonb)`;
  return camel<TxRow>(rows[0]!);
}

/** Guard + transition in one call. */
export async function guardedTransition(
  db: TxSql,
  tx: TxRow,
  to: TransactionStatus,
  actorType: Actor,
  actorId: string | null,
  ctx: TransactionGuardContext,
  reason: string | null = null,
  meta: Record<string, unknown> = {},
): Promise<TxRow> {
  assertCanTransition(tx.status, to, actorType, ctx);
  return transitionTx(db, tx, to, actorType, actorId, reason, meta);
}

/** Sets jk.actor_* (transaction-local) so trigger-written events (refund_events) carry the actor. */
export async function setDbActor(db: TxSql, actorType: Actor, actorId: string | null): Promise<void> {
  await db`SELECT set_config('jk.actor_type', ${actorType}, true), set_config('jk.actor_id', ${actorId ?? ''}, true)`;
}

/** Converts CoreError (contract violations / business values from core) into a 422 AppError. */
export function coreToApp(err: unknown): never {
  if (err instanceof CoreError) {
    throw new AppError(422, err.code, err.message, (err.details ?? {}) as Record<string, unknown>);
  }
  throw err;
}

export async function withCore<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    return coreToApp(err);
  }
}

// ------------------------------------------------------------------ money policy (optional config key)

export interface MoneyPolicy {
  /** Refunds above this go to PENDING_APPROVAL (maker-checker). ASSUMPTION — tune via business_configs `money.policy`. */
  refundAutoApproveMaxIdr: number;
  /** SYSTEM retry budget for refunds (§15.6 RETRY_BUDGET) and payouts. */
  refundMaxSystemRetries: number;
  payoutMaxSystemRetries: number;
  /** Delay between COMPLETED and the payout attempt (hours). */
  payoutDelayHours: number;
  /** Reconciliation: poll the provider for PENDING payments older than this. */
  pendingPaymentPollMinutes: number;
}

export const DEFAULT_MONEY_POLICY: MoneyPolicy = {
  refundAutoApproveMaxIdr: 10_000_000,
  refundMaxSystemRetries: 3,
  payoutMaxSystemRetries: 3,
  payoutDelayHours: 0,
  pendingPaymentPollMinutes: 15,
};

/**
 * Reads the optional ACTIVE business_configs row `money.policy` (not part of core BusinessConfig yet);
 * missing keys fall back to DEFAULT_MONEY_POLICY.
 */
export async function moneyPolicy(db: Db): Promise<MoneyPolicy> {
  const [row] = await db<{ value: Partial<MoneyPolicy> }[]>`
    SELECT value FROM business_configs WHERE key = 'money.policy' AND status = 'ACTIVE' ORDER BY version DESC LIMIT 1`;
  return { ...DEFAULT_MONEY_POLICY, ...(row?.value ?? {}) };
}

// ------------------------------------------------------------------ files

export interface FileRow {
  id: string;
  ownerId: string | null;
  purpose: string;
  mime: string;
  sha256: Buffer | null;
  scanStatus: string;
  deletedAt: Date | null;
}

/**
 * Validates uploaded files: exist, owned by `ownerId`, not deleted, malware scan CLEAN, allowed purpose.
 * Returns the rows in input order.
 */
export async function assertOwnedFiles(
  db: Db,
  ids: readonly string[],
  ownerId: string,
  purposes: readonly string[],
  field: string,
): Promise<FileRow[]> {
  if (ids.length === 0) return [];
  const rows = await db<Record<string, unknown>[]>`
    SELECT id, owner_id, purpose, mime, sha256, scan_status, deleted_at FROM files WHERE id = ANY(${ids as string[]}::uuid[])`;
  const byId = new Map(rows.map((r) => [String(r.id), camel<FileRow>(r)]));
  return ids.map((id) => {
    const f = byId.get(id);
    if (!f || f.deletedAt || f.ownerId !== ownerId) {
      throw Errors.unprocessable('FILE_INVALID', 'Berkas tidak ditemukan atau bukan milik Anda', { field, fileId: id });
    }
    if (f.scanStatus !== 'CLEAN') {
      throw Errors.unprocessable('FILE_NOT_SCANNED', 'Berkas belum lolos pemindaian keamanan', { field, fileId: id, scanStatus: f.scanStatus });
    }
    if (!purposes.includes(f.purpose)) {
      throw Errors.unprocessable('FILE_PURPOSE_INVALID', 'Jenis berkas tidak sesuai', { field, fileId: id, expected: purposes });
    }
    return f;
  });
}

// ------------------------------------------------------------------ misc

export function isoOrNull(d: Date | string | null | undefined): string | null {
  if (d === null || d === undefined) return null;
  return d instanceof Date ? d.toISOString() : new Date(d).toISOString();
}

export function iso(d: Date | string): string {
  return d instanceof Date ? d.toISOString() : new Date(d).toISOString();
}

/** Loads the provider payment env label. */
export function nowOf(deps: Pick<AppDeps, 'clock'>): Date {
  return deps.clock.now();
}

export function maskAccount(accountNumber: string): string {
  const digits = accountNumber.replace(/\D/g, '');
  return `****${digits.slice(-4).padStart(4, '0')}`;
}
