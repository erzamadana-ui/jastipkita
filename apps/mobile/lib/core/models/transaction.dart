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
    this.priceCurrency,
    this.maxBudgetIdr,
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
        priceCurrency: readStringOrNull(json, 'priceCurrency')?.trim(),
        maxBudgetIdr: readIntOrNull(json, 'maxBudgetIdr'),
      );

  final String productName;
  final String? productUrl;
  final String? merchantName;
  final String? merchantCountry;
  final String? categoryCode;
  final int quantity;
  final String? variant;
  final int? unitPriceMinor;
  final String? priceCurrency;
  final int? maxBudgetIdr;
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
    this.serialNumber,
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
        serialNumber: readStringOrNull(json, 'serialNumber'),
      );

  final String id;
  final String status;
  final String? merchantName;
  final int? actualPriceMinor;
  final String? currency;
  final DateTime? purchasedAt;
  final String? receiptFileId;
  final List<String> productPhotoFileIds;
  final String? serialNumber;
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
  final String? failureReason;
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
    this.createdAt,
    this.statusChangedAt,
  });

  factory TransactionSummary.fromJson(Json json) {
    final gate = readObjectOrNull(json, 'purchaseGate');
    final item = readObjectOrNull(json, 'item');
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
    this.payoutStatus,
    this.payoutNetIdr,
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
    final payout = readObjectOrNull(json, 'payout');
    return TransactionDetail(
      id: readString(json, 'id'),
      number: readString(json, 'number'),
      status: readString(json, 'status'),
      role: readString(json, 'role', 'BUYER'),
      allowedActions: readStringList(json, 'allowedActions'),
      item: itemJson == null ? null : TxItem.fromJson(itemJson),
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
      itemCurrency: readStringOrNull(json, 'itemCurrency')?.trim(),
      purchaseCeilingMinor: ceiling == null ? null : readIntOrNull(ceiling, 'minor'),
      purchaseCeilingIdr: ceiling == null ? null : readIntOrNull(ceiling, 'idr'),
      deliveryMethod: readStringOrNull(json, 'deliveryMethod'),
      autoConfirmAt: readDate(json, 'autoConfirmAt'),
      createdAt: readDate(json, 'createdAt'),
      payoutStatus: payout == null ? null : readStringOrNull(payout, 'status'),
      payoutNetIdr: payout == null ? null : readIntOrNull(payout, 'netIdr'),
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
  final String? payoutStatus;
  final int? payoutNetIdr;

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
