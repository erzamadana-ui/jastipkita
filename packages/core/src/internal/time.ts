import { CoreError } from '../errors';

export type DateInput = Date | string;

export const SECOND_MS = 1_000;
export const MINUTE_MS = 60 * SECOND_MS;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** Parses a Date or ISO-8601 string (a bare `YYYY-MM-DD` is treated as UTC midnight). */
export function toDate(value: DateInput, label = 'date'): Date {
  const d = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new CoreError('INVALID_DATE', `${label} is not a valid date`, { value: String(value) });
  }
  return d;
}

export function toTime(value: DateInput, label = 'date'): number {
  return toDate(value, label).getTime();
}

export function addMs(date: Date, ms: number): Date {
  return new Date(date.getTime() + ms);
}

export function addSeconds(date: Date, seconds: number): Date {
  return addMs(date, seconds * SECOND_MS);
}

export function addMinutes(date: Date, minutes: number): Date {
  return addMs(date, minutes * MINUTE_MS);
}

export function addHours(date: Date, hours: number): Date {
  return addMs(date, hours * HOUR_MS);
}

export function addDays(date: Date, days: number): Date {
  return addMs(date, days * DAY_MS);
}

/** Whole or fractional days between two instants (b - a). */
export function daysBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / DAY_MS;
}

/** Jakarta (WIB) is UTC+07:00 year-round (no DST). */
export const WIB_OFFSET_MS = 7 * HOUR_MS;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Calendar date (YYYY-MM-DD) of an instant in Asia/Jakarta (fixed +07:00 offset). */
export function wibCalendarDate(date: Date): string {
  return new Date(date.getTime() + WIB_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * Normalizes a rule date to a WIB calendar date. A bare `YYYY-MM-DD` (DB `date`) is taken as-is;
 * a Date or timestamp string is converted to its Asia/Jakarta calendar date.
 */
export function toWibCalendarDate(value: DateInput, label = 'date'): string {
  if (typeof value === 'string' && ISO_DATE_RE.test(value)) {
    toDate(value, label);
    return value;
  }
  return wibCalendarDate(toDate(value, label));
}

/** Inclusive calendar-date window check (§16): from ≤ d ≤ until (until null = open-ended). */
export function isWithinInclusiveDates(date: Date, from: DateInput, until: DateInput | null): boolean {
  const d = wibCalendarDate(date);
  if (d < toWibCalendarDate(from, 'effectiveFrom')) return false;
  return until === null || d <= toWibCalendarDate(until, 'effectiveUntil');
}
