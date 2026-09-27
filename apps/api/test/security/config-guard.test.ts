/**
 * SEC-08 (docs/security/review-2026-09.md): production refuses to boot with log/mock providers for OTP delivery,
 * malware scanning or KYC; plus the existing guards (dev OTP echo, mock payments, live payments approval).
 */
import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/env';

const PROD = {
  APP_ENV: 'production',
  DATABASE_URL: 'postgres://x@db.example/jk?sslmode=require',
  JWT_SECRET: 'p'.repeat(48),
  DATA_ENCRYPTION_KEYS: `k1:${Buffer.alloc(32, 7).toString('base64')}`,
  HMAC_PEPPER: 'q'.repeat(48),
  PAYMENT_PROVIDER: 'xendit',
  XENDIT_SECRET_KEY: 'xnd_development_abc',
  XENDIT_WEBHOOK_TOKEN: 'tok',
  EMAIL_PROVIDER: 'resend',
  SMS_PROVIDER: 'twilio',
  STORAGE_PROVIDER: 's3',
  S3_ENDPOINT: 'https://r2.example',
  S3_BUCKET: 'b',
  S3_ACCESS_KEY_ID: 'a',
  S3_SECRET_ACCESS_KEY: 's',
  MALWARE_SCAN_PROVIDER: 'clamav-http',
  CLAMAV_HTTP_URL: 'https://clamd.internal.example/scan',
  KYC_PROVIDER: 'manual',
};

describe('SEC-08 production configuration guard', () => {
  it('accepts a complete production configuration', () => {
    expect(loadEnv(PROD).APP_ENV).toBe('production');
  });

  it.each([
    ['EMAIL_PROVIDER', 'log'],
    ['SMS_PROVIDER', 'log'],
    ['MALWARE_SCAN_PROVIDER', 'mock'],
    ['MALWARE_SCAN_PROVIDER', 'none'],
    ['CLAMAV_HTTP_URL', ''],
    ['KYC_PROVIDER', 'mock'],
    ['OTP_DEV_ECHO', 'true'],
    ['PAYMENT_PROVIDER', 'mock'],
    ['XENDIT_ENV', 'live'],
    ['JWT_SECRET', 'short'],
    ['STORAGE_PROVIDER', 'memory'],
  ])('refuses %s=%s', (k, v) => {
    expect(() => loadEnv({ ...PROD, [k]: v })).toThrow(/Invalid environment configuration/);
  });

  it('keeps development/test permissive (mock providers allowed)', () => {
    expect(() => loadEnv({ ...PROD, APP_ENV: 'test', EMAIL_PROVIDER: 'log', SMS_PROVIDER: 'log', MALWARE_SCAN_PROVIDER: 'mock', STORAGE_PROVIDER: 'memory' })).not.toThrow();
  });
});
