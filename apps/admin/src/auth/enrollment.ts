/**
 * SEC-13 TOTP enrolment rules (docs/api/CHANGELOG.md 2026-09-28, identity.md):
 *  - POST /v1/auth/mfa/totp/enroll only from a session created by an OTP login ≤ 15 min ago
 *    (403 MFA_ENROLL_FRESH_LOGIN_REQUIRED) → the admin must sign in with OTP again;
 *  - a pending enrolment of another session → 409 MFA_ENROLLMENT_IN_PROGRESS {retryAfterSec};
 *  - a confirmed factor → 409 MFA_ALREADY_ENROLLED (verify instead; resets only via the SUPER_ADMIN maker-checker request);
 *  - /confirm only from the enrolling session (403 MFA_ENROLL_SESSION_MISMATCH) within 15 min (409 MFA_ENROLLMENT_EXPIRED).
 * The server is the authority; the client only remembers when the OTP login happened to show the remaining window.
 */
import { isApiError } from '../api/errors';

export const ENROLL_WINDOW_SEC = 15 * 60;
const KEY = 'jk_admin_otp_login_at';

export function markOtpLogin(now = Date.now()): void {
  try {
    window.sessionStorage.setItem(KEY, String(now));
  } catch {
    /* storage blocked — the server still enforces the window */
  }
}

export function clearOtpLogin(): void {
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/** Seconds left in the enrolment window, or null when this tab did not perform the OTP login. */
export function enrollSecondsLeft(now = Date.now()): number | null {
  let raw: string | null = null;
  try {
    raw = window.sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
  const at = raw ? Number(raw) : NaN;
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.floor(ENROLL_WINDOW_SEC - (now - at) / 1000));
}

export interface EnrollmentIssue {
  title: string;
  detail: string;
  /** relogin → sign out and repeat the OTP login; reload → re-read /v1/me (already enrolled); wait → another session is enrolling */
  action: 'relogin' | 'reload' | 'wait' | null;
  retryAfterSec?: number;
}

export function enrollmentIssue(e: unknown): EnrollmentIssue | null {
  if (!isApiError(e)) return null;
  switch (e.code) {
    case 'MFA_ENROLL_FRESH_LOGIN_REQUIRED':
      return { title: 'Login OTP sudah lebih dari 15 menit', detail: 'Demi keamanan, aktivasi authenticator hanya bisa dari sesi login OTP yang baru. Masuk ulang dengan OTP lalu langsung aktivasi.', action: 'relogin' };
    case 'MFA_ENROLL_SESSION_MISMATCH':
      return { title: 'Aktivasi dimulai di sesi lain', detail: 'Konfirmasi harus dari sesi (tab) yang memulai aktivasi. Masuk ulang dengan OTP dan ulangi dari awal.', action: 'relogin' };
    case 'MFA_ENROLLMENT_EXPIRED':
      return { title: 'Aktivasi kedaluwarsa (15 menit)', detail: 'QR/secret ini tidak berlaku lagi. Masuk ulang dengan OTP dan pindai QR baru.', action: 'relogin' };
    case 'MFA_ENROLLMENT_IN_PROGRESS': {
      const d = e.details as { retryAfterSec?: unknown } | undefined;
      const retryAfterSec = typeof d?.retryAfterSec === 'number' ? d.retryAfterSec : undefined;
      return {
        title: 'Aktivasi sedang berjalan di sesi lain',
        detail: `Selesaikan aktivasi di tab/perangkat tersebut, atau tunggu${retryAfterSec ? ` ±${Math.ceil(retryAfterSec / 60)} menit` : ''} sampai kedaluwarsa. Jika bukan Anda, segera hubungi SUPER_ADMIN.`,
        action: 'wait',
        ...(retryAfterSec !== undefined ? { retryAfterSec } : {}),
      };
    }
    case 'MFA_ALREADY_ENROLLED':
      return { title: 'Authenticator sudah aktif', detail: 'Akun ini sudah punya authenticator terkonfirmasi. Verifikasi dengan kodenya; bila hilang, minta reset MFA (maker-checker SUPER_ADMIN).', action: 'reload' };
    default:
      return null;
  }
}
