/**
 * Account-linkage signals between two users (multi-account / collusion detection), read from data
 * other groups already store as peppered hashes — never raw identifiers:
 *   device   : user_devices ↔ devices (fingerprint)
 *   ip       : refresh_tokens.ip_hash (sessions)
 *   payment  : payout_accounts.account_number_hash (same bank account)
 *   identity : identity_records.id_number_hash — UNIQUE per account by schema, so a match can only
 *              appear through KYC risk flags; kept for completeness (always false today).
 */
import type { Db } from '../../db/sql';

export interface LinkSignals {
  sharedDevice: boolean;
  sharedIp: boolean;
  sharedPaymentInstrument: boolean;
  sharedIdentity: boolean;
}

export async function linkSignals(db: Db, a: string, b: string): Promise<LinkSignals> {
  const [r] = await db<{ device: boolean; ip: boolean; payment: boolean; identity: boolean }[]>`
    SELECT
      EXISTS (SELECT 1 FROM user_devices x JOIN user_devices y ON y.device_id = x.device_id
               WHERE x.user_id = ${a} AND y.user_id = ${b}) AS device,
      EXISTS (SELECT 1 FROM refresh_tokens x JOIN refresh_tokens y ON y.ip_hash = x.ip_hash
               WHERE x.user_id = ${a} AND y.user_id = ${b} AND x.ip_hash IS NOT NULL) AS ip,
      EXISTS (SELECT 1 FROM payout_accounts x JOIN payout_accounts y ON y.account_number_hash = x.account_number_hash
               WHERE x.user_id = ${a} AND y.user_id = ${b}) AS payment,
      EXISTS (SELECT 1 FROM identity_records x JOIN identity_records y ON y.id_number_hash = x.id_number_hash
               WHERE x.user_id = ${a} AND y.user_id = ${b}) AS identity`;
  return { sharedDevice: !!r?.device, sharedIp: !!r?.ip, sharedPaymentInstrument: !!r?.payment, sharedIdentity: !!r?.identity };
}

export function isLinked(s: LinkSignals): boolean {
  return s.sharedDevice || s.sharedPaymentInstrument || s.sharedIdentity;
}

/** Number of OTHER accounts on the user's devices, and those created in the last 24 h. */
export async function deviceAccountStats(db: Db, userId: string, now: Date) {
  const [r] = await db<{ others: number; recent: number; accounts_on_device: number }[]>`
    WITH mine AS (SELECT device_id FROM user_devices WHERE user_id = ${userId})
    SELECT count(DISTINCT ud.user_id) FILTER (WHERE ud.user_id <> ${userId})::int AS others,
           count(DISTINCT ud.user_id) FILTER (WHERE u.created_at > ${new Date(now.getTime() - 86400_000)})::int AS recent,
           coalesce(max(per.n), 0)::int AS accounts_on_device
      FROM mine
      JOIN user_devices ud ON ud.device_id = mine.device_id
      JOIN users u ON u.id = ud.user_id
      LEFT JOIN LATERAL (SELECT count(*) AS n FROM user_devices z WHERE z.device_id = mine.device_id) per ON true`;
  return { sharedDeviceAccounts: r?.others ?? 0, accountsCreatedFromDeviceLast24h: r?.recent ?? 0, accountsOnDevice: r?.accounts_on_device ?? 0 };
}
