/**
 * Small helpers shared by the marketplace modules (catalog, fx, customs, restricted, trips, requests,
 * matching, offers). Kept inside the marketplace group instead of lib/ (shared files are owned by
 * the platform team).
 */
import { CoreError } from '@jastipkita/core';
import type { Context } from 'hono';
import type { AppDeps, AppEnv, AuthContext } from '../../context';
import { withTx, type Db, type TxSql } from '../../db/sql';
import { AppError, Errors } from '../../lib/errors';
import { decodeCursor, encodeCursor } from '../../lib/pagination';
import { ErrorSchema } from '../../lib/openapi';

const DAY_MS = 86_400_000;
const WIB_OFFSET_MS = 7 * 3_600_000;

/** Calendar date (YYYY-MM-DD) in Asia/Jakarta (fixed +07:00, no DST). */
export function wibDate(d: Date): string {
  return new Date(d.getTime() + WIB_OFFSET_MS).toISOString().slice(0, 10);
}

/** Adds whole days to a YYYY-MM-DD string. */
export function addDaysIso(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Start of a WIB calendar day as an instant. */
export function wibStartOfDay(date: string): Date {
  return new Date(`${date}T00:00:00+07:00`);
}

/** End of a WIB calendar day (23:59:59.999 WIB) as an instant. */
export function wibEndOfDay(date: string): Date {
  return new Date(Date.parse(`${date}T00:00:00+07:00`) + DAY_MS - 1);
}

export function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
}

/** DB `numeric` arrives as string; null-safe conversion to number. */
export function num(v: unknown): number {
  if (v === null || v === undefined) return 0;
  return typeof v === 'number' ? v : Number(v);
}

export function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function iso(v: Date | string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

/** Round kg to 2 decimals upwards (trips.reserved_kg is numeric(6,2)) — conservative capacity. */
export function ceilKg(kg: number): number {
  return Math.ceil(Math.round(kg * 1e6) / 1e4) / 100;
}

/**
 * Maps a CoreError (contract violation from @jastipkita/core) to an API error. FX problems become
 * clear FX_RATE_* codes; everything else is a 422 with the core code.
 */
export function coreToAppError(err: unknown): unknown {
  if (!(err instanceof CoreError)) return err;
  const details = { ...(err.details ?? {}) } as Record<string, unknown>;
  switch (err.code) {
    case 'FX_RATE_STALE':
      return new AppError(503, 'FX_RATE_STALE', 'Kurs terbaru belum tersedia (data kurs terlalu lama). Coba lagi nanti.', details);
    case 'FX_RATE_UNAVAILABLE':
      return details.reason === 'NOT_ECB_REFERENCE'
        ? new AppError(422, 'FX_RATE_UNAVAILABLE', 'Mata uang ini belum didukung sumber kurs kami.', details)
        : new AppError(503, 'FX_RATE_UNAVAILABLE', 'Kurs untuk mata uang ini belum tersedia. Coba lagi nanti.', details);
    case 'FX_RATE_MISSING':
      return new AppError(503, 'FX_RATE_UNAVAILABLE', 'Kurs untuk mata uang ini belum tersedia. Coba lagi nanti.', details);
    case 'UNKNOWN_CURRENCY':
      return new AppError(400, 'UNKNOWN_CURRENCY', 'Mata uang tidak dikenal', details);
    case 'INVALID_FX_PAIR':
      return new AppError(400, 'INVALID_FX_PAIR', 'Pasangan mata uang tidak valid', details);
    default:
      return new AppError(422, err.code, err.message, details);
  }
}

/** Runs fn and rethrows CoreErrors as AppErrors. */
export async function core<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw coreToAppError(err);
  }
}

/** Transaction helper that reuses an outer transaction when given one. */
export function tx<T>(db: Db, fn: (tx: TxSql) => Promise<T>): Promise<T> {
  return withTx(db, fn);
}

/** "Budi Santoso" → "Budi S.", "budi" → "Budi"; never exposes the full name. */
export function publicDisplayName(displayName: string | null | undefined, fallback = 'Pengguna JastipKita'): string {
  const parts = (displayName ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return fallback;
  const cap = (s: string) => s.charAt(0).toLocaleUpperCase('id') + s.slice(1);
  const first = cap(parts[0]!.slice(0, 30));
  if (parts.length === 1) return first;
  const last = parts[parts.length - 1]!;
  return `${first} ${last.charAt(0).toLocaleUpperCase('id')}.`;
}

export type TrustBadgeTier = 'TRUSTED_TRAVELER' | 'TRAVELER_VERIFIED' | 'IDENTITY_VERIFIED' | 'BASIC';

/** Badge shown on public profiles; derived from the KYC level (§2) — no raw PII. */
export function trustBadge(kycLevel: number): { tier: TrustBadgeTier; label: string } {
  if (kycLevel >= 5) return { tier: 'TRUSTED_TRAVELER', label: 'Trusted Traveler' };
  if (kycLevel >= 4) return { tier: 'TRAVELER_VERIFIED', label: 'Traveler Terverifikasi' };
  if (kycLevel >= 3) return { tier: 'IDENTITY_VERIFIED', label: 'Identitas Terverifikasi' };
  return { tier: 'BASIC', label: 'Akun Dasar' };
}

export function requireAuthContext(c: Context<AppEnv>): AuthContext {
  const a = c.get('auth');
  if (!a) throw Errors.unauthorized();
  return a;
}

export function depsOf(c: Context<AppEnv>): AppDeps {
  return c.get('deps');
}

/** Cursor for keyset pagination on (sortKey, id) — same opaque format as lib/pagination. */
export function encodeKeyset(t: string, id: string): string {
  return encodeCursor({ t, id });
}

export function decodeKeyset(cursor: string | undefined): { t: string; id: string } | null {
  const v = decodeCursor(cursor);
  if (!v || !/^[0-9a-f-]{36}$/i.test(v.id)) return null;
  return v;
}

export function badCursor(): AppError {
  return Errors.badRequest('INVALID_CURSOR', 'Cursor tidak valid');
}

/** 503 response doc for routes depending on FX / external providers. */
export const unavailableResponse = {
  description: 'Temporarily unavailable (e.g. FX_RATE_STALE, FX_RATE_UNAVAILABLE)',
  content: { 'application/json': { schema: ErrorSchema } },
} as const;
