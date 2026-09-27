import { DOCUMENT_NUMBER_PREFIXES, type DocumentNumberPrefix, isOneOf } from '../domain';
import { CoreError } from '../errors';
import { wibCalendarDate } from '../internal/time';

/** Crockford base32 alphabet (no I, L, O, U). */
export const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const RANDOM_CHARS = 6; // 30 bits
const RANDOM_BYTES_NEEDED = 4;

/** YYMMDD in Asia/Jakarta (WIB, UTC+7, no DST) — the date users see. */
export function wibDateStamp(date: Date): string {
  const [y = '', m = '', d = ''] = wibCalendarDate(date).split('-');
  return `${y.slice(2)}${m}${d}`;
}

/** 6 Crockford chars from the first 4 random bytes (uses 30 of 32 bits → uniform, no modulo bias). */
export function crockfordRandom(randomBytes: Uint8Array): string {
  if (randomBytes.length < RANDOM_BYTES_NEEDED) {
    throw new CoreError('INSUFFICIENT_RANDOMNESS', `Need at least ${RANDOM_BYTES_NEEDED} random bytes`);
  }
  let v =
    (((randomBytes[0] as number) << 24) >>> 0) +
    ((randomBytes[1] as number) << 16) +
    ((randomBytes[2] as number) << 8) +
    (randomBytes[3] as number);
  v >>>= 2; // keep 30 bits
  let out = '';
  for (let i = 0; i < RANDOM_CHARS; i++) {
    out = (CROCKFORD_ALPHABET[v & 31] as string) + out;
    v >>>= 5;
  }
  return out;
}

/** `PREFIX-YYMMDD-XXXXXX`, e.g. `DSP-260927-7K3QZC`. */
export function formatDocumentNumber(prefix: DocumentNumberPrefix, date: Date, randomBytes: Uint8Array): string {
  if (!isOneOf(DOCUMENT_NUMBER_PREFIXES, prefix)) throw new CoreError('INVALID_PREFIX', `Unknown prefix ${String(prefix)}`);
  return `${prefix}-${wibDateStamp(date)}-${crockfordRandom(randomBytes)}`;
}

/** `JK-YYMMDD-XXXXXX` */
export function formatTransactionNumber(date: Date, randomBytes: Uint8Array): string {
  return formatDocumentNumber('JK', date, randomBytes);
}

/** Normalizes user input: uppercase, I/L → 1, O → 0, strips spaces. */
export function normalizeCrockford(input: string): string {
  return input
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0');
}

export interface ParsedDocumentNumber {
  readonly prefix: DocumentNumberPrefix;
  readonly dateStamp: string;
  readonly random: string;
  readonly normalized: string;
}

const NUMBER_RE = /^(JK|DSP|RFD|TKT|PO)-(\d{6})-([0-9A-HJKMNP-TV-Z]{6})$/;

/** Parses and normalizes a typed number (tolerates lowercase and I/L/O confusions). Null if invalid. */
export function parseDocumentNumber(input: string): ParsedDocumentNumber | null {
  const parts = input.trim().toUpperCase().split('-');
  if (parts.length !== 3) return null;
  const [prefix = '', stamp = '', rand = ''] = parts;
  const normalized = `${prefix}-${stamp}-${normalizeCrockford(rand)}`;
  const m = NUMBER_RE.exec(normalized);
  if (!m) return null;
  const mm = Number(stamp.slice(2, 4));
  const dd = Number(stamp.slice(4, 6));
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  return { prefix: m[1] as DocumentNumberPrefix, dateStamp: m[2] as string, random: m[3] as string, normalized };
}
