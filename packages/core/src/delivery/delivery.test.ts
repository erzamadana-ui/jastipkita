import { describe, expect, it } from 'vitest';
import { SEEDS, createPrng } from '../testing/prng';
import {
  autoConfirmAt,
  constantTimeEqual,
  generatePin,
  isAutoConfirmDue,
  pinRandomBytesNeeded,
  qrExpiresAt,
  verifyPinAttempt,
} from './index';

describe('generatePin', () => {
  it('produces fixed-length numeric PINs', () => {
    const pin = generatePin(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), 6);
    expect(pin).toBe('123456');
    expect(generatePin(createPrng(1).bytes(pinRandomBytesNeeded())).length).toBe(6);
  });

  it('rejects bytes ≥ 250 (rejection sampling)', () => {
    expect(generatePin(new Uint8Array([250, 255, 9, 19, 29, 39, 251, 49, 59]), 6)).toBe('999999');
  });

  it('is unbiased: every accepted byte value maps to digits uniformly', () => {
    const counts = new Array<number>(10).fill(0);
    for (let b = 0; b < 256; b++) {
      try {
        const d = generatePin(new Uint8Array([b, b, b, b]), 4)[0];
        counts[Number(d)] = (counts[Number(d)] ?? 0) + 1;
      } catch {
        // rejected byte
      }
    }
    expect(counts).toEqual(new Array(10).fill(25));
  });

  it('throws when randomness runs out or length is invalid', () => {
    expect(() => generatePin(new Uint8Array([255, 255, 1]), 6)).toThrowError(expect.objectContaining({ code: 'INSUFFICIENT_RANDOMNESS' }));
    expect(() => generatePin(new Uint8Array(32), 3)).toThrow();
  });

  it('digit distribution is roughly uniform across seeds (property)', () => {
    const counts = new Array<number>(10).fill(0);
    for (const seed of SEEDS) {
      for (const ch of generatePin(createPrng(seed).bytes(pinRandomBytesNeeded(6)), 6)) counts[Number(ch)] = (counts[Number(ch)] ?? 0) + 1;
    }
    for (const c of counts) expect(c).toBeGreaterThan(80); // 1200 digits → expect ~120 each
  });
});

describe('verifyPinAttempt', () => {
  it('verifies, counts failures and locks at the maximum', () => {
    expect(verifyPinAttempt({ attempts: 0, maxAttempts: 5, matches: true }).code).toBe('VERIFIED');
    expect(verifyPinAttempt({ attempts: 3, maxAttempts: 5, matches: false })).toMatchObject({
      code: 'WRONG_PIN',
      attempts: 4,
      attemptsRemaining: 1,
    });
    expect(verifyPinAttempt({ attempts: 4, maxAttempts: 5, matches: false })).toMatchObject({ code: 'LOCKED', locked: true });
    expect(verifyPinAttempt({ attempts: 5, maxAttempts: 5, matches: true })).toMatchObject({ allowed: false, verified: false });
    expect(verifyPinAttempt({ attempts: 2, maxAttempts: 5 }).code).toBe('ATTEMPT_ALLOWED');
  });

  it('constantTimeEqual compares correctly', () => {
    expect(constantTimeEqual('123456', '123456')).toBe(true);
    expect(constantTimeEqual('123456', '123457')).toBe(false);
    expect(constantTimeEqual('12345', '123456')).toBe(false);
  });
});

describe('auto-confirm & QR', () => {
  it('auto-confirms 48h after delivery', () => {
    const d = new Date('2026-09-27T10:00:00Z');
    expect(autoConfirmAt(d, 48).toISOString()).toBe('2026-09-29T10:00:00.000Z');
    expect(isAutoConfirmDue(d, 48, new Date('2026-09-29T09:59:59Z'))).toBe(false);
    expect(isAutoConfirmDue(d, 48, new Date('2026-09-29T10:00:00Z'))).toBe(true);
    expect(qrExpiresAt(d, 30).toISOString()).toBe('2026-09-27T10:30:00.000Z');
  });
});
