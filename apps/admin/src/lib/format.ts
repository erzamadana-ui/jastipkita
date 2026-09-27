/**
 * Formatting (docs/05-ui-design-system.md §2.5): "Rp 1.234.567", "27 Sep 2026, 14:32 WIB", WIB by default,
 * true minus sign for negatives, tabular figures in CSS. Money arrives as integer IDR (minor unit = rupiah).
 */
const TZ = 'Asia/Jakarta';
const nf = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 2 });
const dtf = new Intl.DateTimeFormat('id-ID', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const df = new Intl.DateTimeFormat('id-ID', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric' });
const dfShort = new Intl.DateTimeFormat('id-ID', { timeZone: 'UTC', day: 'numeric', month: 'short' });

export const MINUS = '−';

export function formatIdr(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const s = `Rp ${nf.format(Math.abs(Math.round(v)))}`;
  return v < 0 ? `${MINUS}${s}` : s;
}

/** Compact IDR for chart axes: Rp 1,2 jt / Rp 3,4 M. */
export function formatIdrCompact(v: number): string {
  const a = Math.abs(v);
  const sign = v < 0 ? MINUS : '';
  if (a >= 1e12) return `${sign}Rp ${nf2.format(a / 1e12)} T`;
  if (a >= 1e9) return `${sign}Rp ${nf2.format(a / 1e9)} M`;
  if (a >= 1e6) return `${sign}Rp ${nf2.format(a / 1e6)} jt`;
  if (a >= 1e3) return `${sign}Rp ${nf2.format(a / 1e3)} rb`;
  return `${sign}Rp ${nf.format(a)}`;
}

export function formatNumber(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return v < 0 ? `${MINUS}${nf2.format(-v)}` : nf2.format(v);
}

export function formatPercent(ratio: number | null | undefined, digits = 1): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return '—';
  const f = new Intl.NumberFormat('id-ID', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const s = `${f.format(Math.abs(ratio) * 100)} %`;
  return ratio < 0 ? `${MINUS}${s}` : s;
}

/**
 * Exact decimal string (e.g. an FX rate "111.9037500000") in Indonesian notation without rounding:
 * trailing zeros trimmed, "." thousands grouping, "," decimal separator → "111,90375".
 */
export function formatDecimalString(s: string | null | undefined): string {
  if (!s) return '—';
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s.trim());
  if (!m) return s;
  const int = m[2]!.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const frac = (m[3] ?? '').replace(/0+$/, '');
  return `${m[1] ? MINUS : ''}${int}${frac ? `,${frac}` : ''}`;
}

export function formatBps(bps: number | null | undefined): string {
  if (bps === null || bps === undefined) return '—';
  return formatPercent(bps / 10000, bps % 100 === 0 ? 0 : 2);
}

export function formatHours(h: number | null | undefined): string {
  if (h === null || h === undefined || !Number.isFinite(h)) return '—';
  if (h < 1) return `${Math.round(h * 60)} mnt`;
  if (h < 48) return `${nf2.format(Math.round(h * 10) / 10)} jam`;
  return `${nf2.format(Math.round((h / 24) * 10) / 10)} hari`;
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${dtf.format(d).replace(/\./g, ':')} WIB`;
}

/** YYYY-MM-DD (calendar date, no zone) or ISO instant → "27 Sep 2026". */
export function formatDate(v: string | null | undefined): string {
  if (!v) return '—';
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return df.format(new Date(`${v}T12:00:00+07:00`));
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : df.format(d);
}

export function formatDayShort(ymd: string): string {
  return dfShort.format(new Date(`${ymd}T00:00:00Z`));
}

export function formatRelative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const diff = (t - now) / 1000;
  const a = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat('id-ID', { numeric: 'auto' });
  if (a < 60) return rtf.format(Math.round(diff), 'second');
  if (a < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (a < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  return rtf.format(Math.round(diff / 86400), 'day');
}

export function formatBytes(b: number | null | undefined): string {
  if (b === null || b === undefined || !Number.isFinite(b)) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = b;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${nf2.format(Math.round(v * 10) / 10)} ${u[i]}`;
}

export function shortId(id: string | null | undefined): string {
  if (!id) return '—';
  return id.length > 10 ? id.slice(0, 8) : id;
}

export function formatMetric(value: number | null, unit: 'IDR' | 'COUNT' | 'RATIO' | 'HOURS' | string): string {
  if (value === null) return '—';
  switch (unit) {
    case 'IDR':
      return formatIdr(value);
    case 'RATIO':
      return formatPercent(value, 2);
    case 'HOURS':
      return formatHours(value);
    default:
      return formatNumber(value);
  }
}

/** Money read out in full for screen readers (§4.2): "1.250.000 rupiah". */
export function spokenIdr(v: number | null | undefined): string {
  if (v === null || v === undefined) return 'tidak ada nilai';
  return `${v < 0 ? 'minus ' : ''}${nf.format(Math.abs(v))} rupiah`;
}

/** WIB calendar date (YYYY-MM-DD) for API `from`/`to` params. */
export function wibDate(d: Date = new Date()): string {
  return new Date(d.getTime() + 7 * 3600_000).toISOString().slice(0, 10);
}

export function addDays(ymd: string, days: number): string {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + days * 86400_000).toISOString().slice(0, 10);
}

export function humanize(code: string | null | undefined): string {
  if (!code) return '—';
  return code.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
}
