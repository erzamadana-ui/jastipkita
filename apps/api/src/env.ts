import { z } from 'zod';

/**
 * Runtime configuration. Values come from process.env (Node) or Worker bindings/secrets.
 * NEVER put secrets in code, mobile apps or web bundles — see .env.example for names only.
 */
const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));
const csv = z
  .string()
  .default('')
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

export const EnvSchema = z
  .object({
    APP_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    APP_NAME: z.string().default('JastipKita'),
    APP_VERSION: z.string().default('0.1.0'),
    API_BASE_URL: z.string().url().default('http://localhost:8787'),
    WEB_BASE_URL: z.string().url().default('http://localhost:4321'),
    ADMIN_BASE_URL: z.string().url().default('http://localhost:5173'),
    CORS_ORIGINS: csv,
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    PORT: z.coerce.number().int().default(8787),

    DATABASE_URL: z.string().min(1),
    DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
    DB_PROVIDER: z.enum(['postgres', 'neon', 'supabase', 'rds', 'cloudsql']).default('postgres'),

    JWT_SECRET: z.string().min(32, 'JWT_SECRET must be ≥ 32 chars'),
    JWT_ISSUER: z.string().default('jastipkita-api'),
    JWT_AUDIENCE: z.string().default('jastipkita'),
    ACCESS_TOKEN_TTL_SEC: z.coerce.number().int().min(60).max(3600).default(900),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
    ADMIN_MFA_STEP_UP_SEC: z.coerce.number().int().min(60).max(3600).default(900),

    /** "kid1:base64key32,kid2:base64key32" — first entry is the active key; others decrypt-only (rotation). */
    DATA_ENCRYPTION_KEYS: z.string().min(10),
    /** Pepper for HMAC of identifiers (phone, e-mail, ID numbers, device fingerprints, IPs). */
    HMAC_PEPPER: z.string().min(32),

    GOOGLE_CLIENT_IDS: csv,
    APPLE_CLIENT_IDS: csv,
    OTP_DEV_ECHO: bool.default(false),

    PAYMENT_PROVIDER: z.enum(['mock', 'xendit']).default('mock'),
    XENDIT_ENV: z.enum(['test', 'live']).default('test'),
    XENDIT_BASE_URL: z.string().url().default('https://api.xendit.co'),
    XENDIT_SECRET_KEY: z.string().optional(),
    XENDIT_WEBHOOK_TOKEN: z.string().optional(),
    ALLOW_LIVE_PAYMENTS: bool.default(false),

    EMAIL_PROVIDER: z.enum(['log', 'resend']).default('log'),
    EMAIL_FROM: z.string().default('JastipKita <no-reply@example.com>'),
    EMAIL_REPLY_TO: z.string().optional(),
    RESEND_API_KEY: z.string().optional(),

    PUSH_PROVIDER: z.enum(['log', 'fcm']).default('log'),
    FCM_PROJECT_ID: z.string().optional(),
    FCM_SERVICE_ACCOUNT_JSON: z.string().optional(),

    SMS_PROVIDER: z.enum(['log', 'twilio']).default('log'),
    TWILIO_ACCOUNT_SID: z.string().optional(),
    TWILIO_AUTH_TOKEN: z.string().optional(),
    TWILIO_FROM: z.string().optional(),

    STORAGE_PROVIDER: z.enum(['memory', 's3']).default('memory'),
    S3_ENDPOINT: z.string().optional(),
    S3_REGION: z.string().default('auto'),
    S3_BUCKET: z.string().optional(),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),

    FX_PROVIDER: z.enum(['static', 'frankfurter']).default('static'),
    FX_FRANKFURTER_BASE_URL: z.string().url().default('https://api.frankfurter.dev/v1'),

    KYC_PROVIDER: z.enum(['manual', 'mock']).default('manual'),
    MALWARE_SCAN_PROVIDER: z.enum(['none', 'mock', 'clamav-http']).default('mock'),
    CLAMAV_HTTP_URL: z.string().optional(),
    INSURANCE_PROVIDER: z.enum(['none', 'mock']).default('mock'),
    EXTRACTION_PROVIDER: z.enum(['heuristic', 'mock']).default('heuristic'),

    DB_ADMIN_PROVIDER: z.enum(['generic', 'neon']).default('generic'),
    NEON_API_KEY: z.string().optional(),
    NEON_PROJECT_ID: z.string().optional(),

    /**
     * Settlement account secrets live ONLY in the server secret store. settlement_accounts.secret_ref
     * names a key of this JSON map: {"SETTLEMENT_MAIN": {"bankCode":"BCA","accountNumber":"...","holderName":"..."}}.
     */
    SETTLEMENT_SECRETS_JSON: z.string().default('{}'),

    WORKER_ENABLED: bool.default(true),
    WORKER_ID: z.string().default('worker-1'),
  })
  .superRefine((env, ctx) => {
    const prodLike = env.APP_ENV === 'production' || env.APP_ENV === 'staging';
    if (prodLike && env.OTP_DEV_ECHO) {
      ctx.addIssue({ code: 'custom', path: ['OTP_DEV_ECHO'], message: 'OTP_DEV_ECHO is forbidden outside development/test' });
    }
    if (env.APP_ENV === 'production' && env.PAYMENT_PROVIDER === 'mock') {
      ctx.addIssue({ code: 'custom', path: ['PAYMENT_PROVIDER'], message: 'mock payment provider is forbidden in production' });
    }
    if (env.XENDIT_ENV === 'live' && !env.ALLOW_LIVE_PAYMENTS) {
      ctx.addIssue({
        code: 'custom',
        path: ['XENDIT_ENV'],
        message: 'Live payments require ALLOW_LIVE_PAYMENTS=true (explicit owner approval)',
      });
    }
    if (env.PAYMENT_PROVIDER === 'xendit' && (!env.XENDIT_SECRET_KEY || !env.XENDIT_WEBHOOK_TOKEN)) {
      ctx.addIssue({ code: 'custom', path: ['XENDIT_SECRET_KEY'], message: 'Xendit requires XENDIT_SECRET_KEY and XENDIT_WEBHOOK_TOKEN' });
    }
    if (env.STORAGE_PROVIDER === 's3' && (!env.S3_ENDPOINT || !env.S3_BUCKET || !env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY)) {
      ctx.addIssue({ code: 'custom', path: ['STORAGE_PROVIDER'], message: 'S3 storage requires S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY' });
    }
    if (prodLike && env.STORAGE_PROVIDER === 'memory') {
      ctx.addIssue({ code: 'custom', path: ['STORAGE_PROVIDER'], message: 'memory storage is for development/test only' });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: Record<string, unknown>): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n  ');
    throw new Error(`Invalid environment configuration:\n  ${issues}`);
  }
  return parsed.data;
}

/** True when an integration runs against a sandbox/test/mock backend. Surfaced in /health and admin UI. */
export function sandboxFlags(env: Env) {
  return {
    payments: env.PAYMENT_PROVIDER === 'mock' ? 'MOCK' : env.XENDIT_ENV === 'test' ? 'SANDBOX' : 'LIVE',
    email: env.EMAIL_PROVIDER === 'log' ? 'MOCK' : 'LIVE',
    push: env.PUSH_PROVIDER === 'log' ? 'MOCK' : 'LIVE',
    sms: env.SMS_PROVIDER === 'log' ? 'MOCK' : 'LIVE',
    storage: env.STORAGE_PROVIDER === 'memory' ? 'MOCK' : 'LIVE',
    fx: env.FX_PROVIDER === 'static' ? 'MOCK' : 'LIVE',
    kyc: env.KYC_PROVIDER === 'mock' ? 'MOCK' : 'MANUAL',
    insurance: env.INSURANCE_PROVIDER === 'none' ? 'DISABLED' : 'MOCK',
  } as const;
}
