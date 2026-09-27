/// Date/time display. The API sends UTC ISO-8601; the UI shows WIB (Asia/Jakarta, UTC+7, no
/// DST) with the zone abbreviation, per docs/05-ui-design-system.md §2.5. Calendar dates
/// (`YYYY-MM-DD`: trip dates, `neededBy`) are already WIB days and are shown as-is.
abstract final class JkDates {
  static const Duration wibOffset = Duration(hours: 7);

  static const List<String> _monthsId = <String>[
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'Mei',
    'Jun',
    'Jul',
    'Agu',
    'Sep',
    'Okt',
    'Nov',
    'Des',
  ];

  static const List<String> _monthsEn = <String>[
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];

  /// Wall-clock WIB fields carried in a UTC [DateTime] (only read its fields).
  static DateTime toWib(DateTime instant) => instant.toUtc().add(wibOffset);

  static String month(int month, String locale) {
    final names = locale == 'en' ? _monthsEn : _monthsId;
    if (month < 1) return names.first;
    if (month > 12) return names.last;
    return names[month - 1];
  }

  static String two(int value) => value.toString().padLeft(2, '0');

  /// "27 Sep 2026, 14:32 WIB"
  static String dateTime(DateTime instant, String locale) {
    final w = toWib(instant);
    return '${w.day} ${month(w.month, locale)} ${w.year}, ${two(w.hour)}:${two(w.minute)} WIB';
  }

  /// "26 Sep, 20:14"
  static String shortDateTime(DateTime instant, String locale) {
    final w = toWib(instant);
    return '${w.day} ${month(w.month, locale)}, ${two(w.hour)}:${two(w.minute)}';
  }

  /// "27 Sep 2026"
  static String date(DateTime instant, String locale) {
    final w = toWib(instant);
    return '${w.day} ${month(w.month, locale)} ${w.year}';
  }

  /// "14:32 WIB"
  static String time(DateTime instant) {
    final w = toWib(instant);
    return '${two(w.hour)}:${two(w.minute)} WIB';
  }

  /// `2026-10-12` → "12 Okt 2026"
  static String calendar(String ymd, String locale) {
    final d = DateTime.tryParse(ymd);
    if (d == null) return ymd;
    return '${d.day} ${month(d.month, locale)} ${d.year}';
  }

  /// `2026-10-12` → "12 Okt"
  static String calendarShort(String ymd, String locale) {
    final d = DateTime.tryParse(ymd);
    if (d == null) return ymd;
    return '${d.day} ${month(d.month, locale)}';
  }

  /// Local calendar date → `YYYY-MM-DD`.
  static String toYmd(DateTime day) => '${day.year}-${two(day.month)}-${two(day.day)}';

  /// Today in WIB as a calendar day.
  static DateTime todayWib([DateTime? nowUtc]) {
    final w = toWib(nowUtc ?? DateTime.now().toUtc());
    return DateTime(w.year, w.month, w.day);
  }

  /// `mm:ss`, or `h:mm:ss` above one hour. Negative durations render as `00:00`.
  static String countdown(Duration remaining) {
    if (remaining.isNegative) return '00:00';
    final hours = remaining.inHours;
    final minutes = remaining.inMinutes.remainder(60);
    final seconds = remaining.inSeconds.remainder(60);
    if (hours > 0) return '$hours:${two(minutes)}:${two(seconds)}';
    return '${two(minutes)}:${two(seconds)}';
  }
}
