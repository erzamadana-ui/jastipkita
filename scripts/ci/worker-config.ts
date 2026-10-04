/**
 * Builds the Cloudflare Worker configuration for one environment WITHOUT printing any secret value.
 *
 *   pnpm --filter @jastipkita/api exec tsx ../../scripts/ci/worker-config.ts <staging|production>
 *
 * Inputs (environment):
 *   VARS_JSON      toJSON(vars)    — GitHub Variables (repository + environment level)
 *   SECRETS_JSON   toJSON(secrets) — GitHub Secrets (only the allow-listed names below are used)
 *   APP_VERSION    optional version string (e.g. 0.1.0+abc1234)
 *   EXPECT_LIVE    production only: "true" | "false" — the recorded owner decision (deploy-production.yml)
 *   RUNNER_TEMP    output directory (defaults to os.tmpdir())
 *
 * Outputs:
 *   $RUNNER_TEMP/worker-vars.args      one wrangler argument per line: --var / KEY:VALUE (non-secret overrides)
 *   $RUNNER_TEMP/worker-secrets.json   mode 0600, input for `wrangler secret bulk` (deleted by the workflow)
 *   GITHUB_OUTPUT: fingerprint=<hmac>  HMAC-SHA256(secrets JSON) keyed with CLOUDFLARE_API_TOKEN — lets CI skip
 *                  `secret bulk` when nothing changed without revealing anything about the values.
 *
 * It validates the merged configuration with the API's own EnvSchema (apps/api/src/env.ts), so a deploy that
 * would crash every request (missing Xendit key, memory storage on staging, LIVE payments without approval, …)
 * fails here, before anything is uploaded.
 */
import { createHmac } from 'node:crypto';
import { appendFileSync, chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EnvSchema, sandboxFlags } from '../../apps/api/src/env';
import { systemClock } from '../../apps/api/src/lib/clock';
import { silentLogger } from '../../apps/api/src/lib/logger';
import { buildProviders } from '../../apps/api/src/providers';

const target = process.argv[2];
if (target !== 'staging' && target !== 'production') {
  console.error('usage: worker-config.ts <staging|production>');
  process.exit(2);
}

/** Non-secret settings that may be overridden per environment from GitHub Variables (same names as env.ts). */
const VAR_OVERRIDES = [
  'API_BASE_URL', 'WEB_BASE_URL', 'ADMIN_BASE_URL', 'CORS_ORIGINS', 'LOG_LEVEL',
  'PAYMENT_PROVIDER', 'XENDIT_BASE_URL',
  'EMAIL_PROVIDER', 'EMAIL_FROM', 'EMAIL_REPLY_TO',
  'PUSH_PROVIDER', 'FCM_PROJECT_ID',
  'SMS_PROVIDER', 'TWILIO_FROM', 'TWILIO_WHATSAPP_FROM', 'TWILIO_WHATSAPP_CONTENT_SID',
  'S3_ENDPOINT', 'S3_REGION', 'S3_BUCKET',
  'FX_PROVIDER', 'KYC_PROVIDER', 'MALWARE_SCAN_PROVIDER', 'CLAMAV_HTTP_URL', 'INSURANCE_PROVIDER', 'EXTRACTION_PROVIDER',
  'GOOGLE_CLIENT_IDS', 'APPLE_CLIENT_IDS', 'OAUTH_REQUIRE_NONCE', 'NEON_PROJECT_ID',
  'SUPPORT_WHATSAPP', 'SUPPORT_EMAIL',
] as const;

/** Values that are secrets (Worker secrets, never plain vars). */
const SECRET_NAMES = [
  'DATABASE_URL', 'JWT_SECRET', 'DATA_ENCRYPTION_KEYS', 'HMAC_PEPPER',
  'XENDIT_SECRET_KEY', 'XENDIT_WEBHOOK_TOKEN',
  'RESEND_API_KEY', 'FCM_SERVICE_ACCOUNT_JSON', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN',
  'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'NEON_API_KEY', 'SETTLEMENT_SECRETS_JSON',
] as const;

/** Never overridable from GitHub Variables — decided by the workflow / wrangler.toml only. */
const LOCKED = new Set(['APP_ENV', 'XENDIT_ENV', 'ALLOW_LIVE_PAYMENTS', 'OTP_DEV_ECHO', 'STORAGE_PROVIDER']);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOML = join(ROOT, 'infra', 'cloudflare', 'wrangler.toml');
const outDir = process.env.RUNNER_TEMP || tmpdir();

function parseJson(name: string): Record<string, string> {
  const raw = process.env[name];
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(obj).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
  } catch {
    console.error(`::error::${name} is not valid JSON`);
    process.exit(2);
  }
}

/** Minimal reader for `[env.<name>.vars]` tables with KEY = "string" lines (the format used in wrangler.toml). */
function tomlVars(env: string): Record<string, string> {
  const lines = readFileSync(TOML, 'utf8').split('\n');
  const out: Record<string, string> = {};
  let inside = false;
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('[')) {
      inside = t === `[env.${env}.vars]`;
      continue;
    }
    if (!inside || !t || t.startsWith('#')) continue;
    const m = /^([A-Z0-9_]+)\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(t);
    if (m && m[1] && m[2] !== undefined) out[m[1]] = m[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return out;
}

const vars = parseJson('VARS_JSON');
const secrets = parseJson('SECRETS_JSON');
const base = tomlVars(target);
if (!Object.keys(base).length) {
  console.error(`::error::no [env.${target}.vars] table found in ${TOML}`);
  process.exit(2);
}

const overrides: Record<string, string> = {};
for (const k of VAR_OVERRIDES) {
  const v = vars[k];
  if (v !== undefined && v !== '' && !LOCKED.has(k)) overrides[k] = v;
}
if (process.env.APP_VERSION) overrides.APP_VERSION = process.env.APP_VERSION;

// Production: the live-payment switch comes ONLY from the recorded decision passed by the workflow.
if (target === 'production') {
  const live = process.env.EXPECT_LIVE;
  if (live !== 'true' && live !== 'false') {
    console.error('::error::EXPECT_LIVE must be "true" or "false" for production');
    process.exit(2);
  }
  overrides.XENDIT_ENV = live === 'true' ? 'live' : 'test';
  overrides.ALLOW_LIVE_PAYMENTS = live;
}

const secretValues: Record<string, string> = {};
for (const k of SECRET_NAMES) {
  const v = secrets[k];
  if (v !== undefined && v !== '') secretValues[k] = v;
}

// --- validation with the API's own schema (values never printed) ---
const merged: Record<string, string> = { ...base, ...overrides, ...secretValues };
const problems: string[] = [];
const parsed = EnvSchema.safeParse(merged);
if (!parsed.success) {
  for (const i of parsed.error.issues) problems.push(`${i.path.join('.')}: ${i.message}`);
} else {
  const flags = sandboxFlags(parsed.data);
  if (target === 'staging' && flags.payments === 'LIVE') problems.push('staging must never run LIVE payments');
  if (target === 'staging' && parsed.data.XENDIT_ENV !== 'test') problems.push('staging requires XENDIT_ENV=test');
  if (target === 'production' && process.env.EXPECT_LIVE === 'true' && flags.payments !== 'LIVE') {
    problems.push('owner decision is LIVE but the configuration does not resolve to LIVE payments');
  }
  const key = secretValues.XENDIT_SECRET_KEY ?? '';
  if (parsed.data.XENDIT_ENV === 'test' && key.startsWith('xnd_production_')) problems.push('XENDIT_SECRET_KEY is a PRODUCTION key but XENDIT_ENV=test');
  if (parsed.data.XENDIT_ENV === 'live' && key.startsWith('xnd_development_')) problems.push('XENDIT_SECRET_KEY is a development key but XENDIT_ENV=live');
  if (!/[?&]sslmode=(require|verify-full)/.test(secretValues.DATABASE_URL ?? '')) problems.push('DATABASE_URL must use sslmode=require (Neon)');
  for (const [k, v] of Object.entries({ ...base, ...overrides })) {
    if (v.includes('CHANGE-ME')) problems.push(`${k} still contains a CHANGE-ME placeholder — set the GitHub Variable ${k}`);
  }
  if (parsed.data.DB_PROVIDER === 'neon' && !/-pooler\./.test(secretValues.DATABASE_URL ?? '')) {
    console.log('::warning::DATABASE_URL does not point at the Neon pooler (-pooler host). The API opens one connection per request; use the pooled string.');
  }
  // Provider factories throw at request time when a credential is missing (e.g. EMAIL_PROVIDER=resend without
  // RESEND_API_KEY). Build them once here so that failure happens in CI instead of on every request.
  try {
    buildProviders(parsed.data, silentLogger, systemClock);
  } catch (err) {
    problems.push(err instanceof Error ? err.message : String(err));
  }
  console.log(`integrations: ${JSON.stringify(flags)}`);
}
if (problems.length) {
  for (const p of problems) console.error(`::error title=Worker config (${target})::${p}`);
  process.exit(1);
}

// --- outputs ---
const argsFile = join(outDir, 'worker-vars.args');
writeFileSync(argsFile, Object.entries(overrides).flatMap(([k, v]) => ['--var', `${k}:${v}`]).join('\n') + '\n');
const secretsFile = join(outDir, 'worker-secrets.json');
const secretsJson = JSON.stringify(Object.fromEntries(Object.entries(secretValues).sort(([a], [b]) => a.localeCompare(b))));
writeFileSync(secretsFile, secretsJson, { mode: 0o600 });
chmodSync(secretsFile, 0o600);
const fpKey = secrets.CLOUDFLARE_API_TOKEN || 'no-key';
const fingerprint = createHmac('sha256', fpKey).update(`${target}\n${secretsJson}`).digest('hex').slice(0, 32);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `fingerprint=${fingerprint}\n`);

console.log(`overrides: ${Object.keys(overrides).sort().join(', ') || '(none)'}`);
console.log(`secrets:   ${Object.keys(secretValues).sort().join(', ')}`);
console.log(`wrote ${argsFile} and ${secretsFile} (0600)`);
