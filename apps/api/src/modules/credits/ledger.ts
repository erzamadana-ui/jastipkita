/**
 * JastipKita Credit lots (pure). credit_entries is an append-only ledger (balance = Σ amount_idr).
 * Positive entries are lots with an optional expiry; debits consume the lot that expires first
 * (FIFO by expiry, then age), so the earliest-expiring credit is always used first and
 * Σ remaining(lots) = balance. Expiry writes one negative EXPIRY entry per lot, keyed
 * `credit-expiry:<lotId>` (idempotent), which reduces exactly that lot.
 */
export interface CreditEntry {
  id: number;
  amountIdr: number;
  reason: string;
  expiresAt: Date | null;
  createdAt: Date;
  idempotencyKey: string | null;
}

export interface CreditLot {
  lotId: number;
  reason: string;
  amountIdr: number;
  remainingIdr: number;
  expiresAt: Date | null;
  createdAt: Date;
  expired: boolean;
}

export const EXPIRY_KEY_PREFIX = 'credit-expiry:';

export function expiryKey(lotId: number): string {
  return `${EXPIRY_KEY_PREFIX}${lotId}`;
}

function lotOrder(a: CreditLot, b: CreditLot): number {
  const ea = a.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY;
  const eb = b.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY;
  return ea - eb || a.lotId - b.lotId;
}

export function computeLots(entries: readonly CreditEntry[]): CreditLot[] {
  const lots: CreditLot[] = [];
  const byId = new Map<number, CreditLot>();
  for (const e of [...entries].sort((a, b) => a.id - b.id)) {
    if (e.amountIdr > 0) {
      const lot: CreditLot = { lotId: e.id, reason: e.reason, amountIdr: e.amountIdr, remainingIdr: e.amountIdr, expiresAt: e.expiresAt, createdAt: e.createdAt, expired: false };
      lots.push(lot);
      byId.set(e.id, lot);
      continue;
    }
    let debit = -e.amountIdr;
    if (e.idempotencyKey?.startsWith(EXPIRY_KEY_PREFIX)) {
      const lot = byId.get(Number(e.idempotencyKey.slice(EXPIRY_KEY_PREFIX.length)));
      if (lot) {
        const take = Math.min(lot.remainingIdr, debit);
        lot.remainingIdr -= take;
        lot.expired = true;
        debit -= take;
      }
    }
    for (const lot of lots.filter((l) => l.remainingIdr > 0).sort(lotOrder)) {
      if (debit <= 0) break;
      const take = Math.min(lot.remainingIdr, debit);
      lot.remainingIdr -= take;
      debit -= take;
    }
  }
  return lots;
}

/** Lots whose expiry passed and still hold credit → the EXPIRY entries to write. */
export function dueExpiries(lots: readonly CreditLot[], now: Date): { lotId: number; amountIdr: number }[] {
  return lots.filter((l) => !l.expired && l.remainingIdr > 0 && l.expiresAt && l.expiresAt.getTime() <= now.getTime()).map((l) => ({ lotId: l.lotId, amountIdr: l.remainingIdr }));
}
