import type { AppDeps } from '../../context';
import type { Db } from '../../db/sql';
import { Errors } from '../../lib/errors';
import { buf, iso, type RequestMeta } from '../auth/common';
import type { ConsentInput, DeviceInput, Profile } from './schemas';

interface ProfileRow {
  id: string;
  email: string | null;
  email_verified_at: Date | null;
  phone_e164: string | null;
  phone_verified_at: Date | null;
  display_name: string | null;
  avatar_file_id: string | null;
  locale: 'id' | 'en';
  country_code: string | null;
  status: Profile['status'];
  kyc_level: number;
  active_mode: Profile['activeMode'];
  trust_score: number;
  referral_code: string;
  transaction_email: string | null;
  created_at: Date;
  roles: string[];
  permissions: string[];
  mfa_enabled: boolean;
  deletion_scheduled_for: Date | null;
}

export async function loadProfile(db: Db, userId: string): Promise<Profile> {
  const [r] = await db<ProfileRow[]>`
    SELECT u.id, u.email, u.email_verified_at, u.phone_e164, u.phone_verified_at, u.display_name, u.avatar_file_id,
           u.locale, u.country_code, u.status, u.kyc_level, u.active_mode, u.trust_score, u.referral_code,
           u.transaction_email, u.created_at,
           coalesce((SELECT array_agg(ur.role_code ORDER BY ur.role_code) FROM user_roles ur
                      WHERE ur.user_id = u.id AND ur.revoked_at IS NULL), '{}') AS roles,
           coalesce((SELECT array_agg(DISTINCT rp.permission_code ORDER BY rp.permission_code)
                       FROM user_roles ur JOIN role_permissions rp ON rp.role_code = ur.role_code
                      WHERE ur.user_id = u.id AND ur.revoked_at IS NULL), '{}') AS permissions,
           EXISTS (SELECT 1 FROM mfa_factors m WHERE m.user_id = u.id AND m.confirmed_at IS NOT NULL AND m.disabled_at IS NULL) AS mfa_enabled,
           (SELECT pr.scheduled_for FROM privacy_requests pr
             WHERE pr.user_id = u.id AND pr.type = 'DELETION' AND pr.status = 'IN_PROGRESS'
             ORDER BY pr.created_at DESC LIMIT 1) AS deletion_scheduled_for
      FROM users u WHERE u.id = ${userId}`;
  if (!r) throw Errors.notFound('Pengguna', 'USER_NOT_FOUND');
  return {
    id: r.id,
    email: r.email,
    emailVerified: r.email_verified_at !== null,
    phone: r.phone_e164,
    phoneVerified: r.phone_verified_at !== null,
    displayName: r.display_name,
    avatarFileId: r.avatar_file_id,
    locale: r.locale,
    countryCode: r.country_code ? r.country_code.trim() : null,
    status: r.status,
    kycLevel: r.kyc_level,
    activeMode: r.active_mode,
    trustScore: r.trust_score,
    referralCode: r.referral_code,
    transactionEmail: r.transaction_email,
    roles: r.roles,
    permissions: r.permissions,
    mfaEnabled: r.mfa_enabled,
    deletionScheduledFor: iso(r.deletion_scheduled_for),
    createdAt: iso(r.created_at)!,
  };
}

// ------------------------------------------------------------------ devices
export async function fingerprintHash(deps: AppDeps, fingerprint: string): Promise<Uint8Array> {
  return deps.crypto.hashIdentifier('device', fingerprint.trim());
}

/** Upserts the device (keyed by fingerprint HMAC) and links it to the user. Returns the device id. */
export async function upsertUserDevice(deps: AppDeps, db: Db, userId: string, d: DeviceInput): Promise<string> {
  const now = deps.clock.now();
  const fp = buf(await fingerprintHash(deps, d.fingerprint));
  const pushToken = d.pushToken ?? null;
  const [row] = await db<{ id: string }[]>`
    INSERT INTO devices (fingerprint_hash, platform, push_token, push_token_updated_at, app_version, os_version, first_seen_at, last_seen_at)
    VALUES (${fp}, ${d.platform}, ${pushToken}, ${pushToken ? now : null}, ${d.appVersion ?? null}, ${d.osVersion ?? null}, ${now}, ${now})
    ON CONFLICT (fingerprint_hash) DO UPDATE
       SET platform = EXCLUDED.platform,
           app_version = coalesce(EXCLUDED.app_version, devices.app_version),
           os_version = coalesce(EXCLUDED.os_version, devices.os_version),
           push_token = CASE WHEN ${d.pushToken !== undefined} THEN EXCLUDED.push_token ELSE devices.push_token END,
           push_token_updated_at = CASE WHEN ${d.pushToken !== undefined} THEN ${now}::timestamptz ELSE devices.push_token_updated_at END,
           last_seen_at = EXCLUDED.last_seen_at
    RETURNING id`;
  const deviceId = row!.id;
  if (pushToken) {
    // a push token belongs to exactly one app install
    await db`UPDATE devices SET push_token = NULL, push_token_updated_at = ${now} WHERE push_token = ${pushToken} AND id <> ${deviceId}`;
  }
  await db`
    INSERT INTO user_devices (user_id, device_id, first_seen_at, last_seen_at)
    VALUES (${userId}, ${deviceId}, ${now}, ${now})
    ON CONFLICT (user_id, device_id) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at, revoked_at = NULL`;
  return deviceId;
}

export async function listDevices(db: Db, userId: string) {
  const rows = await db<{ id: string; platform: 'IOS' | 'ANDROID' | 'WEB'; app_version: string | null; os_version: string | null; push: boolean; first_seen_at: Date; last_seen_at: Date }[]>`
    SELECT d.id, d.platform, d.app_version, d.os_version, (d.push_token IS NOT NULL) AS push, ud.first_seen_at, ud.last_seen_at
      FROM user_devices ud JOIN devices d ON d.id = ud.device_id
     WHERE ud.user_id = ${userId} AND ud.revoked_at IS NULL
     ORDER BY ud.last_seen_at DESC`;
  return rows.map((r) => ({
    id: r.id,
    platform: r.platform,
    appVersion: r.app_version,
    osVersion: r.os_version,
    pushEnabled: r.push,
    firstSeenAt: iso(r.first_seen_at)!,
    lastSeenAt: iso(r.last_seen_at)!,
  }));
}

export async function unlinkDevice(deps: AppDeps, db: Db, userId: string, deviceId: string): Promise<boolean> {
  const now = deps.clock.now();
  const r = await db`UPDATE user_devices SET revoked_at = ${now} WHERE user_id = ${userId} AND device_id = ${deviceId} AND revoked_at IS NULL RETURNING device_id`;
  if (!r.length) return false;
  // stop pushes to this install unless another active account still uses it
  await db`UPDATE devices SET push_token = NULL, push_token_updated_at = ${now}
            WHERE id = ${deviceId}
              AND NOT EXISTS (SELECT 1 FROM user_devices WHERE device_id = ${deviceId} AND revoked_at IS NULL)`;
  // sessions bound to the device end too
  await db`UPDATE refresh_tokens SET revoked_at = ${now}, revoked_reason = 'LOGOUT'
            WHERE user_id = ${userId} AND device_id = ${deviceId} AND revoked_at IS NULL`;
  return true;
}

// ------------------------------------------------------------------ consents
export const SIGNUP_REQUIRED_CONSENTS = ['TOS', 'PRIVACY'] as const;
/** Optional at signup (asked, may be declined). */
export const SIGNUP_OPTIONAL_CONSENTS = ['MARKETING'] as const;
/** Required before POST /kyc/submissions (explicit, separate consent for identity & biometric data). */
export const KYC_REQUIRED_CONSENTS = ['KYC'] as const;

/**
 * Consent versions accepted by POST /me/consents (and signup): every published, non-retired legal document version of
 * the type, newest first. Empty = the type has no published document yet → any version string is accepted.
 * GET /v1/consents/requirements exposes exactly this list so clients always submit an accepted version.
 */
export async function acceptedConsentVersions(db: Db, type: string): Promise<string[]> {
  const rows = await db<{ version: string }[]>`
    SELECT version FROM legal_documents WHERE type = ${type} AND published_at IS NOT NULL AND retired_at IS NULL
     GROUP BY version ORDER BY max(published_at) DESC, version DESC`;
  return rows.map((r) => r.version);
}

/** A version is acceptable if it is a published, non-retired legal document version (when any exist for the type). */
export async function assertConsentVersion(db: Db, type: string, version: string): Promise<void> {
  if (!['TOS', 'PRIVACY', 'KYC', 'MARKETING', 'COOKIES', 'TRAVELER_AGREEMENT', 'PAYMENT_TERMS'].includes(type)) return;
  const allowedVersions = await acceptedConsentVersions(db, type);
  if (allowedVersions.length && !allowedVersions.includes(version)) {
    throw Errors.unprocessable('CONSENT_VERSION_INVALID', 'Versi dokumen persetujuan tidak berlaku', { type, allowedVersions });
  }
}

export async function insertConsents(
  deps: AppDeps,
  db: Db,
  userId: string,
  consents: ConsentInput[],
  meta: { req?: RequestMeta | null; locale?: 'id' | 'en' | null; source?: 'APP' | 'WEB' | 'ADMIN' | 'API' },
) {
  const out: { id: number; type: ConsentInput['type']; version: string; granted: boolean; source: string; createdAt: string }[] = [];
  for (const c of consents) {
    await assertConsentVersion(db, c.type, c.version);
    const [row] = await db<{ id: number; created_at: Date; source: string }[]>`
      INSERT INTO consents (user_id, type, version, granted, locale, source, ip_hash, user_agent, created_at)
      VALUES (${userId}, ${c.type}, ${c.version}, ${c.granted}, ${meta.locale ?? null}, ${meta.source ?? 'APP'},
              ${meta.req?.ipHash ? buf(meta.req.ipHash) : null}, ${meta.req?.userAgent ?? null}, ${deps.clock.now()})
      RETURNING id, created_at, source`;
    out.push({ id: row!.id, type: c.type, version: c.version, granted: c.granted, source: row!.source, createdAt: iso(row!.created_at)! });
  }
  return out;
}

export async function hasGrantedConsent(db: Db, userId: string, type: string): Promise<boolean> {
  const [r] = await db<{ granted: boolean }[]>`SELECT granted FROM v_user_consents_current WHERE user_id = ${userId} AND type = ${type}`;
  return !!r?.granted;
}

export async function consentOverview(db: Db, userId: string) {
  const current = await db<{ type: ConsentInput['type']; version: string; granted: boolean; decided_at: Date }[]>`
    SELECT type, version, granted, decided_at FROM v_user_consents_current WHERE user_id = ${userId} ORDER BY type`;
  const history = await db<{ id: number; type: ConsentInput['type']; version: string; granted: boolean; source: string; created_at: Date }[]>`
    SELECT id, type, version, granted, source, created_at FROM consents WHERE user_id = ${userId} ORDER BY created_at DESC, id DESC LIMIT 200`;
  return {
    current: current.map((c) => ({ type: c.type, version: c.version, granted: c.granted, decidedAt: iso(c.decided_at)! })),
    history: history.map((h) => ({ id: h.id, type: h.type, version: h.version, granted: h.granted, source: h.source, createdAt: iso(h.created_at)! })),
    requiredAtSignup: [...SIGNUP_REQUIRED_CONSENTS],
  };
}

/** Returns the missing required signup consents (TOS + PRIVACY must be granted). */
export function missingSignupConsents(consents: ConsentInput[] | undefined): string[] {
  const granted = new Set((consents ?? []).filter((c) => c.granted).map((c) => c.type));
  return SIGNUP_REQUIRED_CONSENTS.filter((t) => !granted.has(t));
}
