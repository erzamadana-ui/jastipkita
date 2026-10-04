/**
 * Authentication: passwordless OTP (SMS / WhatsApp / e-mail), Google & Apple sign-in, sessions
 * (refresh rotation via services/session.ts), admin TOTP MFA with step-up.
 *
 * Invariants:
 *  - OTP codes are stored only as HMAC(pepper, "otp:<challengeId>:<code>"); destinations as HMAC + AES-GCM ciphertext.
 *  - Responses to /auth/otp/request are identical whether or not an account exists (no enumeration).
 *  - Failures that must be remembered (attempt counters, security events, risk records) are COMMITTED:
 *    transactions return an outcome and the error is thrown after commit.
 *  - Registration ≠ KYC: new accounts start at level 1; a verified phone raises them to level 2.
 */
import type { AppDeps, AuthContext } from '../../context';
import type { TxSql } from '../../db/sql';
import { generateTotpSecret, numericCode, randomBytes, sha256, timingSafeEqual, totpUri, verifyTotp, base32Encode } from '../../lib/crypto';
import { AppError, Errors } from '../../lib/errors';
import { audit } from '../../services/audit';
import { emitEvent } from '../../services/outbox';
import {
  findRefreshTokenSession,
  issueSession,
  markSessionMfaVerified,
  revokeSession,
  rotateRefreshToken,
  sessionOrigin,
  signAccessToken,
  type IssuedSession,
} from '../../services/session';
import { recomputeKycLevel } from '../kyc/level';
import { fingerprintHash, insertConsents, loadProfile, missingSignupConsents, upsertUserDevice } from '../me/repository';
import type { ConsentInput, DeviceInput, Profile } from '../me/schemas';
import { buf, normalizeEmail, normalizePhone, SECURITY, securityEvent, u8, type RequestMeta } from './common';
import { nonceRequired, OAuthVerificationError, verifyIdToken, type OAuthProvider, type VerifiedIdentity } from './oauth';
import * as repo from './repository';
import { inTx } from './repository';
import { assessSignup, recordSignupRisk } from './risk';

export interface AuthCallCtx {
  auth?: AuthContext | undefined;
  req: RequestMeta;
}

export type Channel = 'SMS' | 'WHATSAPP' | 'EMAIL';
export type OtpPurpose = 'LOGIN' | 'VERIFY_PHONE' | 'VERIFY_EMAIL' | 'SENSITIVE_ACTION';
/** SEC-12: money-routing changes guarded by a SENSITIVE_ACTION step-up OTP (bound to action + target id). */
export type SensitiveActionCode = 'REFUND_DESTINATION_SET' | 'PAYOUT_ACCOUNT_ADD' | 'PAYOUT_ACCOUNT_SET_DEFAULT';
const SENSITIVE_ACTION_TEXT: Record<SensitiveActionCode, { id: string; en: string }> = {
  REFUND_DESTINATION_SET: { id: 'mengatur rekening tujuan refund', en: 'set a refund bank account' },
  PAYOUT_ACCOUNT_ADD: { id: 'menambah rekening pencairan', en: 'add a payout bank account' },
  PAYOUT_ACCOUNT_SET_DEFAULT: { id: 'mengganti rekening pencairan utama', en: 'change your main payout account' },
};

type Outcome<T> = { ok: true; value: T } | { ok: false; error: AppError };
const ok = <T>(value: T): Outcome<T> => ({ ok: true, value });
const fail = <T>(error: AppError): Outcome<T> => ({ ok: false, error });
const unwrap = <T>(o: Outcome<T>): T => {
  if (!o.ok) throw o.error;
  return o.value;
};

export function tokensOf(s: IssuedSession) {
  return {
    tokenType: 'Bearer' as const,
    accessToken: s.accessToken,
    accessTokenExpiresAt: s.accessTokenExpiresAt,
    refreshToken: s.refreshToken,
    refreshTokenExpiresAt: s.refreshTokenExpiresAt,
    sessionId: s.sessionId,
  };
}
export type Tokens = ReturnType<typeof tokensOf>;

const OTP_INVALID = () => Errors.badRequest('OTP_INVALID', 'Kode verifikasi salah atau sudah tidak berlaku');
const OTP_LOCKED = () => new AppError(429, 'OTP_LOCKED', 'Terlalu banyak percobaan. Silakan minta kode baru.');

// =================================================================== OTP request
export interface OtpChallengeResult {
  challengeId: string;
  expiresAt: string;
  resendAvailableAt: string;
  devCode?: string;
}

export function normalizeDestination(channel: Channel, destination: string): string {
  const v = channel === 'EMAIL' ? normalizeEmail(destination) : normalizePhone(destination);
  if (!v) {
    throw Errors.badRequest(
      'INVALID_DESTINATION',
      channel === 'EMAIL' ? 'Alamat e-mail tidak valid' : 'Nomor HP tidak valid (gunakan format +62… atau 08…)',
    );
  }
  return v;
}

/**
 * Creates (and delivers) an OTP challenge. Enforces DB-backed limits: 60 s cooldown per destination,
 * 5/hour and 10/day per destination, 20/hour per IP. Serialized per destination with an advisory lock.
 */
export async function createOtpChallenge(
  deps: AppDeps,
  input: {
    channel: Channel;
    destination: string;
    purpose: OtpPurpose;
    userId: string | null;
    locale?: 'id' | 'en' | undefined;
    action?: SensitiveActionCode | undefined;
    targetId?: string | undefined;
  },
  req: RequestMeta,
): Promise<OtpChallengeResult> {
  const { channel, destination, purpose } = input;
  const ttlSec = purpose === 'SENSITIVE_ACTION' ? SECURITY.SENSITIVE_OTP_TTL_SEC : SECURITY.OTP_TTL_SEC;
  const now = deps.clock.now();
  const destHash = await deps.crypto.hashIdentifier(channel === 'EMAIL' ? 'email' : 'phone', destination);
  const id = crypto.randomUUID();
  const code = numericCode(6);
  const codeHash = await deps.crypto.hashIdentifier('otp', `${id}:${code}`);
  const destEnc = await deps.crypto.encrypt(destination, `otp_challenges.destination:${id}`);
  const expiresAt = new Date(now.getTime() + ttlSec * 1000);

  const outcome = await inTx(deps, async (tx): Promise<Outcome<null>> => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${Buffer.from(destHash).toString('hex')}, 7270))`;
    const s = await repo.otpStats(tx, destHash, req.ipHash, now);
    const limited = (scope: string, code2: string, retryAfterSec: number, message: string) => ({ scope, code2, retryAfterSec: Math.max(1, Math.ceil(retryAfterSec)), message });
    let hit: ReturnType<typeof limited> | null = null;
    if (s.last && now.getTime() - s.last.getTime() < SECURITY.OTP_RESEND_COOLDOWN_SEC * 1000) {
      hit = limited('COOLDOWN', 'OTP_COOLDOWN', SECURITY.OTP_RESEND_COOLDOWN_SEC - (now.getTime() - s.last.getTime()) / 1000, 'Tunggu sebentar sebelum meminta kode baru');
    } else if (s.hour >= SECURITY.OTP_MAX_PER_DESTINATION_HOUR) {
      hit = limited('DESTINATION_HOUR', 'OTP_RATE_LIMITED', (s.oldestHour!.getTime() + 3600_000 - now.getTime()) / 1000, 'Terlalu banyak permintaan kode. Coba lagi nanti.');
    } else if (s.day >= SECURITY.OTP_MAX_PER_DESTINATION_DAY) {
      hit = limited('DESTINATION_DAY', 'OTP_RATE_LIMITED', (s.oldestDay!.getTime() + 86400_000 - now.getTime()) / 1000, 'Terlalu banyak permintaan kode. Coba lagi nanti.');
    } else if (s.ipHour >= SECURITY.OTP_MAX_PER_IP_HOUR) {
      hit = limited('IP_HOUR', 'OTP_RATE_LIMITED', (s.ipOldest!.getTime() + 3600_000 - now.getTime()) / 1000, 'Terlalu banyak permintaan kode. Coba lagi nanti.');
    }
    if (hit) {
      if (hit.scope !== 'COOLDOWN') {
        await securityEvent(deps, tx, { userId: input.userId, type: 'OTP_RATE_LIMITED', severity: 'MEDIUM', req, meta: { scope: hit.scope, purpose, channel } });
      }
      return fail(new AppError(429, hit.code2, hit.message, { retryAfterSec: hit.retryAfterSec }));
    }
    await repo.insertOtp(tx, {
      id,
      userId: input.userId,
      channel,
      destHash,
      destEnc,
      encKeyId: deps.crypto.activeKeyId,
      purpose,
      codeHash,
      maxAttempts: SECURITY.OTP_MAX_ATTEMPTS,
      expiresAt,
      ipHash: req.ipHash,
      now,
      action: input.action ?? null,
      targetId: input.targetId ?? null,
    });
    return ok(null);
  });
  unwrap(outcome);

  // Delivery is synchronous by nature (the user is waiting for the code) — the one place the identity
  // module talks to SMS/e-mail providers directly instead of going through outbox notifications.
  const en = input.locale === 'en';
  const minutes = Math.round(ttlSec / 60);
  const what = input.action ? SENSITIVE_ACTION_TEXT[input.action] : null;
  const text = what
    ? en
      ? `JastipKita: code ${code} to ${what.en}. Valid for ${minutes} minutes. Not you? Do not share it, change nothing, and contact JastipKita support.`
      : `JastipKita: kode ${code} untuk ${what.id}. Berlaku ${minutes} menit. Bukan kamu? JANGAN berikan kode ini dan segera hubungi CS JastipKita.`
    : en
      ? `JastipKita: your verification code is ${code}. Valid for ${minutes} minutes. Never share this code with anyone, including JastipKita staff.`
      : `JastipKita: kode verifikasi Anda ${code}. Berlaku ${minutes} menit. JANGAN berikan kode ini kepada siapa pun, termasuk pihak yang mengaku dari JastipKita.`;
  try {
    if (channel === 'EMAIL') {
      await deps.providers.email.send({
        to: destination,
        subject: en ? 'Your JastipKita verification code' : 'Kode verifikasi JastipKita',
        text,
        html: `<p>${en ? 'Your verification code' : 'Kode verifikasi Anda'}:</p><p style="font-size:24px;font-weight:600;letter-spacing:4px">${code}</p><p>${what ? (en ? `To ${what.en}. ` : `Untuk ${what.id}. `) : ''}${en ? `Valid for ${minutes} minutes. Never share this code.` : `Berlaku ${minutes} menit. Jangan bagikan kode ini kepada siapa pun.`}</p>`,
        tags: { category: 'otp', purpose },
        idempotencyKey: `otp:${id}`,
      });
    } else {
      await deps.providers.sms.send({ to: destination, body: text, channel });
    }
  } catch (err) {
    deps.logger.error('otp.delivery_failed', { challengeId: id, channel, error: err instanceof Error ? err.message : String(err) });
    await deps.sql`DELETE FROM otp_challenges WHERE id = ${id}`;
    throw Errors.unavailable('OTP_DELIVERY_FAILED', 'Kode verifikasi gagal dikirim, silakan coba lagi');
  }

  return {
    challengeId: id,
    expiresAt: expiresAt.toISOString(),
    resendAvailableAt: new Date(now.getTime() + SECURITY.OTP_RESEND_COOLDOWN_SEC * 1000).toISOString(),
    ...(deps.env.OTP_DEV_ECHO ? { devCode: code } : {}),
  };
}

export async function requestOtp(
  deps: AppDeps,
  body: {
    channel: Channel;
    destination: string;
    purpose: OtpPurpose;
    locale?: 'id' | 'en' | undefined;
    action?: SensitiveActionCode | undefined;
    targetId?: string | undefined;
  },
  ctx: AuthCallCtx,
): Promise<OtpChallengeResult> {
  if (body.purpose === 'SENSITIVE_ACTION') return requestSensitiveActionOtp(deps, body, ctx);
  if (body.purpose === 'VERIFY_PHONE' && body.channel === 'EMAIL') throw Errors.badRequest('OTP_CHANNEL_INVALID', 'Verifikasi HP memakai SMS atau WhatsApp');
  if (body.purpose === 'VERIFY_EMAIL' && body.channel !== 'EMAIL') throw Errors.badRequest('OTP_CHANNEL_INVALID', 'Verifikasi e-mail memakai kanal EMAIL');
  if (body.purpose !== 'LOGIN' && !ctx.auth) throw Errors.unauthorized();
  const destination = normalizeDestination(body.channel, body.destination);
  return createOtpChallenge(
    deps,
    { channel: body.channel, destination, purpose: body.purpose, userId: body.purpose === 'LOGIN' ? null : ctx.auth!.userId, locale: body.locale },
    ctx.req,
  );
}

// =================================================================== SEC-12 step-up for sensitive actions
/**
 * SENSITIVE_ACTION OTP: sent only to the caller's own VERIFIED phone (SMS/WhatsApp) or verified e-mail, bound to
 * (action, targetId), valid 10 minutes, single use. A stolen access token alone can no longer re-route refunds or payouts.
 */
async function requestSensitiveActionOtp(
  deps: AppDeps,
  body: { channel: Channel; destination: string; locale?: 'id' | 'en' | undefined; action?: SensitiveActionCode | undefined; targetId?: string | undefined },
  ctx: AuthCallCtx,
): Promise<OtpChallengeResult> {
  if (!ctx.auth) throw Errors.unauthorized();
  if (!body.action || !body.targetId) throw Errors.badRequest('STEP_UP_ACTION_REQUIRED', 'action dan targetId wajib untuk purpose SENSITIVE_ACTION');
  if (body.action === 'PAYOUT_ACCOUNT_ADD' && body.targetId !== ctx.auth.userId) {
    throw Errors.unprocessable('STEP_UP_TARGET_INVALID', 'Untuk PAYOUT_ACCOUNT_ADD, targetId adalah id akunmu sendiri');
  }
  const destination = normalizeDestination(body.channel, body.destination);
  const [u] = await deps.sql<{ phone_e164: string | null; phone_verified_at: Date | null; email: string | null; email_verified_at: Date | null; transaction_email: string | null }[]>`
    SELECT phone_e164, phone_verified_at, email, email_verified_at, transaction_email FROM users WHERE id = ${ctx.auth.userId}`;
  const allowed =
    body.channel === 'EMAIL'
      ? [u?.email_verified_at ? u.email : null, u?.transaction_email ?? null].filter((x): x is string => !!x).map((x) => x.toLowerCase())
      : [u?.phone_verified_at ? u.phone_e164 : null].filter((x): x is string => !!x);
  if (!allowed.includes(destination)) {
    throw Errors.unprocessable('STEP_UP_DESTINATION_NOT_VERIFIED', 'Kode hanya dapat dikirim ke nomor HP / e-mail terverifikasi milikmu');
  }
  return createOtpChallenge(
    deps,
    { channel: body.channel, destination, purpose: 'SENSITIVE_ACTION', userId: ctx.auth.userId, locale: body.locale, action: body.action, targetId: body.targetId },
    ctx.req,
  );
}

/**
 * Verifies and CONSUMES a SENSITIVE_ACTION step-up in its own committed DB transaction (so failed attempts count even
 * when the caller's action fails later). Throws 403 STEP_UP_REQUIRED {action, targetId} when no proof was sent.
 */
export async function consumeSensitiveActionOtp(
  deps: AppDeps,
  input: { userId: string; action: SensitiveActionCode; targetId: string; proof?: { challengeId: string; code: string } | undefined },
  req: RequestMeta | null,
): Promise<{ challengeId: string }> {
  const proof = input.proof;
  if (!proof) {
    throw new AppError(403, 'STEP_UP_REQUIRED', 'Verifikasi tambahan diperlukan: minta kode (purpose SENSITIVE_ACTION) lalu kirim stepUp', {
      purpose: 'SENSITIVE_ACTION',
      action: input.action,
      targetId: input.targetId,
    });
  }
  const now = deps.clock.now();
  const outcome = await inTx(deps, async (tx): Promise<Outcome<string>> => {
    const ch = await repo.lockOtp(tx, proof.challengeId);
    if (!ch || ch.purpose !== 'SENSITIVE_ACTION' || ch.user_id !== input.userId || ch.consumed_at) return fail(OTP_INVALID());
    if (ch.action !== input.action || ch.target_id !== input.targetId) {
      await securityEvent(deps, tx, { userId: input.userId, type: 'STEP_UP_TARGET_MISMATCH', severity: 'MEDIUM', req, meta: { challengeId: ch.id, action: input.action } });
      return fail(Errors.forbidden('Kode verifikasi ini untuk aksi lain', 'STEP_UP_MISMATCH'));
    }
    if (ch.expires_at.getTime() <= now.getTime()) return fail(Errors.badRequest('OTP_EXPIRED', 'Kode verifikasi sudah kedaluwarsa, silakan minta kode baru'));
    if (ch.attempts >= ch.max_attempts) return fail(OTP_LOCKED());
    const expected = await deps.crypto.hashIdentifier('otp', `${ch.id}:${proof.code}`);
    if (!timingSafeEqual(u8(expected), u8(ch.code_hash))) {
      const attempts = ch.attempts + 1;
      await tx`UPDATE otp_challenges SET attempts = ${attempts} WHERE id = ${ch.id}`;
      const locked = attempts >= ch.max_attempts;
      await securityEvent(deps, tx, {
        userId: input.userId,
        type: locked ? 'OTP_LOCKED' : 'OTP_VERIFY_FAILED',
        severity: locked ? 'MEDIUM' : 'LOW',
        req,
        meta: { challengeId: ch.id, purpose: 'SENSITIVE_ACTION', action: input.action, attempts },
      });
      return fail(locked ? OTP_LOCKED() : Errors.badRequest('OTP_INVALID', 'Kode verifikasi salah', { remainingAttempts: ch.max_attempts - attempts }));
    }
    await repo.consumeOtp(tx, ch.id, now);
    await securityEvent(deps, tx, { userId: input.userId, type: 'SENSITIVE_ACTION_VERIFIED', severity: 'LOW', req, meta: { challengeId: ch.id, action: input.action } });
    return ok(ch.id);
  });
  return { challengeId: unwrap(outcome) };
}

// =================================================================== account creation & login
type SignupBody = { device?: DeviceInput | undefined; consents?: ConsentInput[] | undefined };

interface NewUserInput {
  method: 'PHONE' | 'EMAIL' | 'GOOGLE' | 'APPLE';
  email: string | null;
  emailVerified: boolean;
  phone: string | null;
  displayName: string | null;
  identity: { provider: 'GOOGLE' | 'APPLE' | 'EMAIL' | 'PHONE'; subject: string; email: string | null; emailVerified: boolean };
  locale?: 'id' | 'en' | undefined;
}

/** Signup risk → BLOCK stops here (recorded), otherwise the user row, identity, consents and records are created. */
async function createAccount(deps: AppDeps, tx: TxSql, input: NewUserInput, body: SignupBody, req: RequestMeta): Promise<{ userId: string } | { blocked: true }> {
  const now = deps.clock.now();
  const risk = await assessSignup(deps, tx, {
    fingerprintHash: body.device ? await fingerprintHash(deps, body.device.fingerprint) : null,
    ipHash: req.ipHash,
    emailHash: input.email ? await deps.crypto.hashIdentifier('email', input.email) : null,
  });
  if (risk.assessment.decision === 'BLOCK') {
    const attemptId = crypto.randomUUID();
    await recordSignupRisk(tx, attemptId, risk, input.method);
    await securityEvent(deps, tx, {
      type: 'SIGNUP_BLOCKED',
      severity: 'HIGH',
      req,
      meta: { method: input.method, riskSubjectId: attemptId, score: risk.assessment.score, reasons: risk.assessment.reasons.map((r) => r.code) },
    });
    return { blocked: true };
  }
  const userId = await repo.insertUser(tx, {
    email: input.email,
    emailVerifiedAt: input.email && input.emailVerified ? now : null,
    phone: input.phone,
    phoneVerifiedAt: input.phone ? now : null,
    displayName: input.displayName,
    locale: input.locale ?? 'id',
    now,
  });
  await repo.upsertIdentity(tx, { userId, ...input.identity, now });
  await insertConsents(deps, tx, userId, body.consents ?? [], { req, locale: input.locale ?? 'id', source: 'APP' });
  await recordSignupRisk(tx, userId, risk, input.method);
  await securityEvent(deps, tx, {
    userId,
    type: 'USER_REGISTERED',
    req,
    meta: { method: input.method, riskDecision: risk.assessment.decision, riskScore: risk.assessment.score },
  });
  await emitEvent(tx, 'user', userId, 'user.registered', { userId, method: input.method });
  return { userId };
}

async function finishLogin(deps: AppDeps, tx: TxSql, userId: string, method: string, body: SignupBody, req: RequestMeta, isNewUser: boolean) {
  const deviceId = body.device ? await upsertUserDevice(deps, tx, userId, body.device) : null;
  const authMethod = method === 'GOOGLE' || method === 'APPLE' ? method : 'OTP';
  const session = await issueSession(deps, tx, userId, { deviceId, ipHash: req.ipHash, userAgent: req.userAgent, authMethod });
  await tx`UPDATE users SET last_login_at = ${deps.clock.now()} WHERE id = ${userId}`;
  await securityEvent(deps, tx, { userId, type: 'LOGIN_SUCCESS', deviceId, req, meta: { method, isNewUser, sessionId: session.sessionId } });
  return session;
}

function statusGate(deps: AppDeps, tx: TxSql, u: repo.LoginUserRow, method: string, req: RequestMeta): Promise<AppError | null> {
  if (u.status === 'SUSPENDED') {
    return securityEvent(deps, tx, { userId: u.id, type: 'LOGIN_FAILED', severity: 'MEDIUM', req, meta: { method, reason: 'SUSPENDED' } }).then(() =>
      Errors.forbidden('Akun ditangguhkan. Hubungi dukungan pelanggan.', 'ACCOUNT_SUSPENDED'),
    );
  }
  if (u.status === 'DELETED') return Promise.resolve(Errors.forbidden('Akun tidak aktif', 'ACCOUNT_INACTIVE'));
  return Promise.resolve(null);
}

const nonceReused = () => new AppError(401, 'OAUTH_TOKEN_INVALID', 'Token masuk tidak valid atau kedaluwarsa', { reason: 'NONCE_REUSED' });
const consentRequired = (missing: string[]) =>
  Errors.unprocessable('CONSENT_REQUIRED', 'Setujui Syarat & Ketentuan dan Kebijakan Privasi untuk membuat akun', { required: missing });
const signupBlocked = () => Errors.forbidden('Pendaftaran tidak dapat diproses saat ini. Hubungi dukungan pelanggan.', 'SIGNUP_BLOCKED');

export interface LoginResult {
  tokens: Tokens;
  user: Profile;
  isNewUser: boolean;
}

// =================================================================== OTP verify
export interface OtpVerifyResult {
  purpose: OtpPurpose;
  verified: true;
  user: Profile;
  tokens?: Tokens;
  isNewUser?: boolean;
}

export async function verifyOtp(
  deps: AppDeps,
  body: { challengeId: string; code: string } & SignupBody,
  ctx: AuthCallCtx,
): Promise<OtpVerifyResult> {
  const now = deps.clock.now();
  const outcome = await inTx(deps, async (tx): Promise<Outcome<OtpVerifyResult>> => {
    const ch = await repo.lockOtp(tx, body.challengeId);
    if (!ch || ch.consumed_at || !ch.destination_enc) return fail(OTP_INVALID());
    if (ch.expires_at.getTime() <= now.getTime()) return fail(Errors.badRequest('OTP_EXPIRED', 'Kode verifikasi sudah kedaluwarsa, silakan minta kode baru'));
    if (ch.attempts >= ch.max_attempts) return fail(OTP_LOCKED());
    const purpose = ch.purpose as OtpPurpose;
    if (purpose !== 'LOGIN' && purpose !== 'VERIFY_PHONE' && purpose !== 'VERIFY_EMAIL') return fail(OTP_INVALID());
    if (purpose !== 'LOGIN') {
      if (!ctx.auth) return fail(Errors.unauthorized());
      if (ch.user_id !== ctx.auth.userId) return fail(OTP_INVALID());
    }

    const expected = await deps.crypto.hashIdentifier('otp', `${ch.id}:${body.code}`);
    if (!timingSafeEqual(u8(expected), u8(ch.code_hash))) {
      const attempts = ch.attempts + 1;
      await tx`UPDATE otp_challenges SET attempts = ${attempts} WHERE id = ${ch.id}`;
      const locked = attempts >= ch.max_attempts;
      await securityEvent(deps, tx, {
        userId: ch.user_id,
        type: locked ? 'OTP_LOCKED' : 'OTP_VERIFY_FAILED',
        severity: locked ? 'MEDIUM' : 'LOW',
        req: ctx.req,
        meta: { challengeId: ch.id, purpose, attempts },
      });
      return fail(locked ? OTP_LOCKED() : Errors.badRequest('OTP_INVALID', 'Kode verifikasi salah', { remainingAttempts: ch.max_attempts - attempts }));
    }

    const destination = await deps.crypto.decryptString(u8(ch.destination_enc), `otp_challenges.destination:${ch.id}`);
    if (purpose === 'LOGIN') return otpLogin(deps, tx, ch, destination, body, ctx.req);
    if (purpose === 'VERIFY_PHONE') return verifyPhone(deps, tx, ch, destination, ctx);
    return verifyEmail(deps, tx, ch, destination, ctx);
  });
  return unwrap(outcome);
}

async function otpLogin(deps: AppDeps, tx: TxSql, ch: repo.OtpRow, destination: string, body: SignupBody, req: RequestMeta): Promise<Outcome<OtpVerifyResult>> {
  const now = deps.clock.now();
  const isPhone = ch.channel !== 'EMAIL';
  const method = isPhone ? 'PHONE' : 'EMAIL';
  const existing = isPhone ? await repo.findUserByPhone(tx, destination) : await repo.findUserByEmail(tx, destination);
  let userId: string;
  let isNewUser = false;
  let phoneNewlyVerified = false;
  if (existing) {
    const gate = await statusGate(deps, tx, existing, method, req);
    if (gate) {
      await repo.consumeOtp(tx, ch.id, now);
      return fail(gate);
    }
    userId = existing.id;
    if (isPhone && !existing.phone_verified_at) {
      await tx`UPDATE users SET phone_verified_at = ${now} WHERE id = ${userId}`;
      phoneNewlyVerified = true;
    }
    if (!isPhone && !existing.email_verified_at) await tx`UPDATE users SET email_verified_at = ${now} WHERE id = ${userId}`;
    await repo.upsertIdentity(tx, { userId, provider: method, subject: destination, email: isPhone ? null : destination, emailVerified: !isPhone, now });
  } else {
    const missing = missingSignupConsents(body.consents);
    // not consumed: the client re-submits the same code together with the consents
    if (missing.length) return fail(consentRequired(missing));
    const created = await createAccount(
      deps,
      tx,
      {
        method,
        email: isPhone ? null : destination,
        emailVerified: !isPhone,
        phone: isPhone ? destination : null,
        displayName: null,
        identity: { provider: method, subject: destination, email: isPhone ? null : destination, emailVerified: !isPhone },
      },
      body,
      req,
    );
    await repo.consumeOtp(tx, ch.id, now);
    if ('blocked' in created) return fail(signupBlocked());
    userId = created.userId;
    isNewUser = true;
    phoneNewlyVerified = isPhone;
  }
  await repo.consumeOtp(tx, ch.id, now);
  const session = await finishLogin(deps, tx, userId, method, body, req, isNewUser);
  if (phoneNewlyVerified) {
    await emitEvent(tx, 'user', userId, 'user.phone_verified', { userId });
    await recomputeKycLevel(deps, tx, userId, 'phone_verified');
  }
  return ok({ purpose: 'LOGIN', verified: true, user: await loadProfile(tx, userId), tokens: tokensOf(session), isNewUser });
}

async function verifyPhone(deps: AppDeps, tx: TxSql, ch: repo.OtpRow, phone: string, ctx: AuthCallCtx): Promise<Outcome<OtpVerifyResult>> {
  const now = deps.clock.now();
  const userId = ctx.auth!.userId;
  await repo.consumeOtp(tx, ch.id, now);
  const [other] = await tx<{ id: string }[]>`SELECT id FROM users WHERE phone_e164 = ${phone} AND id <> ${userId}`;
  if (other) {
    await securityEvent(deps, tx, { userId, type: 'PHONE_CONFLICT', severity: 'MEDIUM', req: ctx.req, meta: { challengeId: ch.id } });
    return fail(Errors.conflict('PHONE_IN_USE', 'Nomor HP sudah terdaftar pada akun lain'));
  }
  await tx`UPDATE users SET phone_e164 = ${phone}, phone_verified_at = ${now} WHERE id = ${userId}`;
  await repo.upsertIdentity(tx, { userId, provider: 'PHONE', subject: phone, email: null, emailVerified: false, now });
  await securityEvent(deps, tx, { userId, type: 'PHONE_VERIFIED', req: ctx.req, meta: {} });
  await emitEvent(tx, 'user', userId, 'user.phone_verified', { userId });
  await recomputeKycLevel(deps, tx, userId, 'phone_verified');
  return ok({ purpose: 'VERIFY_PHONE', verified: true, user: await loadProfile(tx, userId) });
}

async function verifyEmail(deps: AppDeps, tx: TxSql, ch: repo.OtpRow, email: string, ctx: AuthCallCtx): Promise<Outcome<OtpVerifyResult>> {
  const now = deps.clock.now();
  const userId = ctx.auth!.userId;
  await repo.consumeOtp(tx, ch.id, now);
  await tx`UPDATE users SET transaction_email = ${email} WHERE id = ${userId}`;
  // a phone-only account also gains a verified login e-mail (enables e-mail OTP and provider linking)
  const [u] = await tx<{ email: string | null }[]>`SELECT email FROM users WHERE id = ${userId}`;
  if (!u?.email) {
    const [taken] = await tx<{ id: string }[]>`SELECT id FROM users WHERE email = ${email}`;
    if (!taken) {
      await tx`UPDATE users SET email = ${email}, email_verified_at = ${now} WHERE id = ${userId}`;
      await repo.upsertIdentity(tx, { userId, provider: 'EMAIL', subject: email, email, emailVerified: true, now });
    }
  }
  await securityEvent(deps, tx, { userId, type: 'TRANSACTION_EMAIL_CHANGED', req: ctx.req, meta: {} });
  return ok({ purpose: 'VERIFY_EMAIL', verified: true, user: await loadProfile(tx, userId) });
}

// =================================================================== Google / Apple
export async function oauthLogin(
  deps: AppDeps,
  provider: OAuthProvider,
  input: { token: string; nonce?: string | undefined; rawNonce?: string | undefined; fullName?: { givenName?: string | undefined; familyName?: string | undefined } | undefined } & SignupBody,
  ctx: AuthCallCtx,
): Promise<LoginResult> {
  let id: VerifiedIdentity;
  try {
    id = await verifyIdToken(deps, provider, input.token, {
      nonce: input.nonce,
      rawNonce: provider === 'APPLE' ? input.rawNonce : undefined,
      required: nonceRequired(deps, provider),
    });
  } catch (err) {
    const reason = err instanceof OAuthVerificationError ? err.reason : 'SIGNATURE_INVALID';
    await securityEvent(deps, deps.sql, { type: 'LOGIN_FAILED', req: ctx.req, meta: { method: provider, reason } });
    if (reason === 'KEYS_UNAVAILABLE') throw Errors.unavailable('OAUTH_UNAVAILABLE', 'Layanan masuk sedang tidak tersedia, coba lagi');
    if (reason === 'NOT_CONFIGURED') throw Errors.unavailable('OAUTH_NOT_CONFIGURED', 'Metode masuk ini belum diaktifkan');
    if (reason === 'NONCE_REQUIRED') {
      // SEC-15: an outdated client (or a replayed bare token) — the provider requires a nonce.
      throw new AppError(401, 'OAUTH_NONCE_REQUIRED', 'Permintaan masuk tidak lengkap (nonce wajib). Perbarui aplikasi lalu coba lagi.', { provider });
    }
    throw new AppError(401, 'OAUTH_TOKEN_INVALID', 'Token masuk tidak valid atau kedaluwarsa', { reason });
  }
  // SEC-15: a token whose nonce was verified is single use (recorded on success, below).
  const nonceHash = id.nonce ? await sha256(`${provider}:${id.nonce.claim}`) : null;
  if (provider === 'GOOGLE' && !id.emailVerified) {
    await securityEvent(deps, deps.sql, { type: 'LOGIN_FAILED', req: ctx.req, meta: { method: provider, reason: 'EMAIL_UNVERIFIED' } });
    throw new AppError(401, 'OAUTH_EMAIL_UNVERIFIED', 'E-mail akun Google belum terverifikasi');
  }
  const appleName = [input.fullName?.givenName, input.fullName?.familyName].filter(Boolean).join(' ').trim() || null;
  const displayName = provider === 'APPLE' ? appleName : id.name;

  const outcome = await inTx(deps, async (tx): Promise<Outcome<LoginResult>> => {
    const now = deps.clock.now();
    if (nonceHash && (await repo.oauthNonceUsed(tx, provider, nonceHash))) {
      await securityEvent(deps, tx, { type: 'LOGIN_FAILED', severity: 'MEDIUM', req: ctx.req, meta: { method: provider, reason: 'NONCE_REUSED' } });
      return fail(nonceReused());
    }
    let userId = await repo.findSocialIdentity(tx, provider, id.subject);
    let isNewUser = false;
    if (userId) {
      await repo.upsertIdentity(tx, { userId, provider, subject: id.subject, email: id.email, emailVerified: id.emailVerified, now });
    } else if (id.emailVerified && id.email) {
      // account linking: only when the provider asserts the e-mail is verified AND our account's e-mail is verified
      const u = await repo.findUserByEmail(tx, id.email);
      if (u && u.email_verified_at) {
        userId = u.id;
        await repo.upsertIdentity(tx, { userId, provider, subject: id.subject, email: id.email, emailVerified: true, now });
        await securityEvent(deps, tx, { userId, type: 'ACCOUNT_LINKED', severity: 'MEDIUM', req: ctx.req, meta: { provider } });
      }
    }
    if (!userId) {
      const missing = missingSignupConsents(input.consents);
      if (missing.length) return fail(consentRequired(missing));
      let email: string | null = null;
      if (id.emailVerified && id.email) {
        const [taken] = await tx<{ id: string }[]>`SELECT id FROM users WHERE email = ${id.email}`;
        if (!taken) email = id.email;
      }
      const created = await createAccount(
        deps,
        tx,
        {
          method: provider,
          email,
          emailVerified: !!email,
          phone: null,
          displayName,
          identity: { provider, subject: id.subject, email: id.email, emailVerified: id.emailVerified },
        },
        input,
        ctx.req,
      );
      if ('blocked' in created) return fail(signupBlocked());
      userId = created.userId;
      isNewUser = true;
    }
    const u = (await repo.findUserById(tx, userId))!;
    const gate = await statusGate(deps, tx, u, provider, ctx.req);
    if (gate) return fail(gate);
    if (!isNewUser && !u.display_name && displayName) await tx`UPDATE users SET display_name = ${displayName} WHERE id = ${userId}`;
    // concurrent replay of the same token: the loser rolls back everything (no account, no session)
    if (nonceHash && !(await repo.recordOauthNonce(tx, provider, nonceHash, id.nonce!.expiresAt, now))) throw nonceReused();
    const session = await finishLogin(deps, tx, userId, provider, input, ctx.req, isNewUser);
    return ok({ tokens: tokensOf(session), user: await loadProfile(tx, userId), isNewUser });
  });
  return unwrap(outcome);
}

// =================================================================== sessions
export async function refresh(deps: AppDeps, refreshToken: string, req: RequestMeta) {
  const s = await rotateRefreshToken(deps, refreshToken, { ipHash: req.ipHash, userAgent: req.userAgent });
  return { tokens: tokensOf(s) };
}

/**
 * SEC-07: a logged-out session's device stops receiving this user's push notifications (shared / handed-over
 * phones used to keep showing chat previews, PIN reminders and payout notices of the previous account). The link is
 * kept when another live session of the same user still uses the device; logging in again re-links it.
 */
async function unlinkSessionDevice(tx: TxSql, userId: string, sessionId: string, now: Date) {
  await tx`
    UPDATE user_devices ud SET revoked_at = ${now}
     WHERE ud.user_id = ${userId} AND ud.revoked_at IS NULL
       AND ud.device_id IN (SELECT rt.device_id FROM refresh_tokens rt WHERE rt.family_id = ${sessionId} AND rt.device_id IS NOT NULL)
       AND NOT EXISTS (SELECT 1 FROM refresh_tokens o
                        WHERE o.user_id = ${userId} AND o.device_id = ud.device_id AND o.revoked_at IS NULL AND o.family_id <> ${sessionId})`;
}

/**
 * Revokes the caller's session: the bearer's session and/or the session of the presented refresh token (body, or the
 * `jk_rt` cookie with cookie transport — lets a web tab without a live access token log out). A refresh token that no
 * longer maps to a live session is a no-op (logout is idempotent). Returns the number of sessions revoked.
 */
export async function logout(deps: AppDeps, who: { auth?: AuthContext | undefined; refreshToken?: string | undefined }, req: RequestMeta): Promise<number> {
  return inTx(deps, async (tx) => {
    const now = deps.clock.now();
    const sessions = new Map<string, { userId: string; via: 'ACCESS_TOKEN' | 'REFRESH_TOKEN' }>();
    if (who.auth) sessions.set(who.auth.sessionId, { userId: who.auth.userId, via: 'ACCESS_TOKEN' });
    if (who.refreshToken) {
      const s = await findRefreshTokenSession(tx, who.refreshToken);
      if (s && !sessions.has(s.sessionId)) sessions.set(s.sessionId, { userId: s.userId, via: 'REFRESH_TOKEN' });
    }
    let revoked = 0;
    for (const [sessionId, { userId, via }] of sessions) {
      if (!(await repo.sessionBelongsTo(tx, userId, sessionId))) continue; // already revoked / rotated away: nothing to do
      await revokeSession(tx, sessionId, 'LOGOUT', now);
      await unlinkSessionDevice(tx, userId, sessionId, now);
      await securityEvent(deps, tx, { userId, type: 'LOGOUT', req, meta: { sessionId, via } });
      revoked++;
    }
    return revoked;
  });
}

export async function sessions(deps: AppDeps, auth: AuthContext) {
  const rows = await repo.listSessions(deps.sql, auth.userId, deps.clock.now());
  return rows.map((r) => ({
    id: r.family_id,
    current: r.family_id === auth.sessionId,
    createdAt: r.created_at.toISOString(),
    lastActiveAt: r.last_active_at.toISOString(),
    expiresAt: r.expires_at.toISOString(),
    device: r.device_id ? { id: r.device_id, platform: r.platform ?? 'UNKNOWN', appVersion: r.app_version } : null,
    userAgent: r.user_agent,
  }));
}

export async function revokeUserSession(deps: AppDeps, auth: AuthContext, sessionId: string, req: RequestMeta) {
  await inTx(deps, async (tx) => {
    if (!(await repo.sessionBelongsTo(tx, auth.userId, sessionId))) throw Errors.notFound('Sesi', 'SESSION_NOT_FOUND');
    await revokeSession(tx, sessionId, 'LOGOUT', deps.clock.now());
    await unlinkSessionDevice(tx, auth.userId, sessionId, deps.clock.now());
    await securityEvent(deps, tx, { userId: auth.userId, type: 'SESSION_REVOKED', req, meta: { sessionId, current: sessionId === auth.sessionId } });
  });
}

// =================================================================== MFA (TOTP, RFC 6238)
const MFA_ISSUER = 'JastipKita';
const mfaAad = (factorId: string) => `mfa_factors.secret:${factorId}`;

/**
 * SEC-13 — TOTP (re-)enrollment is trust-on-first-use, so it is only allowed from a FRESH session: the refresh family
 * was created by an OTP login (phone/e-mail possession, not a social token) at most 15 minutes ago. A pending
 * (unconfirmed) factor belongs to the session that started it: another session can replace it only after it has
 * been pending for 15 minutes. A CONFIRMED factor is never replaced here — only through the maker-checker reset
 * (POST /v1/admin/users/{id}/mfa-reset-requests, approved by another SUPER_ADMIN).
 */
async function assertFreshEnrollmentSession(deps: AppDeps, auth: AuthContext, req: RequestMeta) {
  const origin = await sessionOrigin(deps.sql, auth.sessionId, auth.userId);
  const now = deps.clock.now().getTime();
  const fresh =
    origin?.authMethod === 'OTP' && origin.startedAt !== null && now - origin.startedAt.getTime() <= SECURITY.MFA_ENROLL_FRESH_SESSION_SEC * 1000;
  if (!fresh) {
    await securityEvent(deps, deps.sql, { userId: auth.userId, type: 'MFA_ENROLL_DENIED', severity: 'MEDIUM', req, meta: { reason: 'STALE_SESSION', authMethod: origin?.authMethod ?? null } });
    throw Errors.forbidden('Masuk ulang dengan kode OTP (≤ 15 menit) sebelum mendaftarkan authenticator', 'MFA_ENROLL_FRESH_LOGIN_REQUIRED', {
      maxSessionAgeSec: SECURITY.MFA_ENROLL_FRESH_SESSION_SEC,
      requiredAuthMethod: 'OTP',
    });
  }
}

export async function mfaEnroll(deps: AppDeps, auth: AuthContext, req: RequestMeta) {
  await assertFreshEnrollmentSession(deps, auth, req);
  const secret = generateTotpSecret();
  const factorId = crypto.randomUUID();
  const secretEnc = await deps.crypto.encrypt(secret, mfaAad(factorId));
  const [u] = await deps.sql<{ email: string | null; phone_e164: string | null }[]>`SELECT email, phone_e164 FROM users WHERE id = ${auth.userId}`;
  const now = deps.clock.now();
  await inTx(deps, async (tx) => {
    const existing = await repo.activeFactor(tx, auth.userId, true);
    if (existing?.confirmed_at) {
      throw Errors.conflict('MFA_ALREADY_ENROLLED', 'MFA sudah aktif. Reset hanya melalui permintaan admin yang disetujui SUPER_ADMIN lain.');
    }
    if (existing) {
      const pendingFresh = now.getTime() - existing.created_at.getTime() < SECURITY.MFA_PENDING_ENROLLMENT_TTL_SEC * 1000;
      if (existing.enroll_session_id !== auth.sessionId && pendingFresh) {
        throw Errors.conflict('MFA_ENROLLMENT_IN_PROGRESS', 'Pendaftaran authenticator sedang berlangsung dari sesi lain', {
          retryAfterSec: Math.ceil((existing.created_at.getTime() + SECURITY.MFA_PENDING_ENROLLMENT_TTL_SEC * 1000 - now.getTime()) / 1000),
        });
      }
      await tx`DELETE FROM mfa_factors WHERE id = ${existing.id}`;
    }
    await tx`INSERT INTO mfa_factors (id, user_id, type, label, secret_enc, enc_key_id, created_at, enroll_session_id)
             VALUES (${factorId}, ${auth.userId}, 'TOTP', 'Authenticator', ${buf(secretEnc)}, ${deps.crypto.activeKeyId}, ${now}, ${auth.sessionId})`;
    await securityEvent(deps, tx, { userId: auth.userId, type: 'MFA_ENROLL_STARTED', severity: 'MEDIUM', req, meta: { factorId, sessionId: auth.sessionId } });
    await audit(tx, { actorType: 'ADMIN', actorId: auth.userId, action: 'auth.mfa.enroll_started', entityType: 'mfa_factor', entityId: factorId, meta: {} });
  });
  return { factorId, secret, otpauthUri: totpUri(secret, u?.email ?? u?.phone_e164 ?? auth.userId, MFA_ISSUER), issuer: MFA_ISSUER };
}

function recoveryCode(): string {
  // 8 chars Crockford-ish base32 from 5 random bytes → XXXX-XXXX
  const s = base32Encode(randomBytes(5)).replace(/[^A-Z2-7]/g, '').slice(0, 8).toUpperCase();
  return `${s.slice(0, 4)}-${s.slice(4, 8)}`;
}

type MfaOutcome<T> = Outcome<T>;

async function mfaFailure(deps: AppDeps, tx: TxSql, userId: string, req: RequestMeta, reason: string, factorId: string | null) {
  await securityEvent(deps, tx, { userId, type: 'MFA_FAILED', severity: 'MEDIUM', req, meta: { reason, factorId } });
}

async function assertMfaNotLocked(deps: AppDeps, tx: TxSql, userId: string) {
  const since = new Date(deps.clock.now().getTime() - SECURITY.MFA_FAILURE_WINDOW_SEC * 1000);
  if ((await repo.recentMfaFailures(tx, userId, since)) >= SECURITY.MFA_MAX_FAILURES) {
    return new AppError(429, 'MFA_LOCKED', 'Terlalu banyak percobaan MFA. Coba lagi dalam 15 menit.');
  }
  return null;
}

export async function mfaConfirm(deps: AppDeps, auth: AuthContext, code: string, req: RequestMeta) {
  const now = deps.clock.now();
  const outcome = await inTx(deps, async (tx): Promise<MfaOutcome<{ recoveryCodes: string[]; mfaAt: number }>> => {
    const f = await repo.activeFactor(tx, auth.userId, true);
    if (!f) return fail(Errors.conflict('MFA_NOT_ENROLLED', 'Mulai pendaftaran MFA terlebih dahulu'));
    if (f.confirmed_at) return fail(Errors.conflict('MFA_ALREADY_ENROLLED', 'MFA sudah aktif untuk akun ini'));
    // SEC-13: only the session that started the enrollment (and saw the secret) may activate it, within the TTL.
    if (f.enroll_session_id !== auth.sessionId) {
      await mfaFailure(deps, tx, auth.userId, req, 'ENROLL_SESSION_MISMATCH', f.id);
      return fail(Errors.forbidden('Konfirmasi harus dari sesi yang memulai pendaftaran', 'MFA_ENROLL_SESSION_MISMATCH'));
    }
    if (now.getTime() - f.created_at.getTime() > SECURITY.MFA_PENDING_ENROLLMENT_TTL_SEC * 1000) {
      return fail(Errors.conflict('MFA_ENROLLMENT_EXPIRED', 'Pendaftaran authenticator kedaluwarsa, mulai lagi'));
    }
    const locked = await assertMfaNotLocked(deps, tx, auth.userId);
    if (locked) return fail(locked);
    const secret = await deps.crypto.decryptString(u8(f.secret_enc), mfaAad(f.id));
    const step = await verifyTotp(secret, code, now);
    if (step === null) {
      await mfaFailure(deps, tx, auth.userId, req, 'INVALID_CODE', f.id);
      return fail(Errors.badRequest('MFA_CODE_INVALID', 'Kode MFA salah'));
    }
    await tx`UPDATE mfa_factors SET confirmed_at = ${now}, last_used_step = ${step}, last_used_at = ${now} WHERE id = ${f.id}`;
    await tx`DELETE FROM mfa_recovery_codes WHERE user_id = ${auth.userId}`;
    const codes: string[] = [];
    for (let i = 0; i < SECURITY.MFA_RECOVERY_CODES; i++) {
      const c = recoveryCode();
      codes.push(c);
      await tx`INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES (${auth.userId}, ${buf(await deps.crypto.hashIdentifier('mfa_recovery', `${auth.userId}:${c}`))})
               ON CONFLICT DO NOTHING`;
    }
    await markSessionMfaVerified(tx, auth.sessionId, auth.userId, now);
    await securityEvent(deps, tx, { userId: auth.userId, type: 'MFA_ENABLED', severity: 'MEDIUM', req, meta: { factorId: f.id } });
    await audit(tx, { actorType: 'ADMIN', actorId: auth.userId, action: 'auth.mfa.enabled', entityType: 'mfa_factor', entityId: f.id, meta: {} });
    return ok({ recoveryCodes: codes, mfaAt: Math.floor(now.getTime() / 1000) });
  });
  const r = unwrap(outcome);
  const access = await signAccessToken(deps, auth.userId, auth.sessionId, r.mfaAt);
  return { confirmed: true as const, recoveryCodes: r.recoveryCodes, accessToken: access.token, accessTokenExpiresAt: access.expiresAt.toISOString(), mfaAt: r.mfaAt };
}

/** Step-up: verifies a TOTP (replay-protected by last used time-step) or a one-time recovery code. */
export async function mfaVerify(deps: AppDeps, auth: AuthContext, input: { code?: string | undefined; recoveryCode?: string | undefined }, req: RequestMeta) {
  const now = deps.clock.now();
  const outcome = await inTx(deps, async (tx): Promise<MfaOutcome<{ mfaAt: number; method: 'TOTP' | 'RECOVERY_CODE' }>> => {
    const f = await repo.activeFactor(tx, auth.userId, true);
    if (!f || !f.confirmed_at) return fail(Errors.conflict('MFA_NOT_ENROLLED', 'MFA belum aktif untuk akun ini'));
    const locked = await assertMfaNotLocked(deps, tx, auth.userId);
    if (locked) return fail(locked);
    const mfaAt = Math.floor(now.getTime() / 1000);
    if (input.recoveryCode) {
      const h = buf(await deps.crypto.hashIdentifier('mfa_recovery', `${auth.userId}:${input.recoveryCode.toUpperCase()}`));
      const used = await tx`UPDATE mfa_recovery_codes SET used_at = ${now} WHERE user_id = ${auth.userId} AND code_hash = ${h} AND used_at IS NULL RETURNING id`;
      if (!used.length) {
        await mfaFailure(deps, tx, auth.userId, req, 'INVALID_RECOVERY_CODE', f.id);
        return fail(Errors.badRequest('MFA_CODE_INVALID', 'Kode pemulihan salah atau sudah dipakai'));
      }
      await markSessionMfaVerified(tx, auth.sessionId, auth.userId, now);
      await securityEvent(deps, tx, { userId: auth.userId, type: 'MFA_RECOVERY_CODE_USED', severity: 'HIGH', req, meta: { factorId: f.id } });
      return ok({ mfaAt, method: 'RECOVERY_CODE' });
    }
    const secret = await deps.crypto.decryptString(u8(f.secret_enc), mfaAad(f.id));
    const step = await verifyTotp(secret, input.code!, now);
    if (step === null) {
      await mfaFailure(deps, tx, auth.userId, req, 'INVALID_CODE', f.id);
      return fail(Errors.badRequest('MFA_CODE_INVALID', 'Kode MFA salah'));
    }
    if (f.last_used_step !== null && step <= f.last_used_step) {
      await mfaFailure(deps, tx, auth.userId, req, 'REPLAY', f.id);
      return fail(Errors.badRequest('MFA_CODE_REPLAYED', 'Kode MFA sudah dipakai, tunggu kode berikutnya'));
    }
    await tx`UPDATE mfa_factors SET last_used_step = ${step}, last_used_at = ${now} WHERE id = ${f.id}`;
    await markSessionMfaVerified(tx, auth.sessionId, auth.userId, now);
    await securityEvent(deps, tx, { userId: auth.userId, type: 'MFA_VERIFIED', req, meta: { factorId: f.id, sessionId: auth.sessionId } });
    return ok({ mfaAt, method: 'TOTP' });
  });
  const r = unwrap(outcome);
  const access = await signAccessToken(deps, auth.userId, auth.sessionId, r.mfaAt);
  return { accessToken: access.token, accessTokenExpiresAt: access.expiresAt.toISOString(), mfaAt: r.mfaAt, method: r.method };
}
