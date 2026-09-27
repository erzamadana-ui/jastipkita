import 'json.dart';

class TripFee {
  const TripFee({required this.type, required this.value, this.label = ''});

  factory TripFee.fromJson(Json json) => TripFee(
        type: readString(json, 'type', 'FIXED'),
        value: readInt(json, 'value'),
        label: readString(json, 'label'),
      );

  /// FIXED (IDR per item) · PERCENT (bps of item value) · PER_KG (IDR per kg).
  final String type;
  final int value;

  /// Server-rendered Indonesian label, e.g. "Rp 150.000 / barang".
  final String label;

  Json toJson() => <String, dynamic>{'type': type, 'value': value};
}

/// Public profile — first name + initial, badge and rating only (no PII).
class PublicProfile {
  const PublicProfile({
    required this.id,
    required this.displayName,
    this.badgeTier,
    this.badgeLabel,
    this.identityVerified = false,
    this.ratingAverage,
    this.ratingCount = 0,
    this.completedTransactions = 0,
    this.trustScore,
    this.kycLevel,
  });

  factory PublicProfile.fromJson(Json json) {
    final badge = readObjectOrNull(json, 'trustBadge');
    final rating = readObjectOrNull(json, 'rating');
    final asTraveler = rating == null ? null : readObjectOrNull(rating, 'asTraveler');
    final ratingSource = asTraveler ?? rating;
    return PublicProfile(
      id: readString(json, 'id'),
      displayName: readString(json, 'displayName'),
      badgeTier: badge == null ? null : readStringOrNull(badge, 'tier'),
      badgeLabel: badge == null ? null : readStringOrNull(badge, 'label'),
      identityVerified: readBool(json, 'identityVerified'),
      ratingAverage: ratingSource == null ? null : readDoubleOrNull(ratingSource, 'average'),
      ratingCount: ratingSource == null ? 0 : readInt(ratingSource, 'count'),
      completedTransactions: readInt(json, 'completedTransactions'),
      trustScore: readIntOrNull(json, 'trustScore'),
      kycLevel: readIntOrNull(json, 'kycLevel'),
    );
  }

  final String id;
  final String displayName;
  final String? badgeTier;
  final String? badgeLabel;
  final bool identityVerified;
  final double? ratingAverage;
  final int ratingCount;
  final int completedTransactions;

  /// Only present on transaction parties (`GET /transactions/{id}`), not on discovery.
  final int? trustScore;
  final int? kycLevel;

  /// KYC level implied by the public badge tier when the exact level is not disclosed.
  int? get impliedKycLevel {
    if (kycLevel != null) return kycLevel;
    switch (badgeTier) {
      case 'TRUSTED_TRAVELER':
        return 5;
      case 'TRAVELER_VERIFIED':
        return 4;
      case 'IDENTITY_VERIFIED':
        return 3;
      default:
        return null;
    }
  }
}

class TripVerification {
  const TripVerification({required this.id, required this.docType, required this.status, this.flightNumber, this.createdAt});

  factory TripVerification.fromJson(Json json) => TripVerification(
        id: readString(json, 'id'),
        docType: readString(json, 'docType'),
        status: readString(json, 'status'),
        flightNumber: readStringOrNull(json, 'flightNumber'),
        createdAt: readDate(json, 'createdAt'),
      );

  final String id;
  final String docType;
  final String status;
  final String? flightNumber;
  final DateTime? createdAt;
}

/// Trip — owner view (`TripOwner`) and public view (`TripPublic`) share this model; owner-only
/// fields are null/empty in the public view.
class Trip {
  const Trip({
    required this.id,
    required this.status,
    required this.originCountry,
    required this.originCity,
    required this.destinationCountry,
    required this.destinationCity,
    required this.departureDate,
    required this.arrivalDate,
    required this.fee,
    required this.remainingKg,
    this.capacityKg,
    this.maxItems,
    this.itemsRemaining,
    this.returnDate,
    this.excludedCategories = const <String>[],
    this.verified = false,
    this.traveler,
    this.verifications = const <TripVerification>[],
    this.allowedActions = const <String>[],
    this.notes,
    this.isOwnerView = false,
  });

  factory Trip.fromJson(Json json) {
    final travelerJson = readObjectOrNull(json, 'traveler');
    final isOwner = json.containsKey('travelerId') || json.containsKey('allowedActions');
    return Trip(
      id: readString(json, 'id'),
      status: readString(json, 'status'),
      originCountry: readString(json, 'originCountry').trim(),
      originCity: readString(json, 'originCity'),
      destinationCountry: readString(json, 'destinationCountry', 'ID').trim(),
      destinationCity: readString(json, 'destinationCity'),
      departureDate: readString(json, 'departureDate'),
      arrivalDate: readString(json, 'arrivalDate'),
      returnDate: readStringOrNull(json, 'returnDate'),
      fee: TripFee.fromJson(readObject(json, 'fee')),
      capacityKg: readDoubleOrNull(json, 'capacityKg'),
      remainingKg: readDoubleOrNull(json, 'remainingCapacityKg') ?? readDouble(json, 'capacityRemainingKg'),
      maxItems: readIntOrNull(json, 'maxItems'),
      itemsRemaining: readIntOrNull(json, 'itemsRemaining'),
      excludedCategories: readStringList(json, 'excludedCategories'),
      verified: readBool(json, 'verified'),
      traveler: travelerJson == null ? null : PublicProfile.fromJson(travelerJson),
      verifications: readList(json, 'verifications').map(TripVerification.fromJson).toList(),
      allowedActions: readStringList(json, 'allowedActions'),
      notes: readStringOrNull(json, 'notes'),
      isOwnerView: isOwner,
    );
  }

  final String id;
  final String status;
  final String originCountry;
  final String originCity;
  final String destinationCountry;
  final String destinationCity;
  final String departureDate;
  final String arrivalDate;
  final String? returnDate;
  final TripFee fee;
  final double? capacityKg;
  final double remainingKg;
  final int? maxItems;
  final int? itemsRemaining;
  final List<String> excludedCategories;
  final bool verified;
  final PublicProfile? traveler;
  final List<TripVerification> verifications;
  final List<String> allowedActions;
  final String? notes;
  final bool isOwnerView;

  /// 0..1 share of capacity already used (owner view only; public view → null).
  double? get usedRatio {
    final cap = capacityKg;
    if (cap == null || cap <= 0) return null;
    final used = (cap - remainingKg) / cap;
    if (used < 0) return 0;
    if (used > 1) return 1;
    return used;
  }
}

class RequestItem {
  const RequestItem({
    required this.id,
    required this.status,
    required this.productName,
    required this.quantity,
    required this.destinationCountry,
    this.sourceType,
    this.productUrl,
    this.merchantName,
    this.merchantCountry,
    this.categoryCode,
    this.variant,
    this.unitPriceMinor,
    this.priceCurrency,
    this.itemValueIdr,
    this.estWeightKg,
    this.maxBudgetIdr,
    this.neededBy,
    this.destinationCity,
    this.deliveryPreference,
    this.notes,
    this.restrictionClass,
    this.restrictionRuleRef,
    this.requiresAcknowledgement = false,
    this.acknowledgedAt,
    this.blocksPublishing = false,
    this.imageUrl,
    this.pendingOffers = 0,
    this.buyer,
    this.version,
    this.expiresAt,
    this.createdAt,
    this.isOwnerView = false,
  });

  factory RequestItem.fromJson(Json json) {
    final restriction = readObjectOrNull(json, 'restriction');
    final buyerJson = readObjectOrNull(json, 'buyer');
    String? image;
    for (final img in readList(json, 'images')) {
      final url = readStringOrNull(img, 'url');
      if (url != null) {
        image = url;
        break;
      }
    }
    return RequestItem(
      id: readString(json, 'id'),
      status: readString(json, 'status'),
      sourceType: readStringOrNull(json, 'sourceType'),
      productUrl: readStringOrNull(json, 'productUrl'),
      productName: readString(json, 'productName'),
      merchantName: readStringOrNull(json, 'merchantName'),
      merchantCountry: readStringOrNull(json, 'merchantCountry')?.trim(),
      categoryCode: readStringOrNull(json, 'categoryCode'),
      quantity: readInt(json, 'quantity', 1),
      variant: readStringOrNull(json, 'variant'),
      unitPriceMinor: readIntOrNull(json, 'unitPriceMinor'),
      priceCurrency: readStringOrNull(json, 'priceCurrency')?.trim(),
      itemValueIdr: readIntOrNull(json, 'itemValueIdr'),
      estWeightKg: readDoubleOrNull(json, 'estWeightKg'),
      maxBudgetIdr: readIntOrNull(json, 'maxBudgetIdr'),
      neededBy: readStringOrNull(json, 'neededBy'),
      destinationCountry: readString(json, 'destinationCountry', 'ID').trim(),
      destinationCity: readStringOrNull(json, 'destinationCity'),
      deliveryPreference: readStringOrNull(json, 'deliveryPreference'),
      notes: readStringOrNull(json, 'notes'),
      restrictionClass: restriction == null
          ? readStringOrNull(json, 'restrictionClass')
          : readStringOrNull(restriction, 'classification'),
      restrictionRuleRef: restriction == null ? null : readStringOrNull(restriction, 'ruleRef'),
      requiresAcknowledgement: restriction != null && readBool(restriction, 'requiresAcknowledgement'),
      acknowledgedAt: restriction == null ? null : readDate(restriction, 'acknowledgedAt'),
      blocksPublishing: restriction != null && readBool(restriction, 'blocksPublishing'),
      imageUrl: image,
      pendingOffers: readInt(json, 'pendingOffers'),
      buyer: buyerJson == null ? null : PublicProfile.fromJson(buyerJson),
      version: readIntOrNull(json, 'version'),
      expiresAt: readDate(json, 'expiresAt'),
      createdAt: readDate(json, 'createdAt'),
      isOwnerView: restriction != null,
    );
  }

  final String id;
  final String status;
  final String? sourceType;
  final String? productUrl;
  final String productName;
  final String? merchantName;
  final String? merchantCountry;
  final String? categoryCode;
  final int quantity;
  final String? variant;
  final int? unitPriceMinor;
  final String? priceCurrency;
  final int? itemValueIdr;
  final double? estWeightKg;
  final int? maxBudgetIdr;
  final String? neededBy;
  final String destinationCountry;
  final String? destinationCity;
  final String? deliveryPreference;
  final String? notes;
  final String? restrictionClass;
  final String? restrictionRuleRef;
  final bool requiresAcknowledgement;
  final DateTime? acknowledgedAt;
  final bool blocksPublishing;
  final String? imageUrl;
  final int pendingOffers;
  final PublicProfile? buyer;
  final int? version;
  final DateTime? expiresAt;
  final DateTime? createdAt;
  final bool isOwnerView;

  String? get merchantDomain {
    final url = productUrl;
    if (url == null) return null;
    final host = Uri.tryParse(url)?.host;
    if (host == null || host.isEmpty) return null;
    return host.startsWith('www.') ? host.substring(4) : host;
  }
}

class ExtractionDraft {
  const ExtractionDraft({
    required this.sourceType,
    this.productUrl,
    this.productName,
    this.merchantName,
    this.merchantCountry,
    this.unitPriceMinor,
    this.priceCurrency,
    this.imageUrl,
    this.categoryCode,
    this.variant,
  });

  factory ExtractionDraft.fromJson(Json json) => ExtractionDraft(
        sourceType: readString(json, 'sourceType', 'URL'),
        productUrl: readStringOrNull(json, 'productUrl'),
        productName: readStringOrNull(json, 'productName'),
        merchantName: readStringOrNull(json, 'merchantName'),
        merchantCountry: readStringOrNull(json, 'merchantCountry')?.trim(),
        unitPriceMinor: readIntOrNull(json, 'unitPriceMinor'),
        priceCurrency: readStringOrNull(json, 'priceCurrency')?.trim(),
        imageUrl: readStringOrNull(json, 'imageUrl'),
        categoryCode: readStringOrNull(json, 'categoryCode'),
        variant: readStringOrNull(json, 'variant'),
      );

  final String sourceType;
  final String? productUrl;
  final String? productName;
  final String? merchantName;
  final String? merchantCountry;
  final int? unitPriceMinor;
  final String? priceCurrency;
  final String? imageUrl;
  final String? categoryCode;
  final String? variant;
}

class ExtractionResult {
  const ExtractionResult({
    required this.drafts,
    required this.confidence,
    required this.needsManualInput,
    required this.warnings,
    required this.mode,
  });

  factory ExtractionResult.fromJson(Json json) => ExtractionResult(
        drafts: readList(json, 'drafts').map(ExtractionDraft.fromJson).toList(),
        confidence: readDouble(json, 'confidence'),
        needsManualInput: readBool(json, 'needsManualInput'),
        warnings: readStringList(json, 'warnings'),
        mode: readString(json, 'mode', 'LIVE'),
      );

  final List<ExtractionDraft> drafts;
  final double confidence;
  final bool needsManualInput;
  final List<String> warnings;

  /// MOCK | SANDBOX | LIVE — anything but LIVE gets a SANDBOX badge in the UI.
  final String mode;
}

class RecommendedTrip {
  const RecommendedTrip({required this.trip, required this.score, required this.reasons, required this.estimatedTravelerFeeIdr});

  factory RecommendedTrip.fromJson(Json json) => RecommendedTrip(
        trip: Trip.fromJson(readObject(json, 'trip')),
        score: readDouble(json, 'score'),
        reasons: readStringList(json, 'reasons'),
        estimatedTravelerFeeIdr: readInt(json, 'estimatedTravelerFeeIdr'),
      );

  final Trip trip;
  final double score;

  /// Indonesian reasons from the matching engine ("Tiba 7 hari sebelum batas").
  final List<String> reasons;
  final int estimatedTravelerFeeIdr;
}

class RecommendedRequest {
  const RecommendedRequest({required this.request, required this.score, required this.reasons, required this.estimatedTravelerFeeIdr});

  factory RecommendedRequest.fromJson(Json json) => RecommendedRequest(
        request: RequestItem.fromJson(readObject(json, 'request')),
        score: readDouble(json, 'score'),
        reasons: readStringList(json, 'reasons'),
        estimatedTravelerFeeIdr: readInt(json, 'estimatedTravelerFeeIdr'),
      );

  final RequestItem request;
  final double score;
  final List<String> reasons;
  final int estimatedTravelerFeeIdr;
}

class Offer {
  const Offer({
    required this.id,
    required this.requestId,
    required this.tripId,
    required this.initiatedBy,
    required this.travelerFeeIdr,
    required this.status,
    this.message,
    this.expiresAt,
    this.transactionId,
    this.trip,
    this.traveler,
    this.request,
    this.allowedActions = const <String>[],
    this.createdAt,
  });

  factory Offer.fromJson(Json json) {
    final tripJson = readObjectOrNull(json, 'trip');
    final travelerJson = readObjectOrNull(json, 'traveler');
    final requestJson = readObjectOrNull(json, 'request');
    return Offer(
      id: readString(json, 'id'),
      requestId: readString(json, 'requestId'),
      tripId: readString(json, 'tripId'),
      initiatedBy: readString(json, 'initiatedBy'),
      travelerFeeIdr: readInt(json, 'travelerFeeIdr'),
      status: readString(json, 'status'),
      message: readStringOrNull(json, 'message'),
      expiresAt: readDate(json, 'expiresAt'),
      transactionId: readStringOrNull(json, 'transactionId'),
      trip: tripJson == null ? null : Trip.fromJson(tripJson),
      traveler: travelerJson == null ? null : PublicProfile.fromJson(travelerJson),
      request: requestJson == null ? null : RequestItem.fromJson(requestJson),
      allowedActions: readStringList(json, 'allowedActions'),
      createdAt: readDate(json, 'createdAt'),
    );
  }

  final String id;
  final String requestId;
  final String tripId;
  final String initiatedBy;
  final int travelerFeeIdr;
  final String status;
  final String? message;
  final DateTime? expiresAt;
  final String? transactionId;
  final Trip? trip;
  final PublicProfile? traveler;
  final RequestItem? request;
  final List<String> allowedActions;
  final DateTime? createdAt;

  bool get canAccept => allowedActions.contains('ACCEPT');
  bool get canDecline => allowedActions.contains('DECLINE');
  bool get canWithdraw => allowedActions.contains('WITHDRAW');
}
