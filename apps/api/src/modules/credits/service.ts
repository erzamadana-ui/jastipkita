import type { AppDeps, AuthContext } from '../../context';
import type { TxSql } from '../../db/sql';
import { Errors } from '../../lib/errors';
import { decodeCursor, encodeCursor } from '../../lib/pagination';
import { audit } from '../../services/audit';
import { computeLots, dueExpiries, expiryKey } from './ledger';
import * as repo from './repository';

/** "Expiring soon" horizon shown in GET /credits. */
export const EXPIRING_SOON_DAYS = 30;

const REASON_LABEL: Record<string, { id: string; en: string }> = {
  REFERRAL_REWARD: { id: 'Hadiah referral', en: 'Referral reward' },
  PROMO_CASHBACK: { id: 'Cashback promo', en: 'Promo cashback' },
  CHECKOUT_REDEEM: { id: 'Dipakai saat checkout', en: 'Used at checkout' },
  REDEEM_REVERSAL: { id: 'Dikembalikan (transaksi batal)', en: 'Returned (transaction cancelled)' },
  EXPIRY: { id: 'Kedaluwarsa', en: 'Expired' },
  ADMIN_ADJUST: { id: 'Penyesuaian oleh tim JastipKita', en: 'Adjustment by JastipKita' },
};

export async function getCredits(deps: AppDeps, auth: AuthContext, q: { limit: number; cursor?: string | undefined }) {
  const cursor = decodeCursor(q.cursor);
  const beforeId = cursor ? Number(cursor.id) : null;
  if (q.cursor && (!cursor || !Number.isSafeInteger(beforeId))) throw Errors.badRequest('CURSOR_INVALID', 'Cursor tidak valid');
  const now = deps.clock.now();
  const [entries, rows, [u]] = await Promise.all([
    repo.entriesOf(deps.sql, auth.userId),
    repo.history(deps.sql, auth.userId, { beforeId, limit: q.limit + 1 }),
    deps.sql<{ locale: string }[]>`SELECT locale FROM users WHERE id = ${auth.userId}`,
  ]);
  const locale = u?.locale === 'en' ? 'en' : 'id';
  const lots = computeLots(entries).filter((l) => l.remainingIdr > 0 && !(l.expiresAt && l.expiresAt <= now));
  const horizon = now.getTime() + EXPIRING_SOON_DAYS * 86400_000;
  const soon = lots.filter((l) => l.expiresAt && l.expiresAt.getTime() <= horizon).sort((a, b) => a.expiresAt!.getTime() - b.expiresAt!.getTime());
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    balanceIdr: entries.reduce((s, e) => s + e.amountIdr, 0),
    availableIdr: lots.reduce((s, l) => s + l.remainingIdr, 0),
    withdrawable: false as const,
    nextExpiryAt: lots.filter((l) => l.expiresAt).sort((a, b) => a.expiresAt!.getTime() - b.expiresAt!.getTime())[0]?.expiresAt?.toISOString() ?? null,
    expiringSoon: {
      withinDays: EXPIRING_SOON_DAYS,
      totalIdr: soon.reduce((s, l) => s + l.remainingIdr, 0),
      lots: soon.map((l) => ({ amountIdr: l.remainingIdr, expiresAt: l.expiresAt!.toISOString(), source: l.reason })),
    },
    history: {
      data: page.map((r) => ({
        id: String(r.id),
        amountIdr: Number(r.amount_idr),
        reason: r.reason,
        label: REASON_LABEL[r.reason]?.[locale] ?? r.reason,
        referenceType: r.reference_type,
        referenceId: r.reference_id,
        expiresAt: r.expires_at?.toISOString() ?? null,
        createdAt: r.created_at.toISOString(),
      })),
      nextCursor: rows.length > q.limit && last ? encodeCursor({ t: last.created_at.toISOString(), id: String(last.id) }) : null,
    },
  };
}

/** Writes EXPIRY entries for every lot past its expiry (idempotent per lot). */
export async function expireUserCredits(deps: AppDeps, userId: string): Promise<number> {
  const now = deps.clock.now();
  return deps.sql.begin(async (tq) => {
    const tx = tq as unknown as TxSql;
    await repo.lockUserCredit(tx, userId);
    const due = dueExpiries(computeLots(await repo.entriesOf(tx, userId)), now);
    let total = 0;
    for (const d of due) {
      const id = await repo.insertExpiry(tx, userId, d.lotId, d.amountIdr, expiryKey(d.lotId), now);
      if (id !== null) total += d.amountIdr;
    }
    if (total > 0) {
      await audit(tx, { actorType: 'JOB', actorId: null, action: 'credit.expired', entityType: 'user', entityId: userId, after: { expiredIdr: total, lots: due.map((d) => d.lotId) } });
    }
    return total;
  });
}

export async function runCreditExpiry(deps: AppDeps): Promise<Record<string, number>> {
  const users = await repo.usersWithDueLots(deps.sql, deps.clock.now(), 500);
  let expiredIdr = 0;
  let failed = 0;
  for (const u of users) {
    try {
      expiredIdr += await expireUserCredits(deps, u);
    } catch (err) {
      failed++;
      deps.logger.warn('credits.expiry_failed', { userId: u, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { users: users.length, expiredIdr, failed };
}
