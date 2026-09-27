/// Tolerant JSON readers. The API contract (docs/api/openapi.json) is camelCase JSON; money is
/// integer minor units. These helpers never throw on a missing/odd field — models decide the
/// fallback so a newer API adding fields (or a nullable one) never crashes the app.
typedef Json = Map<String, dynamic>;

Json asJson(Object? value) {
  if (value is Map<String, dynamic>) return value;
  if (value is Map) {
    return value.map<String, dynamic>((Object? k, Object? v) => MapEntry<String, dynamic>(k.toString(), v));
  }
  return <String, dynamic>{};
}

String readString(Json json, String key, [String fallback = '']) {
  final Object? v = json[key];
  if (v == null) return fallback;
  return v.toString();
}

String? readStringOrNull(Json json, String key) {
  final Object? v = json[key];
  if (v == null) return null;
  final s = v.toString();
  return s.isEmpty ? null : s;
}

int readInt(Json json, String key, [int fallback = 0]) => readIntOrNull(json, key) ?? fallback;

int? readIntOrNull(Json json, String key) {
  final Object? v = json[key];
  if (v is int) return v;
  if (v is num) return v.round();
  if (v is String) return int.tryParse(v) ?? double.tryParse(v)?.round();
  return null;
}

double? readDoubleOrNull(Json json, String key) {
  final Object? v = json[key];
  if (v is num) return v.toDouble();
  if (v is String) return double.tryParse(v);
  return null;
}

double readDouble(Json json, String key, [double fallback = 0]) => readDoubleOrNull(json, key) ?? fallback;

bool readBool(Json json, String key, [bool fallback = false]) {
  final Object? v = json[key];
  if (v is bool) return v;
  if (v is String) return v == 'true';
  if (v is num) return v != 0;
  return fallback;
}

/// ISO-8601 timestamp → UTC [DateTime]. Calendar dates (`YYYY-MM-DD`) are parsed as UTC midnight.
DateTime? readDate(Json json, String key) {
  final Object? v = json[key];
  if (v is String && v.isNotEmpty) return DateTime.tryParse(v)?.toUtc();
  return null;
}

Json readObject(Json json, String key) => asJson(json[key]);

Json? readObjectOrNull(Json json, String key) {
  final Object? v = json[key];
  return v is Map ? asJson(v) : null;
}

List<Json> readList(Json json, String key) {
  final Object? v = json[key];
  if (v is List) return v.whereType<Map<dynamic, dynamic>>().map<Json>(asJson).toList();
  return <Json>[];
}

List<String> readStringList(Json json, String key) {
  final Object? v = json[key];
  if (v is List) return v.where((Object? e) => e != null).map((Object? e) => e.toString()).toList();
  return <String>[];
}

/// Cursor page: `{ data: [], nextCursor }`.
class Paged<T> {
  const Paged(this.items, this.nextCursor);

  final List<T> items;
  final String? nextCursor;

  bool get hasMore => nextCursor != null;

  static Paged<E> parse<E>(Json json, E Function(Json) item) =>
      Paged<E>(readList(json, 'data').map(item).toList(), readStringOrNull(json, 'nextCursor'));
}
