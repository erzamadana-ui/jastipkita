/// Money formatting. Amounts are integer minor units from the API (IDR has 0 decimals);
/// never floats. Formatting is hand-rolled so it is identical on every platform and does not
/// depend on intl locale data being loaded.
abstract final class Money {
  /// True minus sign (U+2212), as required by the design system for negative amounts.
  static const String minus = '−';

  /// Minor units per currency — fallback when the catalog (`/catalog/currencies`) is not loaded.
  static const Map<String, int> defaultMinorUnits = <String, int>{
    'IDR': 0,
    'JPY': 0,
    'KRW': 0,
    'VND': 0,
    'USD': 2,
    'SGD': 2,
    'MYR': 2,
    'AUD': 2,
    'NZD': 2,
    'EUR': 2,
    'GBP': 2,
    'CNY': 2,
    'HKD': 2,
    'TWD': 2,
    'THB': 2,
    'CAD': 2,
    'CHF': 2,
    'SAR': 2,
    'AED': 2,
    'PHP': 2,
    'INR': 2,
  };

  static const Map<String, String> symbols = <String, String>{
    'IDR': 'Rp',
    'JPY': '¥',
    'KRW': '₩',
    'USD': 'US\$',
    'SGD': 'S\$',
    'MYR': 'RM',
    'AUD': 'A\$',
    'NZD': 'NZ\$',
    'EUR': '€',
    'GBP': '£',
    'CNY': 'CN¥',
    'HKD': 'HK\$',
    'TWD': 'NT\$',
    'THB': '฿',
  };

  static int minorUnitsOf(String currency, [int? override]) =>
      override ?? defaultMinorUnits[currency.toUpperCase()] ?? 2;

  static String groupDigits(int value, String separator) {
    final digits = value.abs().toString();
    final buffer = StringBuffer();
    for (var i = 0; i < digits.length; i++) {
      if (i > 0 && (digits.length - i) % 3 == 0) buffer.write(separator);
      buffer.write(digits[i]);
    }
    return buffer.toString();
  }

  /// IDR: `id` → `Rp1.250.000`, `en` → `IDR 1,250,000`; negatives use a true minus (`−Rp50.000`).
  static String idr(int amount, {String locale = 'id'}) {
    final en = locale == 'en';
    final digits = groupDigits(amount, en ? ',' : '.');
    final body = en ? 'IDR $digits' : 'Rp$digits';
    return amount < 0 ? '$minus$body' : body;
  }

  /// Any currency in minor units: `¥88.000`, `S$1.234,50` (id) / `S$1,234.50` (en).
  static String minor(int amountMinor, String currency, {String locale = 'id', int? minorUnits}) {
    final code = currency.toUpperCase();
    if (code == 'IDR') return idr(amountMinor, locale: locale);
    final units = minorUnitsOf(code, minorUnits);
    final en = locale == 'en';
    final divisor = _pow10(units);
    final abs = amountMinor.abs();
    var body = groupDigits(abs ~/ divisor, en ? ',' : '.');
    if (units > 0) {
      final fraction = (abs % divisor).toString().padLeft(units, '0');
      body = '$body${en ? '.' : ','}$fraction';
    }
    final symbol = symbols[code];
    final text = symbol == null ? '$code $body' : '$symbol$body';
    return amountMinor < 0 ? '$minus$text' : text;
  }

  /// FX rate (decimal string from the API) → "Rp108,42" / "IDR 108.42". Display only — money
  /// maths always happens on the server with the locked rate.
  static String rate(String decimal, {String locale = 'id', String quote = 'IDR'}) {
    final value = double.tryParse(decimal);
    if (value == null) return decimal;
    final fixed = value.abs().toStringAsFixed(2);
    final dot = fixed.indexOf('.');
    final wholeText = dot < 0 ? fixed : fixed.substring(0, dot);
    final fraction = dot < 0 ? '00' : fixed.substring(dot + 1);
    final en = locale == 'en';
    final whole = groupDigits(int.tryParse(wholeText) ?? 0, en ? ',' : '.');
    final body = '$whole${en ? '.' : ','}$fraction';
    if (quote.toUpperCase() == 'IDR') return en ? 'IDR $body' : 'Rp$body';
    return '${quote.toUpperCase()} $body';
  }

  /// Parses user input ("88.000", "12,50", "1,234.5") into minor units.
  static int? parseMinor(String input, String currency, {int? minorUnits}) {
    final code = currency.toUpperCase();
    final units = code == 'IDR' ? 0 : minorUnitsOf(code, minorUnits);
    final cleaned = input.replaceAll(RegExp(r'[^0-9.,]'), '');
    if (cleaned.isEmpty) return null;
    final separators = RegExp(r'[.,]');
    if (units == 0) return int.tryParse(cleaned.replaceAll(separators, ''));
    var whole = cleaned;
    var fraction = '';
    final last = cleaned.lastIndexOf(separators);
    if (last >= 0) {
      final tail = cleaned.length - last - 1;
      if (tail > 0 && tail <= units) {
        whole = cleaned.substring(0, last);
        fraction = cleaned.substring(last + 1);
      }
    }
    whole = whole.replaceAll(separators, '');
    if (whole.isEmpty) whole = '0';
    final wholeValue = int.tryParse(whole);
    if (wholeValue == null) return null;
    final fractionValue = int.tryParse(fraction.padRight(units, '0')) ?? 0;
    return wholeValue * _pow10(units) + fractionValue;
  }

  /// Screen-reader sentence: "sebelas juta … rupiah" / "eleven million … rupiah".
  static String spokenIdr(int amount, {String locale = 'id'}) {
    final words = locale == 'en' ? _spellEn(amount.abs()) : _spellId(amount.abs());
    return '${amount < 0 ? 'minus ' : ''}$words rupiah';
  }

  static int _pow10(int exponent) {
    var result = 1;
    for (var i = 0; i < exponent; i++) {
      result *= 10;
    }
    return result;
  }

  static const List<(int, String, String)> _scales = <(int, String, String)>[
    (1000000000000, 'triliun', 'trillion'),
    (1000000000, 'miliar', 'billion'),
    (1000000, 'juta', 'million'),
    (1000, 'ribu', 'thousand'),
  ];

  static const List<String> _idOnes = <String>[
    '',
    'satu',
    'dua',
    'tiga',
    'empat',
    'lima',
    'enam',
    'tujuh',
    'delapan',
    'sembilan',
    'sepuluh',
    'sebelas',
  ];

  static String _idBelowThousand(int n) {
    if (n < 12) return _idOnes[n];
    if (n < 20) return '${_idOnes[n - 10]} belas';
    if (n < 100) {
      final tens = n ~/ 10;
      final rest = n % 10;
      return rest == 0 ? '${_idOnes[tens]} puluh' : '${_idOnes[tens]} puluh ${_idOnes[rest]}';
    }
    final hundreds = n ~/ 100;
    final rest = n % 100;
    final head = hundreds == 1 ? 'seratus' : '${_idOnes[hundreds]} ratus';
    return rest == 0 ? head : '$head ${_idBelowThousand(rest)}';
  }

  static String _spellId(int n) {
    if (n == 0) return 'nol';
    final parts = <String>[];
    var rest = n;
    for (final (value, idName, _) in _scales) {
      final count = rest ~/ value;
      if (count > 0) {
        parts.add(value == 1000 && count == 1 ? 'seribu' : '${_idBelowThousand(count % 1000)} $idName');
        rest %= value;
      }
    }
    if (rest > 0) parts.add(_idBelowThousand(rest));
    return parts.join(' ');
  }

  static const List<String> _enOnes = <String>[
    '',
    'one',
    'two',
    'three',
    'four',
    'five',
    'six',
    'seven',
    'eight',
    'nine',
    'ten',
    'eleven',
    'twelve',
    'thirteen',
    'fourteen',
    'fifteen',
    'sixteen',
    'seventeen',
    'eighteen',
    'nineteen',
  ];

  static const List<String> _enTens = <String>[
    '',
    '',
    'twenty',
    'thirty',
    'forty',
    'fifty',
    'sixty',
    'seventy',
    'eighty',
    'ninety',
  ];

  static String _enBelowThousand(int n) {
    final parts = <String>[];
    var rest = n;
    if (rest >= 100) {
      parts.add('${_enOnes[rest ~/ 100]} hundred');
      rest %= 100;
    }
    if (rest >= 20) {
      final tens = _enTens[rest ~/ 10];
      final ones = rest % 10;
      parts.add(ones == 0 ? tens : '$tens-${_enOnes[ones]}');
    } else if (rest > 0) {
      parts.add(_enOnes[rest]);
    }
    return parts.join(' ');
  }

  static String _spellEn(int n) {
    if (n == 0) return 'zero';
    final parts = <String>[];
    var rest = n;
    for (final (value, _, enName) in _scales) {
      final count = rest ~/ value;
      if (count > 0) {
        parts.add('${_enBelowThousand(count % 1000)} $enName');
        rest %= value;
      }
    }
    if (rest > 0) parts.add(_enBelowThousand(rest));
    return parts.join(' ');
  }
}
