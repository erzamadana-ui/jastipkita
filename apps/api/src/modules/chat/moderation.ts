/**
 * Chat moderation (pure). Detects attempts to move payment off-platform or to exchange contact
 * details. Policy (docs/api/engagement.md §Chat moderation):
 *   - the message is still delivered (conversation keeps flowing) but stored with
 *     moderation_status = FLAGGED + reason codes;
 *   - sensitive spans (phone numbers, e-mails, bank-account-like numbers, messenger links) are
 *     replaced by "[disembunyikan]" in the version BOTH participants see (UI spec §5.17: "Tidak ada
 *     nomor rekening di chat (di-mask)"); the original text is kept for moderators / dispute evidence;
 *   - a SYSTEM safety tip is posted in the conversation.
 * Intent phrases ("transfer langsung", "bayar di luar", …) are flagged but not masked (nothing to hide).
 */

export const MASK = '[disembunyikan]';

export type ModerationReason = 'OFF_PLATFORM_PAYMENT' | 'CONTACT_PHONE' | 'CONTACT_EMAIL' | 'CONTACT_LINK' | 'BANK_ACCOUNT';

export interface ModerationResult {
  flagged: boolean;
  reasons: ModerationReason[];
  masked: string;
}

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi;
const LINK_RE = /\b(?:https?:\/\/)?(?:www\.)?(?:wa\.me|api\.whatsapp\.com|chat\.whatsapp\.com|wa\.link|t\.me|telegram\.me|line\.me|m\.me|instagram\.com|bit\.ly|s\.id|linktr\.ee)(?:\/[^\s]*)?/gi;
// Indonesian mobile numbers (+62 / 62 / 08) with optional separators, and other +CC numbers
const PHONE_RE = /(?<![\w])(?:\+?62|0)\s?8\d(?:[\s.-]?\d){6,11}(?!\d)|\+\d{1,3}[\s.-]?\d(?:[\s.-]?\d){6,13}(?!\d)/g;
// 8–18 digit runs (spaces/dashes allowed, not dots/commas → "15.000.000" is money, not an account)
const DIGITS_RE = /(?<![\w.,])\d(?:[ -]?\d){7,17}(?![\w.,])/g;
const MONEY_BEFORE = /(?:rp|idr|¥|\$|usd|jpy|krw|sgd)\s*$/i;
const MONEY_AFTER = /^\s*(?:rb|ribu|jt|juta|k|idr|rupiah|yen|won|usd|jpy)\b/i;

const PAYMENT_PHRASES = [
  'transfer langsung',
  'tf langsung',
  'transfer aja ke',
  'transfer ke rekening',
  'transfer ke rek',
  'tf ke rek',
  'bayar di luar',
  'bayar diluar',
  'bayar langsung',
  'bayar ke saya langsung',
  'di luar aplikasi',
  'diluar aplikasi',
  'di luar jastipkita',
  'diluar jastipkita',
  'tanpa safepay',
  'gak usah lewat aplikasi',
  'ga usah lewat aplikasi',
  'no rek',
  'norek',
  'nomor rekening',
  'rekening saya',
  'rek saya',
  'cod aja',
  'pay outside',
  'pay directly',
  'direct transfer',
  'bank transfer to me',
  'outside the app',
];
const CONTACT_PHRASES = ['lewat wa', 'lanjut wa', 'chat wa', 'hubungi wa', 'kontak wa', 'add wa', 'nomor wa', 'no wa', 'whatsapp saya', 'wa saya', 'dm ig', 'line id', 'id line', 'telegram saya'];

function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ');
}

export function moderateText(input: string): ModerationResult {
  const reasons = new Set<ModerationReason>();
  let masked = input;
  const apply = (re: RegExp, reason: ModerationReason, keep?: (match: string, offset: number, whole: string) => boolean) => {
    masked = masked.replace(re, (m: string, ...rest: unknown[]) => {
      const offset = rest[rest.length - 2] as number;
      const whole = rest[rest.length - 1] as string;
      if (keep?.(m, offset, whole)) return m;
      reasons.add(reason);
      return MASK;
    });
  };
  apply(EMAIL_RE, 'CONTACT_EMAIL');
  apply(LINK_RE, 'CONTACT_LINK');
  apply(PHONE_RE, 'CONTACT_PHONE');
  apply(DIGITS_RE, 'BANK_ACCOUNT', (_m, offset, whole) => MONEY_BEFORE.test(whole.slice(Math.max(0, offset - 5), offset)) || MONEY_AFTER.test(whole.slice(offset + _m.length)));

  const n = norm(input);
  if (PAYMENT_PHRASES.some((p) => n.includes(p))) reasons.add('OFF_PLATFORM_PAYMENT');
  if (CONTACT_PHRASES.some((p) => n.includes(p)) && !reasons.has('CONTACT_PHONE')) reasons.add('CONTACT_LINK');
  // account number + bank keyword = payment redirection, not just a number
  if (reasons.has('BANK_ACCOUNT') && /\b(bca|bni|bri|mandiri|cimb|permata|btn|jenius|seabank|rek|rekening|transfer|tf)\b/i.test(input)) {
    reasons.add('OFF_PLATFORM_PAYMENT');
  }
  const list = [...reasons].sort();
  return { flagged: list.length > 0, reasons: list, masked };
}
