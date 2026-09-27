import '../domain/domain.dart';
import 'json.dart';
import 'marketplace.dart';

/// One line of the transparent landed-cost breakdown (domain §10).
class PriceLine {
  const PriceLine({
    required this.type,
    required this.amountIdr,
    this.labelId = '',
    this.labelEn = '',
    this.bucket,
    this.isEstimate = false,
    this.ruleRef,
    this.originalAmountIdr,
  });

  factory PriceLine.fromJson(Json json) => PriceLine(
        type: readString(json, 'type'),
        labelId: readString(json, 'labelId'),
        labelEn: readString(json, 'labelEn'),
        amountIdr: readInt(json, 'amountIdr'),
        bucket: readStringOrNull(json, 'bucket'),
        isEstimate: readBool(json, 'isEstimate'),
        ruleRef: readStringOrNull(json, 'ruleRef'),
        originalAmountIdr: readIntOrNull(json, 'originalAmountIdr'),
      );

  final String type;
  final String labelId;
  final String labelEn;
  final int amountIdr;
  final String? bucket;
  final bool isEstimate;
  final String? ruleRef;

  /// Set when the value changed versus the previous quote/price (highlighted once in the UI).
  final int? originalAmountIdr;

  bool get changed => originalAmountIdr != null && originalAmountIdr != amountIdr;
}

class FxLockInfo {
  const FxLockInfo({
    required this.base,
    required this.quote,
    required this.lockedRate,
    required this.spotRate,
    required this.markupBps,
    this.lockedAt,
    this.expiresAt,
    this.source,
  });

  factory FxLockInfo.fromJson(Json json) => FxLockInfo(
        base: readString(json, 'base').trim(),
        quote: readString(json, 'quote', 'IDR').trim(),
        lockedRate: readString(json, 'lockedRate'),
        spotRate: readString(json, 'spotRate'),
        markupBps: readInt(json, 'markupBps'),
        lockedAt: readDate(json, 'lockedAt'),
        expiresAt: readDate(json, 'expiresAt'),
        source: readStringOrNull(json, 'source'),
      );

  final String base;
  final String quote;

  /// Decimal string (numeric(20,10) on the server) — kept as text, never converted to double
  /// for money math.
  final String lockedRate;
  final String spotRate;
  final int markupBps;
  final DateTime? lockedAt;
  final DateTime? expiresAt;
  final String? source;
}

class Quote {
  const Quote({
    required this.quoteId,
    required this.transactionId,
    required this.status,
    required this.totalIdr,
    required this.lines,
    this.expiresAt,
    this.paymentChannel,
    this.fx,
    this.customsRuleCode,
    this.restrictedClassification,
    this.restrictedRequiresAck = false,
    this.discountIdr = 0,
    this.cashbackIdr = 0,
    this.creditAppliedIdr = 0,
    this.creditAvailableIdr = 0,
    this.itemCurrency,
    this.itemUnitPriceMinor,
    this.itemQuantity,
    this.customsDisclaimer,
    this.paymentOptions = const <PaymentOption>[],
    this.blocksCheckout = false,
  });

  factory Quote.fromJson(Json json) {
    final fxJson = readObjectOrNull(json, 'fx');
    final customs = readObject(json, 'customs');
    final restricted = readObject(json, 'restricted');
    final promotion = readObject(json, 'promotion');
    final credit = readObject(json, 'credit');
    final item = readObject(json, 'item');
    return Quote(
      quoteId: readString(json, 'quoteId'),
      transactionId: readString(json, 'transactionId'),
      status: readString(json, 'status'),
      totalIdr: readInt(json, 'totalIdr'),
      lines: readList(json, 'lines').map(PriceLine.fromJson).toList(),
      expiresAt: readDate(json, 'expiresAt'),
      paymentChannel: readStringOrNull(json, 'paymentChannel'),
      fx: fxJson == null ? null : FxLockInfo.fromJson(fxJson),
      customsRuleCode: readStringOrNull(customs, 'ruleCode'),
      customsDisclaimer: readStringOrNull(customs, 'disclaimerId'),
      restrictedClassification: readStringOrNull(restricted, 'classification'),
      restrictedRequiresAck: readBool(restricted, 'requiresAcknowledgement'),
      discountIdr: readInt(promotion, 'discountIdr'),
      cashbackIdr: readInt(promotion, 'cashbackIdr'),
      creditAppliedIdr: readInt(credit, 'appliedIdr'),
      creditAvailableIdr: readInt(credit, 'availableIdr'),
      itemCurrency: readStringOrNull(item, 'currency')?.trim(),
      itemUnitPriceMinor: readIntOrNull(item, 'unitPriceMinor'),
      itemQuantity: readIntOrNull(item, 'quantity'),
      paymentOptions: readList(json, 'paymentOptions').map(PaymentOption.fromJson).toList(),
      blocksCheckout: readBool(restricted, 'blocksCheckout'),
    );
  }

  final String quoteId;
  final String transactionId;
  final String status;
  final int totalIdr;
  final List<PriceLine> lines;
  final DateTime? expiresAt;
  final String? paymentChannel;
  final FxLockInfo? fx;
  final String? customsRuleCode;
  final String? customsDisclaimer;
  final String? restrictedClassification;
  final bool restrictedRequiresAck;
  final int discountIdr;
  final int cashbackIdr;
  final int creditAppliedIdr;
  final int creditAvailableIdr;
  final String? itemCurrency;
  final int? itemUnitPriceMinor;
  final int? itemQuantity;

  /// Fee and total for every configured channel (`[]` for quotes created before the field existed).
  final List<PaymentOption> paymentOptions;

  /// Restricted-item rules forbid paying for this item (PROHIBITED).
  final bool blocksCheckout;

  PaymentOption? paymentOption(String? channel) {
    for (final o in paymentOptions) {
      if (o.channel == channel) return o;
    }
    return null;
  }

  /// Lines in the fixed domain order (§10), regardless of the order the API sent.
  List<PriceLine> get orderedLines {
    final copy = List<PriceLine>.of(lines);
    copy.sort((PriceLine a, PriceLine b) => PriceLineType.indexOf(a.type).compareTo(PriceLineType.indexOf(b.type)));
    return copy;
  }

  PriceLine? line(String type) {
    for (final l in lines) {
      if (l.type == type) return l;
    }
    return null;
  }

  /// The earlier of quote expiry and FX-lock expiry: after it, checkout needs a new quote.
  DateTime? get lockedUntil {
    final a = expiresAt;
    final b = fx?.expiresAt;
    if (a == null) return b;
    if (b == null) return a;
    return a.isBefore(b) ? a : b;
  }

  bool isUsable(DateTime nowUtc) {
    if (status != 'ACTIVE') return false;
    final until = lockedUntil;
    return until == null || nowUtc.isBefore(until);
  }
}

/// `Quote.paymentOptions[]`: what paying with a channel costs, straight from the pricing engine.
class PaymentOption {
  const PaymentOption({
    required this.channel,
    required this.label,
    required this.feeIdr,
    required this.totalIdr,
    this.bearer = 'BUYER',
    this.refundable = true,
    this.minAmountIdr,
    this.maxAmountIdr,
    this.available = true,
    this.unavailableReason,
    this.selected = false,
  });

  factory PaymentOption.fromJson(Json json) => PaymentOption(
        channel: readString(json, 'channel'),
        label: readString(json, 'label'),
        feeIdr: readInt(json, 'feeIdr'),
        totalIdr: readInt(json, 'totalIdr'),
        bearer: readString(json, 'bearer', 'BUYER'),
        refundable: readBool(json, 'refundable', true),
        minAmountIdr: readIntOrNull(json, 'minAmountIdr'),
        maxAmountIdr: readIntOrNull(json, 'maxAmountIdr'),
        available: readBool(json, 'available', true),
        unavailableReason: readStringOrNull(json, 'unavailableReason'),
        selected: readBool(json, 'selected'),
      );

  final String channel;

  /// Server label, e.g. "Virtual Account (BCA, BNI, BRI, Mandiri)".
  final String label;
  final int feeIdr;
  final int totalIdr;

  /// BUYER | PLATFORM — who pays [feeIdr].
  final String bearer;

  /// False for VA/retail: refunds need a bank account from the buyer.
  final bool refundable;
  final int? minAmountIdr;
  final int? maxAmountIdr;
  final bool available;

  /// ABOVE_CHANNEL_MAX | BELOW_CHANNEL_MIN.
  final String? unavailableReason;
  final bool selected;
}

class Payment {
  const Payment({
    required this.id,
    required this.purpose,
    required this.status,
    required this.amountIdr,
    this.refundedIdr = 0,
    this.channel,
    this.provider,
    this.providerEnv,
    this.sandbox = false,
    this.checkoutUrl,
    this.expiresAt,
    this.securedAt,
    this.failureReason,
  });

  factory Payment.fromJson(Json json) => Payment(
        id: readString(json, 'id'),
        purpose: readString(json, 'purpose', 'CHECKOUT'),
        status: readString(json, 'status'),
        amountIdr: readInt(json, 'amountIdr'),
        refundedIdr: readInt(json, 'refundedIdr'),
        channel: readStringOrNull(json, 'channel'),
        provider: readStringOrNull(json, 'provider'),
        providerEnv: readStringOrNull(json, 'providerEnv'),
        sandbox: readBool(json, 'sandbox'),
        checkoutUrl: readStringOrNull(json, 'checkoutUrl'),
        expiresAt: readDate(json, 'expiresAt'),
        securedAt: readDate(json, 'securedAt'),
        failureReason: readStringOrNull(json, 'failureReason'),
      );

  final String id;
  final String purpose;
  final String status;
  final int amountIdr;
  final int refundedIdr;
  final String? channel;
  final String? provider;
  final String? providerEnv;
  final bool sandbox;
  final String? checkoutUrl;
  final DateTime? expiresAt;
  final DateTime? securedAt;
  final String? failureReason;

  bool get isPending => status == 'PENDING';
  bool get isSecured => status == 'SECURED';
}

/// Server-side purchase gate for the traveler (`purchaseGate`).
class PurchaseGate {
  const PurchaseGate({
    required this.canPurchase,
    required this.banner,
    this.paymentBadge,
    this.tone,
    this.messageId = '',
    this.messageEn = '',
  });

  factory PurchaseGate.fromJson(Json json) => PurchaseGate(
        canPurchase: readBool(json, 'canPurchase'),
        banner: readString(json, 'banner', 'DO_NOT_PURCHASE'),
        paymentBadge: readStringOrNull(json, 'paymentBadge'),
        tone: readStringOrNull(json, 'tone'),
        messageId: readString(json, 'messageId'),
        messageEn: readString(json, 'messageEn'),
      );

  final bool canPurchase;
  final String banner;
  final String? paymentBadge;
  final String? tone;
  final String messageId;
  final String messageEn;
}

class PriceConfirmation {
  const PriceConfirmation({
    required this.id,
    required this.status,
    required this.currency,
    required this.originalPriceMinor,
    required this.actualPriceMinor,
    required this.originalIdr,
    required this.actualIdr,
    this.supplementalRequiredIdr = 0,
    this.receiptFileId,
    this.notes,
    this.responseNote,
    this.round = 1,
    this.windowSeconds = 900,
    this.expiresAt,
    this.respondedAt,
  });

  factory PriceConfirmation.fromJson(Json json) => PriceConfirmation(
        id: readString(json, 'id'),
        status: readString(json, 'status'),
        currency: readString(json, 'currency', 'IDR').trim(),
        originalPriceMinor: readInt(json, 'originalPriceMinor'),
        actualPriceMinor: readInt(json, 'actualPriceMinor'),
        originalIdr: readInt(json, 'originalIdr'),
        actualIdr: readInt(json, 'actualIdr'),
        supplementalRequiredIdr: readInt(json, 'supplementalRequiredIdr'),
        receiptFileId: readStringOrNull(json, 'receiptFileId'),
        notes: readStringOrNull(json, 'notes'),
        responseNote: readStringOrNull(json, 'responseNote'),
        round: readInt(json, 'round', 1),
        windowSeconds: readInt(json, 'windowSeconds', 900),
        expiresAt: readDate(json, 'expiresAt'),
        respondedAt: readDate(json, 'respondedAt'),
      );

  final String id;
  final String status;
  final String currency;
  final int originalPriceMinor;
  final int actualPriceMinor;
  final int originalIdr;
  final int actualIdr;
  final int supplementalRequiredIdr;
  final String? receiptFileId;
  final String? notes;
  final String? responseNote;
  final int round;
  final int windowSeconds;
  final DateTime? expiresAt;
  final DateTime? respondedAt;

  bool get isOpen => status == 'PENDING' || status == 'CLARIFICATION_REQUESTED';

  int get differenceIdr => actualIdr - originalIdr;

  /// Change in basis points of the secured price (positive = more expensive).
  int get differenceBps => originalIdr == 0 ? 0 : (differenceIdr * 10000 ~/ originalIdr);
}

class TxItem {
  const TxItem({
    required this.productName,
    this.productUrl,
    this.merchantName,
    this.merchantCountry,
    this.categoryCode,
    this.quantity = 1,
    this.variant,
    this.unitPriceMinor,
    this.currency,
    this.maxBudgetIdr,
    this.imageUrl,
    this.hsCode,
  });

  factory TxItem.fromJson(Json json) => TxItem(
        productName: readString(json, 'productName'),
        productUrl: readStringOrNull(json, 'productUrl'),
        merchantName: readStringOrNull(json, 'merchantName'),
        merchantCountry: readStringOrNull(json, 'merchantCountry')?.trim(),
        categoryCode: readStringOrNull(json, 'categoryCode'),
        quantity: readInt(json, 'quantity', 1),
        variant: readStringOrNull(json, 'variant'),
        unitPriceMinor: readIntOrNull(json, 'unitPriceMinor'),
        // `priceCurrency` is the deprecated alias of `currency`.
        currency: (readStringOrNull(json, 'currency') ?? readStringOrNull(json, 'priceCurrency'))?.trim(),
        maxBudgetIdr: readIntOrNull(json, 'maxBudgetIdr'),
        imageUrl: readStringOrNull(json, 'imageUrl'),
        hsCode: readStringOrNull(json, 'hsCode'),
      );

  final String productName;
  final String? productUrl;
  final String? merchantName;
  final String? merchantCountry;
  final String? categoryCode;
  final int quantity;
  final String? variant;
  final int? unitPriceMinor;
  final String? currency;
  final int? maxBudgetIdr;

  /// Absolute URL (presigned, or `/v1/files/{id}/content` with bearer).
  final String? imageUrl;
  final String? hsCode;
}

/// `TransactionDetail.trip` — the traveler's route and dates.
class TripRoute {
  const TripRoute({
    required this.id,
    required this.originCountry,
    required this.originCity,
    required this.destinationCountry,
    required this.destinationCity,
    required this.departureDate,
    required this.arrivalDate,
    this.status = '',
  });

  factory TripRoute.fromJson(Json json) => TripRoute(
        id: readString(json, 'id'),
        status: readString(json, 'status'),
        originCountry: readString(json, 'originCountry').trim(),
        originCity: readString(json, 'originCity'),
        destinationCountry: readString(json, 'destinationCountry', 'ID').trim(),
        destinationCity: readString(json, 'destinationCity'),
        departureDate: readString(json, 'departureDate'),
        arrivalDate: readString(json, 'arrivalDate'),
      );

  final String id;
  final String status;
  final String originCountry;
  final String originCity;
  final String destinationCountry;
  final String destinationCity;

  /// Calendar dates `YYYY-MM-DD`.
  final String departureDate;
  final String arrivalDate;
}

class PurchaseProof {
  const PurchaseProof({
    required this.id,
    required this.status,
    this.merchantName,
    this.actualPriceMinor,
    this.currency,
    this.purchasedAt,
    this.receiptFileId,
    this.productPhotoFileIds = const <String>[],
    this.videoFileId,
    this.serialNumber,
    this.files = const <ProofFile>[],
  });

  factory PurchaseProof.fromJson(Json json) => PurchaseProof(
        id: readString(json, 'id'),
        status: readString(json, 'status'),
        merchantName: readStringOrNull(json, 'merchantName'),
        actualPriceMinor: readIntOrNull(json, 'actualPriceMinor'),
        currency: readStringOrNull(json, 'currency')?.trim(),
        purchasedAt: readDate(json, 'purchasedAt'),
        receiptFileId: readStringOrNull(json, 'receiptFileId'),
        productPhotoFileIds: readStringList(json, 'productPhotoFileIds'),
        videoFileId: readStringOrNull(json, 'videoFileId'),
        serialNumber: readStringOrNull(json, 'serialNumber'),
        files: readList(json, 'files').map(ProofFile.fromJson).toList(),
      );

  final String id;
  final String status;
  final String? merchantName;
  final int? actualPriceMinor;
  final String? currency;
  final DateTime? purchasedAt;
  final String? receiptFileId;
  final List<String> productPhotoFileIds;
  final String? videoFileId;
  final String? serialNumber;

  /// The proof's own files with absolute `contentUrl`s (bearer required).
  final List<ProofFile> files;

  List<ProofFile> get images => files.where((ProofFile f) => f.isImage).toList();
}

class ProofFile {
  const ProofFile({required this.id, required this.kind, required this.contentUrl, this.mime, this.sizeBytes});

  factory ProofFile.fromJson(Json json) => ProofFile(
        id: readString(json, 'id'),
        kind: readString(json, 'kind'),
        contentUrl: readString(json, 'contentUrl'),
        mime: readStringOrNull(json, 'mime'),
        sizeBytes: readIntOrNull(json, 'sizeBytes'),
      );

  final String id;

  /// RECEIPT | PRODUCT_PHOTO | VIDEO
  final String kind;
  final String contentUrl;
  final String? mime;
  final int? sizeBytes;

  bool get isImage => kind != 'VIDEO' && (mime == null || mime!.startsWith('image/'));
}

class DeliveryInfo {
  const DeliveryInfo({
    required this.method,
    required this.status,
    this.courierName,
    this.trackingNumber,
    this.addressCity,
    this.meetupPoint,
    this.scheduledAt,
    this.confirmedAt,
    this.confirmedVia,
    this.pinLocked = false,
    this.pinAttemptsRemaining,
    this.pinAvailable = false,
    this.proofFileIds = const <String>[],
  });

  factory DeliveryInfo.fromJson(Json json) {
    final pin = readObjectOrNull(json, 'pin');
    return DeliveryInfo(
      method: readString(json, 'method'),
      status: readString(json, 'status'),
      courierName: readStringOrNull(json, 'courierName'),
      trackingNumber: readStringOrNull(json, 'trackingNumber'),
      addressCity: readStringOrNull(json, 'addressCity'),
      meetupPoint: readStringOrNull(json, 'meetupPoint'),
      scheduledAt: readDate(json, 'scheduledAt'),
      confirmedAt: readDate(json, 'confirmedAt'),
      confirmedVia: readStringOrNull(json, 'confirmedVia'),
      pinLocked: pin != null && readBool(pin, 'locked'),
      pinAttemptsRemaining: pin == null ? null : readIntOrNull(pin, 'attemptsRemaining'),
      pinAvailable: readBool(json, 'pinAvailable'),
      proofFileIds: readStringList(json, 'proofFileIds'),
    );
  }

  final String method;
  final String status;
  final String? courierName;
  final String? trackingNumber;
  final String? addressCity;
  final String? meetupPoint;
  final DateTime? scheduledAt;
  final DateTime? confirmedAt;
  final String? confirmedVia;
  final bool pinLocked;
  final int? pinAttemptsRemaining;

  /// Buyer only: the handover PIN can be revealed (`GET /delivery/pin`).
  final bool pinAvailable;
  final List<String> proofFileIds;
}

/// `TransactionDetail.customsDeclaration`.
class CustomsDeclarationInfo {
  const CustomsDeclarationInfo({
    required this.status,
    this.totalPaidIdr,
    this.estimatedTotalIdr,
    this.paidAt,
  });

  factory CustomsDeclarationInfo.fromJson(Json json) => CustomsDeclarationInfo(
        status: readString(json, 'status'),
        totalPaidIdr: readIntOrNull(json, 'totalPaidIdr'),
        estimatedTotalIdr: readIntOrNull(json, 'estimatedTotalIdr'),
        paidAt: readDate(json, 'paidAt'),
      );

  final String status;
  final int? totalPaidIdr;
  final int? estimatedTotalIdr;
  final DateTime? paidAt;
}

/// `TransactionDetail.payout` — traveler only (always null for the buyer).
class TransactionPayout {
  const TransactionPayout({
    required this.id,
    required this.number,
    required this.status,
    required this.amountIdr,
    required this.netIdr,
    this.holdReason,
    this.scheduledAt,
    this.paidAt,
  });

  factory TransactionPayout.fromJson(Json json) => TransactionPayout(
        id: readString(json, 'id'),
        number: readString(json, 'number'),
        status: readString(json, 'status'),
        amountIdr: readInt(json, 'amountIdr'),
        netIdr: readInt(json, 'netIdr'),
        holdReason: readStringOrNull(json, 'holdReason'),
        scheduledAt: readDate(json, 'scheduledAt'),
        paidAt: readDate(json, 'paidAt'),
      );

  final String id;
  final String number;
  final String status;
  final int amountIdr;
  final int netIdr;
  final String? holdReason;
  final DateTime? scheduledAt;
  final DateTime? paidAt;
}

class RefundInfo {
  const RefundInfo({
    required this.id,
    required this.status,
    required this.amountIdr,
    this.number,
    this.method,
    this.destinationRequired = false,
    this.destinationMask,
    this.destinationBankCode,
    this.destinationStatus,
    this.failureReason,
  });

  factory RefundInfo.fromJson(Json json) {
    final destination = readObjectOrNull(json, 'destination');
    return RefundInfo(
      id: readString(json, 'id'),
      status: readString(json, 'status'),
      amountIdr: readInt(json, 'amountIdr'),
      number: readStringOrNull(json, 'number'),
      method: readStringOrNull(json, 'method'),
      destinationRequired: readBool(json, 'destinationRequired'),
      destinationMask: destination == null ? null : readStringOrNull(destination, 'accountMask'),
      destinationBankCode: destination == null ? null : readStringOrNull(destination, 'bankCode'),
      destinationStatus: destination == null ? null : readStringOrNull(destination, 'validationStatus'),
      failureReason: readStringOrNull(json, 'failureReason'),
    );
  }

  final String id;
  final String status;
  final int amountIdr;
  final String? number;
  final String? method;
  final bool destinationRequired;
  final String? destinationMask;
  final String? destinationBankCode;

  /// `VALID` | `PENDING_REVIEW` (holder name ≠ verified identity, FINANCE decides) | `REJECTED`.
  final String? destinationStatus;
  final String? failureReason;

  static const Set<String> _closed = <String>{'SUCCEEDED', 'REJECTED', 'CANCELLED'};

  /// The destination waits for FINANCE (money.md §5.3); the refund is paid only after approval.
  bool get destinationUnderReview => destinationStatus == RefundDestinationResult.pendingReview;

  /// FINANCE rejected the account: the buyer is asked for another one (`refund.destination_required`).
  bool get destinationRejected => destinationStatus == RefundDestinationResult.rejected && !_closed.contains(status);

  bool get needsDestination => destinationRequired || destinationRejected;
}

/// `POST /refunds/{id}/destination` → `{refundId, bankCode, accountMask, validationStatus, reviewRequired, validatedAt}`.
class RefundDestinationResult {
  const RefundDestinationResult({
    required this.refundId,
    required this.validationStatus,
    this.bankCode,
    this.accountMask,
    this.reviewRequired = false,
    this.validatedAt,
  });

  factory RefundDestinationResult.fromJson(Json json) {
    final status = readString(json, 'validationStatus', valid);
    return RefundDestinationResult(
      refundId: readString(json, 'refundId'),
      validationStatus: status,
      bankCode: readStringOrNull(json, 'bankCode'),
      accountMask: readStringOrNull(json, 'accountMask'),
      reviewRequired: readBool(json, 'reviewRequired') || status == pendingReview,
      validatedAt: readDate(json, 'validatedAt'),
    );
  }

  static const String valid = 'VALID';
  static const String pendingReview = 'PENDING_REVIEW';
  static const String rejected = 'REJECTED';

  final String refundId;
  final String validationStatus;
  final String? bankCode;
  final String? accountMask;

  /// Holder name ≠ verified identity: stored `PENDING_REVIEW`, paid only after FINANCE approval.
  final bool reviewRequired;
  final DateTime? validatedAt;
}

/// Row of `GET /transactions`.
class TransactionSummary {
  const TransactionSummary({
    required this.id,
    required this.number,
    required this.status,
    required this.role,
    this.totalIdr,
    this.securedIdr = 0,
    this.purchaseGate,
    this.productName,
    this.categoryCode,
    this.merchantCountry,
    this.imageUrl,
    this.counterpartyName,
    this.counterpartyAvatarUrl,
    this.purchaseCeilingIdr,
    this.purchaseCeilingMinor,
    this.createdAt,
    this.statusChangedAt,
  });

  factory TransactionSummary.fromJson(Json json) {
    final gate = readObjectOrNull(json, 'purchaseGate');
    final ceiling = readObjectOrNull(json, 'purchaseCeiling');
    final item = readObjectOrNull(json, 'item');
    final counterparty = readObjectOrNull(json, 'counterparty');
    return TransactionSummary(
      id: readString(json, 'id'),
      number: readString(json, 'number'),
      status: readString(json, 'status'),
      role: readString(json, 'role', 'BUYER'),
      totalIdr: readIntOrNull(json, 'totalIdr'),
      securedIdr: readInt(json, 'securedIdr'),
      purchaseGate: gate == null ? null : PurchaseGate.fromJson(gate),
      productName: item == null ? null : readStringOrNull(item, 'productName'),
      categoryCode: item == null ? null : readStringOrNull(item, 'categoryCode'),
      merchantCountry: item == null ? null : readStringOrNull(item, 'merchantCountry')?.trim(),
      imageUrl: item == null ? null : readStringOrNull(item, 'imageUrl'),
      counterpartyName: counterparty == null ? null : readStringOrNull(counterparty, 'displayName'),
      counterpartyAvatarUrl: counterparty == null ? null : readStringOrNull(counterparty, 'avatarUrl'),
      purchaseCeilingIdr: readIntOrNull(json, 'purchaseCeilingIdr'),
      purchaseCeilingMinor: readIntOrNull(json, 'purchaseCeilingMinor') ?? (ceiling == null ? null : readIntOrNull(ceiling, 'minor')),
      createdAt: readDate(json, 'createdAt'),
      statusChangedAt: readDate(json, 'statusChangedAt'),
    );
  }

  final String id;
  final String number;
  final String status;
  final String role;
  final int? totalIdr;
  final int securedIdr;
  final PurchaseGate? purchaseGate;
  final String? productName;
  final String? categoryCode;
  final String? merchantCountry;
  final String? imageUrl;

  /// The other party ("Budi S."); null before a traveler is matched.
  final String? counterpartyName;
  final String? counterpartyAvatarUrl;
  final int? purchaseCeilingIdr;

  /// Minor units of the item currency.
  final int? purchaseCeilingMinor;
  final DateTime? createdAt;
  final DateTime? statusChangedAt;

  bool get isBuyer => role == 'BUYER';
}

class TransactionDetail {
  const TransactionDetail({
    required this.id,
    required this.number,
    required this.status,
    required this.role,
    required this.allowedActions,
    this.item,
    this.buyer,
    this.traveler,
    this.quote,
    this.payments = const <Payment>[],
    this.priceConfirmations = const <PriceConfirmation>[],
    this.purchaseProof,
    this.delivery,
    this.refunds = const <RefundInfo>[],
    this.purchaseGate,
    this.totalIdr,
    this.securedIdr = 0,
    this.itemCurrency,
    this.purchaseCeilingMinor,
    this.purchaseCeilingIdr,
    this.deliveryMethod,
    this.autoConfirmAt,
    this.createdAt,
    this.statusChangedAt,
    this.trip,
    this.payout,
    this.customsDeclaration,
    this.conversationId,
  });

  factory TransactionDetail.fromJson(Json json) {
    final itemJson = readObjectOrNull(json, 'item');
    final buyerJson = readObjectOrNull(json, 'buyer');
    final travelerJson = readObjectOrNull(json, 'traveler');
    final quoteJson = readObjectOrNull(json, 'quote');
    final proofJson = readObjectOrNull(json, 'purchaseProof');
    final deliveryJson = readObjectOrNull(json, 'delivery');
    final gateJson = readObjectOrNull(json, 'purchaseGate');
    final ceiling = readObjectOrNull(json, 'purchaseCeiling');
    final tripJson = readObjectOrNull(json, 'trip');
    final payoutJson = readObjectOrNull(json, 'payout');
    final customsJson = readObjectOrNull(json, 'customsDeclaration');
    final item = itemJson == null ? null : TxItem.fromJson(itemJson);
    return TransactionDetail(
      id: readString(json, 'id'),
      number: readString(json, 'number'),
      status: readString(json, 'status'),
      role: readString(json, 'role', 'BUYER'),
      allowedActions: readStringList(json, 'allowedActions'),
      item: item,
      buyer: buyerJson == null ? null : PublicProfile.fromJson(buyerJson),
      traveler: travelerJson == null ? null : PublicProfile.fromJson(travelerJson),
      quote: quoteJson == null ? null : Quote.fromJson(quoteJson),
      payments: readList(json, 'payments').map(Payment.fromJson).toList(),
      priceConfirmations: readList(json, 'priceConfirmations').map(PriceConfirmation.fromJson).toList(),
      purchaseProof: proofJson == null ? null : PurchaseProof.fromJson(proofJson),
      delivery: deliveryJson == null ? null : DeliveryInfo.fromJson(deliveryJson),
      refunds: readList(json, 'refunds').map(RefundInfo.fromJson).toList(),
      purchaseGate: gateJson == null ? null : PurchaseGate.fromJson(gateJson),
      totalIdr: readIntOrNull(json, 'totalIdr'),
      securedIdr: readInt(json, 'securedIdr'),
      itemCurrency: (item?.currency ?? readStringOrNull(json, 'itemCurrency'))?.trim(),
      // Item-currency ceiling (the proof form compares the receipt total in the shop's currency):
      // top-level `purchaseCeilingMinor`, falling back to the deprecated `purchaseCeiling.minor`.
      purchaseCeilingMinor: readIntOrNull(json, 'purchaseCeilingMinor') ?? (ceiling == null ? null : readIntOrNull(ceiling, 'minor')),
      purchaseCeilingIdr: readIntOrNull(json, 'purchaseCeilingIdr'),
      deliveryMethod: readStringOrNull(json, 'deliveryMethod'),
      autoConfirmAt: readDate(json, 'autoConfirmAt'),
      createdAt: readDate(json, 'createdAt'),
      statusChangedAt: readDate(json, 'statusChangedAt'),
      trip: tripJson == null ? null : TripRoute.fromJson(tripJson),
      payout: payoutJson == null ? null : TransactionPayout.fromJson(payoutJson),
      customsDeclaration: customsJson == null ? null : CustomsDeclarationInfo.fromJson(customsJson),
      conversationId: readStringOrNull(json, 'conversationId'),
    );
  }

  final String id;
  final String number;
  final String status;
  final String role;
  final List<String> allowedActions;
  final TxItem? item;
  final PublicProfile? buyer;
  final PublicProfile? traveler;
  final Quote? quote;
  final List<Payment> payments;
  final List<PriceConfirmation> priceConfirmations;
  final PurchaseProof? purchaseProof;
  final DeliveryInfo? delivery;
  final List<RefundInfo> refunds;
  final PurchaseGate? purchaseGate;
  final int? totalIdr;
  final int securedIdr;
  final String? itemCurrency;
  final int? purchaseCeilingMinor;
  final int? purchaseCeilingIdr;
  final String? deliveryMethod;
  final DateTime? autoConfirmAt;
  final DateTime? createdAt;
  final DateTime? statusChangedAt;
  final TripRoute? trip;
  final TransactionPayout? payout;
  final CustomsDeclarationInfo? customsDeclaration;

  /// Null until the transaction reached MATCHED (then `GET /transactions/{id}/conversation`).
  final String? conversationId;

  bool get isBuyer => role == 'BUYER';

  bool can(String action) => allowedActions.contains(action);

  bool canUpdateStatusTo(String to) => allowedActions.contains('UPDATE_STATUS:$to');

  PriceConfirmation? get openPriceConfirmation {
    for (final pc in priceConfirmations.reversed) {
      if (pc.isOpen) return pc;
    }
    return null;
  }

  Payment? get pendingPayment {
    for (final p in payments.reversed) {
      if (p.isPending) return p;
    }
    return null;
  }

  Payment? get securedPayment {
    for (final p in payments.reversed) {
      if (p.isSecured) return p;
    }
    return null;
  }

  /// Golden rule, enforced twice: the local FSM status AND the server gate must both allow it.
  bool get travelerMayPurchase =>
      TxStatus.travelerMayPurchase(status) && (purchaseGate == null || purchaseGate!.canPurchase);
}

class TimelineEvent {
  const TimelineEvent({required this.to, this.from, this.actorType, this.reason, this.at});

  factory TimelineEvent.fromJson(Json json) => TimelineEvent(
        to: readString(json, 'to'),
        from: readStringOrNull(json, 'from'),
        actorType: readStringOrNull(json, 'actorType'),
        reason: readStringOrNull(json, 'reason'),
        at: readDate(json, 'at'),
      );

  final String to;
  final String? from;
  final String? actorType;
  final String? reason;
  final DateTime? at;
}

class HandoverPin {
  const HandoverPin({
    required this.pin,
    required this.qrPayload,
    this.qrToken,
    this.qrExpiresAt,
    this.attemptsRemaining,
    this.note,
  });

  factory HandoverPin.fromJson(Json json) => HandoverPin(
        pin: readString(json, 'pin'),
        qrToken: readStringOrNull(json, 'qrToken'),
        qrPayload: readString(json, 'qrPayload'),
        qrExpiresAt: readDate(json, 'qrExpiresAt'),
        attemptsRemaining: readIntOrNull(json, 'attemptsRemaining'),
        note: readStringOrNull(json, 'note'),
      );

  final String pin;
  final String? qrToken;
  final String qrPayload;
  final DateTime? qrExpiresAt;
  final int? attemptsRemaining;
  final String? note;

  /// "482915" → "482 915"
  String get groupedPin => pin.length == 6 ? '${pin.substring(0, 3)} ${pin.substring(3)}' : pin;
}

class CheckoutResult {
  const CheckoutResult({
    required this.paymentId,
    required this.amountIdr,
    this.checkoutUrl,
    this.expiresAt,
    this.provider,
    this.providerEnv,
    this.sandbox = false,
    this.transactionStatus,
  });

  factory CheckoutResult.fromJson(Json json) => CheckoutResult(
        paymentId: readString(json, 'paymentId'),
        amountIdr: readInt(json, 'amountIdr'),
        checkoutUrl: readStringOrNull(json, 'checkoutUrl'),
        expiresAt: readDate(json, 'expiresAt'),
        provider: readStringOrNull(json, 'provider'),
        providerEnv: readStringOrNull(json, 'providerEnv'),
        sandbox: readBool(json, 'sandbox'),
        transactionStatus: readStringOrNull(json, 'transactionStatus'),
      );

  final String paymentId;
  final int amountIdr;
  final String? checkoutUrl;
  final DateTime? expiresAt;
  final String? provider;
  final String? providerEnv;
  final bool sandbox;
  final String? transactionStatus;
}

class CancellationOutcome {
  const CancellationOutcome({
    required this.stage,
    required this.refundIdr,
    required this.travelerCompensationIdr,
    required this.trustPenalty,
  });

  factory CancellationOutcome.fromJson(Json json) => CancellationOutcome(
        stage: readString(json, 'stage'),
        refundIdr: readInt(json, 'refundIdr'),
        travelerCompensationIdr: readInt(json, 'travelerCompensationIdr'),
        trustPenalty: readInt(json, 'trustPenalty'),
      );

  final String stage;
  final int refundIdr;
  final int travelerCompensationIdr;
  final int trustPenalty;
}

/// `GET /transactions/{id}/cancel/preview` — computed by the same code path as `POST /cancel`.
class CancellationPreview {
  const CancellationPreview({
    required this.allowed,
    required this.canCancel,
    this.stage,
    this.reasonCode,
    this.reason,
    this.paymentCaptured = false,
    this.paidIdr = 0,
    this.refundIdr = 0,
    this.travelerCompensationIdr = 0,
    this.platformRetainedIdr = 0,
    this.paymentFeeRetainedIdr = 0,
    this.serviceTaxRetainedIdr = 0,
    this.customsRetainedIdr = 0,
    this.creditRestoredIdr = 0,
    this.discountReversedIdr = 0,
    this.trustPenalty = 0,
    this.penalizedActor,
    this.requiresAdminApproval = false,
    this.blockedCode,
    this.blockedMessage,
  });

  factory CancellationPreview.fromJson(Json json) {
    final blocked = readObjectOrNull(json, 'blockedBy');
    return CancellationPreview(
      allowed: readBool(json, 'allowed'),
      canCancel: readBool(json, 'canCancel'),
      stage: readStringOrNull(json, 'stage'),
      reasonCode: readStringOrNull(json, 'reasonCode'),
      reason: readStringOrNull(json, 'reason'),
      paymentCaptured: readBool(json, 'paymentCaptured'),
      paidIdr: readInt(json, 'paidIdr'),
      refundIdr: readInt(json, 'refundIdr'),
      travelerCompensationIdr: readInt(json, 'travelerCompensationIdr'),
      platformRetainedIdr: readInt(json, 'platformRetainedIdr'),
      paymentFeeRetainedIdr: readInt(json, 'paymentFeeRetainedIdr'),
      serviceTaxRetainedIdr: readInt(json, 'serviceTaxRetainedIdr'),
      customsRetainedIdr: readInt(json, 'customsRetainedIdr'),
      creditRestoredIdr: readInt(json, 'creditRestoredIdr'),
      discountReversedIdr: readInt(json, 'discountReversedIdr'),
      trustPenalty: readInt(json, 'trustPenalty'),
      penalizedActor: readStringOrNull(json, 'penalizedActor'),
      requiresAdminApproval: readBool(json, 'requiresAdminApproval'),
      blockedCode: blocked == null ? null : readStringOrNull(blocked, 'code'),
      blockedMessage: blocked == null ? null : readStringOrNull(blocked, 'message'),
    );
  }

  final bool allowed;

  /// The caller may submit `POST /cancel` now (allowed, FSM permits, no admin approval needed).
  final bool canCancel;
  final String? stage;
  final String? reasonCode;

  /// Server explanation (Indonesian by default, `Accept-Language` aware).
  final String? reason;
  final bool paymentCaptured;
  final int paidIdr;
  final int refundIdr;
  final int travelerCompensationIdr;
  final int platformRetainedIdr;
  final int paymentFeeRetainedIdr;
  final int serviceTaxRetainedIdr;
  final int customsRetainedIdr;
  final int creditRestoredIdr;
  final int discountReversedIdr;
  final int trustPenalty;
  final String? penalizedActor;
  final bool requiresAdminApproval;

  /// CANCELLATION_NOT_ALLOWED | ADMIN_APPROVAL_REQUIRED.
  final String? blockedCode;
  final String? blockedMessage;

  /// Paid but not refunded (compensation, retained fees, customs already paid, …).
  int get notRefundedIdr => paidIdr > refundIdr ? paidIdr - refundIdr : 0;
}

/// Result of money mutations (`MoneyActionResult` is open-ended in the spec).
class MoneyActionResult {
  const MoneyActionResult(this.raw);

  final Json raw;

  String? get transactionStatus => readStringOrNull(raw, 'transactionStatus') ?? readStringOrNull(raw, 'status');

  String? get outcome => readStringOrNull(raw, 'outcome');

  bool get alreadyConfirmed => readBool(raw, 'alreadyConfirmed');

  CancellationOutcome? get cancellation {
    final c = readObjectOrNull(raw, 'cancellation');
    return c == null ? null : CancellationOutcome.fromJson(c);
  }

  Payment? get supplementalPayment {
    final p = readObjectOrNull(raw, 'payment');
    return p == null ? null : Payment.fromJson(p);
  }
}

class Payout {
  const Payout({
    required this.id,
    required this.number,
    required this.status,
    required this.amountIdr,
    required this.netIdr,
    this.feeIdr = 0,
    this.transactionId,
    this.transactionNumber,
    this.holdReason,
    this.scheduledFor,
    this.paidAt,
    this.bankCode,
    this.accountMask,
  });

  factory Payout.fromJson(Json json) {
    final destination = readObject(json, 'destination');
    return Payout(
      id: readString(json, 'id'),
      number: readString(json, 'number'),
      status: readString(json, 'status'),
      amountIdr: readInt(json, 'amountIdr'),
      netIdr: readInt(json, 'netIdr'),
      feeIdr: readInt(json, 'feeIdr'),
      transactionId: readStringOrNull(json, 'transactionId'),
      transactionNumber: readStringOrNull(json, 'transactionNumber'),
      holdReason: readStringOrNull(json, 'holdReason'),
      scheduledFor: readDate(json, 'scheduledFor'),
      paidAt: readDate(json, 'paidAt'),
      bankCode: readStringOrNull(destination, 'bankCode'),
      accountMask: readStringOrNull(destination, 'accountMask'),
    );
  }

  final String id;
  final String number;
  final String status;
  final int amountIdr;
  final int netIdr;
  final int feeIdr;
  final String? transactionId;
  final String? transactionNumber;
  final String? holdReason;
  final DateTime? scheduledFor;
  final DateTime? paidAt;
  final String? bankCode;
  final String? accountMask;
}

class PayoutSummary {
  const PayoutSummary({
    this.scheduledIdr = 0,
    this.paidIdr = 0,
    this.heldIdr = 0,
    this.processingIdr = 0,
    this.failedIdr = 0,
  });

  factory PayoutSummary.fromJson(Json json) => PayoutSummary(
        scheduledIdr: readInt(json, 'scheduledIdr'),
        paidIdr: readInt(json, 'paidIdr'),
        heldIdr: readInt(json, 'heldIdr'),
        processingIdr: readInt(json, 'processingIdr'),
        failedIdr: readInt(json, 'failedIdr'),
      );

  final int scheduledIdr;
  final int paidIdr;
  final int heldIdr;
  final int processingIdr;
  final int failedIdr;
}

class PayoutPage {
  const PayoutPage({required this.items, required this.summary, this.nextCursor});

  factory PayoutPage.fromJson(Json json) => PayoutPage(
        items: readList(json, 'data').map(Payout.fromJson).toList(),
        summary: PayoutSummary.fromJson(readObject(json, 'summary')),
        nextCursor: readStringOrNull(json, 'nextCursor'),
      );

  final List<Payout> items;
  final PayoutSummary summary;
  final String? nextCursor;
}
