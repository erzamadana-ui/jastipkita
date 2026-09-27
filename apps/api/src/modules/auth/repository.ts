import type { AppDeps } from '../../context';
import type { Db, TxSql } from '../../db/sql';
import { buf } from './common';

/** Runs fn in a DB transaction and returns its value (typed; postgres.js unwraps arrays otherwise). */
export async function inTx<T>(deps: AppDeps, fn: (tx: TxSql) => Promise<T>): Promise<T> {
  return (await deps.sql.begin((tx) => fn(tx as unknown as TxSql))) as T;
}

export interface OtpRow {
  id: string;
  user_id: string | null;
  channel: 'SMS' | 'WHATSAPP' | 'EMAIL';
  destination_hash: Buffer;
  destination_enc: Buffer | null;
  purpose: string;
  code_hash: Buffer;
  attempts: number;
  max_attempts: number;
  expires_at: Date;
  consumed_at: Date | null;
  created_at: Date;
}

export async function lockOtp(db: Db, id: string): Promise<OtpRow | undefined> {
  const [row] = await db<OtpRow[]>`
    SELECT id, user_id, channel, destination_hash, destination_enc, purpose, code_hash, attempts, max_attempts,
           expires_at, consumed_at, created_at
      FROM otp_challenges WHERE id = ${id} FOR UPDATE`;
  return row;
}

export async function otpStats(db: Db, destHash: Uint8Array, ipHash: Uint8Array | null, now: Date) {
  const hourAgo = new Date(now.getTime() - 3600_000);
  const dayAgo = new Date(now.getTime() - 86400_000);
  const [d] = await db<{ last: Date | null; hour: number; day: number; oldest_hour: Date | null; oldest_day: Date | null }[]>`
    SELECT max(created_at) AS last,
           count(*) FILTER (WHERE created_at >= ${hourAgo})::int AS hour,
           count(*)::int AS day,
           min(created_at) FILTER (WHERE created_at >= ${hourAgo}) AS oldest_hour,
           min(created_at) AS oldest_day
      FROM otp_challenges WHERE destination_hash = ${buf(destHash)} AND created_at >= ${dayAgo}`;
  let ipHour = 0;
  let ipOldest: Date | null = null;
  if (ipHash) {
    const [i] = await db<{ n: number; oldest: Date | null }[]>`
      SELECT count(*)::int AS n, min(created_at) AS oldest FROM otp_challenges WHERE ip_hash = ${buf(ipHash)} AND created_at >= ${hourAgo}`;
    ipHour = i?.n ?? 0;
    ipOldest = i?.oldest ?? null;
  }
  return { last: d?.last ?? null, hour: d?.hour ?? 0, day: d?.day ?? 0, oldestHour: d?.oldest_hour ?? null, oldestDay: d?.oldest_day ?? null, ipHour, ipOldest };
}

export async function insertOtp(
  db: Db,
  r: {
    id: string;
    userId: string | null;
    channel: string;
    destHash: Uint8Array;
    destEnc: Uint8Array;
    encKeyId: string;
    purpose: string;
    codeHash: Uint8Array;
    maxAttempts: number;
    expiresAt: Date;
    ipHash: Uint8Array | null;
    now: Date;
  },
) {
  // a newer code supersedes older unused ones for the same destination + purpose
  await db`UPDATE otp_challenges SET consumed_at = ${r.now}
            WHERE destination_hash = ${buf(r.destHash)} AND purpose = ${r.purpose} AND consumed_at IS NULL AND expires_at > ${r.now}`;
  await db`
    INSERT INTO otp_challenges (id, user_id, channel, destination_hash, destination_enc, enc_key_id, purpose, code_hash,
                                max_attempts, expires_at, ip_hash, created_at)
    VALUES (${r.id}, ${r.userId}, ${r.channel}, ${buf(r.destHash)}, ${buf(r.destEnc)}, ${r.encKeyId}, ${r.purpose},
            ${buf(r.codeHash)}, ${r.maxAttempts}, ${r.expiresAt}, ${r.ipHash ? buf(r.ipHash) : null}, ${r.now})`;
}

export async function consumeOtp(db: Db, id: string, now: Date) {
  await db`UPDATE otp_challenges SET consumed_at = ${now} WHERE id = ${id} AND consumed_at IS NULL`;
}

export interface LoginUserRow {
  id: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'PENDING_DELETION' | 'DELETED';
  email: string | null;
  email_verified_at: Date | null;
  phone_verified_at: Date | null;
  display_name: string | null;
}

export async function findUserByPhone(db: Db, phone: string) {
  const [u] = await db<LoginUserRow[]>`
    SELECT id, status, email, email_verified_at, phone_verified_at, display_name FROM users WHERE phone_e164 = ${phone} FOR UPDATE`;
  return u;
}

export async function findUserByEmail(db: Db, email: string) {
  const [u] = await db<LoginUserRow[]>`
    SELECT id, status, email, email_verified_at, phone_verified_at, display_name FROM users WHERE email = ${email} FOR UPDATE`;
  return u;
}

export async function findUserById(db: Db, id: string) {
  const [u] = await db<LoginUserRow[]>`
    SELECT id, status, email, email_verified_at, phone_verified_at, display_name FROM users WHERE id = ${id} FOR UPDATE`;
  return u;
}

export async function insertUser(
  db: Db,
  u: { email: string | null; emailVerifiedAt: Date | null; phone: string | null; phoneVerifiedAt: Date | null; displayName: string | null; locale: 'id' | 'en'; now: Date },
): Promise<string> {
  const [row] = await db<{ id: string }[]>`
    INSERT INTO users (email, email_verified_at, phone_e164, phone_verified_at, display_name, locale, kyc_level, created_at, last_login_at)
    VALUES (${u.email}, ${u.emailVerifiedAt}, ${u.phone}, ${u.phoneVerifiedAt}, ${u.displayName}, ${u.locale}, 1, ${u.now}, ${u.now})
    RETURNING id`;
  return row!.id;
}

/**
 * Contact identities (PHONE / EMAIL) mirror users.phone_e164 / users.email, so the subject may move
 * to the user that verified it last. Social identities (GOOGLE / APPLE) never move.
 */
export async function upsertIdentity(
  db: Db,
  i: { userId: string; provider: 'GOOGLE' | 'APPLE' | 'EMAIL' | 'PHONE'; subject: string; email: string | null; emailVerified: boolean; now: Date },
) {
  if (i.provider === 'PHONE' || i.provider === 'EMAIL') {
    await db`DELETE FROM auth_identities WHERE user_id = ${i.userId} AND provider = ${i.provider} AND provider_subject <> ${i.subject}`;
    await db`
      INSERT INTO auth_identities (user_id, provider, provider_subject, email, email_verified, last_used_at)
      VALUES (${i.userId}, ${i.provider}, ${i.subject}, ${i.email}, ${i.emailVerified}, ${i.now})
      ON CONFLICT (provider, provider_subject) DO UPDATE
         SET user_id = EXCLUDED.user_id, email = EXCLUDED.email, email_verified = EXCLUDED.email_verified, last_used_at = EXCLUDED.last_used_at`;
    return;
  }
  await db`
    INSERT INTO auth_identities (user_id, provider, provider_subject, email, email_verified, last_used_at)
    VALUES (${i.userId}, ${i.provider}, ${i.subject}, ${i.email}, ${i.emailVerified}, ${i.now})
    ON CONFLICT (provider, provider_subject) DO UPDATE
       SET email = coalesce(EXCLUDED.email, auth_identities.email),
           email_verified = EXCLUDED.email_verified OR auth_identities.email_verified,
           last_used_at = EXCLUDED.last_used_at`;
}

export async function findSocialIdentity(db: Db, provider: 'GOOGLE' | 'APPLE', subject: string) {
  const [r] = await db<{ user_id: string }[]>`
    SELECT user_id FROM auth_identities WHERE provider = ${provider} AND provider_subject = ${subject} FOR UPDATE`;
  return r?.user_id ?? null;
}

// ------------------------------------------------------------------ sessions
export async function listSessions(db: Db, userId: string, now: Date) {
  return db<{ family_id: string; created_at: Date; last_active_at: Date; expires_at: Date; device_id: string | null; user_agent: string | null; platform: string | null; app_version: string | null }[]>`
    WITH fam AS (
      SELECT family_id,
             min(created_at) AS created_at,
             max(created_at) AS last_active_at,
             max(expires_at) FILTER (WHERE revoked_at IS NULL) AS expires_at,
             (array_agg(device_id ORDER BY created_at DESC))[1] AS device_id,
             (array_agg(user_agent ORDER BY created_at DESC))[1] AS user_agent
        FROM refresh_tokens WHERE user_id = ${userId}
       GROUP BY family_id
      HAVING bool_or(revoked_at IS NULL AND expires_at > ${now}))
    SELECT fam.*, d.platform, d.app_version
      FROM fam LEFT JOIN devices d ON d.id = fam.device_id
     ORDER BY fam.last_active_at DESC`;
}

export async function sessionBelongsTo(db: Db, userId: string, familyId: string): Promise<boolean> {
  const [r] = await db<{ ok: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM refresh_tokens WHERE user_id = ${userId} AND family_id = ${familyId} AND revoked_at IS NULL) AS ok`;
  return !!r?.ok;
}

// ------------------------------------------------------------------ MFA
export interface MfaFactorRow {
  id: string;
  secret_enc: Buffer;
  confirmed_at: Date | null;
  last_used_step: number | null;
}

export async function activeFactor(db: Db, userId: string, lock = false) {
  const [r] = lock
    ? await db<MfaFactorRow[]>`SELECT id, secret_enc, confirmed_at, last_used_step FROM mfa_factors
                                 WHERE user_id = ${userId} AND type = 'TOTP' AND disabled_at IS NULL FOR UPDATE`
    : await db<MfaFactorRow[]>`SELECT id, secret_enc, confirmed_at, last_used_step FROM mfa_factors
                                 WHERE user_id = ${userId} AND type = 'TOTP' AND disabled_at IS NULL`;
  return r;
}

export async function recentMfaFailures(db: Db, userId: string, since: Date): Promise<number> {
  const [r] = await db<{ n: number }[]>`
    SELECT count(*)::int AS n FROM security_events WHERE user_id = ${userId} AND type = 'MFA_FAILED' AND created_at >= ${since}`;
  return r?.n ?? 0;
}
