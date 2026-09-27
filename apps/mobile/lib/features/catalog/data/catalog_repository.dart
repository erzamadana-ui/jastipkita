import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/models/catalog.dart';
import '../../../core/models/json.dart';
import '../../../core/network/api_client.dart';

/// Public catalog, FX, customs calculator and restricted-item check.
class CatalogRepository {
  CatalogRepository(this._api);

  final ApiClient _api;

  Future<Catalog> load() async {
    final results = await Future.wait<Json>(<Future<Json>>[
      _api.get('/catalog/countries', query: <String, Object?>{'role': 'origin'}),
      _api.get('/catalog/countries', query: <String, Object?>{'role': 'destination'}),
      _api.get('/catalog/categories'),
      _api.get('/catalog/currencies'),
    ]);
    final byCode = <String, Country>{};
    for (final json in <Json>[results[0], results[1]]) {
      for (final c in readList(json, 'data').map(Country.fromJson)) {
        final existing = byCode[c.code];
        byCode[c.code] = existing == null
            ? c
            : Country(
                code: c.code,
                nameId: c.nameId,
                nameEn: c.nameEn,
                currencyCode: c.currencyCode,
                isOrigin: c.isOrigin || existing.isOrigin,
                isDestination: c.isDestination || existing.isDestination,
              );
      }
    }
    return Catalog(
      countries: byCode.values.toList(),
      categories: readList(results[2], 'data').map(ProductCategory.fromJson).toList(),
      currencies: readList(results[3], 'data').map(CurrencyInfo.fromJson).toList(),
    );
  }

  Future<RestrictedCheck> restrictedCheck({
    required String originCountry,
    required String categoryCode,
    required String productName,
    int? quantity,
    int? unitPriceMinor,
    String? currency,
    String destinationCountry = 'ID',
    String locale = 'id',
  }) async {
    final json = await _api.post(
      '/restricted/check',
      body: <String, dynamic>{
        'originCountry': originCountry,
        'destinationCountry': destinationCountry,
        'categoryCode': categoryCode,
        'productName': productName,
        if (quantity != null) 'quantity': quantity,
        if (unitPriceMinor != null) 'unitPriceMinor': unitPriceMinor,
        if (currency != null) 'currency': currency,
        'locale': locale,
      },
    );
    return RestrictedCheck.fromJson(json);
  }

  Future<CustomsEstimate> customsEstimate({
    required String originCountry,
    required String categoryCode,
    required int unitPriceMinor,
    required String currency,
    int quantity = 1,
    String destinationCountry = 'ID',
  }) async {
    final json = await _api.post(
      '/customs/estimate',
      body: <String, dynamic>{
        'originCountry': originCountry,
        'destinationCountry': destinationCountry,
        'categoryCode': categoryCode,
        'unitPriceMinor': unitPriceMinor,
        'currency': currency,
        'quantity': quantity,
      },
    );
    return CustomsEstimate.fromJson(json);
  }
}

final catalogRepositoryProvider = Provider<CatalogRepository>((ref) => CatalogRepository(ref.watch(apiClientProvider)));

/// Loaded once per app run (public, cacheable).
final catalogProvider = FutureProvider<Catalog>((ref) => ref.watch(catalogRepositoryProvider).load());
