import { CoreError } from '../errors';
import { addHours, addMinutes } from '../internal/time';

/**
 * Generates a numeric one-time PIN from caller-supplied CSPRNG bytes (e.g. crypto.getRandomValues).
 * Unbiased: bytes ≥ 250 are rejected so each accepted byte maps uniformly onto 0–9 (250 = 25 × 10).
 * Supply generously (≥ 2 × length bytes); throws INSUFFICIENT_RANDOMNESS if they run out.
 */
export function generatePin(randomBytes: Uint8Array, length = 6): string {
  if (!Number.isSafeInteger(length) || length < 4 || length > 12) {
    throw new CoreError('INVALID_PIN_LENGTH', `PIN length must be 4–12, got ${length}`);
  }
  let pin = '';
  for (let i = 0; i < randomBytes.length && pin.length < length; i++) {
    const b = randomBytes[i] as number;
    if (b < 250) pin += String(b % 10);
  }
  if (pin.length < length) {
    throw new CoreError('INSUFFICIENT_RANDOMNESS', `Need more random bytes to build a ${length}-digit PIN`);
  }
  return pin;
}

/** Recommended byte count for `generatePin` (probability of running out < 1e-12 for length ≤ 12). */
export function pinRandomBytesNeeded(length = 6): number {
  return length * 2 + 16;
}

export interface PinAttemptInput {
  /** Failed attempts so far. */
  readonly attempts: number;
  readonly maxAttempts: number;
  /** Result of the constant-time comparison for this attempt; omit to only check the lock. */
  readonly matches?: boolean;
}

export interface PinAttemptResult {
  readonly allowed: boolean;
  readonly verified: boolean;
  readonly locked: boolean;
  /** Failed attempts after this call. */
  readonly attempts: number;
  readonly attemptsRemaining: number;
  readonly code: 'VERIFIED' | 'WRONG_PIN' | 'LOCKED' | 'ATTEMPT_ALLOWED';
}

/** Max 5 attempts (config `delivery.maxPinAttempts`); the lock is permanent for that PIN. */
export function verifyPinAttempt(input: PinAttemptInput): PinAttemptResult {
  if (!Number.isSafeInteger(input.attempts) || input.attempts < 0 || !Number.isSafeInteger(input.maxAttempts) || input.maxAttempts < 1) {
    throw new CoreError('INVALID_ATTEMPTS', 'attempts must be >= 0 and maxAttempts >= 1');
  }
  if (input.attempts >= input.maxAttempts) {
    return { allowed: false, verified: false, locked: true, attempts: input.attempts, attemptsRemaining: 0, code: 'LOCKED' };
  }
  if (input.matches === undefined) {
    return {
      allowed: true,
      verified: false,
      locked: false,
      attempts: input.attempts,
      attemptsRemaining: input.maxAttempts - input.attempts,
      code: 'ATTEMPT_ALLOWED',
    };
  }
  if (input.matches) {
    return {
      allowed: true,
      verified: true,
      locked: false,
      attempts: input.attempts,
      attemptsRemaining: input.maxAttempts - input.attempts,
      code: 'VERIFIED',
    };
  }
  const attempts = input.attempts + 1;
  const locked = attempts >= input.maxAttempts;
  return {
    allowed: true,
    verified: false,
    locked,
    attempts,
    attemptsRemaining: Math.max(0, input.maxAttempts - attempts),
    code: locked ? 'LOCKED' : 'WRONG_PIN',
  };
}

/** Constant-time string comparison (length leak only). */
export function constantTimeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

/** DELIVERED → BUYER_CONFIRMED auto-confirm time (config `delivery.autoConfirmHours`, default 48). */
export function autoConfirmAt(deliveredAt: Date, hours: number): Date {
  if (!(hours > 0)) throw new CoreError('INVALID_HOURS', `hours must be > 0, got ${hours}`);
  return addHours(deliveredAt, hours);
}

export function isAutoConfirmDue(deliveredAt: Date, hours: number, now: Date): boolean {
  return now.getTime() >= autoConfirmAt(deliveredAt, hours).getTime();
}

export function qrExpiresAt(issuedAt: Date, ttlMinutes: number): Date {
  if (!(ttlMinutes > 0)) throw new CoreError('INVALID_TTL', `ttlMinutes must be > 0, got ${ttlMinutes}`);
  return addMinutes(issuedAt, ttlMinutes);
}
