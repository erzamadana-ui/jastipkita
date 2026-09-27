/**
 * Deterministic formatting helpers for notification/e-mail copy (no Intl → identical output on Node
 * and Workers, stable snapshots). Brand rules (BRAND-GUIDE §3/§4): "Rp 1.234.567" (space after Rp,
 * dot thousands, no decimals), times in WIB.
 */
export type Locale = 'id' | 'en';

export function asLocale(v: unknown): Locale {
  return v === 'en' ? 'en' : 'id';
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function group(intPart: string, sep: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
}

/** Integer IDR → "Rp 1.250.000" (id) / "Rp 1,250,000" (en); negatives "−Rp 50.000". */
export function formatIdr(amount: number, locale: Locale = 'id'): string {
  const n = Math.round(Number(amount) || 0);
  const body = group(String(Math.abs(n)), locale === 'en' ? ',' : '.');
  return `${n < 0 ? '−' : ''}Rp ${body}`;
}

const MONTHS: Record<Locale, string[]> = {
  id: ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'],
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
};

const WIB_MS = 7 * 3600_000;

export function toDate(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === 'string' || typeof v === 'number') {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/** "27 Sep 2026, 14.32 WIB" (id) / "27 Sep 2026, 14:32 WIB" (en). */
export function formatDateTimeWib(v: unknown, locale: Locale = 'id'): string {
  const d = toDate(v);
  if (!d) return '-';
  const w = new Date(d.getTime() + WIB_MS);
  const hh = String(w.getUTCHours()).padStart(2, '0');
  const mm = String(w.getUTCMinutes()).padStart(2, '0');
  return `${w.getUTCDate()} ${MONTHS[locale][w.getUTCMonth()]} ${w.getUTCFullYear()}, ${hh}${locale === 'en' ? ':' : '.'}${mm} WIB`;
}

/** Calendar date only ("27 Sep 2026"); DB `date` strings are used as-is. */
export function formatDate(v: unknown, locale: Locale = 'id'): string {
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const [y, m, d] = v.split('-').map(Number) as [number, number, number];
    return `${d} ${MONTHS[locale][m - 1]} ${y}`;
  }
  const d = toDate(v);
  if (!d) return '-';
  const w = new Date(d.getTime() + WIB_MS);
  return `${w.getUTCDate()} ${MONTHS[locale][w.getUTCMonth()]} ${w.getUTCFullYear()}`;
}

/**
 * Public name shown to the counterparty: first name + initial of the last name ("Dimas P.").
 * Never exposes e-mail/phone; falls back to a neutral label.
 */
export function publicName(displayName: string | null | undefined, fallback: string): string {
  const parts = (displayName ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return fallback;
  const first = parts[0]!.slice(0, 40);
  if (parts.length === 1) return first;
  const last = parts[parts.length - 1]!;
  return `${first} ${last.charAt(0).toUpperCase()}.`;
}

/** Greeting name for the recipient themself (first name only). */
export function firstName(displayName: string | null | undefined, locale: Locale): string {
  const first = (displayName ?? '').trim().split(/\s+/)[0];
  return first ? first.slice(0, 40) : locale === 'en' ? 'there' : 'Kak';
}

export function truncate(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}
