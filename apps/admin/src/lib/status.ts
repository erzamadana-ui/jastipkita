/**
 * Status → tone mapping. Transaction statuses follow `transactionStatusGroup` (docs/05-ui-design-system.md §3.1,
 * tokens `--jk-status-<group>-*`); everything else maps to the semantic groups below. A badge always shows the
 * label text next to the colour (status is never colour-only).
 */
export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'violet' | 'teal' | 'sky' | 'completed' | 'amber' | 'navy';

const TX_GROUP: Record<string, Tone> = {
  REQUEST_CREATED: 'info',
  MATCHED: 'info',
  AWAITING_PAYMENT: 'warning',
  PRICE_CHANGE_PENDING: 'warning',
  PAYMENT_SECURED: 'success',
  PURCHASE_APPROVED: 'success',
  PURCHASED: 'violet',
  TRAVELING: 'violet',
  ARRIVED: 'violet',
  CUSTOMS_PROCESS: 'violet',
  READY_FOR_HANDOVER: 'violet',
  OUT_FOR_DELIVERY: 'violet',
  DELIVERED: 'teal',
  BUYER_CONFIRMED: 'teal',
  COMPLETED: 'completed',
  DISPUTED: 'danger',
  REFUND_PENDING: 'sky',
  REFUNDED: 'neutral',
  CANCELLED: 'neutral',
};

export const TX_STATUSES = Object.keys(TX_GROUP);

const GENERIC: Record<string, Tone> = {};
const put = (tone: Tone, ...codes: string[]) => codes.forEach((c) => (GENERIC[c] = tone));
put('success', 'APPROVED', 'ACTIVE', 'APPLIED', 'SUCCEEDED', 'PAID', 'VERIFIED', 'CLEARED', 'REWARDED', 'PUBLISHED', 'OK', 'UP', 'DONE',
  'LIVE', 'SECURED', 'ACCEPTED', 'CLEAN', 'ALLOW', 'ALLOWED', 'ON_TRACK', 'RESPONDED', 'GRANTED', 'IN_SYNC', 'MIGRATED');
put('warning', 'PENDING', 'PENDING_APPROVAL', 'IN_REVIEW', 'ON_HOLD', 'REQUESTED', 'EVIDENCE_COLLECTION', 'UNDER_REVIEW', 'DUE_SOON',
  'DEGRADED', 'PAUSED', 'FLAGGED', 'QUALIFIED', 'SANDBOX', 'MEDIUM', 'NEEDS_VERIFICATION', 'PENDING_USER', 'REVIEW', 'APPEALED',
  'RESTRICTED', 'DECLARATION_REQUIRED', 'PERMIT_REQUIRED', 'UNVERIFIED', 'NAME_MISMATCH', 'PENDING_DELETION', 'PENDING_UPLOAD', 'HOLD', 'TEST');
put('danger', 'REJECTED', 'FAILED', 'BREACHED', 'CRITICAL', 'CONFIRMED_FRAUD', 'SUSPENDED', 'CHECKSUM_DRIFT', 'BROKEN', 'HIDDEN', 'BLOCK',
  'HIGH', 'INFECTED', 'DOWN', 'PROHIBITED', 'DEAD', 'URGENT');
put('info', 'OPEN', 'IN_PROGRESS', 'RUNNING', 'SCHEDULED', 'PROCESSING', 'MOCK', 'MANUAL', 'NORMAL', 'LOW', 'PENDING_MIGRATION');
put('neutral', 'CLOSED', 'CANCELLED', 'EXPIRED', 'RETIRED', 'SUPERSEDED', 'ARCHIVED', 'ENDED', 'SKIPPED', 'UNKNOWN_IN_BUILD', 'DELETED',
  'DRAFT', 'DISABLED', 'NONE');
put('violet', 'RESOLVED');
put('sky', 'REFUND_REQUESTED');

export function statusTone(status: string | null | undefined): Tone {
  if (!status) return 'neutral';
  return TX_GROUP[status] ?? GENERIC[status] ?? 'neutral';
}

export function txTone(status: string): Tone {
  return TX_GROUP[status] ?? 'neutral';
}

/** Integration mode badge tone: LIVE is the only "real money" state. */
export function modeTone(mode: string): Tone {
  if (mode === 'LIVE') return 'success';
  if (mode === 'SANDBOX' || mode === 'TEST') return 'warning';
  if (mode === 'MOCK' || mode === 'MANUAL' || mode === 'DISABLED') return 'amber';
  return 'neutral';
}

export function severityTone(sev: string): Tone {
  return sev === 'CRITICAL' || sev === 'HIGH' ? 'danger' : sev === 'MEDIUM' ? 'warning' : 'info';
}

export const KYC_LABEL: Record<number, string> = {
  1: 'Terdaftar',
  2: 'HP terverifikasi',
  3: 'Identitas terverifikasi',
  4: 'Traveler terverifikasi',
  5: 'Trusted Traveler',
};

export function kycTone(level: number): Tone {
  return (['neutral', 'neutral', 'sky', 'info', 'navy', 'amber'] as Tone[])[level] ?? 'neutral';
}

export function trustTone(score: number): Tone {
  if (score >= 85) return 'success';
  if (score >= 70) return 'info';
  if (score >= 40) return 'warning';
  return 'danger';
}

/** Indonesian labels for common status codes (fallback: humanized code). */
export const STATUS_LABEL: Record<string, string> = {
  PENDING_APPROVAL: 'Menunggu persetujuan',
  PENDING: 'Menunggu',
  APPROVED: 'Disetujui',
  REJECTED: 'Ditolak',
  APPLIED: 'Diterapkan',
  ACTIVE: 'Aktif',
  DRAFT: 'Draf',
  RETIRED: 'Pensiun',
  SUPERSEDED: 'Digantikan',
  EXPIRED: 'Kedaluwarsa',
  CANCELLED: 'Dibatalkan',
  FAILED: 'Gagal',
  SUCCEEDED: 'Berhasil',
  ON_HOLD: 'Ditahan',
  SCHEDULED: 'Terjadwal',
  PROCESSING: 'Diproses',
  PAID: 'Dibayar',
  BREACHED: 'Lewat SLA',
  DUE_SOON: 'Segera jatuh tempo',
  ON_TRACK: 'Sesuai SLA',
  IN_REVIEW: 'Ditinjau',
  OPEN: 'Terbuka',
  CLOSED: 'Ditutup',
  RESOLVED: 'Diputuskan',
};
