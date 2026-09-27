/**
 * Data export (UU PDP right of access). Contains the requesting user's own data only:
 * no other user's identifiers or PII (counterparties are omitted, received ratings carry scores only).
 * KYC identity numbers are masked; secrets/hashes/ciphertext are never exported.
 */
import type { AppDeps } from '../../context';
import type { Db } from '../../db/sql';
import { iso, u8 } from '../auth/common';

const isoRows = <T extends Record<string, unknown>>(rows: readonly T[]) =>
  rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()), v instanceof Date ? v.toISOString() : v])));

export async function buildExport(deps: AppDeps, db: Db, userId: string) {
  const [profile] = await db`
    SELECT id, email, email_verified_at, phone_e164 AS phone, phone_verified_at, display_name, locale, country_code, status,
           kyc_level, active_mode, trust_score, referral_code, transaction_email, created_at, last_login_at
      FROM users WHERE id = ${userId}`;
  const identities = await db`SELECT provider, email, email_verified, created_at, last_used_at FROM auth_identities WHERE user_id = ${userId} ORDER BY created_at`;
  const devices = await db`
    SELECT d.platform, d.app_version, d.os_version, ud.first_seen_at, ud.last_seen_at, ud.revoked_at
      FROM user_devices ud JOIN devices d ON d.id = ud.device_id WHERE ud.user_id = ${userId} ORDER BY ud.first_seen_at`;
  const sessions = await db`
    SELECT family_id AS session_id, min(created_at) AS created_at, max(expires_at) AS expires_at, bool_and(revoked_at IS NOT NULL) AS ended
      FROM refresh_tokens WHERE user_id = ${userId} GROUP BY family_id ORDER BY 2`;
  const consents = await db`SELECT type, version, granted, source, created_at FROM consents WHERE user_id = ${userId} ORDER BY created_at, id`;
  const privacyRequests = await db`SELECT id, type, status, created_at, scheduled_for, completed_at FROM privacy_requests WHERE user_id = ${userId} ORDER BY created_at`;
  const kycSubmissions = await db`
    SELECT id, target_level, id_type, status, submitted_at, reviewed_at, decision_reason FROM kyc_submissions WHERE user_id = ${userId} ORDER BY created_at`;
  const [ir] = await db<{ id: string; id_type: string; id_number_enc: Buffer; full_name_enc: Buffer; dob_enc: Buffer | null; nationality: string | null; verified_at: Date | null }[]>`
    SELECT id, id_type, id_number_enc, full_name_enc, dob_enc, nationality, verified_at FROM identity_records WHERE user_id = ${userId}`;
  let identity: Record<string, unknown> | null = null;
  if (ir) {
    const num = await deps.crypto.decryptString(u8(ir.id_number_enc), `identity_records.id_number:${ir.id}`);
    identity = {
      idType: ir.id_type,
      idNumberMasked: `${'*'.repeat(Math.max(0, num.length - 4))}${num.slice(-4)}`,
      fullName: await deps.crypto.decryptString(u8(ir.full_name_enc), `identity_records.full_name:${ir.id}`),
      dateOfBirth: ir.dob_enc ? await deps.crypto.decryptString(u8(ir.dob_enc), `identity_records.dob:${ir.id}`) : null,
      nationality: ir.nationality?.trim() ?? null,
      verifiedAt: iso(ir.verified_at),
    };
  }
  const payoutAccounts = await db`
    SELECT bank_code, account_mask, holder_name, verification_status, is_default, created_at, disabled_at FROM payout_accounts WHERE user_id = ${userId} ORDER BY created_at`;
  const transactions = await db`
    SELECT id, number, CASE WHEN buyer_id = ${userId} THEN 'BUYER' ELSE 'TRAVELER' END AS role, status, total_idr, created_at, completed_at, cancelled_at
      FROM transactions WHERE buyer_id = ${userId} OR traveler_id = ${userId} ORDER BY created_at`;
  const requests = await db`
    SELECT id, product_name, product_url, merchant_name, merchant_country, quantity, status, created_at FROM requests WHERE buyer_id = ${userId} ORDER BY created_at`;
  const trips = await db`
    SELECT id, origin_country, origin_city, destination_country, destination_city, departure_date, arrival_date, status, created_at
      FROM trips WHERE traveler_id = ${userId} ORDER BY created_at`;
  const messagesSent = await db`
    SELECT conversation_id, type, body, created_at FROM messages WHERE sender_id = ${userId} AND deleted_at IS NULL ORDER BY created_at`;
  const ratingsGiven = await db`
    SELECT transaction_id, direction, overall, communication, accuracy, timeliness, comment, created_at FROM ratings WHERE rater_id = ${userId} ORDER BY created_at`;
  const ratingsReceived = await db`
    SELECT transaction_id, direction, overall, communication, accuracy, timeliness, created_at FROM ratings WHERE ratee_id = ${userId} AND status = 'PUBLISHED' ORDER BY created_at`;
  const credits = await db`SELECT amount_idr, reason, expires_at, created_at FROM credit_entries WHERE user_id = ${userId} ORDER BY created_at`;
  const securityEvents = await db`
    SELECT type, severity, created_at FROM security_events WHERE user_id = ${userId} AND created_at >= ${new Date(deps.clock.now().getTime() - 365 * 86400_000)} ORDER BY created_at`;

  return {
    format: 'jastipkita-data-export/v1',
    generatedAt: deps.clock.now().toISOString(),
    notes: [
      'Berisi data pribadi Anda di JastipKita. Data pengguna lain (lawan transaksi) tidak disertakan.',
      'Nomor identitas ditampilkan tersamar; data rekening hanya dalam bentuk mask.',
    ],
    profile: profile ? isoRows([profile as Record<string, unknown>])[0] : null,
    identities: isoRows(identities),
    devices: isoRows(devices),
    sessions: isoRows(sessions),
    consents: isoRows(consents),
    privacyRequests: isoRows(privacyRequests),
    kycSubmissions: isoRows(kycSubmissions),
    identity,
    payoutAccounts: isoRows(payoutAccounts),
    transactions: isoRows(transactions),
    requests: isoRows(requests),
    trips: isoRows(trips),
    messagesSent: isoRows(messagesSent),
    ratingsGiven: isoRows(ratingsGiven),
    ratingsReceived: isoRows(ratingsReceived),
    credits: isoRows(credits),
    securityEvents: isoRows(securityEvents),
  };
}
