import type { Db } from '../../db/sql';

export interface RateLegRow {
  id: string;
  quote: string;
  rate: string;
  as_of: Date;
  fetched_at: Date;
}

/** Latest stored rate per quote currency for one (source, pivot) table. */
export async function latestLegs(db: Db, source: string, pivot: string): Promise<RateLegRow[]> {
  return db<RateLegRow[]>`
    SELECT DISTINCT ON (quote) id, quote, rate::text AS rate, as_of, fetched_at
      FROM fx_rates
     WHERE base = ${pivot} AND source = ${source}
     ORDER BY quote, as_of DESC, fetched_at DESC`;
}

export async function insertRates(
  db: Db,
  rows: { base: string; quote: string; rate: string; source: string; asOf: Date; fetchedAt: Date }[],
): Promise<number> {
  let inserted = 0;
  for (const r of rows) {
    const res = await db`
      INSERT INTO fx_rates (base, quote, rate, source, as_of, fetched_at)
      VALUES (${r.base}, ${r.quote}, ${r.rate}::numeric, ${r.source}, ${r.asOf}, ${r.fetchedAt})
      ON CONFLICT (base, quote, source, as_of) DO NOTHING
      RETURNING id`;
    inserted += res.length;
  }
  return inserted;
}

export interface FxLockRow {
  id: string;
  base: string;
  quote: string;
  spot_rate: string;
  markup_bps: number;
  locked_rate: string;
  locked_at: Date;
  expires_at: Date;
  status: 'ACTIVE' | 'CONSUMED' | 'EXPIRED';
  source_rate_id: string | null;
}

export async function insertLock(
  db: Db,
  l: { base: string; quote: string; spotRate: string; markupBps: number; lockedRate: string; lockedAt: Date; expiresAt: Date; sourceRateId: string | null },
): Promise<FxLockRow> {
  const [row] = await db<FxLockRow[]>`
    INSERT INTO fx_locks (base, quote, spot_rate, markup_bps, locked_rate, locked_at, expires_at, status, source_rate_id)
    VALUES (${l.base}, ${l.quote}, ${l.spotRate}::numeric, ${l.markupBps}, ${l.lockedRate}::numeric, ${l.lockedAt}, ${l.expiresAt},
            'ACTIVE', ${l.sourceRateId})
    RETURNING id, base, quote, spot_rate::text AS spot_rate, markup_bps, locked_rate::text AS locked_rate, locked_at, expires_at,
              status, source_rate_id`;
  return row!;
}

export async function activeCurrencyCodes(db: Db): Promise<{ code: string; ecb_reference: boolean }[]> {
  return db<{ code: string; ecb_reference: boolean }[]>`SELECT code, ecb_reference FROM currencies WHERE is_active ORDER BY code`;
}
