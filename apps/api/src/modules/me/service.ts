import type { AppDeps, AuthContext } from '../../context';
import { Errors } from '../../lib/errors';
import { normalizeEmail, securityEvent, type RequestMeta } from '../auth/common';
import { inTx } from '../auth/repository';
import { createOtpChallenge } from '../auth/service';
import * as repo from './repository';
import type { ConsentInput, DeviceInput, Profile } from './schemas';

export async function getMe(deps: AppDeps, auth: AuthContext) {
  const profile = await repo.loadProfile(deps.sql, auth.userId);
  return {
    ...profile,
    adminMfaPolicy: profile.roles.length
      ? { stepUpSec: deps.env.ADMIN_MFA_STEP_UP_SEC, sessionMaxAgeSec: deps.env.ADMIN_SESSION_MFA_MAX_AGE_SEC }
      : null,
  };
}

export interface PatchMeInput {
  displayName?: string | null | undefined;
  locale?: 'id' | 'en' | undefined;
  countryCode?: string | null | undefined;
  transactionEmail?: string | null | undefined;
  avatarFileId?: string | null | undefined;
}

/**
 * Profile update. `transactionEmail` is NOT applied directly (unless it equals the already-verified login
 * e-mail or is cleared): an e-mail OTP (purpose VERIFY_EMAIL) is sent to the new address and the change is
 * applied by POST /v1/auth/otp/verify. Google/Apple login e-mail need not be the transaction e-mail.
 */
export async function patchMe(deps: AppDeps, auth: AuthContext, input: PatchMeInput, req: RequestMeta) {
  // 1. decide whether the transaction e-mail needs an OTP — and send it FIRST, so a cooldown/rate-limit
  //    error (429) does not leave the rest of the PATCH half-applied
  let applyEmailNow: string | null | undefined; // undefined = untouched
  let pendingVerification = null;
  if (input.transactionEmail !== undefined) {
    const [u] = await deps.sql<{ email: string | null; email_verified_at: Date | null; transaction_email: string | null }[]>`
      SELECT email, email_verified_at, transaction_email FROM users WHERE id = ${auth.userId}`;
    if (!u) throw Errors.notFound('Pengguna', 'USER_NOT_FOUND');
    if (input.transactionEmail === null) applyEmailNow = null;
    else {
      const email = normalizeEmail(input.transactionEmail);
      if (!email) throw Errors.badRequest('INVALID_DESTINATION', 'Alamat e-mail tidak valid');
      if (email === u.transaction_email) {
        // unchanged
      } else if (u.email === email && u.email_verified_at) {
        applyEmailNow = email; // already verified as the login e-mail
      } else {
        const ch = await createOtpChallenge(deps, { channel: 'EMAIL', destination: email, purpose: 'VERIFY_EMAIL', userId: auth.userId }, req);
        pendingVerification = {
          challengeId: ch.challengeId,
          channel: 'EMAIL' as const,
          purpose: 'VERIFY_EMAIL' as const,
          expiresAt: ch.expiresAt,
          ...(ch.devCode ? { devCode: ch.devCode } : {}),
        };
      }
    }
  }
  // 2. apply the plain fields atomically
  await inTx(deps, async (tx) => {
    if (input.displayName !== undefined) await tx`UPDATE users SET display_name = ${input.displayName} WHERE id = ${auth.userId}`;
    if (input.locale !== undefined) await tx`UPDATE users SET locale = ${input.locale} WHERE id = ${auth.userId}`;
    if (input.countryCode !== undefined) {
      if (input.countryCode) {
        const [c] = await tx`SELECT 1 FROM countries WHERE code = ${input.countryCode}`;
        if (!c) throw Errors.unprocessable('COUNTRY_INVALID', 'Kode negara tidak dikenal');
      }
      await tx`UPDATE users SET country_code = ${input.countryCode} WHERE id = ${auth.userId}`;
    }
    if (input.avatarFileId !== undefined) {
      if (input.avatarFileId) {
        const [f] = await tx<{ ok: boolean }[]>`
          SELECT true AS ok FROM files WHERE id = ${input.avatarFileId} AND owner_id = ${auth.userId} AND purpose = 'AVATAR'
             AND scan_status = 'CLEAN' AND completed_at IS NOT NULL AND deleted_at IS NULL`;
        if (!f) throw Errors.unprocessable('AVATAR_FILE_INVALID', 'Foto profil belum diunggah atau tidak valid');
      }
      await tx`UPDATE users SET avatar_file_id = ${input.avatarFileId} WHERE id = ${auth.userId}`;
    }
    if (applyEmailNow !== undefined) {
      await tx`UPDATE users SET transaction_email = ${applyEmailNow} WHERE id = ${auth.userId}`;
      await securityEvent(deps, tx, { userId: auth.userId, type: 'TRANSACTION_EMAIL_CHANGED', req, meta: { via: applyEmailNow ? 'LOGIN_EMAIL' : 'CLEARED' } });
    }
  });
  return { user: await repo.loadProfile(deps.sql, auth.userId), pendingVerification };
}

/** Mode switch is always allowed; traveler capabilities are gated by KYC level where they are used. */
export async function switchMode(deps: AppDeps, auth: AuthContext, mode: Profile['activeMode']) {
  await deps.sql`UPDATE users SET active_mode = ${mode} WHERE id = ${auth.userId}`;
  return repo.loadProfile(deps.sql, auth.userId);
}

export async function registerDevice(deps: AppDeps, auth: AuthContext, d: DeviceInput) {
  const id = await inTx(deps, (tx) => repo.upsertUserDevice(deps, tx, auth.userId, d));
  const all = await repo.listDevices(deps.sql, auth.userId);
  return all.find((x) => x.id === id)!;
}

export const listDevices = (deps: AppDeps, auth: AuthContext) => repo.listDevices(deps.sql, auth.userId);

export async function removeDevice(deps: AppDeps, auth: AuthContext, deviceId: string, req: RequestMeta) {
  await inTx(deps, async (tx) => {
    if (!(await repo.unlinkDevice(deps, tx, auth.userId, deviceId))) throw Errors.notFound('Perangkat', 'DEVICE_NOT_FOUND');
    await securityEvent(deps, tx, { userId: auth.userId, type: 'DEVICE_REMOVED', deviceId, req, meta: {} });
  });
}

export const consents = (deps: AppDeps, auth: AuthContext) => repo.consentOverview(deps.sql, auth.userId);

/** Consents are append-only and versioned: every decision is a new row (withdrawal = granted:false). */
export async function recordConsent(deps: AppDeps, auth: AuthContext, c: ConsentInput, req: RequestMeta, locale?: 'id' | 'en') {
  const [row] = await inTx(deps, (tx) => repo.insertConsents(deps, tx, auth.userId, [c], { req, locale: locale ?? null, source: 'APP' }));
  return row!;
}
