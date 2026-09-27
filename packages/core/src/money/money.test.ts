import { describe, expect, it } from 'vitest';
import { CoreError } from '../errors';
import { SEEDS, createPrng } from '../testing/prng';
import {
  CURRENCIES,
  allocateProportionally,
  applyBps,
  applyRoundingRule,
  bpsToPercent,
  bpsToRate,
  ceilTo,
  decimalToString,
  divDecimal,
  divRound,
  floorTo,
  formatDecimal,
  formatIdr,
  formatMoney,
  fromMinor,
  getCurrency,
  mulByRate,
  mulByRates,
  parseDecimal,
  percentToBps,
  rateToBps,
  roundHalfUp,
  roundTo,
  sumMinor,
  toMinor,
} from './index';

describe('currencies table', () => {
  it('loads every currency from currencies.json with minor units', () => {
    expect(CURRENCIES.length).toBe(20);
    expect(getCurrency('IDR').minorUnits).toBe(0);
    expect(getCurrency('USD').minorUnits).toBe(2);
    expect(getCurrency('JPY').minorUnits).toBe(0);
    expect(getCurrency('KRW').minorUnits).toBe(0);
  });

  it('throws CoreError for unknown currencies', () => {
    expect(() => getCurrency('XXX')).toThrowError(CoreError);
  });
});

describe('decimal helper', () => {
  it('parses strings, numbers and exponents exactly', () => {
    expect(decimalToString(parseDecimal('108.5432'))).toBe('108.5432');
    expect(decimalToString(parseDecimal(0.1))).toBe('0.1');
    expect(decimalToString(parseDecimal('1.5e-3'))).toBe('0.0015');
    expect(decimalToString(parseDecimal('-2.50'))).toBe('-2.5');
    expect(decimalToString(parseDecimal(1e21))).toBe('1000000000000000000000');
  });

  it('rejects garbage input', () => {
    expect(() => parseDecimal('abc')).toThrowError(CoreError);
    expect(() => parseDecimal('')).toThrowError(CoreError);
    expect(() => parseDecimal(Number.NaN)).toThrowError(CoreError);
  });

  it('divRound implements HALF_UP away from zero, CEIL, FLOOR, TRUNC', () => {
    expect(divRound(5n, 2n, 'HALF_UP')).toBe(3n);
    expect(divRound(-5n, 2n, 'HALF_UP')).toBe(-3n);
    expect(divRound(4n, 3n, 'HALF_UP')).toBe(1n);
    expect(divRound(4n, 3n, 'CEIL')).toBe(2n);
    expect(divRound(-4n, 3n, 'CEIL')).toBe(-1n);
    expect(divRound(-4n, 3n, 'FLOOR')).toBe(-2n);
    expect(divRound(-4n, 3n, 'TRUNC')).toBe(-1n);
  });

  it('divides to a fixed scale', () => {
    expect(decimalToString(divDecimal('17800', '162.3', 10))).toBe('109.6734442391');
  });
});

describe('toMinor / fromMinor', () => {
  it('converts using currency minor units with half-up', () => {
    expect(toMinor('12.345', 'USD')).toBe(1235);
    expect(toMinor('12.344', 'USD')).toBe(1234);
    expect(toMinor(1250000, 'IDR')).toBe(1250000);
    expect(toMinor('1500.5', 'JPY')).toBe(1501);
  });

  it('fromMinor returns exact strings', () => {
    expect(fromMinor(1250, 'USD')).toBe('12.50');
    expect(fromMinor(-5, 'USD')).toBe('-0.05');
    expect(fromMinor(1250000, 'IDR')).toBe('1250000');
  });

  it('round-trips random amounts (property)', () => {
    for (const seed of SEEDS.slice(0, 50)) {
      const r = createPrng(seed);
      const minor = r.int(-1_000_000_000, 1_000_000_000);
      const ccy = r.pick(CURRENCIES).code;
      expect(toMinor(fromMinor(minor, ccy), ccy)).toBe(minor);
    }
  });

  it('rejects non-safe integers', () => {
    expect(() => fromMinor(1.5, 'IDR')).toThrowError(/safe integer/);
    expect(() => fromMinor(2 ** 60, 'IDR')).toThrowError(CoreError);
  });
});

describe('rounding helpers', () => {
  it('roundHalfUp avoids float drift', () => {
    expect(roundHalfUp(1.005, 2)).toBe(1.01);
    expect(roundHalfUp(2.5)).toBe(3);
    expect(roundHalfUp(-2.5)).toBe(-3);
    expect(roundHalfUp('0.125', 2)).toBe(0.13);
  });

  it('ceilTo / floorTo / roundTo on steps', () => {
    expect(ceilTo(12_345, 1000)).toBe(13_000);
    expect(ceilTo(12_000, 1000)).toBe(12_000);
    expect(floorTo(12_999, 1000)).toBe(12_000);
    expect(roundTo(12_500, 1000)).toBe(13_000);
    expect(roundTo(12_499, 1000)).toBe(12_000);
  });

  it('applies customs rounding rules', () => {
    expect(applyRoundingRule(12_301, 'NONE')).toBe(12_301);
    expect(applyRoundingRule(12_301, 'CEIL_1000')).toBe(13_000);
    expect(applyRoundingRule(12_301, 'ROUND_1000')).toBe(12_000);
    expect(applyRoundingRule(12_301, 'CEIL_100')).toBe(12_400);
  });
});

describe('bps & rates', () => {
  it('applies bps exactly', () => {
    expect(applyBps(1_000_000, 150)).toBe(15_000);
    expect(applyBps(333, 5000)).toBe(167);
    expect(applyBps(333, 5000, 'FLOOR')).toBe(166);
  });

  it('multiplies by several rates with a single rounding', () => {
    // 1_000_000 × 0.12 × 0.916667 = 110_000.04 → 110_000
    expect(mulByRates(1_000_000, ['0.12', '0.916667'])).toBe(110_000);
    expect(mulByRate(3, '0.5')).toBe(2);
    // float would give 0.1*3 = 0.30000000000000004
    expect(mulByRate(10, 0.03)).toBe(0);
  });

  it('converts between bps, rate and percent', () => {
    expect(bpsToRate(150)).toBe('0.015');
    expect(rateToBps('0.015')).toBe(150);
    expect(percentToBps(1.5)).toBe(150);
    expect(bpsToPercent(250)).toBe(2.5);
  });

  it('allocateProportionally always sums to the total (property)', () => {
    for (const seed of SEEDS.slice(0, 80)) {
      const r = createPrng(seed);
      const total = r.int(-5_000_000, 5_000_000);
      const weights = Array.from({ length: r.int(1, 8) }, () => r.int(0, 100_000));
      const parts = allocateProportionally(total, weights);
      expect(sumMinor(parts)).toBe(total);
      parts.forEach((p, i) => {
        const wsum = weights.reduce((a, b) => a + b, 0);
        if (wsum > 0) expect(Math.abs(p - (total * (weights[i] ?? 0)) / wsum)).toBeLessThanOrEqual(1);
      });
    }
  });
});

describe('formatting', () => {
  it('formatIdr uses id-ID grouping without a space', () => {
    expect(formatIdr(1_250_000)).toBe('Rp1.250.000');
    expect(formatIdr(0)).toBe('Rp0');
    expect(formatIdr(999)).toBe('Rp999');
    expect(formatIdr(-25_000)).toBe('-Rp25.000');
  });

  it('formatMoney respects currency decimals and locale separators', () => {
    expect(formatMoney(1250, 'USD', 'en-US')).toBe('$12.50');
    expect(formatMoney(123456789, 'USD', 'id-ID')).toBe('$1.234.567,89');
    expect(formatMoney(50_000, 'JPY', 'id-ID')).toBe('¥50.000');
    expect(formatMoney(1_234_567, 'KRW', 'en')).toBe('₩1,234,567');
  });

  it('formats decimal rates for breakdown text', () => {
    expect(formatDecimal('108.5432')).toBe('108,5432');
    expect(formatDecimal('17800.5', 'en-US')).toBe('17,800.5');
  });
});
