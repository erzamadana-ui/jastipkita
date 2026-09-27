import 'package:flutter_test/flutter_test.dart';
import 'package:jastipkita/core/format/money.dart';

void main() {
  group('Money.idr', () {
    test('Indonesian format: Rp, dot grouping, no space, no decimals', () {
      expect(Money.idr(1250000), 'Rp1.250.000');
      expect(Money.idr(0), 'Rp0');
      expect(Money.idr(999), 'Rp999');
      expect(Money.idr(1000), 'Rp1.000');
      expect(Money.idr(12345678901), 'Rp12.345.678.901');
    });

    test('negative amounts use a true minus sign (U+2212)', () {
      expect(Money.idr(-50000), '−Rp50.000');
      expect(Money.idr(-50000).contains('-'), isFalse);
    });

    test('English format', () {
      expect(Money.idr(1250000, locale: 'en'), 'IDR 1,250,000');
      expect(Money.idr(-7500, locale: 'en'), '−IDR 7,500');
    });
  });

  group('Money.minor', () {
    test('zero-decimal currencies', () {
      expect(Money.minor(88000, 'JPY'), '¥88.000');
      expect(Money.minor(88000, 'JPY', locale: 'en'), '¥88,000');
      expect(Money.minor(1500000, 'KRW'), '₩1.500.000');
    });

    test('two-decimal currencies', () {
      expect(Money.minor(123450, 'SGD'), 'S\$1.234,50');
      expect(Money.minor(123450, 'SGD', locale: 'en'), 'S\$1,234.50');
      expect(Money.minor(5, 'USD', locale: 'en'), 'US\$0.05');
      expect(Money.minor(-199, 'EUR', locale: 'en'), '−€1.99');
    });

    test('IDR delegates to the IDR formatter', () {
      expect(Money.minor(1250000, 'IDR'), 'Rp1.250.000');
    });

    test('unknown currency falls back to its code', () {
      expect(Money.minor(1000, 'XYZ', locale: 'en'), 'XYZ 10.00');
    });
  });

  group('Money.parseMinor', () {
    test('IDR input ignores separators', () {
      expect(Money.parseMinor('1.250.000', 'IDR'), 1250000);
      expect(Money.parseMinor('Rp 75.000', 'IDR'), 75000);
      expect(Money.parseMinor('', 'IDR'), isNull);
    });

    test('decimal currencies accept either decimal separator', () {
      expect(Money.parseMinor('12,50', 'SGD'), 1250);
      expect(Money.parseMinor('1,234.5', 'USD'), 123450);
      expect(Money.parseMinor('1.234,56', 'EUR'), 123456);
      expect(Money.parseMinor('88.000', 'JPY'), 88000);
    });
  });

  test('FX rate is display-only text with two decimals', () {
    expect(Money.rate('108.4213'), 'Rp108,42');
    expect(Money.rate('11234.5', locale: 'en'), 'IDR 11,234.50');
    expect(Money.rate('not-a-number'), 'not-a-number');
  });

  test('spoken amounts for screen readers', () {
    expect(Money.spokenIdr(1250000), 'satu juta dua ratus lima puluh ribu rupiah');
    expect(Money.spokenIdr(1000), 'seribu rupiah');
    expect(Money.spokenIdr(115), 'seratus lima belas rupiah');
    expect(Money.spokenIdr(0), 'nol rupiah');
    expect(Money.spokenIdr(-50000), 'minus lima puluh ribu rupiah');
    expect(Money.spokenIdr(1250000, locale: 'en'), contains('million'));
  });
}
