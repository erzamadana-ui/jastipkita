import 'package:flutter_test/flutter_test.dart';
import 'package:jastipkita/core/domain/domain.dart';
import 'package:jastipkita/core/models/account.dart';
import 'package:jastipkita/core/models/engagement.dart';
import 'package:jastipkita/core/models/json.dart';
import 'package:jastipkita/core/models/marketplace.dart';
import 'package:jastipkita/core/models/transaction.dart';
import 'package:jastipkita/core/storage/token_storage.dart';
import 'package:jastipkita/features/auth/data/auth_repository.dart';

import '../fixtures.dart';

void main() {
  group('Quote', () {
    test('parses every OpenAPI field the app uses', () {
      final q = Quote.fromJson(quoteJson());
      expect(q.status, 'ACTIVE');
      expect(q.totalIdr, fixtureTotalIdr);
      expect(q.lines, hasLength(11));
      expect(q.paymentChannel, 'VA');
      expect(q.fx?.base, 'JPY');
      expect(q.fx?.lockedRate, '109.8737500000', reason: 'rates stay decimal strings, never doubles');
      expect(q.fx?.markupBps, 150);
      expect(q.customsRuleCode, 'PASSENGER_GOODS');
      expect(q.restrictedClassification, 'DECLARATION_REQUIRED');
      expect(q.restrictedRequiresAck, isTrue);
      expect(q.discountIdr, 25000);
      expect(q.creditAppliedIdr, 10000);
      expect(q.creditAvailableIdr, 40000);
      final duty = q.line(PriceLineType.customsDuty);
      expect(duty?.isEstimate, isTrue);
      expect(duty?.ruleRef, 'customs:PASSENGER_GOODS@v3');
    });

    test('paymentOptions: fee and total per channel, refundability and availability', () {
      final q = Quote.fromJson(quoteJson());
      expect(q.paymentOptions.map((PaymentOption o) => o.channel), <String>['VA', 'QRIS', 'EWALLET', 'CARD']);
      final va = q.paymentOption('VA')!;
      expect(va.selected, isTrue);
      expect(va.refundable, isFalse);
      expect(va.feeIdr, 4440);
      expect(va.totalIdr, fixtureTotalIdr);
      final card = q.paymentOption('CARD')!;
      expect(card.available, isFalse);
      expect(card.unavailableReason, 'ABOVE_CHANNEL_MAX');
      expect(card.maxAmountIdr, 1000000);
      expect(Quote.fromJson(<String, dynamic>{...quoteJson(), 'paymentOptions': <Object>[]}).paymentOptions, isEmpty);
    });

    test('orderedLines restores the §10 order whatever order the API sends', () {
      final l = priceLinesJson();
      final shuffled = <Map<String, dynamic>>[l[10], l[3], l[0], l[8], l[5], l[1], l[9], l[7], l[2], l[6], l[4]];
      final q = Quote.fromJson(quoteJson(lines: shuffled));
      expect(q.orderedLines.map((PriceLine l) => l.type).toList(), PriceLineType.order);
    });

    test('the quote is usable until the earlier of quote expiry and FX lock', () {
      final q = Quote.fromJson(quoteJson());
      expect(q.lockedUntil, DateTime.utc(2026, 9, 27, 7, 15));
      expect(q.isUsable(DateTime.utc(2026, 9, 27, 7, 14, 59)), isTrue);
      expect(q.isUsable(DateTime.utc(2026, 9, 27, 7, 15)), isFalse);
      expect(Quote.fromJson(quoteJson(status: 'EXPIRED')).isUsable(DateTime.utc(2026, 9, 27, 7)), isFalse);
    });
  });

  group('TransactionDetail', () {
    test('parses payments, gate and allowed actions', () {
      final d = TransactionDetail.fromJson(transactionDetailJson());
      expect(d.number, 'JK-260927-0001');
      expect(d.isBuyer, isFalse);
      expect(d.quote?.lines, hasLength(11));
      expect(d.securedPayment?.sandbox, isTrue);
      expect(d.pendingPayment, isNull);
      expect(d.purchaseGate?.banner, 'DO_NOT_PURCHASE');
      expect(d.can('PRICE_CHECK'), isTrue);
      expect(d.can('SUBMIT_PURCHASE_PROOF'), isFalse);
      expect(d.openPriceConfirmation, isNull);
    });

    test('typed parties, item, trip, ceiling and conversation', () {
      final d = TransactionDetail.fromJson(transactionDetailJson());
      expect(d.item?.currency, 'JPY');
      expect(d.itemCurrency, 'JPY');
      expect(d.item?.imageUrl, startsWith('https://'));
      expect(d.traveler?.displayName, 'Budi S.');
      expect(d.traveler?.trustScore, 92);
      expect(d.traveler?.trustTier, 'EXCELLENT');
      expect(d.traveler?.kycLevel, 4);
      expect(d.traveler?.ratingAs('TRAVELER'), (4.9, 128));
      expect(d.buyer?.ratingAs('BUYER'), (4.5, 3));
      expect(d.trip?.originCity, 'Tokyo');
      expect(d.trip?.arrivalDate, '2026-10-13');
      expect(d.purchaseCeilingIdr, 1208611);
      expect(d.purchaseCeilingMinor, 11000);
      expect(d.conversationId, isNotNull);
      expect(d.payout, isNull, reason: 'payout is always null for the buyer and before scheduling');
    });

    test('golden rule: the traveler may buy only in PURCHASE_APPROVED and only if the server agrees', () {
      expect(TransactionDetail.fromJson(transactionDetailJson()).travelerMayPurchase, isFalse);
      expect(
        TransactionDetail.fromJson(transactionDetailJson(status: 'PURCHASE_APPROVED', canPurchase: true)).travelerMayPurchase,
        isTrue,
      );
      expect(
        TransactionDetail.fromJson(transactionDetailJson(status: 'PURCHASE_APPROVED', canPurchase: false)).travelerMayPurchase,
        isFalse,
        reason: 'a server gate that says no always wins',
      );
      expect(
        TransactionDetail.fromJson(transactionDetailJson(status: 'PAYMENT_SECURED', canPurchase: true)).travelerMayPurchase,
        isFalse,
        reason: 'PAYMENT_SECURED is still DO NOT PURCHASE',
      );
    });

    test('is tolerant of missing or null optional fields', () {
      final d = TransactionDetail.fromJson(<String, dynamic>{'id': 'x', 'status': 'MATCHED', 'quote': null, 'purchaseGate': null});
      expect(d.role, 'BUYER');
      expect(d.quote, isNull);
      expect(d.payments, isEmpty);
      expect(d.allowedActions, isEmpty);
      expect(d.travelerMayPurchase, isFalse);
    });
  });

  test('TripPublic + PublicProfile', () {
    final trip = Trip.fromJson(tripPublicJson());
    expect(trip.originCountry, 'JP');
    expect(trip.remainingKg, 6.5);
    expect(trip.itemsRemaining, 4);
    expect(trip.fee.type, 'FIXED');
    expect(trip.fee.label, 'Rp150.000 / barang');
    expect(trip.verified, isTrue);
    expect(trip.isOwnerView, isFalse);
    final traveler = trip.traveler!;
    expect(traveler.displayName, 'Budi S.');
    expect(traveler.ratingAverage, 4.9);
    expect(traveler.ratingCount, 128);
    expect(traveler.kycLevel, 4);
    expect(traveler.trustScore, 92);
    expect(traveler.trustTier, 'EXCELLENT');
  });

  test('CancellationPreview (same evaluation as POST /cancel)', () {
    final p = CancellationPreview.fromJson(cancelPreviewJson());
    expect(p.canCancel, isTrue);
    expect(p.stage, 'AFTER_PAYMENT');
    expect(p.refundIdr, fixtureTotalIdr - 4440);
    expect(p.notRefundedIdr, 4440);
    expect(p.creditRestoredIdr, 10000);
    final blocked = CancellationPreview.fromJson(cancelPreviewJson(canCancel: false));
    expect(blocked.canCancel, isFalse);
    expect(blocked.requiresAdminApproval, isTrue);
    expect(blocked.blockedCode, 'ADMIN_APPROVAL_REQUIRED');
  });

  test('consent requirements drive the payload (no hard-coded versions)', () {
    final r = ConsentRequirements.fromJson(consentRequirementsJson());
    expect(r.signup.requiredItems.map((ConsentRequirement c) => c.type), <String>['TOS', 'PRIVACY']);
    expect(r.signup.optionalItems.single.type, 'MARKETING');
    expect(r.kyc.byType('KYC')?.versionToSend, '0.1-template');
    expect(r.kyc.byType('KYC')?.granted, isFalse);
    expect(r.byType('MARKETING')?.isRequired, isFalse);
  });

  test('signup consent payload: published versions, marketing only when ticked', () {
    final r = ConsentRequirements.fromJson(consentRequirementsJson());
    final choice = ConsentChoice(group: r.signup, granted: const <String, bool>{'TOS': true, 'PRIVACY': true});
    expect(choice.toPayload(), <Map<String, dynamic>>[
      <String, dynamic>{'type': 'TOS', 'version': '0.1-template', 'granted': true},
      <String, dynamic>{'type': 'PRIVACY', 'version': '0.1-template', 'granted': true},
      <String, dynamic>{'type': 'MARKETING', 'version': '0.1-template', 'granted': false},
    ]);
    expect(choice.toPayload(versionOverride: '0.2').first['version'], '0.2');
  });

  test('Tokens (LOGIN / refresh result)', () {
    final t = AuthTokens.fromJson(tokensJson());
    expect(t.isValid, isTrue);
    expect(t.sessionId, isNotNull);
    expect(t.accessTokenExpiresAt, DateTime.utc(2026, 9, 27, 7, 15));
    expect(t.accessExpiresWithin(const Duration(seconds: 30), DateTime.utc(2026, 9, 27, 7, 14, 45)), isTrue);
    expect(t.accessExpiresWithin(const Duration(seconds: 30), DateTime.utc(2026, 9, 27, 7)), isFalse);
    expect(AuthTokens.fromJson(t.toJson()).refreshToken, 'rt_abc');
  });

  test('cursor pages', () {
    final page = Paged.parse<String>(
      <String, dynamic>{
        'data': <Map<String, dynamic>>[
          <String, dynamic>{'id': 'a'},
          <String, dynamic>{'id': 'b'},
        ],
        'nextCursor': 'c2',
      },
      (Json j) => readString(j, 'id'),
    );
    expect(page.items, <String>['a', 'b']);
    expect(page.hasMore, isTrue);
    expect(Paged.parse<String>(<String, dynamic>{'data': <Object>[], 'nextCursor': null}, (Json j) => '').hasMore, isFalse);
  });

  test('JSON readers never throw on odd values', () {
    final j = <String, dynamic>{'n': '42', 'd': 1.6, 'b': 'true', 'bad': <int>[1]};
    expect(readInt(j, 'n'), 42);
    expect(readInt(j, 'd'), 2);
    expect(readBool(j, 'b'), isTrue);
    expect(readString(j, 'missing', 'x'), 'x');
    expect(readObject(j, 'bad'), isEmpty);
    expect(readDate(j, 'missing'), isNull);
  });

  test('request autoFill (AI-content label) and complaint info', () {
    Map<String, dynamic> request([Object? autoFill]) => <String, dynamic>{
          'id': 'r1',
          'status': 'OPEN',
          'productName': 'Uniqlo AIRism',
          'quantity': 1,
          'destinationCountry': 'ID',
          'sourceType': 'URL',
          'autoFill': autoFill,
        };
    final filled = RequestItem.fromJson(request(<String, dynamic>{'sourceType': 'URL', 'mode': 'MOCK'}));
    expect(filled.isAutoFilled, isTrue);
    expect(filled.autoFillSource, 'URL');
    expect(filled.autoFillMode, 'MOCK');
    expect(RequestItem.fromJson(request()).isAutoFilled, isFalse, reason: 'sourceType alone is not an auto-fill');

    final info = ComplaintInfo.fromJson(<String, dynamic>{
      'channels': <String, dynamic>{'whatsapp': null, 'email': 'cs@example.com', 'webUrl': 'https://example.com/pengaduan/'},
      'sla': <String, dynamic>{
        'complaintPriority': 'HIGH',
        'complaintFirstResponseHours': 12,
        'hoursByPriority': <String, dynamic>{'URGENT': 4, 'HIGH': 12, 'NORMAL': 24, 'LOW': 72},
        'isAssumption': true,
      },
      'escalation': <String, dynamic>{
        'authority': 'Ditjen PKTN',
        'whatsapp': <String, dynamic>{'display': '0853-1111-1010', 'url': 'https://wa.me/6285311111010'},
        'verification': <String, dynamic>{'accessedAt': '2026-10-04'},
      },
    });
    expect(info.whatsappUrl, isNull, reason: 'not announced yet');
    expect(info.email, 'cs@example.com');
    expect(info.complaintFirstResponseHours, 12);
    expect(info.hoursByPriority, <String, int>{'URGENT': 4, 'HIGH': 12, 'NORMAL': 24, 'LOW': 72});
    expect(info.escalationWhatsappUrl, 'https://wa.me/6285311111010');
    expect(info.escalationEmail, isNull);
    expect(info.escalationVerifiedAt, '2026-10-04');
  });
}
