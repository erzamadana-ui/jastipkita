/**
 * Analytics hygiene (pure): event-name allowlist, property shape/size limits and PII stripping.
 * Properties are flat: string (≤ 200 chars), finite number, boolean, null, or an array of ≤ 10
 * short strings. PII-looking keys are dropped; PII-looking values (e-mail, phone, ≥ 8-digit numbers)
 * are replaced by "[REDACTED]". The serialized object is capped at 2 KB.
 */
export const ANALYTICS_EVENTS = [
  'app_install',
  'app_open',
  'signup_started',
  'signup_completed',
  'kyc_started',
  'kyc_submitted',
  'request_started',
  'request_created',
  'recommendations_viewed',
  'offer_sent',
  'offer_accepted',
  'checkout_started',
  'payment_initiated',
  'payment_secured',
  'purchase_completed',
  'delivery_confirmed',
  'transaction_completed',
  'repeat_transaction',
  'referral_shared',
  'referral_applied',
  'search',
  'screen_view',
] as const;
export type AnalyticsEventName = (typeof ANALYTICS_EVENTS)[number];
const ALLOWED = new Set<string>(ANALYTICS_EVENTS);

export function isAllowedEvent(name: string): name is AnalyticsEventName {
  return ALLOWED.has(name);
}

export const MAX_PROPERTIES = 20;
export const MAX_STRING = 200;
export const MAX_PROPERTIES_BYTES = 2048;

const KEY_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/;
const PII_EXACT = new Set(['name', 'fullname', 'firstname', 'lastname', 'displayname', 'nama', 'dob', 'birthdate', 'birthday', 'lat', 'lng', 'lon', 'latitude', 'longitude', 'ip', 'ipaddress', 'pin', 'otp', 'nik', 'ktp', 'npwp', 'iban', 'hp', 'msisdn', 'wa', 'whatsapp']);
const PII_PART = ['email', 'phone', 'password', 'passwd', 'token', 'secret', 'passport', 'paspor', 'address', 'alamat', 'accountnumber', 'cardnumber', 'rekening', 'norek', 'cvv', 'credential'];
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi;
const PHONE_RE = /(?:\+?62|0)\s?8\d(?:[\s.-]?\d){6,11}|\+\d{1,3}[\s.-]?\d(?:[\s.-]?\d){6,13}/g;
const DIGITS_RE = /\d(?:[ -]?\d){7,}/g;

export function isPiiKey(key: string): boolean {
  const k = key.toLowerCase().replace(/[_-]/g, '');
  return PII_EXACT.has(k) || PII_PART.some((p) => k.includes(p));
}

export function redactValue(v: string): string {
  return v.replace(EMAIL_RE, '[REDACTED]').replace(PHONE_RE, '[REDACTED]').replace(DIGITS_RE, '[REDACTED]');
}

export interface SanitizeResult {
  properties: Record<string, string | number | boolean | null | string[]>;
  dropped: string[];
}

export function sanitizeProperties(input: unknown): SanitizeResult {
  const out: SanitizeResult['properties'] = {};
  const dropped: string[] = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { properties: out, dropped };
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (Object.keys(out).length >= MAX_PROPERTIES) {
      dropped.push(k);
      continue;
    }
    if (!KEY_RE.test(k) || isPiiKey(k)) {
      dropped.push(k);
      continue;
    }
    if (v === null || typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'number') {
      if (Number.isFinite(v)) out[k] = v;
      else dropped.push(k);
    } else if (typeof v === 'string') out[k] = redactValue(v.slice(0, MAX_STRING));
    else if (Array.isArray(v) && v.length <= 10 && v.every((x) => typeof x === 'string')) out[k] = (v as string[]).map((x) => redactValue(x.slice(0, 50)));
    else dropped.push(k);
  }
  while (new TextEncoder().encode(JSON.stringify(out)).length > MAX_PROPERTIES_BYTES) {
    const last = Object.keys(out).pop();
    if (!last) break;
    delete out[last];
    dropped.push(last);
  }
  return { properties: out, dropped };
}
