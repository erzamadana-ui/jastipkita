import { describe, expect, it } from 'vitest';
import { SEEDS, createPrng } from '../testing/prng';
import {
  CROCKFORD_ALPHABET,
  crockfordRandom,
  formatDocumentNumber,
  formatTransactionNumber,
  normalizeCrockford,
  parseDocumentNumber,
  wibDateStamp,
} from './index';

describe('numbering', () => {
  it('formats JK-YYMMDD-XXXXXX using the WIB date', () => {
    const d = new Date('2026-09-27T18:30:00Z'); // 01:30 WIB on 28 Sep
    expect(wibDateStamp(d)).toBe('260928');
    expect(formatTransactionNumber(d, new Uint8Array([0, 0, 0, 0]))).toBe('JK-260928-000000');
    expect(formatTransactionNumber(d, new Uint8Array([255, 255, 255, 255]))).toBe('JK-260928-ZZZZZZ');
  });

  it('supports DSP/RFD/TKT/PO prefixes', () => {
    const d = new Date('2026-01-02T00:00:00Z');
    const bytes = new Uint8Array([1, 2, 3, 4]);
    for (const p of ['DSP', 'RFD', 'TKT', 'PO'] as const) {
      expect(formatDocumentNumber(p, d, bytes)).toMatch(new RegExp(`^${p}-260102-[${CROCKFORD_ALPHABET}]{6}$`));
    }
  });

  it('never emits I, L, O or U and always 6 chars (property)', () => {
    for (const seed of SEEDS) {
      const s = crockfordRandom(createPrng(seed).bytes(4));
      expect(s).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}$/);
    }
  });

  it('requires 4 random bytes', () => {
    expect(() => crockfordRandom(new Uint8Array(3))).toThrow();
  });

  it('parses and normalizes typed numbers', () => {
    expect(normalizeCrockford('o1l i')).toBe('0111');
    expect(parseDocumentNumber('jk-260927-7k3qzo')?.normalized).toBe('JK-260927-7K3QZ0');
    expect(parseDocumentNumber('JK-261327-7K3QZ0')).toBeNull();
    expect(parseDocumentNumber('XX-260927-7K3QZ0')).toBeNull();
    const n = formatTransactionNumber(new Date(), createPrng(7).bytes(4));
    expect(parseDocumentNumber(n)?.normalized).toBe(n);
  });
});
