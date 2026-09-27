import 'json.dart';

class Country {
  const Country({
    required this.code,
    required this.nameId,
    required this.nameEn,
    required this.currencyCode,
    this.isOrigin = false,
    this.isDestination = false,
  });

  factory Country.fromJson(Json json) => Country(
        code: readString(json, 'code').trim(),
        nameId: readString(json, 'nameId'),
        nameEn: readString(json, 'nameEn'),
        currencyCode: readString(json, 'currencyCode').trim(),
        isOrigin: readBool(json, 'isOrigin'),
        isDestination: readBool(json, 'isDestination'),
      );

  final String code;
  final String nameId;
  final String nameEn;
  final String currencyCode;
  final bool isOrigin;
  final bool isDestination;

  String name(String locale) => locale == 'en' ? nameEn : nameId;
}

class ProductCategory {
  const ProductCategory({
    required this.code,
    required this.nameId,
    required this.nameEn,
    this.parentCode,
    this.riskLevel = 'LOW',
    this.requiresSerial = false,
    this.requiresVideo = false,
    this.defaultWeightKg,
  });

  factory ProductCategory.fromJson(Json json) => ProductCategory(
        code: readString(json, 'code'),
        nameId: readString(json, 'nameId'),
        nameEn: readString(json, 'nameEn'),
        parentCode: readStringOrNull(json, 'parentCode'),
        riskLevel: readString(json, 'riskLevel', 'LOW'),
        requiresSerial: readBool(json, 'requiresSerial'),
        requiresVideo: readBool(json, 'requiresVideo'),
        defaultWeightKg: readDoubleOrNull(json, 'defaultWeightKg'),
      );

  final String code;
  final String nameId;
  final String nameEn;
  final String? parentCode;
  final String riskLevel;
  final bool requiresSerial;
  final bool requiresVideo;
  final double? defaultWeightKg;

  String name(String locale) => locale == 'en' ? nameEn : nameId;
}

class CurrencyInfo {
  const CurrencyInfo({required this.code, required this.minorUnits, required this.symbol, required this.name});

  factory CurrencyInfo.fromJson(Json json) => CurrencyInfo(
        code: readString(json, 'code').trim(),
        minorUnits: readInt(json, 'minorUnits'),
        symbol: readString(json, 'symbol'),
        name: readString(json, 'name'),
      );

  final String code;
  final int minorUnits;
  final String symbol;
  final String name;
}

/// Everything the forms need from `/catalog/*`, loaded once and cached.
class Catalog {
  const Catalog({required this.countries, required this.categories, required this.currencies});

  final List<Country> countries;
  final List<ProductCategory> categories;
  final List<CurrencyInfo> currencies;

  List<Country> get origins => countries.where((Country c) => c.isOrigin).toList();

  List<Country> get destinations => countries.where((Country c) => c.isDestination).toList();

  Country? country(String? code) {
    if (code == null) return null;
    for (final c in countries) {
      if (c.code == code) return c;
    }
    return null;
  }

  ProductCategory? category(String? code) {
    if (code == null) return null;
    for (final c in categories) {
      if (c.code == code) return c;
    }
    return null;
  }

  int? minorUnits(String? currency) {
    if (currency == null) return null;
    for (final c in currencies) {
      if (c.code == currency) return c.minorUnits;
    }
    return null;
  }

  String countryName(String? code, String locale) => country(code)?.name(locale) ?? (code ?? '');

  String categoryName(String? code, String locale) => category(code)?.name(locale) ?? (code ?? '');
}

class RestrictedCheck {
  const RestrictedCheck({
    required this.classification,
    required this.blocksCheckout,
    required this.requiresAcknowledgement,
    this.messages = const <String>[],
    this.permitAuthorities = const <String>[],
    this.airlineDg = false,
    this.ruleRef,
    this.disclaimer,
  });

  factory RestrictedCheck.fromJson(Json json) => RestrictedCheck(
        classification: readString(json, 'classification', 'ALLOWED'),
        blocksCheckout: readBool(json, 'blocksCheckout'),
        requiresAcknowledgement: readBool(json, 'requiresAcknowledgement'),
        messages: readStringList(json, 'messages'),
        permitAuthorities: readStringList(json, 'permitAuthorities'),
        airlineDg: readBool(json, 'airlineDg'),
        ruleRef: readStringOrNull(json, 'ruleRef'),
        disclaimer: readStringOrNull(json, 'disclaimer'),
      );

  final String classification;
  final bool blocksCheckout;
  final bool requiresAcknowledgement;
  final List<String> messages;
  final List<String> permitAuthorities;
  final bool airlineDg;
  final String? ruleRef;
  final String? disclaimer;
}

class CustomsEstimate {
  const CustomsEstimate({
    required this.treatment,
    required this.dutyIdr,
    required this.importTaxIdr,
    required this.totalIdr,
    required this.customsValueIdr,
    this.ruleRef,
    this.sourceReference,
    this.treatmentExplanation,
    this.disclaimer,
    this.warnings = const <String>[],
  });

  factory CustomsEstimate.fromJson(Json json) {
    final estimate = readObject(json, 'estimate');
    return CustomsEstimate(
      treatment: readString(json, 'treatment', readString(estimate, 'treatment')),
      dutyIdr: readInt(estimate, 'dutyIdr'),
      importTaxIdr: readInt(estimate, 'importTaxIdr'),
      totalIdr: readInt(estimate, 'totalIdr'),
      customsValueIdr: readInt(estimate, 'customsValueIdr'),
      ruleRef: readStringOrNull(estimate, 'ruleRef'),
      sourceReference: readStringOrNull(estimate, 'sourceReference'),
      treatmentExplanation: readStringOrNull(json, 'treatmentExplanation'),
      disclaimer: readStringOrNull(json, 'disclaimer'),
      warnings: readList(estimate, 'warnings').map((Json w) => readString(w, 'message')).where((String m) => m.isNotEmpty).toList(),
    );
  }

  final String treatment;
  final int dutyIdr;
  final int importTaxIdr;
  final int totalIdr;
  final int customsValueIdr;
  final String? ruleRef;
  final String? sourceReference;
  final String? treatmentExplanation;
  final String? disclaimer;
  final List<String> warnings;
}
