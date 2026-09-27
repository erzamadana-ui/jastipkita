import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '../api/errors';
import { clearOtpLogin, ENROLL_WINDOW_SEC, enrollmentIssue, enrollSecondsLeft, markOtpLogin } from './enrollment';

afterEach(() => clearOtpLogin());

describe('SEC-13 TOTP enrolment rules', () => {
  it('maps enrolment refusals to the right recovery path', () => {
    expect(enrollmentIssue(new ApiError(403, 'MFA_ENROLL_FRESH_LOGIN_REQUIRED', 'x'))?.action).toBe('relogin');
    expect(enrollmentIssue(new ApiError(403, 'MFA_ENROLL_SESSION_MISMATCH', 'x'))?.action).toBe('relogin');
    expect(enrollmentIssue(new ApiError(409, 'MFA_ENROLLMENT_EXPIRED', 'x'))?.action).toBe('relogin');
    expect(enrollmentIssue(new ApiError(409, 'MFA_ALREADY_ENROLLED', 'x'))?.action).toBe('reload');
    const wait = enrollmentIssue(new ApiError(409, 'MFA_ENROLLMENT_IN_PROGRESS', 'x', { retryAfterSec: 420 }));
    expect(wait).toMatchObject({ action: 'wait', retryAfterSec: 420 });
    expect(wait?.detail).toMatch(/±7 menit/);
    expect(enrollmentIssue(new ApiError(400, 'MFA_CODE_INVALID', 'x'))).toBeNull();
  });

  it('counts down the 15-minute window from the OTP login of this tab', () => {
    expect(enrollSecondsLeft()).toBeNull();
    const t0 = Date.parse('2026-09-28T01:00:00Z');
    markOtpLogin(t0);
    expect(enrollSecondsLeft(t0)).toBe(ENROLL_WINDOW_SEC);
    expect(enrollSecondsLeft(t0 + 14 * 60_000)).toBe(60);
    expect(enrollSecondsLeft(t0 + 20 * 60_000)).toBe(0);
  });
});
