import 'package:flutter_test/flutter_test.dart';
import 'package:jastipkita/core/domain/domain.dart';
import 'package:jastipkita/core/models/json.dart';
import 'package:jastipkita/core/models/marketplace.dart';
import 'package:jastipkita/core/models/transaction.dart';
import 'package:jastipkita/core/storage/token_storage.dart';

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
    expect(traveler.impliedKycLevel, 4);
    expect(traveler.trustScore, isNull, reason: 'discovery responses do not disclose the score');
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
}
