import QRCode from 'qrcode';
import { describe, expect, it } from 'vitest';
import { encodeQr } from './qr';

function reference(text: string, ecc: 'L' | 'M' | 'Q' | 'H', mask: number) {
  const bytes = new TextEncoder().encode(text);
  const q = QRCode.create([{ data: bytes, mode: 'byte' }] as never, { errorCorrectionLevel: ecc, maskPattern: mask as never });
  const size = q.modules.size;
  const rows: boolean[][] = [];
  for (let y = 0; y < size; y++) {
    const row: boolean[] = [];
    for (let x = 0; x < size; x++) row.push(!!q.modules.get(y, x));
    rows.push(row);
  }
  return { version: q.version, size, rows };
}

const SAMPLES = [
  'A',
  'hello world',
  'otpauth://totp/JastipKita%20Admin:admin%40jastipkita.id?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=JastipKita%20Admin&algorithm=SHA1&digits=6&period=30',
  'Titip Mudah, Aman, Terpercaya. — Rp 11.577.140 ✓',
  'x'.repeat(300),
];

describe('QR encoder', () => {
  for (const text of SAMPLES) {
    for (const ecc of ['L', 'M', 'Q', 'H'] as const) {
      it(`matches the reference encoder (${ecc}, ${text.length} chars, every mask)`, () => {
        for (let mask = 0; mask < 8; mask++) {
          const mine = encodeQr(text, ecc, mask);
          const ref = reference(text, ecc, mask);
          expect(mine.version).toBe(ref.version);
          expect(mine.modules).toEqual(ref.rows);
        }
      });
    }
  }

  it('picks a mask automatically and stays a valid symbol', () => {
    const text = SAMPLES[2]!;
    const auto = encodeQr(text, 'M');
    expect(auto.mask).toBeGreaterThanOrEqual(0);
    expect(auto.modules).toEqual(reference(text, 'M', auto.mask).rows);
  });
});
