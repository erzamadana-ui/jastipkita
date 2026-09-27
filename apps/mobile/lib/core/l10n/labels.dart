import '../domain/domain.dart';
import 'l10n.dart';

/// Domain code → localised label. Unknown codes fall back to the raw code so a newer API never
/// renders an empty label.
abstract final class Labels {
  static String txStatus(AppLocalizations l10n, String status) {
    switch (status) {
      case TxStatus.requestCreated:
        return l10n.txStatusRequestCreated;
      case TxStatus.matched:
        return l10n.txStatusMatched;
      case TxStatus.awaitingPayment:
        return l10n.txStatusAwaitingPayment;
      case TxStatus.paymentSecured:
        return l10n.txStatusPaymentSecured;
      case TxStatus.priceChangePending:
        return l10n.txStatusPriceChangePending;
      case TxStatus.purchaseApproved:
        return l10n.txStatusPurchaseApproved;
      case TxStatus.purchased:
        return l10n.txStatusPurchased;
      case TxStatus.traveling:
        return l10n.txStatusTraveling;
      case TxStatus.arrived:
        return l10n.txStatusArrived;
      case TxStatus.customsProcess:
        return l10n.txStatusCustomsProcess;
      case TxStatus.readyForHandover:
        return l10n.txStatusReadyForHandover;
      case TxStatus.outForDelivery:
        return l10n.txStatusOutForDelivery;
      case TxStatus.delivered:
        return l10n.txStatusDelivered;
      case TxStatus.buyerConfirmed:
        return l10n.txStatusBuyerConfirmed;
      case TxStatus.completed:
        return l10n.txStatusCompleted;
      case TxStatus.cancelled:
        return l10n.txStatusCancelled;
      case TxStatus.disputed:
        return l10n.txStatusDisputed;
      case TxStatus.refundPending:
        return l10n.txStatusRefundPending;
      case TxStatus.refunded:
        return l10n.txStatusRefunded;
      default:
        return status;
    }
  }

  static String tripStatus(AppLocalizations l10n, String status) {
    switch (status) {
      case TripStatus.draft:
        return l10n.tripStatusDraft;
      case TripStatus.verificationPending:
        return l10n.tripStatusVerificationPending;
      case TripStatus.verified:
        return l10n.tripStatusVerified;
      case TripStatus.active:
        return l10n.tripStatusActive;
      case TripStatus.full:
        return l10n.tripStatusFull;
      case TripStatus.traveling:
        return l10n.tripStatusTraveling;
      case TripStatus.completed:
        return l10n.tripStatusCompleted;
      case TripStatus.cancelled:
        return l10n.tripStatusCancelled;
      default:
        return status;
    }
  }

  static String requestStatus(AppLocalizations l10n, String status) {
    switch (status) {
      case RequestStatus.draft:
        return l10n.requestStatusDraft;
      case RequestStatus.open:
        return l10n.requestStatusOpen;
      case RequestStatus.matched:
        return l10n.requestStatusMatched;
      case RequestStatus.closed:
        return l10n.requestStatusClosed;
      case RequestStatus.cancelled:
        return l10n.requestStatusCancelled;
      case RequestStatus.expired:
        return l10n.requestStatusExpired;
      default:
        return status;
    }
  }

  static String kycLevel(AppLocalizations l10n, int level) {
    switch (level) {
      case 1:
        return l10n.kycLevel1;
      case 2:
        return l10n.kycLevel2;
      case 3:
        return l10n.kycLevel3;
      case 4:
        return l10n.kycLevel4;
      default:
        return level >= 5 ? l10n.kycLevel5 : l10n.kycLevel1;
    }
  }

  static String kycBenefit(AppLocalizations l10n, int level) {
    switch (level) {
      case 1:
        return l10n.kycBenefit1;
      case 2:
        return l10n.kycBenefit2;
      case 3:
        return l10n.kycBenefit3;
      case 4:
        return l10n.kycBenefit4;
      default:
        return l10n.kycBenefit5;
    }
  }

  static String kycSubmissionStatus(AppLocalizations l10n, String status) {
    switch (status) {
      case 'PENDING':
        return l10n.kycSubmissionPending;
      case 'IN_REVIEW':
        return l10n.kycSubmissionInReview;
      case 'APPROVED':
        return l10n.kycSubmissionApproved;
      case 'REJECTED':
        return l10n.kycSubmissionRejected;
      case 'EXPIRED':
        return l10n.kycSubmissionExpired;
      default:
        return status;
    }
  }

  static String payoutAccountStatus(AppLocalizations l10n, String status) {
    switch (status) {
      case 'VERIFIED':
        return l10n.payoutAccountVerified;
      case 'PENDING':
        return l10n.payoutAccountPending;
      case 'FAILED':
        return l10n.payoutAccountFailed;
      case 'NAME_MISMATCH':
        return l10n.payoutAccountNameMismatch;
      default:
        return l10n.payoutAccountUnverified;
    }
  }

  static String restrictionTitle(AppLocalizations l10n, String classification) {
    switch (classification) {
      case Restriction.restricted:
        return l10n.restrictionRestrictedTitle;
      case Restriction.declarationRequired:
        return l10n.restrictionDeclarationTitle;
      case Restriction.permitRequired:
        return l10n.restrictionPermitTitle;
      case Restriction.prohibited:
        return l10n.restrictionProhibitedTitle;
      default:
        return l10n.restrictionAllowedTitle;
    }
  }

  static String restrictionBody(AppLocalizations l10n, String classification) {
    switch (classification) {
      case Restriction.restricted:
        return l10n.restrictionRestrictedBody;
      case Restriction.declarationRequired:
        return l10n.restrictionDeclarationBody;
      case Restriction.permitRequired:
        return l10n.restrictionPermitBody;
      case Restriction.prohibited:
        return l10n.restrictionProhibitedBody;
      default:
        return l10n.restrictionAllowedBody;
    }
  }

  /// App label for a breakdown line; the server label is used for unknown types.
  static String priceLine(AppLocalizations l10n, String type, {String fallback = ''}) {
    switch (type) {
      case PriceLineType.itemPrice:
        return l10n.priceLineItemPrice;
      case PriceLineType.travelerFee:
        return l10n.priceLineTravelerFee;
      case PriceLineType.customsDuty:
        return l10n.priceLineCustomsDuty;
      case PriceLineType.importTax:
        return l10n.priceLineImportTax;
      case PriceLineType.protectionFee:
        return l10n.priceLineProtectionFee;
      case PriceLineType.platformFee:
        return l10n.priceLinePlatformFee;
      case PriceLineType.serviceTax:
        return l10n.priceLineServiceTax;
      case PriceLineType.paymentFee:
        return l10n.priceLinePaymentFee;
      case PriceLineType.discount:
        return l10n.priceLineDiscount;
      case PriceLineType.referralCredit:
        return l10n.priceLineReferralCredit;
      case PriceLineType.total:
        return l10n.priceLineTotal;
      default:
        return fallback.isEmpty ? type : fallback;
    }
  }

  static String paymentChannel(AppLocalizations l10n, String? channel) {
    switch (channel) {
      case PaymentChannel.va:
        return l10n.channelVa;
      case PaymentChannel.qris:
        return l10n.channelQris;
      case PaymentChannel.ewallet:
        return l10n.channelEwallet;
      case PaymentChannel.card:
        return l10n.channelCard;
      default:
        return channel ?? '';
    }
  }

  static String paymentStatus(AppLocalizations l10n, String status) {
    switch (status) {
      case 'PENDING':
        return l10n.paymentStatusPending;
      case 'SECURED':
        return l10n.paymentStatusSecured;
      case 'EXPIRED':
        return l10n.paymentStatusExpired;
      case 'FAILED':
        return l10n.paymentStatusFailed;
      case 'REFUNDED':
        return l10n.paymentStatusRefunded;
      case 'PARTIALLY_REFUNDED':
        return l10n.paymentStatusPartiallyRefunded;
      default:
        return status;
    }
  }

  static String deliveryMethod(AppLocalizations l10n, String? method) {
    switch (method) {
      case DeliveryMethod.meetup:
        return l10n.deliveryMeetup;
      case DeliveryMethod.courier:
        return l10n.deliveryCourier;
      case DeliveryMethod.partnerLogistics:
        return l10n.deliveryPartnerLogistics;
      default:
        return method ?? '';
    }
  }

  static String disputeType(AppLocalizations l10n, String type) {
    switch (type) {
      case 'ITEM_NOT_RECEIVED':
        return l10n.disputeTypeItemNotReceived;
      case 'WRONG_ITEM':
        return l10n.disputeTypeWrongItem;
      case 'DAMAGED_ITEM':
        return l10n.disputeTypeDamagedItem;
      case 'COUNTERFEIT':
        return l10n.disputeTypeCounterfeit;
      case 'PRICE_DISPUTE':
        return l10n.disputeTypePriceDispute;
      case 'DELIVERY_DISPUTE':
        return l10n.disputeTypeDeliveryDispute;
      default:
        return l10n.disputeTypeOther;
    }
  }

  static String disputeStatus(AppLocalizations l10n, String status) {
    switch (status) {
      case 'OPEN':
        return l10n.disputeStatusOpen;
      case 'EVIDENCE_COLLECTION':
        return l10n.disputeStatusEvidenceCollection;
      case 'UNDER_REVIEW':
        return l10n.disputeStatusUnderReview;
      case 'RESOLVED':
        return l10n.disputeStatusResolved;
      case 'APPEALED':
        return l10n.disputeStatusAppealed;
      case 'CLOSED':
        return l10n.disputeStatusClosed;
      default:
        return status;
    }
  }

  static String resolution(AppLocalizations l10n, String resolution) {
    switch (resolution) {
      case 'REFUND_FULL':
        return l10n.resolutionRefundFull;
      case 'REFUND_PARTIAL':
        return l10n.resolutionRefundPartial;
      case 'NO_REFUND':
        return l10n.resolutionNoRefund;
      case 'RETURN_AND_REFUND':
        return l10n.resolutionReturnAndRefund;
      default:
        return l10n.resolutionOther;
    }
  }

  static String evidenceType(AppLocalizations l10n, String type) {
    switch (type) {
      case 'PHOTO':
        return l10n.evidencePhoto;
      case 'VIDEO':
        return l10n.evidenceVideo;
      case 'RECEIPT':
        return l10n.evidenceReceipt;
      case 'CHAT':
        return l10n.evidenceChat;
      case 'TRACKING':
        return l10n.evidenceTracking;
      case 'DELIVERY_PROOF':
        return l10n.evidenceDeliveryProof;
      default:
        return l10n.evidenceOther;
    }
  }

  static String payoutStatus(AppLocalizations l10n, String status) {
    switch (status) {
      case 'SCHEDULED':
        return l10n.payoutStatusScheduled;
      case 'ON_HOLD':
        return l10n.payoutStatusOnHold;
      case 'PROCESSING':
        return l10n.payoutStatusProcessing;
      case 'PAID':
        return l10n.payoutStatusPaid;
      case 'FAILED':
        return l10n.payoutStatusFailed;
      case 'CANCELLED':
        return l10n.payoutStatusCancelled;
      default:
        return status;
    }
  }

  static String offerStatus(AppLocalizations l10n, String status) {
    switch (status) {
      case 'PENDING':
        return l10n.offerStatusPending;
      case 'ACCEPTED':
        return l10n.offerStatusAccepted;
      case 'DECLINED':
        return l10n.offerStatusDeclined;
      case 'WITHDRAWN':
        return l10n.offerStatusWithdrawn;
      case 'EXPIRED':
        return l10n.offerStatusExpired;
      default:
        return status;
    }
  }

  static String feeType(AppLocalizations l10n, String type) {
    switch (type) {
      case 'PERCENT':
        return l10n.feeTypePercent;
      case 'PER_KG':
        return l10n.feeTypePerKg;
      default:
        return l10n.feeTypeFixed;
    }
  }

  static String docType(AppLocalizations l10n, String type) {
    switch (type) {
      case 'ITINERARY':
        return l10n.docTypeItinerary;
      case 'BOARDING_PASS':
        return l10n.docTypeBoardingPass;
      default:
        return l10n.docTypeEticket;
    }
  }

  static String trustTier(AppLocalizations l10n, int score) {
    if (score >= 85) return l10n.trustTierExcellent;
    if (score >= 70) return l10n.trustTierGood;
    if (score >= 40) return l10n.trustTierFair;
    return l10n.trustTierLow;
  }

  static String cancellationStage(AppLocalizations l10n, String stage) {
    switch (stage) {
      case 'BEFORE_MATCH':
        return l10n.stageBeforeMatch;
      case 'AFTER_MATCH':
        return l10n.stageAfterMatch;
      case 'AFTER_PAYMENT':
        return l10n.stageAfterPayment;
      case 'BEFORE_PURCHASE':
        return l10n.stageBeforePurchase;
      case 'AFTER_PURCHASE':
        return l10n.stageAfterPurchase;
      case 'DURING_TRAVEL':
        return l10n.stageDuringTravel;
      default:
        return l10n.stageAfterArrival;
    }
  }

  static String cancellationStageHint(AppLocalizations l10n, String stage) {
    switch (stage) {
      case 'BEFORE_MATCH':
      case 'AFTER_MATCH':
        return l10n.stageHintBeforePayment;
      case 'AFTER_PAYMENT':
      case 'BEFORE_PURCHASE':
        return l10n.stageHintAfterPayment;
      default:
        return l10n.stageHintAfterPurchase;
    }
  }

  static String ticketStatus(AppLocalizations l10n, String status) {
    switch (status) {
      case 'OPEN':
        return l10n.ticketStatusOpen;
      case 'PENDING_USER':
        return l10n.ticketStatusPendingUser;
      case 'IN_PROGRESS':
        return l10n.ticketStatusInProgress;
      case 'RESOLVED':
        return l10n.ticketStatusResolved;
      case 'CLOSED':
        return l10n.ticketStatusClosed;
      default:
        return status;
    }
  }

  static const List<String> ticketCategories = <String>[
    'TRANSACTION',
    'PAYMENT',
    'REFUND',
    'DISPUTE',
    'CUSTOMS',
    'ACCOUNT',
    'OTHER',
  ];

  static String ticketCategory(AppLocalizations l10n, String category) {
    switch (category) {
      case 'TRANSACTION':
        return l10n.ticketCategoryTransaction;
      case 'DISPUTE':
        return l10n.ticketCategoryDispute;
      case 'REFUND':
        return l10n.ticketCategoryRefund;
      case 'ACCOUNT':
        return l10n.ticketCategoryAccount;
      case 'PAYMENT':
        return l10n.ticketCategoryPayment;
      case 'CUSTOMS':
        return l10n.ticketCategoryCustoms;
      default:
        return l10n.ticketCategoryOther;
    }
  }

  static String notificationGroup(AppLocalizations l10n, String group, String fallback) {
    switch (group) {
      case 'TRANSACTION':
        return l10n.notifGroupTransaction;
      case 'PAYMENT':
        return l10n.notifGroupPayment;
      case 'CHAT':
        return l10n.notifGroupChat;
      case 'PROMOTION':
        return l10n.notifGroupPromotion;
      case 'ACCOUNT':
        return l10n.notifGroupAccount;
      default:
        return fallback.isEmpty ? group : fallback;
    }
  }

  static String notificationChannel(AppLocalizations l10n, String channel) {
    switch (channel) {
      case 'PUSH':
        return l10n.notifChannelPush;
      case 'EMAIL':
        return l10n.notifChannelEmail;
      default:
        return l10n.notifChannelInApp;
    }
  }

  static String privacyStatus(AppLocalizations l10n, String status) {
    switch (status) {
      case 'RECEIVED':
        return l10n.privacyStatusReceived;
      case 'VERIFYING':
      case 'IN_PROGRESS':
        return l10n.privacyStatusInProgress;
      case 'COMPLETED':
        return l10n.privacyStatusCompleted;
      case 'REJECTED':
        return l10n.privacyStatusRejected;
      case 'CANCELLED':
        return l10n.privacyStatusCancelled;
      default:
        return status;
    }
  }

  static String refundStatus(AppLocalizations l10n, String status) {
    switch (status) {
      case 'SUCCEEDED':
        return l10n.refundStatusSucceeded;
      case 'FAILED':
        return l10n.refundStatusFailed;
      case 'REJECTED':
      case 'CANCELLED':
        return l10n.refundStatusCancelled;
      default:
        return l10n.refundStatusProcessing;
    }
  }
}
