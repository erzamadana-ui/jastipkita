/**
 * Kurs pajak (Keputusan Menteri Keuangan mingguan) — dipakai HANYA untuk contoh & fallback offline kalkulator.
 * Sumber: docs/research/01-customs-tax-indonesia.md §4 → KMK 45/MK/EF.2/2026 (berlaku 23–29 Sep 2026),
 * https://fiskal.kemenkeu.go.id/informasi-publik/kurs-pajak — diverifikasi 2026-09-27.
 * Bea Cukai memakai kurs pada MINGGU KEDATANGAN, bukan kurs di halaman ini.
 * Nilai = rupiah per 1 unit mata uang (JPY dikonversi dari "per 100 JPY").
 */
export const KMK_RATES = {
  reference: 'KMK 45/MK/EF.2/2026',
  validFrom: '2026-09-23',
  validUntil: '2026-09-29',
  sourceUrl: 'https://fiskal.kemenkeu.go.id/informasi-publik/kurs-pajak',
  verifiedAt: '2026-09-27',
  rates: {
    USD: '17707',
    JPY: '113.7125',
    SGD: '13893.47',
    KRW: '12.92',
    MYR: '4335.21',
    AUD: '12604.12',
    EUR: '20369.44',
  } as Record<string, string>,
} as const;

export const CURRENCY_META: Record<string, { symbol: string; minorUnits: number; nameId: string; nameEn: string }> = {
  JPY: { symbol: '¥', minorUnits: 0, nameId: 'Yen Jepang', nameEn: 'Japanese yen' },
  KRW: { symbol: '₩', minorUnits: 0, nameId: 'Won Korea', nameEn: 'Korean won' },
  SGD: { symbol: 'S$', minorUnits: 2, nameId: 'Dolar Singapura', nameEn: 'Singapore dollar' },
  USD: { symbol: 'US$', minorUnits: 2, nameId: 'Dolar AS', nameEn: 'US dollar' },
  MYR: { symbol: 'RM', minorUnits: 2, nameId: 'Ringgit Malaysia', nameEn: 'Malaysian ringgit' },
  AUD: { symbol: 'A$', minorUnits: 2, nameId: 'Dolar Australia', nameEn: 'Australian dollar' },
  EUR: { symbol: '€', minorUnits: 2, nameId: 'Euro', nameEn: 'Euro' },
};
