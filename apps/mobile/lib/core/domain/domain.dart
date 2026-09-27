/// Domain vocabulary mirrored from docs/00-domain-model.md (the source of truth). Codes stay
/// English/UPPER_SNAKE exactly as the API sends them; labels come from l10n.
abstract final class TxStatus {
  static const String requestCreated = 'REQUEST_CREATED';
  static const String matched = 'MATCHED';
  static const String awaitingPayment = 'AWAITING_PAYMENT';
  static const String paymentSecured = 'PAYMENT_SECURED';
  static const String priceChangePending = 'PRICE_CHANGE_PENDING';
  static const String purchaseApproved = 'PURCHASE_APPROVED';
  static const String purchased = 'PURCHASED';
  static const String traveling = 'TRAVELING';
  static const String arrived = 'ARRIVED';
  static const String customsProcess = 'CUSTOMS_PROCESS';
  static const String readyForHandover = 'READY_FOR_HANDOVER';
  static const String outForDelivery = 'OUT_FOR_DELIVERY';
  static const String delivered = 'DELIVERED';
  static const String buyerConfirmed = 'BUYER_CONFIRMED';
  static const String completed = 'COMPLETED';
  static const String cancelled = 'CANCELLED';
  static const String disputed = 'DISPUTED';
  static const String refundPending = 'REFUND_PENDING';
  static const String refunded = 'REFUNDED';

  static const List<String> all = <String>[
    requestCreated,
    matched,
    awaitingPayment,
    paymentSecured,
    priceChangePending,
    purchaseApproved,
    purchased,
    traveling,
    arrived,
    customsProcess,
    readyForHandover,
    outForDelivery,
    delivered,
    buyerConfirmed,
    completed,
    cancelled,
    disputed,
    refundPending,
    refunded,
  ];

  static const Set<String> terminal = <String>{completed, cancelled, refunded};

  /// Every status before PURCHASE_APPROVED — the traveler sees DO NOT PURCHASE.
  static const Set<String> prePurchase = <String>{
    requestCreated,
    matched,
    awaitingPayment,
    paymentSecured,
    priceChangePending,
  };

  /// Funds held by SafePay (buyer sees PAYMENT SECURED).
  static const Set<String> fundsSecured = <String>{
    paymentSecured,
    priceChangePending,
    purchaseApproved,
    purchased,
    traveling,
    arrived,
    customsProcess,
    readyForHandover,
    outForDelivery,
    delivered,
    buyerConfirmed,
    disputed,
  };

  static const Set<String> errorStates = <String>{cancelled, disputed, refundPending, refunded};

  static bool isTerminal(String status) => terminal.contains(status);

  /// Golden rule: a traveler may only buy in PURCHASE_APPROVED.
  static bool travelerMayPurchase(String status) => status == purchaseApproved;

  /// Cancellation-matrix stage for a status (domain §8) — used for the pre-confirmation preview.
  static String cancellationStage(String status) {
    switch (status) {
      case requestCreated:
        return 'BEFORE_MATCH';
      case matched:
      case awaitingPayment:
        return 'AFTER_MATCH';
      case paymentSecured:
      case priceChangePending:
        return 'AFTER_PAYMENT';
      case purchaseApproved:
        return 'BEFORE_PURCHASE';
      case purchased:
        return 'AFTER_PURCHASE';
      case traveling:
        return 'DURING_TRAVEL';
      default:
        return 'AFTER_ARRIVAL';
    }
  }
}

abstract final class TripStatus {
  static const String draft = 'DRAFT';
  static const String verificationPending = 'VERIFICATION_PENDING';
  static const String verified = 'VERIFIED';
  static const String active = 'ACTIVE';
  static const String full = 'FULL';
  static const String traveling = 'TRAVELING';
  static const String completed = 'COMPLETED';
  static const String cancelled = 'CANCELLED';
}

abstract final class RequestStatus {
  static const String draft = 'DRAFT';
  static const String open = 'OPEN';
  static const String matched = 'MATCHED';
  static const String closed = 'CLOSED';
  static const String cancelled = 'CANCELLED';
  static const String expired = 'EXPIRED';
}

/// Restricted-item classification (domain §7).
abstract final class Restriction {
  static const String allowed = 'ALLOWED';
  static const String restricted = 'RESTRICTED';
  static const String declarationRequired = 'DECLARATION_REQUIRED';
  static const String permitRequired = 'PERMIT_REQUIRED';
  static const String prohibited = 'PROHIBITED';

  static const List<String> all = <String>[allowed, restricted, declarationRequired, permitRequired, prohibited];

  static bool blocksCheckout(String? classification) => classification == prohibited;

  static bool needsAcknowledgement(String? classification) =>
      classification != null && classification != allowed && classification != prohibited;
}

/// Price breakdown lines in the fixed display order of domain §10.
abstract final class PriceLineType {
  static const String itemPrice = 'ITEM_PRICE';
  static const String travelerFee = 'TRAVELER_FEE';
  static const String customsDuty = 'CUSTOMS_DUTY';
  static const String importTax = 'IMPORT_TAX';
  static const String protectionFee = 'PROTECTION_FEE';
  static const String platformFee = 'PLATFORM_FEE';
  static const String serviceTax = 'SERVICE_TAX';
  static const String paymentFee = 'PAYMENT_FEE';
  static const String discount = 'DISCOUNT';
  static const String referralCredit = 'REFERRAL_CREDIT';
  static const String total = 'TOTAL';

  static const List<String> order = <String>[
    itemPrice,
    travelerFee,
    customsDuty,
    importTax,
    protectionFee,
    platformFee,
    serviceTax,
    paymentFee,
    discount,
    referralCredit,
    total,
  ];

  /// Lines 1–8 are always shown when present (even Rp0); 9–10 only when there is a reduction.
  static const Set<String> reductions = <String>{discount, referralCredit};

  static int indexOf(String type) {
    final i = order.indexOf(type);
    return i < 0 ? order.length : i;
  }
}

abstract final class PaymentChannel {
  static const String va = 'VA';
  static const String qris = 'QRIS';
  static const String ewallet = 'EWALLET';
  static const String card = 'CARD';

  static const List<String> all = <String>[va, qris, ewallet, card];
}

abstract final class DeliveryMethod {
  static const String meetup = 'MEETUP';
  static const String courier = 'COURIER';
  static const String partnerLogistics = 'PARTNER_LOGISTICS';

  static const List<String> all = <String>[meetup, courier, partnerLogistics];
}

abstract final class DisputeType {
  static const List<String> all = <String>[
    'ITEM_NOT_RECEIVED',
    'WRONG_ITEM',
    'DAMAGED_ITEM',
    'COUNTERFEIT',
    'PRICE_DISPUTE',
    'DELIVERY_DISPUTE',
    'OTHER',
  ];

  static const List<String> resolutions = <String>[
    'REFUND_FULL',
    'REFUND_PARTIAL',
    'NO_REFUND',
    'RETURN_AND_REFUND',
    'OTHER',
  ];

  static const List<String> statusFlow = <String>[
    'OPEN',
    'EVIDENCE_COLLECTION',
    'UNDER_REVIEW',
    'RESOLVED',
    'CLOSED',
  ];

  static const List<String> evidenceTypes = <String>[
    'PHOTO',
    'VIDEO',
    'RECEIPT',
    'CHAT',
    'TRACKING',
    'DELIVERY_PROOF',
    'OTHER',
  ];
}

/// Account levels (domain §2).
abstract final class KycLevel {
  static const int registered = 1;
  static const int phoneVerified = 2;
  static const int identityVerified = 3;
  static const int travelerVerified = 4;
  static const int trustedTraveler = 5;

  static const List<int> all = <int>[1, 2, 3, 4, 5];
}

abstract final class UserMode {
  static const String buyer = 'BUYER';
  static const String traveler = 'TRAVELER';
}

/// Shortcut origins on the buyer home (country code → flag emoji is derived, no assets).
abstract final class PopularOrigins {
  static const List<String> codes = <String>['JP', 'SG', 'KR', 'MY', 'AU', 'US'];

  static String flag(String countryCode) {
    final code = countryCode.toUpperCase();
    if (code.length != 2) return '';
    const base = 0x1F1E6;
    final a = code.codeUnitAt(0) - 0x41;
    final b = code.codeUnitAt(1) - 0x41;
    if (a < 0 || a > 25 || b < 0 || b > 25) return '';
    return String.fromCharCodes(<int>[base + a, base + b]);
  }
}
