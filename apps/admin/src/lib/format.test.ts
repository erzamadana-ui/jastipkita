import { describe, expect, it } from 'vitest';
import { unitHint } from '../components/data';
import { formatDecimalString, isoFromWibInput, wibInputFromIso } from './format';

describe('format helpers', () => {
  it('renders exact decimal strings (FX rates) in Indonesian notation without rounding', () => {
    expect(formatDecimalString('111.9037500000')).toBe('111,90375');
    expect(formatDecimalString('16250.0000000000')).toBe('16.250');
    expect(formatDecimalString('not-a-number')).toBe('not-a-number');
  });

  it('round-trips datetime-local values as WIB (UTC+7)', () => {
    expect(isoFromWibInput('2026-10-01T09:00')).toBe('2026-10-01T09:00:00+07:00');
    expect(wibInputFromIso('2026-10-01T02:00:00.000Z')).toBe('2026-10-01T09:00');
    expect(isoFromWibInput('')).toBeNull();
  });

  it('adds a human unit hint to numeric config values by key suffix', () => {
    expect(unitHint('pricing.maxIdr', 750000)).toMatch(/^Rp\s750\.000$/);
    expect(unitHint('rateBps', 450)).toMatch(/^4,50\s%$/);
    expect(unitHint('label', 'x')).toBeNull();
  });
});
